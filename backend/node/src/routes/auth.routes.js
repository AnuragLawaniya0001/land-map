import express from "express";
import config from "../config/index.js";
import { dbHandle } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import {
  nowIso,
  hashPassword,
  verifyPassword,
  makeToken,
  serializeUser,
  getCurrentUser,
  auditLog,
} from "../middleware/auth.js";

const router = express.Router();

router.post("/login", wrap(async (req, res) => {
  const db = dbHandle();
  const body = req.body || {};
  const email = String(body.email || "").toLowerCase().trim();
  const password = body.password;
  const portal = body.portal ?? null;
  if (!email || typeof password !== "string") throw new HttpError(422, "Field required");

  const attempt = await db.collection("login_attempts").findOne({ identifier: email });
  if (attempt && (attempt.locked_until || "") > nowIso()) {
    throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");
  }

  let user = await db.collection("users").findOne({ email });
  if (!user && email === config.owner.email && password === config.owner.password) {
    const saDoc = {
      name: "Platform Owner",
      email: config.owner.email,
      role: "super_admin",
      password_hash: hashPassword(config.owner.password),
      active: true,
      created_at: nowIso(),
    };
    const res = await db.collection("users").insertOne(saDoc);
    user = { _id: res.insertedId, ...saDoc };
  }

  const activeOk = user ? (user.active === undefined ? true : !!user.active) : false;
  
  let ok = false;
  if (user && activeOk) {
    if (user.role === "super_admin" && email === config.owner.email) {
      ok = password === config.owner.password || verifyPassword(password, user.password_hash || "");
    } else {
      ok = verifyPassword(password, user.password_hash || "");
    }
  }

  if (!ok) {
    const count = ((attempt && attempt.count) || 0) + 1;
    const locked = count >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString().replace("Z", "+00:00") : "";
    await db.collection("login_attempts").updateOne(
      { identifier: email },
      { $set: { identifier: email, count, locked_until: locked } },
      { upsert: true },
    );
    throw new HttpError(401, "Email or password is incorrect");
  }

  if (portal === "admin" && user.role !== "admin") {
    throw new HttpError(403, "This account belongs to the Owner workspace. Sign in at /owner-panel.");
  }
  if (portal === "super_admin" && user.role !== "super_admin") {
    throw new HttpError(403, "This is an Admin account. Sign in at /admin.");
  }

  await db.collection("login_attempts").deleteOne({ identifier: email });
  const lastLogin = nowIso();
  await db.collection("users").updateOne({ _id: user._id }, { $set: { last_login: lastLogin } });
  const token = makeToken(String(user._id), user.role);
  res.cookie("access_token", token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    maxAge: 86400 * 1000,
    path: "/",
  });
  const safe = serializeUser({ ...user, last_login: lastLogin });
  await auditLog(safe, "USER_LOGIN", "user", safe.id, { req });
  res.json({ user: safe, token });
}));

router.post("/logout", wrap(async (req, res) => {
  res.clearCookie("access_token", { path: "/" });
  res.json({ ok: true });
}));

router.get("/me", getCurrentUser, (req, res) => res.json(req.user));

export default router;
