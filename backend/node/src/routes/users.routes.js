import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import {
  nowIso, hashPassword, serializeUser,
  getCurrentUser, requireSuperAdmin, auditLog,
} from "../middleware/auth.js";
import { slugify } from "../utils/helpers.js";

const router = express.Router();

router.get("/admin/users", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const rows = await db.collection("users")
    .find({ role: { $in: ["admin", "super_admin"] } })
    .sort({ created_at: -1 }).limit(500).toArray();
  const out = [];
  for (const r of rows) {
    const u = serializeUser(r);
    u.colony_count = await db.collection("colonies").countDocuments({ owner_id: u.id });
    out.push(u);
  }
  res.json(out);
}));

router.post("/admin/users", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const body = req.body || {};
  const email = String(body.email || "").toLowerCase().trim();
  const name = String(body.name || "");
  const password = body.password;
  if (!name || !email || typeof password !== "string") throw new HttpError(422, "Field required");
  if (password.length < 6) throw new HttpError(422, "String should have at least 6 characters");
  if (await db.collection("users").findOne({ email })) throw new HttpError(400, "Email already registered");

  const baseSlug = slugify(name);
  let slug = baseSlug;
  let i = 2;
  while (await db.collection("users").findOne({ slug })) {
    slug = `${baseSlug}-${i}`;
    i += 1;
  }
  const doc = {
    name,
    email,
    phone: body.phone || "",
    password_hash: hashPassword(password),
    role: "admin",
    slug,
    active: true,
    created_at: nowIso(),
    created_by: req.user.id,
  };
  const result = await db.collection("users").insertOne(doc);
  doc._id = result.insertedId;
  await auditLog(req.user, "USER_CREATED", "user", String(result.insertedId), { req });
  res.json(serializeUser(doc));
}));

router.patch("/admin/users/:uid", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { uid } = req.params;
  if (!ObjectId.isValid(uid)) throw new HttpError(404, "User not found");
  const body = req.body || {};
  const update = {};
  for (const k of ["name", "phone", "active"]) {
    if (body[k] !== undefined && body[k] !== null) update[k] = body[k];
  }
  if (Object.keys(update).length === 0) throw new HttpError(400, "Nothing to update");
  const result = await db.collection("users").updateOne({ _id: new ObjectId(uid) }, { $set: update });
  if (result.matchedCount === 0) throw new HttpError(404, "User not found");
  await auditLog(req.user, "USER_UPDATED", "user", uid, { metadata: update, req });
  const doc = await db.collection("users").findOne({ _id: new ObjectId(uid) });
  res.json(serializeUser(doc));
}));

router.post("/admin/users/:uid/reset-password", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { uid } = req.params;
  if (!ObjectId.isValid(uid)) throw new HttpError(404, "User not found");
  const pw = (req.body || {}).new_password;
  if (typeof pw !== "string") throw new HttpError(422, "Field required");
  if (pw.length < 6) throw new HttpError(422, "String should have at least 6 characters");
  const result = await db.collection("users").updateOne(
    { _id: new ObjectId(uid) },
    { $set: { password_hash: hashPassword(pw) } },
  );
  if (result.matchedCount === 0) throw new HttpError(404, "User not found");
  await auditLog(req.user, "USER_PASSWORD_RESET", "user", uid, { req });
  res.json({ ok: true });
}));

router.delete("/admin/users/:uid", getCurrentUser, requireSuperAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { uid } = req.params;
  if (!ObjectId.isValid(uid)) throw new HttpError(404, "User not found");
  if (uid === req.user.id) throw new HttpError(400, "Cannot delete yourself");
  const result = await db.collection("users").deleteOne({ _id: new ObjectId(uid), role: { $ne: "super_admin" } });
  if (result.deletedCount === 0) throw new HttpError(404, "User not found");
  await auditLog(req.user, "USER_DELETED", "user", uid, { req });
  res.json({ ok: true });
}));

export default router;
