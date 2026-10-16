import express from "express";
import { dbHandle } from "../db/mongo.js";
import { wrap } from "../utils/errors.js";
import { serializeDoc, getCurrentUser, requireAdmin } from "../middleware/auth.js";

const router = express.Router();

router.get("/admin/dashboard", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const scope = req.user.role === "super_admin" ? {} : { owner_id: req.user.id };
  const colonies = await db.collection("colonies").find(scope, { projection: { _id: 1 } }).limit(1000).toArray();
  const ids = colonies.map((c) => String(c._id));
  const plotTotal = await db.collection("plots").countDocuments({ colony_id: { $in: ids } });
  const statuses = await db.collection("statuses").find({}).sort({ sort_order: 1 }).toArray();
  const counts = {};
  for (const s of statuses) counts[s.id] = 0;
  const plotCursor = db.collection("plots").find({ colony_id: { $in: ids } }, { projection: { status_id: 1 } });
  for await (const p of plotCursor) {
    const sid = p.status_id || "available";
    counts[sid] = (counts[sid] || 0) + 1;
  }
  const registryTotal = await db.collection("registry").countDocuments({ colony_id: { $in: ids } });
  const mediaTotal = await db.collection("property_media").countDocuments({ colony_id: { $in: ids } });

  // Share Analytics
  const activeShares = await db.collection("property_shares").countDocuments({ colony_id: { $in: ids }, status: "ACTIVE", revoked_at: null });
  const totalShares = await db.collection("property_shares").countDocuments({ colony_id: { $in: ids } });

  // Inquiry Analytics
  const inquiryNew = await db.collection("property_inquiries").countDocuments({ colony_id: { $in: ids }, status: "NEW" });
  const inquiryContacted = await db.collection("property_inquiries").countDocuments({ colony_id: { $in: ids }, status: "CONTACTED" });
  const inquiryClosed = await db.collection("property_inquiries").countDocuments({ colony_id: { $in: ids }, status: "CLOSED" });
  const inquiryTotal = inquiryNew + inquiryContacted + inquiryClosed;

  let usersTotal = 0;
  if (req.user.role === "super_admin") {
    usersTotal = await db.collection("users").countDocuments({ role: { $in: ["admin", "super_admin"] } });
  }

  res.json({
    role: req.user.role,
    colonies: ids.length,
    plots: plotTotal,
    status_counts: counts,
    statuses: statuses.map(serializeDoc),
    registry_docs: registryTotal,
    media_total: mediaTotal,
    shares: {
      active: activeShares,
      total: totalShares,
    },
    inquiries: {
      total: inquiryTotal,
      new: inquiryNew,
      contacted: inquiryContacted,
      closed: inquiryClosed,
    },
    total_users: usersTotal,
  });
}));

router.get("/admin/statuses", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const statuses = await dbHandle().collection("statuses").find({}).sort({ sort_order: 1 }).toArray();
  res.json(statuses.map(serializeDoc));
}));

export default router;
