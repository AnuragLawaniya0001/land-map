import crypto from "node:crypto";
import express from "express";
import { dbHandle } from "../db/mongo.js";
import { config } from "../config/index.js";
import { HttpError, wrap } from "../utils/errors.js";
import {
  nowIso, serializeDoc,
  getCurrentUser, requireAdmin, loadOwnedColony, auditLog,
} from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  putObject, getObject, buildStorageKey, validatePdfBuffer,
} from "../storage/index.js";

const router = express.Router();

router.post("/admin/plots/:plotId/sold", getCurrentUser, requireAdmin, upload.single("file"), wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const file = req.file;
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");
  await loadOwnedColony(plot.colony_id, req.user);

  const existingCount = await db.collection("registry").countDocuments({ plot_id: plotId });
  let rec = null;

  if (file) {
    if (existingCount >= config.maxRegistryVersions) {
      throw new HttpError(400, `Maximum ${config.maxRegistryVersions} registry versions reached for this plot`);
    }
    const content = file.buffer;
    if (content.length === 0) throw new HttpError(400, "Empty file");
    if (content.length > config.maxPdfBytes) throw new HttpError(400, "File exceeds 25 MB");
    if (!validatePdfBuffer(content)) throw new HttpError(400, "File signature is not a valid PDF");
    if (file.mimetype && file.mimetype !== "application/pdf") throw new HttpError(400, "Only application/pdf is accepted");
    if (!(file.originalname || "").toLowerCase().endsWith(".pdf")) throw new HttpError(400, "Filename must end with .pdf");

    const docId = crypto.randomUUID();
    const version = existingCount + 1;
    const storagePath = buildStorageKey({
      userId: req.user.id,
      colonyId: plot.colony_id,
      category: "registry",
      plotId,
      filename: file.originalname,
      version,
      docId,
    });

    let uploadResult;
    try {
      uploadResult = await putObject(storagePath, content, "application/pdf");
    } catch (e) {
      console.error("Registry upload failed:", e);
      throw new HttpError(500, "Could not upload registry document");
    }

    rec = {
      id: docId,
      plot_id: plotId,
      colony_id: plot.colony_id,
      filename: file.originalname,
      size: content.length,
      mime: "application/pdf",
      checksum: crypto.createHash("sha256").update(content).digest("hex"),
      version,
      uploaded_by: req.user.id,
      uploaded_by_name: req.user.name,
      created_at: nowIso(),
      storage_key: uploadResult.path || storagePath,
    };
    await db.collection("registry").insertOne(rec);
    await auditLog(req.user, "REGISTRY_UPLOADED", "registry", docId, {
      colonyId: plot.colony_id,
      metadata: { plot_id: plotId, version, size: content.length },
      req,
    });
  } else {
    if (existingCount === 0) {
      throw new HttpError(400, "Registry document is required before this plot can be marked Sold.");
    }
  }

  const previous = plot.status_id || "available";
  await db.collection("plots").updateOne({ id: plotId }, { $set: { status_id: "sold", updated_at: nowIso() } });
  await db.collection("status_history").insertOne({
    plot_id: plotId,
    colony_id: plot.colony_id,
    previous_status: previous,
    new_status: "sold",
    user_id: req.user.id,
    user_name: req.user.name,
    created_at: nowIso(),
  });
  await auditLog(req.user, "PLOT_STATUS_CHANGED", "plot", plotId, {
    colonyId: plot.colony_id,
    metadata: { from: previous, to: "sold", registry_attached: !!rec },
    req,
  });

  const updatedPlot = await db.collection("plots").findOne({ id: plotId });
  res.json({
    success: true,
    plot: serializeDoc(updatedPlot),
    registry: rec ? serializeDoc(rec) : null,
    status: "sold",
  });
}));

router.post("/admin/plots/:plotId/registry", getCurrentUser, requireAdmin, upload.single("file"), wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const file = req.file;
  if (!file) throw new HttpError(422, "Field required");
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");
  await loadOwnedColony(plot.colony_id, req.user);

  const existingCount = await db.collection("registry").countDocuments({ plot_id: plotId });
  if (existingCount >= config.maxRegistryVersions) {
    throw new HttpError(400, `Maximum ${config.maxRegistryVersions} registry versions reached for this plot`);
  }

  const content = file.buffer;
  if (content.length === 0) throw new HttpError(400, "Empty file");
  if (content.length > config.maxPdfBytes) throw new HttpError(400, "File exceeds 25 MB");
  if (!validatePdfBuffer(content)) {
    throw new HttpError(400, "File signature is not a valid PDF");
  }
  if (file.mimetype && file.mimetype !== "application/pdf") {
    throw new HttpError(400, "Only application/pdf is accepted");
  }
  if (!(file.originalname || "").toLowerCase().endsWith(".pdf")) {
    throw new HttpError(400, "Filename must end with .pdf");
  }

  const docId = crypto.randomUUID();
  const version = existingCount + 1;
  const storagePath = buildStorageKey({
    userId: req.user.id,
    colonyId: plot.colony_id,
    category: "registry",
    plotId,
    filename: file.originalname,
    version,
    docId,
  });

  let uploadResult;
  try {
    uploadResult = await putObject(storagePath, content, "application/pdf");
  } catch (e) {
    console.error("Registry upload failed:", e);
    throw new HttpError(500, "Could not upload registry document");
  }

  const rec = {
    id: docId,
    plot_id: plotId,
    colony_id: plot.colony_id,
    filename: file.originalname,
    size: content.length,
    mime: "application/pdf",
    checksum: crypto.createHash("sha256").update(content).digest("hex"),
    version,
    uploaded_by: req.user.id,
    uploaded_by_name: req.user.name,
    created_at: nowIso(),
    storage_key: uploadResult.path || storagePath,
  };
  await db.collection("registry").insertOne(rec);
  await auditLog(req.user, "REGISTRY_UPLOADED", "registry", docId, {
    colonyId: plot.colony_id,
    metadata: { plot_id: plotId, version, size: content.length },
    req,
  });
  res.json(serializeDoc(rec));
}));

router.get("/admin/plots/:plotId/registry", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const { plotId } = req.params;
  const plot = await db.collection("plots").findOne({ id: plotId });
  if (!plot) throw new HttpError(404, "Plot not found");
  await loadOwnedColony(plot.colony_id, req.user);
  const rows = await db.collection("registry").find({ plot_id: plotId }).sort({ version: 1 }).limit(10).toArray();
  res.json(rows.map(serializeDoc));
}));

router.get("/admin/registry/:docId/download", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const rec = await db.collection("registry").findOne({ id: req.params.docId });
  if (!rec) throw new HttpError(404, "Registry document not found");
  await loadOwnedColony(rec.colony_id, req.user);
  let content;
  let mime;
  try {
    ({ content, mime } = await getObject(rec.storage_key));
  } catch (e) {
    console.error("Registry download failed:", e);
    throw new HttpError(410, "Registry file is no longer available");
  }
  res.setHeader("Content-Disposition", `inline; filename="${rec.filename}"`);
  res.setHeader("Content-Type", mime || "application/pdf");
  res.send(content);
}));

export default router;
