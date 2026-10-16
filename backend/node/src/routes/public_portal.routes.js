import crypto from "node:crypto";
import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import { nowIso, getCurrentUser, requireAdmin, loadOwnedColony, auditLog } from "../middleware/auth.js";
import { hashToken, generateRawToken } from "./shares.routes.js";

const router = express.Router();

// 1. GET /api/admin/public-portal — Fetch active Admin Public Portal configuration & metrics
router.get(
  "/admin/public-portal",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const db = dbHandle();
    const portal = await db.collection("admin_portal_shares").findOne({
      admin_id: req.user.id,
      status: { $in: ["ACTIVE", "EXPIRED", "DEVICE_LIMIT_BREACHED"] }
    });

    if (!portal) {
      return res.json({ portal: null });
    }

    const activeSessionsCount = await db.collection("public_link_sessions").countDocuments({
      portal_share_id: String(portal._id),
      status: "ACTIVE"
    });

    res.json({
      portal: {
        id: String(portal._id),
        status: portal.status,
        access_mode: portal.access_mode,
        duration_minutes: portal.duration_minutes,
        max_devices: portal.max_devices,
        created_at: portal.created_at,
        expires_at: portal.expires_at,
        active_sessions_count: activeSessionsCount,
      }
    });
  })
);

// 2. POST /api/admin/public-portal — Create or Regenerate Admin Public Portal Link
router.post(
  "/admin/public-portal",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const db = dbHandle();
    const body = req.body || {};
    const accessMode = body.access_mode === "DEVICE_BASED" ? "DEVICE_BASED" : "TIME_BASED";
    const durationMinutes = Number(body.duration_minutes) || 10;
    const maxDevices = Number(body.max_devices) || 5;

    // Revoke any existing active public portal for this admin
    const now = nowIso();
    const existing = await db.collection("admin_portal_shares").find({ admin_id: req.user.id, status: "ACTIVE" }).toArray();
    for (const p of existing) {
      await db.collection("admin_portal_shares").updateOne(
        { _id: p._id },
        { $set: { status: "REVOKED", revoked_at: now } }
      );
      await db.collection("public_link_sessions").updateMany(
        { portal_share_id: String(p._id) },
        { $set: { status: "REVOKED", revoked_at: now } }
      );
    }

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);

    let expiresAt = null;
    if (accessMode === "TIME_BASED") {
      const d = new Date();
      d.setMinutes(d.getMinutes() + durationMinutes);
      expiresAt = d.toISOString().replace("Z", "+00:00");
    }

    const portalDoc = {
      admin_id: req.user.id,
      owner_id: req.user.id,
      token_hash: tokenHash,
      status: "ACTIVE",
      access_mode: accessMode,
      duration_minutes: durationMinutes,
      max_devices: maxDevices,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      created_by: req.user.name || req.user.email,
    };

    const result = await db.collection("admin_portal_shares").insertOne(portalDoc);
    const portalId = String(result.insertedId);

    await auditLog(req.user, "PUBLIC_PORTAL_CREATED", "admin_portal_share", portalId, {
      metadata: { access_mode: accessMode, duration_minutes: durationMinutes, max_devices: maxDevices },
      req,
    });

    res.status(201).json({
      portal: {
        id: portalId,
        raw_token: rawToken, // Exposed ONCE at creation time
        portal_url: `/portal/${rawToken}`,
        status: "ACTIVE",
        access_mode: accessMode,
        duration_minutes: durationMinutes,
        max_devices: maxDevices,
        created_at: now,
        expires_at: expiresAt,
      }
    });
  })
);

// 3. POST /api/admin/public-portal/revoke — Revoke active Admin Public Portal Link
router.post(
  "/admin/public-portal/revoke",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const db = dbHandle();
    const now = nowIso();

    const activePortals = await db.collection("admin_portal_shares").find({ admin_id: req.user.id, status: "ACTIVE" }).toArray();
    for (const p of activePortals) {
      await db.collection("admin_portal_shares").updateOne(
        { _id: p._id },
        { $set: { status: "REVOKED", revoked_at: now } }
      );
      await db.collection("public_link_sessions").updateMany(
        { portal_share_id: String(p._id) },
        { $set: { status: "REVOKED", revoked_at: now } }
      );

      await auditLog(req.user, "PUBLIC_PORTAL_REVOKED", "admin_portal_share", String(p._id), { req });
    }

    res.json({ success: true, message: "Public portal link revoked successfully" });
  })
);

// ============================================================
// PUBLIC CONSUMER PORTAL ENDPOINTS (UNAUTHENTICATED + SESSION CONTROLLED)
// ============================================================

// 4. POST /api/public/portal/:token/session — Validate portal token & create controlled session
router.post(
  "/public/portal/:token/session",
  wrap(async (req, res) => {
    const db = dbHandle();
    const { token } = req.params;
    const tokenHash = hashToken(token);

    const portal = await db.collection("admin_portal_shares").findOne({ token_hash: tokenHash });
    if (!portal) {
      throw new HttpError(404, "Public portal link is invalid or expired");
    }

    const now = nowIso();

    // 1. Expiry Check
    if (portal.status === "REVOKED" || portal.status === "DEVICE_LIMIT_BREACHED") {
      throw new HttpError(403, "Public portal link has been revoked or invalidated");
    }

    if (portal.access_mode === "TIME_BASED" && portal.expires_at && portal.expires_at < now) {
      await db.collection("admin_portal_shares").updateOne(
        { _id: portal._id },
        { $set: { status: "EXPIRED" } }
      );
      throw new HttpError(403, "Public portal session link has expired");
    }

    // 2. Session & Device Limit Check (Atomic Check-and-Breach)
    const portalIdStr = String(portal._id);
    const existingSessionsCount = await db.collection("public_link_sessions").countDocuments({
      portal_share_id: portalIdStr,
      status: "ACTIVE"
    });

    // 5-Device Rule: 6th device breaches global access
    if (existingSessionsCount >= portal.max_devices) {
      // Transition portal & all sessions to DEVICE_LIMIT_BREACHED
      await db.collection("admin_portal_shares").updateOne(
        { _id: portal._id },
        { $set: { status: "DEVICE_LIMIT_BREACHED", revoked_at: now } }
      );
      await db.collection("public_link_sessions").updateMany(
        { portal_share_id: portalIdStr },
        { $set: { status: "DEVICE_LIMIT_BREACHED", revoked_at: now } }
      );
      throw new HttpError(403, "Maximum device limit reached. Public portal link has been globally invalidated.");
    }

    // Create unique session
    const rawSessionToken = generateRawToken();
    const sessionHash = hashToken(rawSessionToken);

    const sessionDoc = {
      portal_share_id: portalIdStr,
      admin_id: portal.admin_id,
      session_token_hash: sessionHash,
      status: "ACTIVE",
      created_at: now,
      last_seen_at: now,
      expires_at: portal.expires_at,
    };

    await db.collection("public_link_sessions").insertOne(sessionDoc);

    // Set secure HttpOnly cookie
    res.cookie("portal_session_token", rawSessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 3600000,
    });

    res.json({
      success: true,
      session_token: rawSessionToken,
      portal: {
        admin_id: portal.admin_id,
        access_mode: portal.access_mode,
        expires_at: portal.expires_at,
      }
    });
  })
);

// Helper Middleware to validate public portal session
async function validatePortalSession(req) {
  const db = dbHandle();
  let rawSession = req.cookies?.portal_session_token;
  if (!rawSession) {
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) rawSession = authHeader.slice(7);
  }
  if (!rawSession) throw new HttpError(401, "No active portal session found");

  const sessionHash = hashToken(rawSession);
  const session = await db.collection("public_link_sessions").findOne({ session_token_hash: sessionHash });
  if (!session || session.status !== "ACTIVE") {
    throw new HttpError(403, "Public portal session is invalid or expired");
  }

  // Check portal status & time expiration
  const portal = await db.collection("admin_portal_shares").findOne({ _id: new ObjectId(session.portal_share_id) });
  if (!portal || portal.status !== "ACTIVE") {
    throw new HttpError(403, "Public portal access has been revoked or invalidated");
  }

  const now = nowIso();
  if (portal.access_mode === "TIME_BASED" && portal.expires_at && portal.expires_at < now) {
    throw new HttpError(403, "Public portal session has expired");
  }

  return { session, portal };
}

// 5. GET /api/public/portal/session/colonies — List publicly exposed colonies for the Admin
router.get(
  "/public/portal/session/colonies",
  wrap(async (req, res) => {
    const { portal } = await validatePortalSession(req);
    const db = dbHandle();

    // Fetch public-enabled colonies belonging strictly to the portal's owner Admin
    const colonies = await db.collection("colonies").find({
      owner_id: portal.admin_id,
      public_enabled: true
    }).sort({ created_at: -1 }).toArray();

    const result = [];
    for (const c of colonies) {
      const cid = String(c._id);
      const plotCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "available" });
      result.push({
        id: cid,
        name: c.name,
        slug: c.slug,
        location: c.location || "",
        description: c.description || "",
        available_plots: plotCount,
      });
    }

    res.json({ colonies: result });
  })
);

// 6. GET /api/public/portal/session/colonies/:colonyId/plots — List public properties in colony
router.get(
  "/public/portal/session/colonies/:colonyId/plots",
  wrap(async (req, res) => {
    const { portal } = await validatePortalSession(req);
    const { colonyId } = req.params;
    const db = dbHandle();

    // Verify colony ownership & public enabled status
    if (!ObjectId.isValid(colonyId)) throw new HttpError(404, "Colony not found");
    const colony = await db.collection("colonies").findOne({ _id: new ObjectId(colonyId), owner_id: portal.admin_id, public_enabled: true });
    if (!colony) throw new HttpError(404, "Colony not found");

    const cid = String(colony._id);
    const plots = await db.collection("plots").find({ colony_id: cid }).toArray();

    // Sanitize public response fields (STRICT ALLOWLIST, NO REGISTRY)
    const sanitizedPlots = plots.map(p => ({
      id: String(p._id),
      number: p.number || p.plot_number,
      status_id: p.status_id,
      area_sqft: p.area_sqft,
      price: p.price || null,
      facing: p.facing || null,
      geometry: p.geometry,
    }));

    res.json({
      colony: { id: cid, name: colony.name, location: colony.location },
      plots: sanitizedPlots,
    });
  })
);

// 7. POST /api/admin/colonies/:colonyId/preview-session — Authorize permanent preview link session for Admin/Owner
router.post(
  "/admin/colonies/:colonyId/preview-session",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const db = dbHandle();
    const { colonyId } = req.params;

    const colony = await loadOwnedColony(colonyId, req.user);
    const cid = String(colony._id);

    let previewToken = colony.preview_token;
    if (!previewToken) {
      previewToken = crypto.randomBytes(16).toString("hex");
      await db.collection("colonies").updateOne({ _id: colony._id }, { $set: { preview_token: previewToken } });
    }

    const now = nowIso();
    const rawSessionToken = generateRawToken();
    const sessionHash = hashToken(rawSessionToken);

    const sessionDoc = {
      colony_id: cid,
      user_id: req.user.id,
      user_role: req.user.role,
      preview_token: previewToken,
      session_token_hash: sessionHash,
      status: "ACTIVE",
      created_at: now,
      last_seen_at: now,
    };

    await db.collection("preview_link_sessions").insertOne(sessionDoc);

    res.cookie("preview_session_token", rawSessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400000, // 24 hours active session
    });

    await auditLog(req.user, "PREVIEW_AUTHORIZED", "colony", cid, {
      colonyId: cid,
      metadata: { preview_token: previewToken },
      req,
    });

    res.json({
      success: true,
      preview_token: previewToken,
      preview_url: `/preview/${previewToken}`,
    });
  })
);

// Helper Middleware to validate Preview session
async function validateColonyPreviewSession(req, previewToken) {
  const db = dbHandle();
  let rawSession = req.cookies?.preview_session_token;
  if (!rawSession) {
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) rawSession = authHeader.slice(7);
  }
  if (!rawSession) throw new HttpError(403, "Preview access denied. Please click Preview from your panel.");

  const sessionHash = hashToken(rawSession);
  const session = await db.collection("preview_link_sessions").findOne({
    session_token_hash: sessionHash,
    status: "ACTIVE",
  });

  if (!session) throw new HttpError(403, "Preview session is invalid or expired");

  const colony = await db.collection("colonies").findOne({ preview_token: previewToken });
  if (!colony) throw new HttpError(404, "Preview property not found");

  if (session.colony_id !== String(colony._id)) {
    throw new HttpError(403, "Preview session does not authorize access to this property");
  }

  return { session, colony };
}

// 8. GET /api/preview/:previewToken — Verify Preview Session & return layout info
router.get(
  "/preview/:previewToken",
  wrap(async (req, res) => {
    const { previewToken } = req.params;
    const { colony } = await validateColonyPreviewSession(req, previewToken);

    res.json({
      success: true,
      colony_id: String(colony._id),
      slug: colony.slug,
      name: colony.name,
      location: colony.location,
    });
  })
);

// 9. GET /api/preview/:previewToken/data — Fetch full preview map data (zones, plots, statuses, owner)
router.get(
  "/preview/:previewToken/data",
  wrap(async (req, res) => {
    const { previewToken } = req.params;
    const { colony } = await validateColonyPreviewSession(req, previewToken);

    const db = dbHandle();
    const cid = String(colony._id);
    const zones = await db.collection("zones").find({ colony_id: cid }).toArray();
    const plots = await db.collection("plots").find({ colony_id: cid }, { projection: { notes: 0 } }).toArray();
    const statuses = await db.collection("statuses").find({}).sort({ sort_order: 1 }).toArray();
    const owner = ObjectId.isValid(colony.owner_id || "")
      ? await db.collection("users").findOne({ _id: new ObjectId(colony.owner_id) })
      : null;

    res.json({
      colony: {
        id: cid,
        name: colony.name,
        slug: colony.slug,
        map_center: colony.map_center,
        boundary: colony.boundary,
        entry_road: colony.entry_road,
        entrance: colony.entrance,
        entry_centerline: colony.entry_centerline,
        roads: colony.roads || [],
        greens: colony.greens || [],
        location: colony.location || "",
        whatsapp_number: colony.whatsapp_number,
      },
      zones: zones.map(serializeDoc),
      plots: plots.map(serializeDoc),
      statuses: statuses.map(serializeDoc),
      owner: owner ? { name: owner.name, email: owner.email, slug: owner.slug } : null,
    });
  })
);

export default router;
