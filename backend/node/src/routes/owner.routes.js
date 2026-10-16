import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import { serializeUser, serializeDoc, getCurrentUser, requireSuperAdmin } from "../middleware/auth.js";

const router = express.Router();

// GET /api/owner/dashboard — Platform-wide statistics & overview
router.get("/owner/dashboard", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();

  const totalAdmins = await db.collection("users").countDocuments({ role: "admin" });
  const totalColonies = await db.collection("colonies").countDocuments({});
  const totalPlots = await db.collection("plots").countDocuments({});

  // Plot Status counts
  const statuses = await db.collection("statuses").find({}).sort({ sort_order: 1 }).toArray();
  const statusCounts = {};
  for (const s of statuses) statusCounts[s.id] = 0;

  const plotCursor = db.collection("plots").find({}, { projection: { status_id: 1 } });
  for await (const p of plotCursor) {
    const sid = p.status_id || "available";
    statusCounts[sid] = (statusCounts[sid] || 0) + 1;
  }

  // Inquiry counts
  const inquiryNew = await db.collection("property_inquiries").countDocuments({ status: "NEW" });
  const inquiryContacted = await db.collection("property_inquiries").countDocuments({ status: "CONTACTED" });
  const inquiryClosed = await db.collection("property_inquiries").countDocuments({ status: "CLOSED" });
  const inquiryTotal = inquiryNew + inquiryContacted + inquiryClosed;

  // Share & Media totals
  const activeShares = await db.collection("property_shares").countDocuments({ status: "ACTIVE", revoked_at: null });
  const totalShares = await db.collection("property_shares").countDocuments({});
  const registryTotal = await db.collection("registry").countDocuments({});
  const mediaTotal = await db.collection("property_media").countDocuments({});

  // Recent Activity Feed
  const recentAudit = await db.collection("audit_logs")
    .find({})
    .sort({ created_at: -1 })
    .limit(10)
    .toArray();

  res.json({
    role: req.user.role,
    user: serializeUser(req.user),
    totals: {
      admins: totalAdmins,
      colonies: totalColonies,
      plots: totalPlots,
      registry_docs: registryTotal,
      media_total: mediaTotal,
    },
    status_counts: statusCounts,
    inventory: {
      totalPlots: totalPlots,
      availablePlots: statusCounts.available || 0,
      reservedPlots: statusCounts.reserved || 0,
      holdPlots: statusCounts.hold || 0,
      soldPlots: statusCounts.sold || 0,
      blockedPlots: statusCounts.blocked || 0,
    },
    statuses: statuses.map(serializeDoc),
    inquiries: {
      total: inquiryTotal,
      totalInquiries: inquiryTotal,
      new: inquiryNew,
      newInquiries: inquiryNew,
      contacted: inquiryContacted,
      contactedInquiries: inquiryContacted,
      closed: inquiryClosed,
      closedInquiries: inquiryClosed,
    },
    shares: {
      active: activeShares,
      total: totalShares,
    },
    recent_activity: recentAudit.map(serializeDoc),
  });
}));

// GET /api/owner/admins — List all admin accounts with metrics
router.get("/owner/admins", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const admins = await db.collection("users")
    .find({ role: { $in: ["admin", "super_admin"] } })
    .sort({ created_at: -1 })
    .toArray();

  const result = [];
  for (const a of admins) {
    const serialized = serializeUser(a);
    const colonyIds = (await db.collection("colonies").find({ owner_id: String(a._id) }, { projection: { _id: 1 } }).toArray()).map(c => String(c._id));
    
    const colonyCount = colonyIds.length;
    const plotCount = colonyIds.length > 0 ? await db.collection("plots").countDocuments({ colony_id: { $in: colonyIds } }) : 0;
    const availablePlots = colonyIds.length > 0 ? await db.collection("plots").countDocuments({ colony_id: { $in: colonyIds }, status_id: "available" }) : 0;
    const soldPlots = colonyIds.length > 0 ? await db.collection("plots").countDocuments({ colony_id: { $in: colonyIds }, status_id: "sold" }) : 0;
    const inquiryCount = colonyIds.length > 0 ? await db.collection("property_inquiries").countDocuments({ colony_id: { $in: colonyIds } }) : 0;
    const activeShares = colonyIds.length > 0 ? await db.collection("property_shares").countDocuments({ colony_id: { $in: colonyIds }, status: "ACTIVE", revoked_at: null }) : 0;

    serialized.colony_count = colonyCount;
    serialized.plot_count = plotCount;
    serialized.available_plots = availablePlots;
    serialized.sold_plots = soldPlots;
    serialized.inquiry_count = inquiryCount;
    serialized.active_shares = activeShares;

    serialized.metrics = {
      coloniesCount: colonyCount,
      totalPlots: plotCount,
      availablePlots,
      soldPlots,
      inquiriesCount: inquiryCount,
      activeSharesCount: activeShares,
    };

    result.push(serialized);
  }

  res.json({ admins: result });
}));

// PATCH /api/owner/admins/:uid/status — Activate or Deactivate Admin account
router.patch("/owner/admins/:uid/status", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { uid } = req.params;
  const { active } = req.body || {};

  if (typeof active !== "boolean") {
    throw new HttpError(400, "Field 'active' boolean required");
  }

  if (!ObjectId.isValid(uid)) throw new HttpError(404, "Admin account not found");
  if (uid === req.user.id) throw new HttpError(400, "Cannot deactivate your own super admin account");

  const target = await db.collection("users").findOne({ _id: new ObjectId(uid) });
  if (!target) throw new HttpError(404, "Admin account not found");

  await db.collection("users").updateOne(
    { _id: new ObjectId(uid) },
    { $set: { active } }
  );

  const action = active ? "ADMIN_ACTIVATED" : "ADMIN_DEACTIVATED";
  await db.collection("audit_logs").insertOne({
    user_id: req.user.id,
    user_name: req.user.name,
    role: req.user.role,
    action,
    entity_type: "user",
    entity_id: uid,
    metadata: { target_email: target.email, active },
    created_at: new Date().toISOString().replace("Z", "+00:00"),
  });

  const updated = await db.collection("users").findOne({ _id: new ObjectId(uid) });
  res.json(serializeUser(updated));
}));

// GET /api/owner/colonies — Platform-wide colonies list with tenant owner information
router.get("/owner/colonies", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const colonies = await db.collection("colonies").find({}).sort({ created_at: -1 }).toArray();

  const result = [];
  for (const c of colonies) {
    const ownerDoc = ObjectId.isValid(c.owner_id || "")
      ? await db.collection("users").findOne({ _id: new ObjectId(c.owner_id) })
      : null;

    const cid = String(c._id);
    const plotCount = await db.collection("plots").countDocuments({ colony_id: cid });
    const availableCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "available" });
    const reservedCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "reserved" });
    const holdCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "hold" });
    const soldCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "sold" });
    const blockedCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "blocked" });
    const inquiryCount = await db.collection("property_inquiries").countDocuments({ colony_id: cid });

    const partnerDoc = ObjectId.isValid(c.partner_admin_id || "")
      ? await db.collection("users").findOne({ _id: new ObjectId(c.partner_admin_id) })
      : null;

    result.push({
      _id: cid,
      id: cid,
      slug: c.slug,
      name: c.name,
      colony_id: c.name || cid,
      location: c.location || "",
      description: c.description || "",
      source_files: c.import_source?.sources || null,
      public_enabled: !!c.public_enabled,
      is_public: c.public_enabled !== false,
      created_at: c.created_at,
      adminName: ownerDoc ? ownerDoc.name : "System",
      adminEmail: ownerDoc ? ownerDoc.email : "N/A",
      owner: ownerDoc ? serializeUser(ownerDoc) : null,
      partner_admin_id: c.partner_admin_id || null,
      partnerAdminName: partnerDoc ? partnerDoc.name : null,
      partnerAdminEmail: partnerDoc ? partnerDoc.email : null,
      preview_token: c.preview_token || null,
      stats: {
        total_plots: plotCount,
        available: availableCount,
        reserved: reservedCount,
        hold: holdCount,
        sold: soldCount,
        blocked: blockedCount,
        inquiries: inquiryCount,
      },
      metrics: {
        totalPlots: plotCount,
        available: availableCount,
        reserved: reservedCount,
        hold: holdCount,
        sold: soldCount,
        blocked: blockedCount,
        inquiries: inquiryCount,
      }
    });
  }

  res.json({ colonies: result });
}));

// ============================================================
// PHASE 16: OWNER READ-ONLY INSPECTION / GOVERNANCE APIs
// ============================================================

// GET /api/owner/inspection/admins/:adminId — Inspect target Admin summary
router.get("/owner/inspection/admins/:adminId", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { adminId } = req.params;

  if (!ObjectId.isValid(adminId)) throw new HttpError(404, "Target Admin not found");
  const targetAdmin = await db.collection("users").findOne({ _id: new ObjectId(adminId) });
  if (!targetAdmin) throw new HttpError(404, "Target Admin not found");

  const colonyIds = (await db.collection("colonies").find({ owner_id: adminId }, { projection: { _id: 1 } }).toArray()).map(c => String(c._id));

  const stats = {
    colony_count: colonyIds.length,
    plot_count: colonyIds.length > 0 ? await db.collection("plots").countDocuments({ colony_id: { $in: colonyIds } }) : 0,
    available_plots: colonyIds.length > 0 ? await db.collection("plots").countDocuments({ colony_id: { $in: colonyIds }, status_id: "available" }) : 0,
    sold_plots: colonyIds.length > 0 ? await db.collection("plots").countDocuments({ colony_id: { $in: colonyIds }, status_id: "sold" }) : 0,
    inquiry_count: colonyIds.length > 0 ? await db.collection("property_inquiries").countDocuments({ colony_id: { $in: colonyIds } }) : 0,
    active_shares: colonyIds.length > 0 ? await db.collection("property_shares").countDocuments({ colony_id: { $in: colonyIds }, status: "ACTIVE", revoked_at: null }) : 0,
  };

  // Record audit log event for governance traceability
  await db.collection("audit_logs").insertOne({
    user_id: req.user.id,
    user_name: req.user.name,
    role: req.user.role,
    action: "OWNER_INSPECTION_STARTED",
    entity_type: "user",
    entity_id: adminId,
    metadata: { target_email: targetAdmin.email },
    created_at: new Date().toISOString().replace("Z", "+00:00"),
  });

  res.json({
    admin: serializeUser(targetAdmin),
    stats,
  });
}));

// GET /api/owner/inspection/admins/:adminId/colonies — Inspect colonies belonging to target Admin
router.get("/owner/inspection/admins/:adminId/colonies", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { adminId } = req.params;

  if (!ObjectId.isValid(adminId)) throw new HttpError(404, "Target Admin not found");
  const targetAdmin = await db.collection("users").findOne({ _id: new ObjectId(adminId) });
  if (!targetAdmin) throw new HttpError(404, "Target Admin not found");

  const colonies = await db.collection("colonies").find({ owner_id: adminId }).sort({ created_at: -1 }).toArray();

  const result = [];
  for (const c of colonies) {
    const cid = String(c._id);
    const plotCount = await db.collection("plots").countDocuments({ colony_id: cid });
    const availableCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "available" });
    const soldCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "sold" });
    const inquiryCount = await db.collection("property_inquiries").countDocuments({ colony_id: cid });

    result.push({
      id: cid,
      slug: c.slug,
      name: c.name,
      location: c.location || "",
      description: c.description || "",
      public_enabled: !!c.public_enabled,
      created_at: c.created_at,
      stats: {
        total_plots: plotCount,
        available: availableCount,
        sold: soldCount,
        inquiries: inquiryCount,
      }
    });
  }

  res.json({
    admin: serializeUser(targetAdmin),
    colonies: result,
  });
}));

// GET /api/owner/inspection/colonies/:colonyId — Inspect specific colony details (with strict ownership check)
router.get("/owner/inspection/colonies/:colonyId", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { colonyId } = req.params;

  if (!ObjectId.isValid(colonyId)) throw new HttpError(404, "Colony not found");
  const colony = await db.collection("colonies").findOne({ _id: new ObjectId(colonyId) });
  if (!colony) throw new HttpError(404, "Colony not found");

  const ownerDoc = ObjectId.isValid(colony.owner_id || "")
    ? await db.collection("users").findOne({ _id: new ObjectId(colony.owner_id) })
    : null;

  const cid = String(colony._id);
  const plotCount = await db.collection("plots").countDocuments({ colony_id: cid });
  const availableCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "available" });
  const soldCount = await db.collection("plots").countDocuments({ colony_id: cid, status_id: "sold" });
  const inquiryCount = await db.collection("property_inquiries").countDocuments({ colony_id: cid });

  // Record inspection view event
  await db.collection("audit_logs").insertOne({
    user_id: req.user.id,
    user_name: req.user.name,
    role: req.user.role,
    action: "OWNER_INSPECTION_VIEWED",
    entity_type: "colony",
    entity_id: cid,
    colony_id: cid,
    metadata: { colony_name: colony.name, owner_id: colony.owner_id },
    created_at: new Date().toISOString().replace("Z", "+00:00"),
  });

  res.json({
    colony: serializeDoc(colony),
    owner: ownerDoc ? serializeUser(ownerDoc) : null,
    stats: {
      total_plots: plotCount,
      available: availableCount,
      sold: soldCount,
      inquiries: inquiryCount,
    }
  });
}));

// GET /api/owner/inspection/colonies/:colonyId/plots — Inspect plots for a colony (strict ownership validation)
router.get("/owner/inspection/colonies/:colonyId/plots", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { colonyId } = req.params;

  if (!ObjectId.isValid(colonyId)) throw new HttpError(404, "Colony not found");
  const colony = await db.collection("colonies").findOne({ _id: new ObjectId(colonyId) });
  if (!colony) throw new HttpError(404, "Colony not found");

  const cid = String(colony._id);
  const plots = await db.collection("plots").find({ colony_id: cid }).toArray();

  res.json({
    colony: { id: cid, name: colony.name, slug: colony.slug },
    plots: plots.map(serializeDoc),
  });
}));

// GET /api/owner/inspection/plots/:plotId — Inspect single plot detail with strict Plot -> Colony -> Admin ownership chain
router.get("/owner/inspection/plots/:plotId", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;

  if (!ObjectId.isValid(plotId)) throw new HttpError(404, "Plot not found");
  const plot = await db.collection("plots").findOne({ _id: new ObjectId(plotId) });
  if (!plot) throw new HttpError(404, "Plot not found");

  // Verify plot's parent colony exists and belongs to a valid tenant admin
  const colony = await db.collection("colonies").findOne({ _id: new ObjectId(plot.colony_id) });
  if (!colony) throw new HttpError(404, "Plot not found"); // Strict chain check

  const ownerDoc = ObjectId.isValid(colony.owner_id || "")
    ? await db.collection("users").findOne({ _id: new ObjectId(colony.owner_id) })
    : null;

  // Registry metadata check (NEVER expose raw keys or binary files)
  const registryDoc = await db.collection("registry").findOne({ plot_id: String(plot._id) });
  const registryMetadata = registryDoc ? {
    id: String(registryDoc._id),
    filename: registryDoc.filename || "deed.pdf",
    version: registryDoc.version || 1,
    created_at: registryDoc.created_at,
    has_file: true,
  } : null;

  // Media list (metadata & safe URLs only, never raw keys)
  const mediaDocs = await db.collection("property_media").find({ plot_id: String(plot._id) }).toArray();
  const safeMedia = mediaDocs.map(m => ({
    id: String(m._id),
    title: m.title || "",
    is_primary: !!m.is_primary,
    created_at: m.created_at,
  }));

  // Shares metadata (NEVER expose raw token strings)
  const shareDocs = await db.collection("property_shares").find({ plot_id: String(plot._id) }).toArray();
  const safeShares = shareDocs.map(s => ({
    id: String(s._id),
    status: s.status,
    view_count: s.view_count || 0,
    max_views: s.max_views || null,
    expires_at: s.expires_at || null,
    revoked_at: s.revoked_at || null,
    created_at: s.created_at,
  }));

  res.json({
    plot: serializeDoc(plot),
    colony: { id: String(colony._id), name: colony.name, slug: colony.slug },
    owner: ownerDoc ? serializeUser(ownerDoc) : null,
    registry: registryMetadata,
    media: safeMedia,
    shares: safeShares,
  });
}));

// GET /api/owner/inspection/colonies/:colonyId/inquiries — Read-only inquiries inspection for a colony
router.get("/owner/inspection/colonies/:colonyId/inquiries", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { colonyId } = req.params;

  if (!ObjectId.isValid(colonyId)) throw new HttpError(404, "Colony not found");
  const colony = await db.collection("colonies").findOne({ _id: new ObjectId(colonyId) });
  if (!colony) throw new HttpError(404, "Colony not found");

  const cid = String(colony._id);
  const inquiries = await db.collection("property_inquiries").find({ colony_id: cid }).sort({ created_at: -1 }).toArray();

  res.json({
    colony: { id: cid, name: colony.name },
    inquiries: inquiries.map(serializeDoc),
  });
}));

// GET /api/owner/audit-logs — Governance audit history for Owner Audit Log page
router.get("/owner/audit-logs", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { page = 1, limit = 25 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const skip = (pageNum - 1) * limitNum;

  const total = await db.collection("audit_logs").countDocuments({});
  const rows = await db.collection("audit_logs")
    .find({})
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limitNum)
    .toArray();

  const totalPages = Math.ceil(total / limitNum) || 1;

  res.json({
    total,
    auditLogs: rows.map((r) => {
      const doc = serializeDoc(r);
      return {
        ...doc,
        timestamp: r.created_at || r.timestamp,
        user_email: r.user_name || r.user_id || "System",
        user_role: r.role || "system",
        resource_type: r.entity_type,
        resource_id: r.entity_id,
        status: "SUCCESS",
      };
    }),
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalPages,
    },
  });
}));

// GET /api/owner/inquiries — Platform-wide list of inquiries for Super Admin / Owner
router.get("/owner/inquiries", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { status, colony_id } = req.query;

  const query = {};
  if (status) query.status = String(status);
  if (colony_id) query.colony_id = String(colony_id);

  const inquiries = await db.collection("property_inquiries")
    .find(query)
    .sort({ created_at: -1 })
    .limit(300)
    .toArray();

  res.json(inquiries.map(serializeDoc));
}));

export default router;
