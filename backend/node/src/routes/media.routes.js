import crypto from "node:crypto";
import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import {
  nowIso, serializeDoc,
  getCurrentUser, requireAdmin, loadOwnedColony, auditLog,
} from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  putObject, deleteObject, buildStorageKey, getSignedUrl,
} from "../storage/index.js";

const router = express.Router();

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB limit for property media

// Helper: validate image buffer header/magic bytes
function validateImageBuffer(buffer, mime) {
  if (!buffer || buffer.length < 8) return false;
  if (mime === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === "image/png") {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mime === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

// POST /api/admin/plots/:plotId/media — Upload a property image
router.post("/admin/plots/:plotId/media", getCurrentUser, requireAdmin, upload.single("file"), wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const file = req.file;

  if (!file) throw new HttpError(422, "Image file required");
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");
  
  // Verify tenant ownership
  await loadOwnedColony(plot.colony_id, req.user);

  const content = file.buffer;
  if (!content || content.length === 0) throw new HttpError(400, "Empty image file");
  if (content.length > MAX_IMAGE_BYTES) throw new HttpError(400, "Image exceeds maximum allowed size of 10 MB");

  const mime = (file.mimetype || "").toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    throw new HttpError(400, "Invalid image format. Allowed: JPEG, PNG, WEBP");
  }

  if (!validateImageBuffer(content, mime)) {
    throw new HttpError(400, "Image content signature mismatch");
  }

  // Count existing media to set sort_order and check primary state
  const existingCount = await db.collection("property_media").countDocuments({ plot_id: plotId });
  const isPrimary = existingCount === 0;

  const mediaId = crypto.randomUUID();
  const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
  const safeOriginalName = (file.originalname || "property.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");

  const storagePath = buildStorageKey({
    userId: req.user.id,
    colonyId: plot.colony_id,
    category: "media",
    plotId,
    filename: `${mediaId}${ext}`,
    docId: mediaId,
  });

  let uploadResult;
  try {
    uploadResult = await putObject(storagePath, content, mime);
  } catch (e) {
    console.error("Property media upload failed:", e);
    throw new HttpError(500, "Could not store property image");
  }

  const rec = {
    id: mediaId,
    plot_id: plotId,
    colony_id: plot.colony_id,
    filename: safeOriginalName,
    mime,
    size: content.length,
    checksum: crypto.createHash("sha256").update(content).digest("hex"),
    storage_key: uploadResult.path || storagePath,
    title: req.body?.title || "",
    alt_text: req.body?.alt_text || "",
    sort_order: existingCount + 1,
    is_primary: isPrimary,
    uploaded_by: req.user.id,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  await db.collection("property_media").insertOne(rec);

  await auditLog(req.user, "PROPERTY_MEDIA_UPLOADED", "property_media", mediaId, {
    colonyId: plot.colony_id,
    metadata: { plot_id: plotId, size: content.length, mime },
    req,
  });

  const url = await getSignedUrl(rec.storage_key);
  res.json({ ...serializeDoc(rec), url });
}));

// GET /api/admin/plots/:plotId/media — List media for a property
router.get("/api/admin/plots/:plotId/media", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");

  await loadOwnedColony(plot.colony_id, req.user);

  const mediaList = await db.collection("property_media")
    .find({ plot_id: plotId })
    .sort({ is_primary: -1, sort_order: 1, created_at: 1 })
    .toArray();

  const results = await Promise.all(
    mediaList.map(async (m) => {
      const url = await getSignedUrl(m.storage_key);
      return { ...serializeDoc(m), url };
    })
  );

  res.json(results);
}));

// PATCH /api/admin/media/:mediaId — Update title/alt/sort_order/is_primary
router.patch("/api/admin/media/:mediaId", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { mediaId } = req.params;
  const media = await db.collection("property_media").findOne({ id: mediaId });
  if (!media) throw new HttpError(404, "Property media not found");

  await loadOwnedColony(media.colony_id, req.user);

  const updates = { updated_at: nowIso() };
  if (req.body?.title !== undefined) updates.title = String(req.body.title).slice(0, 150);
  if (req.body?.alt_text !== undefined) updates.alt_text = String(req.body.alt_text).slice(0, 150);
  if (req.body?.sort_order !== undefined && !isNaN(Number(req.body.sort_order))) {
    updates.sort_order = Number(req.body.sort_order);
  }

  if (req.body?.is_primary === true) {
    // Unset primary flag for all other images belonging to this plot
    await db.collection("property_media").updateMany(
      { plot_id: media.plot_id },
      { $set: { is_primary: false } }
    );
    updates.is_primary = true;
  }

  await db.collection("property_media").updateOne({ id: mediaId }, { $set: updates });
  const updatedDoc = await db.collection("property_media").findOne({ id: mediaId });

  await auditLog(req.user, "PROPERTY_MEDIA_UPDATED", "property_media", mediaId, {
    colonyId: media.colony_id,
    metadata: { plot_id: media.plot_id, updates },
    req,
  });

  const url = await getSignedUrl(updatedDoc.storage_key);
  res.json({ ...serializeDoc(updatedDoc), url });
}));

// DELETE /api/admin/media/:mediaId — Delete a media item and physical storage
router.delete("/api/admin/media/:mediaId", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { mediaId } = req.params;
  const media = await db.collection("property_media").findOne({ id: mediaId });
  if (!media) throw new HttpError(404, "Property media not found");

  await loadOwnedColony(media.colony_id, req.user);

  // Delete physical storage file first
  try {
    await deleteObject(media.storage_key);
  } catch (e) {
    console.warn("Storage object deletion failed or file missing:", e.message);
  }

  // Delete DB record
  await db.collection("property_media").deleteOne({ id: mediaId });

  // If deleted item was primary, auto-promote the next available image
  if (media.is_primary) {
    const nextMedia = await db.collection("property_media")
      .find({ plot_id: media.plot_id })
      .sort({ sort_order: 1, created_at: 1 })
      .limit(1)
      .toArray();

    if (nextMedia.length > 0) {
      await db.collection("property_media").updateOne({ id: nextMedia[0].id }, { $set: { is_primary: true } });
    }
  }

  await auditLog(req.user, "PROPERTY_MEDIA_DELETED", "property_media", mediaId, {
    colonyId: media.colony_id,
    metadata: { plot_id: media.plot_id, filename: media.filename },
    req,
  });

  res.json({ ok: true, id: mediaId });
}));

export default router;
