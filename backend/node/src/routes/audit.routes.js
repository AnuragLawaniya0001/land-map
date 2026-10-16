import express from "express";
import { dbHandle } from "../db/mongo.js";
import { wrap } from "../utils/errors.js";
import { serializeDoc, getCurrentUser, requireAdmin } from "../middleware/auth.js";

const router = express.Router();

router.get("/admin/audit-logs", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { action, actor_id, page = 1, limit = 50 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (pageNum - 1) * limitNum;

  const query = {};
  if (req.user.role !== "super_admin") {
    const colonies = await db.collection("colonies").find({ owner_id: req.user.id }, { projection: { _id: 1 } }).limit(500).toArray();
    const ids = colonies.map((c) => String(c._id));
    query.$or = [{ colony_id: { $in: ids } }, { user_id: req.user.id }];
  }

  if (action) query.action = String(action);
  if (actor_id) query.user_id = String(actor_id);

  const total = await db.collection("audit_logs").countDocuments(query);
  const rows = await db.collection("audit_logs")
    .find(query)
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limitNum)
    .toArray();

  res.json({
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum) || 1,
    logs: rows.map(serializeDoc),
  });
}));

export default router;
