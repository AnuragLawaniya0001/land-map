import express from "express";
import { dbHandle } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import {
  nowIso, getCurrentUser, requireAdmin, loadOwnedColony, auditLog,
} from "../middleware/auth.js";

const router = express.Router();

router.patch("/admin/plots/:plotId/status", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");
  await loadOwnedColony(plot.colony_id, req.user);

  const statusId = (req.body || {}).status_id;
  const status = await db.collection("statuses").findOne({ id: statusId });
  if (!status) throw new HttpError(400, "Unknown status");

  if (statusId === "sold") {
    const registryCount = await db.collection("registry").countDocuments({ plot_id: plotId });
    if (registryCount === 0) {
      throw new HttpError(400, "Registry document is required before this plot can be marked Sold.");
    }
  }

  const previous = plot.status_id || "available";
  await db.collection("plots").updateOne({ id: plotId }, { $set: { status_id: statusId, updated_at: nowIso() } });
  await db.collection("status_history").insertOne({
    plot_id: plotId,
    colony_id: plot.colony_id,
    previous_status: previous,
    new_status: statusId,
    user_id: req.user.id,
    user_name: req.user.name,
    created_at: nowIso(),
  });
  await auditLog(req.user, "PLOT_STATUS_CHANGED", "plot", plotId, {
    colonyId: plot.colony_id,
    metadata: { from: previous, to: statusId },
    req,
  });
  res.json({ ok: true, status_id: statusId });
}));

router.patch("/admin/plots/bulk-status", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const body = req.body || {};
  const plotIds = body.plot_ids;
  if (!Array.isArray(plotIds) || plotIds.length === 0) throw new HttpError(400, "No plots selected");
  const statusId = body.status_id;
  if (!(await db.collection("statuses").findOne({ id: statusId }))) throw new HttpError(400, "Unknown status");

  const plots = await db.collection("plots").find({ id: { $in: plotIds } }).limit(1000).toArray();
  if (plots.length !== new Set(plotIds).size) throw new HttpError(404, "One or more plots not found");
  const colonyIds = [...new Set(plots.map((p) => p.colony_id))];
  for (const cid of colonyIds) await loadOwnedColony(cid, req.user);

  if (statusId === "sold") {
    for (const p of plots) {
      const regCount = await db.collection("registry").countDocuments({ plot_id: p.id });
      if (regCount === 0) {
        throw new HttpError(400, `Registry document is required before Plot ${p.number} can be marked Sold.`);
      }
    }
  }

  const ts = nowIso();
  await db.collection("plots").updateMany(
    { id: { $in: plotIds } },
    { $set: { status_id: statusId, updated_at: ts } },
  );
  await db.collection("status_history").insertMany(plots.map((p) => ({
    plot_id: p.id,
    colony_id: p.colony_id,
    previous_status: p.status_id || "available",
    new_status: statusId,
    user_id: req.user.id,
    user_name: req.user.name,
    created_at: ts,
  })));
  for (const cid of colonyIds) {
    await auditLog(req.user, "PLOT_STATUS_BULK_CHANGED", "colony", cid, {
      colonyId: cid,
      metadata: { count: plots.length, to: statusId },
      req,
    });
  }
  res.json({ ok: true, updated: plots.length, status_id: statusId });
}));

// PATCH /api/admin/plots/:plotId — Update plot property details (title, description, price, price_per_sqft, facing, visibility)
router.patch("/admin/plots/:plotId", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");
  await loadOwnedColony(plot.colony_id, req.user);

  const body = req.body || {};
  const update = {};

  if (body.title !== undefined) update.title = String(body.title).trim();
  if (body.description !== undefined) update.description = String(body.description).trim();

  if (body.price !== undefined) {
    const val = Number(body.price);
    if (isNaN(val) || val < 0) throw new HttpError(400, "Price must be a non-negative number");
    update.price = val;
  }

  if (body.price_per_sqft !== undefined) {
    const val = Number(body.price_per_sqft);
    if (isNaN(val) || val < 0) throw new HttpError(400, "Price per sqft must be a non-negative number");
    update.price_per_sqft = val;
  }

  if (body.facing !== undefined) {
    const validFacings = ["North", "South", "East", "West", "North-East", "North-West", "South-East", "South-West"];
    const facingStr = String(body.facing).trim();
    if (facingStr && !validFacings.map(f => f.toLowerCase()).includes(facingStr.toLowerCase())) {
      throw new HttpError(400, `Invalid facing direction. Allowed values: ${validFacings.join(", ")}`);
    }
    update.facing = facingStr;
  }

  if (body.visibility !== undefined) {
    const validVisibilities = ["PRIVATE", "PUBLIC", "SHARED"];
    const visStr = String(body.visibility).toUpperCase().trim();
    if (!validVisibilities.includes(visStr)) {
      throw new HttpError(400, `Invalid visibility. Allowed values: ${validVisibilities.join(", ")}`);
    }
    update.visibility = visStr;
  }

  if (Object.keys(update).length === 0) throw new HttpError(400, "Nothing to update");

  update.updated_at = nowIso();
  await db.collection("plots").updateOne({ id: plotId }, { $set: update });
  await auditLog(req.user, "PLOT_UPDATED", "plot", plotId, {
    colonyId: plot.colony_id,
    metadata: update,
    req,
  });

  const updatedPlot = await db.collection("plots").findOne({ id: plotId });
  res.json(updatedPlot);
}));

export default router;

