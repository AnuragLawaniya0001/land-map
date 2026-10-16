import crypto from "node:crypto";
import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import { nowIso, getCurrentUser, requireAdmin, loadOwnedColony, auditLog } from "../middleware/auth.js";
import { getSignedUrl } from "../storage/index.js";

const router = express.Router();

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateRawToken() {
  return crypto.randomBytes(32).toString("hex"); // 256 bits of entropy
}

// POST /api/admin/plots/:plotId/shares — Generate a new secure share link token for a plot
router.post("/admin/plots/:plotId/shares", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");
  
  // Validate tenant ownership
  await loadOwnedColony(plot.colony_id, req.user);

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const body = req.body || {};

  let expiresAt = null;
  if (body.expires_in_days && !isNaN(Number(body.expires_in_days))) {
    const days = Number(body.expires_in_days);
    if (days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      expiresAt = d.toISOString().replace("Z", "+00:00");
    }
  }

  let maxViews = null;
  if (body.max_views !== undefined && body.max_views !== null && body.max_views !== "") {
    const mv = Number(body.max_views);
    if (!isNaN(mv) && mv > 0) {
      maxViews = Math.floor(mv);
    }
  }

  const shareDoc = {
    id: `share-${crypto.randomUUID()}`,
    plot_id: plotId,
    colony_id: plot.colony_id,
    token_hash: tokenHash,
    created_by: req.user.id,
    created_by_name: req.user.name || "",
    created_at: nowIso(),
    expires_at: expiresAt,
    max_views: maxViews,
    view_count: 0,
    revoked_at: null,
    status: "ACTIVE",
  };

  await db.collection("property_shares").insertOne(shareDoc);

  await auditLog(req.user, "PROPERTY_SHARE_CREATED", "plot", plotId, {
    colonyId: plot.colony_id,
    metadata: { share_id: shareDoc.id, expires_at: expiresAt, max_views: maxViews },
    req,
  });

  res.json({
    share: {
      id: shareDoc.id,
      plot_id: shareDoc.plot_id,
      colony_id: shareDoc.colony_id,
      raw_token: rawToken, // Returned ONCE at creation time
      share_url: `/share/${rawToken}`,
      created_at: shareDoc.created_at,
      expires_at: shareDoc.expires_at,
      max_views: shareDoc.max_views,
      view_count: 0,
      status: "ACTIVE",
    },
  });
}));

// GET /api/admin/plots/:plotId/shares — List active and revoked share tokens for a plot
router.get("/admin/plots/:plotId/shares", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");

  await loadOwnedColony(plot.colony_id, req.user);

  const shares = await db.collection("property_shares").find({ plot_id: plotId }).sort({ created_at: -1 }).toArray();

  const now = nowIso();
  const safeShares = shares.map((s) => {
    let currentStatus = s.status || "ACTIVE";
    if (s.revoked_at) {
      currentStatus = "REVOKED";
    } else if (s.expires_at && now >= s.expires_at) {
      currentStatus = "EXPIRED";
    } else if (s.max_views !== null && s.view_count >= s.max_views) {
      currentStatus = "EXHAUSTED";
    }

    return {
      id: s.id,
      plot_id: s.plot_id,
      colony_id: s.colony_id,
      created_at: s.created_at,
      created_by_name: s.created_by_name,
      expires_at: s.expires_at,
      revoked_at: s.revoked_at,
      max_views: s.max_views,
      view_count: s.view_count || 0,
      status: currentStatus,
    };
  });

  res.json(safeShares);
}));

// DELETE /api/admin/shares/:shareId — Revoke a share token
router.delete("/api/admin/shares/:shareId", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { shareId } = req.params;
  const share = await db.collection("property_shares").findOne({ id: shareId });
  if (!share) throw new HttpError(404, "Share record not found");

  // Validate tenant ownership
  await loadOwnedColony(share.colony_id, req.user);

  if (share.revoked_at) {
    return res.json({ ok: true, message: "Share is already revoked" });
  }

  const ts = nowIso();
  await db.collection("property_shares").updateOne({ id: shareId }, { $set: { revoked_at: ts, status: "REVOKED" } });

  await auditLog(req.user, "PROPERTY_SHARE_REVOKED", "plot", share.plot_id, {
    colonyId: share.colony_id,
    metadata: { share_id: shareId },
    req,
  });

  res.json({ ok: true, status: "REVOKED", revoked_at: ts });
}));

// GET /api/share/:token — Public Share View API (Unguessable Token Holder Access)
router.get("/share/:token", wrap(async (req, res) => {
  const db = dbHandle();
  const rawToken = String(req.params.token || "").trim();
  if (!rawToken || rawToken.length < 16) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  const tokenHash = hashToken(rawToken);
  const share = await db.collection("property_shares").findOne({ token_hash: tokenHash });

  if (!share) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  const now = nowIso();

  // Check Revocation
  if (share.revoked_at) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  // Check Expiry
  if (share.expires_at && now >= share.expires_at) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  // Check Max View Count
  if (share.max_views !== null && share.view_count >= share.max_views) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  // Atomic view_count increment
  const updateRes = await db.collection("property_shares").findOneAndUpdate(
    {
      _id: share._id,
      revoked_at: null,
      $or: [{ expires_at: null }, { expires_at: { $gt: now } }],
      $or: [{ max_views: null }, { $expr: { $lt: ["$view_count", "$max_views"] } }],
    },
    { $inc: { view_count: 1 } },
    { returnDocument: "after" }
  );

  if (!updateRes) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  // Log access in share_access_logs (Privacy-conscious IP hashing)
  const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  const ipHash = crypto.createHash("sha256").update(clientIp).digest("hex").slice(0, 16);
  await db.collection("share_access_logs").insertOne({
    share_id: share.id,
    plot_id: share.plot_id,
    colony_id: share.colony_id,
    accessed_at: now,
    ip_hash: ipHash,
    user_agent: (req.headers["user-agent"] || "").slice(0, 150),
    status: "SUCCESS",
  }).catch(() => {});

  // Fetch Plot & Colony data
  const plot = await db.collection("plots").findOne({ id: share.plot_id });
  if (!plot) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  const colony = await db.collection("colonies").findOne({ _id: new ObjectId(plot.colony_id) });
  if (!colony) {
    throw new HttpError(404, "This property link is invalid or no longer available.");
  }

  const zone = await db.collection("zones").findOne({ id: plot.zone_id });
  const status = await db.collection("statuses").findOne({ id: plot.status_id });

  // STRICT ALLOWLIST RESPONSE — NO REGISTRY, NO STORAGE KEYS, NO CREATED_BY, NO OWNER_ID
  const publicPlotData = {
    id: plot.id,
    number: plot.number,
    title: plot.title || "",
    description: plot.description || "",
    price: plot.price !== undefined ? plot.price : null,
    price_per_sqft: plot.price_per_sqft !== undefined ? plot.price_per_sqft : null,
    facing: plot.facing || "",
    visibility: plot.visibility || "SHARED",
    area_sqm: plot.area_sqm,
    area_sqft: plot.area_sqft,
    area_sqyd: plot.area_sqyd,
    dimensions: plot.dimensions,
    shape: plot.shape,
    status_id: plot.status_id,
    geometry: plot.geometry,
    zone: zone ? { name: zone.name, color: zone.color, code: zone.code } : null,
    status: status ? { name: status.name, color: status.color } : null,
  };

  const publicColonyData = {
    name: colony.name,
    location: colony.location || "",
    whatsapp_number: colony.whatsapp_number || "",
    map_center: colony.map_center,
    boundary: colony.boundary,
  };

  // Fetch approved public-safe property media (Exclude internal storage_key, uploaded_by, checksum)
  const mediaList = await db.collection("property_media")
    .find({ plot_id: plot.id })
    .sort({ is_primary: -1, sort_order: 1, created_at: 1 })
    .toArray();

  const publicMedia = await Promise.all(
    mediaList.map(async (m) => ({
      id: m.id,
      title: m.title || "",
      alt_text: m.alt_text || "",
      is_primary: !!m.is_primary,
      sort_order: m.sort_order || 1,
      url: await getSignedUrl(m.storage_key),
    }))
  );

  res.json({
    property: publicPlotData,
    colony: publicColonyData,
    media: publicMedia,
  });
}));

export default router;
