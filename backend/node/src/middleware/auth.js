import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import config from "../config/index.js";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError } from "../utils/errors.js";

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

export function nowIso() {
  return new Date().toISOString().replace("Z", "+00:00");
}

export function hashPassword(pw) {
  return bcrypt.hashSync(pw, BCRYPT_ROUNDS);
}

export function verifyPassword(pw, hashed) {
  if (!hashed) return false;
  try {
    return bcrypt.compareSync(pw, hashed);
  } catch {
    return false;
  }
}

export function makeToken(userId, role) {
  return jwt.sign({ sub: String(userId), role }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: config.tokenTtlSeconds,
  });
}

const SAFE_USER_FIELDS = [
  "id", "name", "email", "phone", "role", "slug", "active", "created_at", "last_login", "created_by",
];

export function serializeUser(doc) {
  if (!doc) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id") out.id = String(v);
    else if (k === "password_hash") continue;
    else if (SAFE_USER_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

export function serializeDoc(doc) {
  if (!doc) return null;
  const out = { ...doc };
  if (out._id !== undefined) {
    const oid = String(out._id);
    delete out._id;
    if (out.id === undefined) out.id = oid;
  }
  delete out.content;
  delete out.storage_key;
  return out;
}

export async function getCurrentUser(req, res, next) {
  try {
    let raw = req.cookies ? req.cookies.access_token : null;
    if (!raw) {
      const auth = req.headers.authorization || "";
      if (auth.startsWith("Bearer ")) raw = auth.slice(7);
    }
    if (!raw) throw new HttpError(401, "Not authenticated");
    let payload;
    try {
      payload = jwt.verify(raw, config.jwtSecret, { algorithms: ["HS256"] });
    } catch {
      throw new HttpError(401, "Session expired");
    }
    const uid = payload.sub;
    if (!uid || !ObjectId.isValid(uid)) throw new HttpError(401, "Invalid session");
    const user = await dbHandle().collection("users").findOne({ _id: new ObjectId(uid), active: true });
    if (!user) throw new HttpError(401, "Account not available");
    req.user = serializeUser(user);
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || !["admin", "super_admin"].includes(req.user.role)) {
    return next(new HttpError(403, "Admin access required"));
  }
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== "super_admin") {
    return next(new HttpError(403, "Super admin access required"));
  }
  next();
}

export async function loadOwnedColony(colonyId, user) {
  const queryIds = [colonyId];
  if (ObjectId.isValid(colonyId)) queryIds.push(new ObjectId(colonyId));
  const base = { $or: [...queryIds.map((q) => ({ _id: q })), { slug: colonyId }] };
  const colony = await dbHandle().collection("colonies").findOne(base);
  if (!colony) throw new HttpError(404, "Colony not found");
  if (user.role !== "super_admin" && colony.owner_id !== user.id && colony.partner_admin_id !== user.id) {
    // Mask as 404 to avoid tenant enumeration
    throw new HttpError(404, "Colony not found");
  }
  return colony;
}

export async function auditLog(user, action, entityType, entityId, opts = {}) {
  const { colonyId = null, metadata = null, req = null } = opts;
  const rec = {
    user_id: user.id,
    user_name: user.name || "",
    action,
    entity_type: entityType,
    entity_id: String(entityId),
    colony_id: colonyId,
    metadata: metadata || {},
    created_at: nowIso(),
  };
  if (req) {
    rec.ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
    rec.user_agent = (req.headers["user-agent"] || "").slice(0, 200);
  }
  await dbHandle().collection("audit_logs").insertOne(rec);
}
