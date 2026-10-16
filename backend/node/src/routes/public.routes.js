import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import { serializeUser, serializeDoc } from "../middleware/auth.js";
import { colonyOut } from "../utils/helpers.js";

const router = express.Router();

router.get("/public/colonies", wrap(async (req, res) => {
  const db = dbHandle();
  const query = { public_enabled: true };
  let ownerDoc = null;
  const owner = req.query.owner;
  if (owner) {
    ownerDoc = await db.collection("users").findOne({
      slug: String(owner), active: true, role: { $in: ["admin", "super_admin"] },
    });
    if (!ownerDoc) throw new HttpError(404, "Admin not found");
    query.owner_id = String(ownerDoc._id);
  }
  const rows = await db.collection("colonies").find(query).sort({ created_at: -1 }).limit(200).toArray();
  const colonies = [];
  for (const c of rows) {
    colonies.push({
      id: String(c._id),
      slug: c.slug,
      name: c.name,
      location: c.location || "",
      description: c.description || "",
      owner_id: c.owner_id,
      plot_count: await db.collection("plots").countDocuments({ colony_id: String(c._id) }),
    });
  }
  res.json({ owner: ownerDoc ? serializeUser(ownerDoc) : null, colonies });
}));

router.get("/public/colonies/:slug", wrap(async (req, res) => {
  const db = dbHandle();
  const c = await db.collection("colonies").findOne({ slug: req.params.slug, public_enabled: true });
  if (!c) throw new HttpError(404, "Project not found");
  const cid = String(c._id);
  const zones = await db.collection("zones").find({ colony_id: cid }).toArray();
  const plots = await db.collection("plots").find({ colony_id: cid }, { projection: { notes: 0 } }).toArray();
  for (const p of plots) {
    p.has_registry = (await db.collection("registry").countDocuments({ plot_id: p.id })) > 0;
  }
  const statuses = await db.collection("statuses").find({}).sort({ sort_order: 1 }).toArray();
  const owner = ObjectId.isValid(c.owner_id || "")
    ? await db.collection("users").findOne({ _id: new ObjectId(c.owner_id) })
    : null;
  res.json({
    colony: colonyOut(c),
    zones: zones.map(serializeDoc),
    plots: plots.map(serializeDoc),
    statuses: statuses.map(serializeDoc),
    owner: owner ? serializeUser(owner) : null,
  });
}));

export default router;
