import crypto from "node:crypto";
import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import {
  nowIso, serializeDoc,
  getCurrentUser, requireAdmin, loadOwnedColony, auditLog,
} from "../middleware/auth.js";
import { hashToken } from "./shares.routes.js";

const router = express.Router();

// Simple honeypot & phone validation helpers
function isValidIndianPhone(phone) {
  if (!phone || typeof phone !== "string") return false;
  const clean = phone.replace(/[^0-9]/g, "");
  return clean.length >= 10 && clean.length <= 12;
}

// POST /api/public/inquiries — Public customer inquiry submission
router.post("/public/inquiries", wrap(async (req, res) => {
  const db = dbHandle();
  const body = req.body || {};

  // Honeypot check (hidden field e.g. fax_number / website_url)
  if (body.fax_number || body.website_url) {
    // Silently drop spam submission
    return res.json({ ok: true, message: "Thank you. Your inquiry has been received." });
  }

  const { share_token, name, phone, email, message } = body;

  const nameVal = (name && typeof name === "string") ? name.trim() : "Interested Buyer";
  if (!phone || !isValidIndianPhone(phone)) {
    throw new HttpError(400, "Valid 10-digit phone number is required");
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new HttpError(400, "Message content is required");
  }

  let plotId = body.plot_id || null;
  let colonyId = body.colony_id || null;
  let shareId = null;

  // If originating from a property share link, derive plot & colony securely from token
  if (share_token) {
    const tokenHash = hashToken(share_token);
    const share = await db.collection("property_shares").findOne({ token_hash: tokenHash });
    if (!share || share.revoked_at) {
      throw new HttpError(404, "Invalid or unavailable property link");
    }
    plotId = share.plot_id;
    colonyId = share.colony_id;
    shareId = share.id;
  }

  if (!plotId || !colonyId) {
    throw new HttpError(400, "Target property must be specified");
  }

  // Rate limiting check per IP / phone hash
  const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  const ipHash = crypto.createHash("sha256").update(clientIp).digest("hex").slice(0, 16);

  const recentCount = await db.collection("property_inquiries").countDocuments({
    ip_hash: ipHash,
    created_at: { $gt: new Date(Date.now() - 15 * 60 * 1000).toISOString() }
  });

  if (recentCount >= 5) {
    throw new HttpError(429, "Too many inquiry submissions. Please try again in 15 minutes.");
  }

  const inquiryId = crypto.randomUUID();
  const rec = {
    id: inquiryId,
    plot_id: String(plotId),
    colony_id: String(colonyId),
    share_id: shareId,
    name: nameVal.slice(0, 100),
    phone: phone.replace(/[^0-9+]/g, "").slice(0, 15),
    email: email ? String(email).trim().slice(0, 100) : "",
    message: message.trim().slice(0, 1000),
    status: "NEW", // NEW, CONTACTED, CLOSED
    ip_hash: ipHash,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  await db.collection("property_inquiries").insertOne(rec);

  res.json({
    ok: true,
    message: "Thank you. Your inquiry has been submitted successfully.",
  });
}));

// GET /api/admin/inquiries — Admin list inquiries with tenant isolation
router.get("/admin/inquiries", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { colony_id, status, plot_id } = req.query;

  const query = {};
  if (colony_id) {
    await loadOwnedColony(String(colony_id), req.user);
    query.colony_id = String(colony_id);
  } else if (req.user.role !== "super_admin") {
    // Restrict list to colonies owned by admin
    const ownedColonies = await db.collection("colonies").find({ owner_id: req.user.id }).toArray();
    const ownedIds = ownedColonies.map((c) => String(c._id));
    query.colony_id = { $in: ownedIds };
  }

  if (status) query.status = String(status);
  if (plot_id) query.plot_id = String(plot_id);

  const inquiries = await db.collection("property_inquiries")
    .find(query)
    .sort({ created_at: -1 })
    .limit(200)
    .toArray();

  res.json(inquiries.map(serializeDoc));
}));

// PATCH /api/admin/inquiries/:id — Update inquiry status (NEW -> CONTACTED -> CLOSED)
router.patch("/admin/inquiries/:id", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { id } = req.params;
  const inquiry = await db.collection("property_inquiries").findOne({ id });
  if (!inquiry) throw new HttpError(404, "Inquiry not found");

  await loadOwnedColony(inquiry.colony_id, req.user);

  const newStatus = req.body?.status;
  if (!newStatus || !["NEW", "CONTACTED", "CLOSED"].includes(newStatus)) {
    throw new HttpError(400, "Invalid status. Allowed: NEW, CONTACTED, CLOSED");
  }

  await db.collection("property_inquiries").updateOne(
    { id },
    { $set: { status: newStatus, updated_at: nowIso() } }
  );

  await auditLog(req.user, "PROPERTY_INQUIRY_STATUS_UPDATED", "property_inquiries", id, {
    colonyId: inquiry.colony_id,
    metadata: { plot_id: inquiry.plot_id, old_status: inquiry.status, new_status: newStatus },
    req,
  });

  const updatedDoc = await db.collection("property_inquiries").findOne({ id });
  res.json(serializeDoc(updatedDoc));
}));

export default router;
