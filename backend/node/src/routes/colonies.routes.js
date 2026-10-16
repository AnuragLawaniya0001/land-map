import crypto from "node:crypto";
import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { config } from "../config/index.js";
import { HttpError, wrap } from "../utils/errors.js";
import {
  nowIso, serializeUser, serializeDoc,
  getCurrentUser, requireAdmin, requireSuperAdmin, loadOwnedColony, auditLog,
} from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { slugify, colonyOut, DEFAULT_WHATSAPP } from "../utils/helpers.js";
import * as importer from "../gis/importer.js";
import * as roads from "../gis/roads.js";

const router = express.Router();

router.get("/admin/colonies", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const scope = req.user.role === "super_admin"
    ? {}
    : { $or: [{ owner_id: req.user.id }, { partner_admin_id: req.user.id }] };
  const rows = await db.collection("colonies").find(scope).sort({ created_at: -1 }).limit(500).toArray();
  const enriched = [];
  for (const c of rows) {
    const cid = String(c._id);
    let owner = null;
    if (ObjectId.isValid(c.owner_id || "")) {
      const o = await db.collection("users").findOne({ _id: new ObjectId(c.owner_id) });
      owner = o ? serializeUser(o) : null;
    }
    enriched.push({
      ...serializeDoc(c),
      plot_count: await db.collection("plots").countDocuments({ colony_id: cid }),
      owner,
    });
  }
  res.json(enriched);
}));

router.post("/admin/colonies", getCurrentUser, requireAdmin, upload.fields([
  { name: "file", maxCount: 1 },
  { name: "layout_pdf", maxCount: 1 },
  { name: "cad_file", maxCount: 1 },
]), wrap(async (req, res) => {
  const db = dbHandle();
  const geojsonFile = req.files?.file?.[0];
  const layoutPdf = req.files?.layout_pdf?.[0];
  const companionFile = req.files?.cad_file?.[0];
  const providedFiles = [geojsonFile, layoutPdf, companionFile].filter(Boolean);
  if (providedFiles.length === 0) {
    throw new HttpError(400, "Upload at least one mapping source file (QGIS GeoJSON, PDF layout, or KML/DWG companion).");
  }
  if (geojsonFile && ![".geojson", ".json"].some((ext) => (geojsonFile.originalname || "").toLowerCase().endsWith(ext))) {
    throw new HttpError(400, "The primary map file must be a QGIS GeoJSON (.geojson or .json) containing one polygon per plot.");
  }
  if (layoutPdf && (!(layoutPdf.originalname || "").toLowerCase().endsWith(".pdf") ||
      layoutPdf.buffer.subarray(0, 5).toString("ascii") !== "%PDF-")) {
    throw new HttpError(400, "Upload a valid PDF layout file.");
  }
  if (companionFile) {
    const companionExt = (companionFile.originalname || "").toLowerCase().split(".").pop();
    if (companionExt !== "kml" && companionExt !== "dwg" && companionExt !== "dxf") {
      throw new HttpError(400, "The companion source must be a KML, DWG, or DXF file.");
    }
  }
  for (const source of providedFiles) {
    if (source.buffer.length > config.maxLayoutBytes) {
      throw new HttpError(413, `File too large (max ${Math.round(config.maxLayoutBytes / (1024 * 1024))} MB)`);
    }
  }
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) throw new HttpError(400, "Colony name is required");
  const whatsapp = (req.body && req.body.whatsapp_number) || DEFAULT_WHATSAPP;
  const digits = String(whatsapp).replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    throw new HttpError(400, "WhatsApp number must have 10–15 digits incl. country code");
  }
  const base = slugify(name);
  let slug = base;
  let i = 2;
  while (await db.collection("colonies").findOne({ slug })) {
    slug = `${base}-${i}`;
    i += 1;
  }
  const location = String((req.body && req.body.location) || "").trim();
  const partnerAdminId = (req.user.role === "super_admin" && req.body?.partner_admin_id)
    ? String(req.body.partner_admin_id)
    : null;
  const previewToken = crypto.randomBytes(16).toString("hex");

  const result = await db.collection("colonies").insertOne({
    name,
    slug,
    owner_id: req.user.id,
    partner_admin_id: partnerAdminId,
    created_by_role: req.user.role,
    preview_token: previewToken,
    location: location || "—",
    description: String((req.body && req.body.description) || "").trim(),
    public_enabled: req.body?.public_enabled !== undefined
      ? String(req.body.public_enabled).toLowerCase() === "true"
      : req.body?.is_public !== undefined
        ? String(req.body.is_public).toLowerCase() === "true"
        : true,
    whatsapp_number: whatsapp,
    created_at: nowIso(),
  });
  const cid = String(result.insertedId);

  let fields;
  let zoneDocs;
  let plotDocs;
  let warnings;
  try {
    [fields, zoneDocs, plotDocs, warnings] = await importer.importColonyBundle({
      geojsonBuffer: geojsonFile?.buffer || null,
      pdfBuffer: layoutPdf?.buffer || null,
      companionBuffer: companionFile?.buffer || null,
      geojsonFilename: geojsonFile?.originalname || "",
      pdfFilename: layoutPdf?.originalname || "",
      companionFilename: companionFile?.originalname || "",
      mapsLink: (req.body && req.body.maps_link) || "",
      colonyId: cid,
      now: nowIso(),
    });
    if (!plotDocs.length) {
      warnings.push("Only an explicit colony land boundary was imported; no plot parcel geometry was supplied.");
    }
  } catch (e) {
    await db.collection("colonies").deleteOne({ _id: result.insertedId });
    if (e instanceof importer.ImportError) throw new HttpError(422, e.message);
    console.error("colony import failed", e);
    throw new HttpError(422, `Could not read the layout file: ${e && e.constructor ? e.constructor.name : "Error"}`);
  }

  if (zoneDocs.length) await db.collection("zones").insertMany(zoneDocs);
  if (plotDocs.length) await db.collection("plots").insertMany(plotDocs);
  if (!location) {
    fields.location = `${fields.map_center.lat.toFixed(5)}, ${fields.map_center.lng.toFixed(5)}`;
  }
  try {
    Object.assign(fields, await roads.entranceFields(fields.boundary, plotDocs.map((p) => p.geometry)));
  } catch (e) {
    console.error("entrance detection failed", e);
  }
  fields.entry_checked = true;
  if (!fields.entrance) warnings.push("No mapped road found near the layout — entry gate not placed");
  await db.collection("colonies").updateOne({ _id: result.insertedId }, { $set: fields });
  const primaryFilename = geojsonFile?.originalname || layoutPdf?.originalname || companionFile?.originalname || "map";
  await auditLog(req.user, "COLONY_IMPORTED", "colony", cid, {
    colonyId: cid,
    metadata: { file: primaryFilename, plots: plotDocs.length, mode: fields.import_source.mode },
    req,
  });
  const out = colonyOut(await db.collection("colonies").findOne({ _id: result.insertedId }));
  out.import_summary = {
    filename: primaryFilename,
    source_files: fields.import_source.sources,
    plots: plotDocs.length,
    zones: zoneDocs.length,
    greens: fields.greens.length,
    roads: fields.roads.length,
    validation: fields.import_source.validation,
    mode: fields.import_source.mode,
    warnings,
  };
  res.json(out);
}));

router.get("/admin/colonies/:colonyId/geojson", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const c = await loadOwnedColony(req.params.colonyId, req.user);
  const cid = String(c._id);
  const zones = await db.collection("zones").find({ colony_id: cid }).limit(100).toArray();
  const plots = await db.collection("plots").find({ colony_id: cid }).limit(5000).toArray();
  res.setHeader("Content-Disposition", `attachment; filename="${c.slug}.geojson"`);
  res.json(importer.toGeojson(c, zones, plots));
}));

router.get("/admin/colonies/:colonyId", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const c = await loadOwnedColony(req.params.colonyId, req.user);
  const cid = String(c._id);
  const zones = await db.collection("zones").find({ colony_id: cid }).toArray();
  const plots = await db.collection("plots").find({ colony_id: cid }).toArray();
  for (const p of plots) {
    p.registry_count = await db.collection("registry").countDocuments({ plot_id: p.id });
  }
  const statuses = await db.collection("statuses").find({}).sort({ sort_order: 1 }).toArray();
  res.json({
    colony: colonyOut(c),
    zones: zones.map(serializeDoc),
    plots: plots.map(serializeDoc),
    statuses: statuses.map(serializeDoc),
  });
}));

router.patch("/admin/colonies/:colonyId", getCurrentUser, requireAdmin, upload.fields([
  { name: "file", maxCount: 1 },
  { name: "layout_pdf", maxCount: 1 },
  { name: "cad_file", maxCount: 1 },
]), wrap(async (req, res) => {
  const db = dbHandle();
  const c = await loadOwnedColony(req.params.colonyId, req.user);
  const body = req.body || {};
  const update = {};
  for (const k of ["name", "location", "description", "whatsapp_number"]) {
    if (body[k] !== undefined && body[k] !== null) update[k] = body[k];
  }
  if (body.is_public !== undefined || body.public_enabled !== undefined) {
    update.public_enabled = String(body.is_public ?? body.public_enabled).toLowerCase() === "true";
  }
  if (req.user.role === "super_admin" && body.partner_admin_id !== undefined) {
    const partnerAdminId = String(body.partner_admin_id || "").trim();
    if (partnerAdminId) {
      if (!ObjectId.isValid(partnerAdminId)) throw new HttpError(400, "Partner admin is invalid");
      const partner = await db.collection("users").findOne({
        _id: new ObjectId(partnerAdminId),
        role: { $in: ["admin", "super_admin"] },
        active: { $ne: false },
      });
      if (!partner) throw new HttpError(400, "Partner admin was not found or is inactive");
      update.partner_admin_id = partnerAdminId;
    } else {
      update.partner_admin_id = null;
    }
  }
  const files = req.files || {};
  const geojsonFile = files.file?.[0];
  const layoutPdf = files.layout_pdf?.[0];
  const companionFile = files.cad_file?.[0];
  const providedFiles = [geojsonFile, layoutPdf, companionFile].filter(Boolean).length;
  if (Object.keys(update).length === 0 && providedFiles === 0) throw new HttpError(400, "Nothing to update");
  if (update.name !== undefined) {
    update.name = String(update.name).trim();
    if (!update.name) throw new HttpError(400, "Colony name is required");
  }
  for (const key of ["location", "description"]) {
    if (update[key] !== undefined) update[key] = String(update[key]).trim();
  }
  if (update.whatsapp_number !== undefined) {
    const digits = String(update.whatsapp_number).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      throw new HttpError(400, "WhatsApp number must have 10–15 digits incl. country code");
    }
  }

  let importSummary = null;
  if (providedFiles > 0) {
    if (geojsonFile && ![".geojson", ".json"].some((ext) => (geojsonFile.originalname || "").toLowerCase().endsWith(ext))) {
      throw new HttpError(400, "GeoJSON file must be a .geojson or .json file.");
    }
    if (layoutPdf && (!(layoutPdf.originalname || "").toLowerCase().endsWith(".pdf") ||
        layoutPdf.buffer.subarray(0, 5).toString("ascii") !== "%PDF-")) {
      throw new HttpError(400, "Upload a valid PDF layout file.");
    }
    if (companionFile) {
      const companionExt = (companionFile.originalname || "").toLowerCase().split(".").pop();
      if (companionExt !== "kml" && companionExt !== "dwg" && companionExt !== "dxf") {
        throw new HttpError(400, "Companion file must be a .kml, .dwg, or .dxf file.");
      }
    }
    for (const source of [geojsonFile, layoutPdf, companionFile].filter(Boolean)) {
      if (source.buffer.length > config.maxLayoutBytes) {
        throw new HttpError(413, `File too large (max ${Math.round(config.maxLayoutBytes / (1024 * 1024))} MB)`);
      }
    }

    let fields;
    let zoneDocs;
    let plotDocs;
    let warnings;
    try {
      [fields, zoneDocs, plotDocs, warnings] = await importer.importColonyBundle({
        geojsonBuffer: geojsonFile?.buffer || null,
        pdfBuffer: layoutPdf?.buffer || null,
        companionBuffer: companionFile?.buffer || null,
        geojsonFilename: geojsonFile?.originalname || "",
        pdfFilename: layoutPdf?.originalname || "",
        companionFilename: companionFile?.originalname || "",
        mapsLink: body.maps_link || c.maps_link || "",
        colonyId: String(c._id),
        now: nowIso(),
        existingBoundary: c.boundary || null,
      });
    } catch (error) {
      if (error instanceof importer.ImportError) throw new HttpError(422, error.message);
      console.error("colony mapping replacement validation failed", error);
      throw new HttpError(422, `Could not read the replacement mapping files: ${error && error.constructor ? error.constructor.name : "Error"}`);
    }

    const currentPlots = await db.collection("plots").find({ colony_id: String(c._id) }).toArray();
    const boundaryOnly = plotDocs.length === 0;
    const currentByNumber = new Map(currentPlots.map((plot) => [importer.normalizePlotNumber(plot.number), plot]));
    const incomingNumbers = new Set(plotDocs.map((plot) => importer.normalizePlotNumber(plot.number)));
    const removedPlots = boundaryOnly
      ? []
      : currentPlots.filter((plot) => !incomingNumbers.has(importer.normalizePlotNumber(plot.number)));
    const removedIds = removedPlots.map((plot) => plot.id);
    if (removedIds.length) {
      const dependentCollections = [
        "registry",
        "property_ownership_history",
        "property_shares",
        "property_media",
        "property_inquiries",
        "status_history",
      ];
      const references = await Promise.all(dependentCollections.map(async (collection) => ({
        collection,
        count: await db.collection(collection).countDocuments({ plot_id: { $in: removedIds } }),
      })));
      const usedReferences = references.filter(({ count }) => count > 0);
      if (usedReferences.length) {
        throw new HttpError(
          409,
          `Cannot remove plots referenced by existing records (${usedReferences.map(({ collection, count }) => `${collection}: ${count}`).join(", ")}). Keep those plot numbers in the replacement GeoJSON.`,
        );
      }
    }

    const preservedPlotFields = [
      "status_id", "notes", "title", "description", "price", "price_per_sqft",
      "facing", "visibility", "created_at",
    ];
    const mergedPlots = boundaryOnly ? currentPlots : plotDocs.map((plot) => {
      const existing = currentByNumber.get(importer.normalizePlotNumber(plot.number));
      if (!existing) return plot;
      const merged = { ...existing, ...plot, id: existing.id, created_at: existing.created_at };
      for (const key of preservedPlotFields) {
        if (existing[key] !== undefined) merged[key] = existing[key];
      }
      merged.updated_at = nowIso();
      return merged;
    });
    const existingZones = await db.collection("zones").find({ colony_id: String(c._id) }).toArray();
    const zonesById = new Map(existingZones.map((zone) => [zone.id, zone]));
    const mergedZones = boundaryOnly ? existingZones : zoneDocs.map((zone) => {
      const existing = zonesById.get(zone.id);
      return existing ? { ...existing, ...zone, _id: existing._id } : zone;
    });
    if (boundaryOnly) {
      fields.greens = Array.isArray(c.greens) ? c.greens : [];
      fields.roads = Array.isArray(c.roads) ? c.roads : [];
      fields.total_area_sqm = c.total_area_sqm ?? currentPlots.reduce((sum, plot) => sum + (Number(plot.area_sqm) || 0), 0);
      fields.import_source.validation.retained_existing_plot_count = currentPlots.length;
      warnings.push(`Updated the colony land boundary only; all ${currentPlots.length} existing plot records and zones were preserved.`);
    }
    if (body.maps_link !== undefined) fields.maps_link = String(body.maps_link || "").trim() || null;
    if (body.location !== undefined && String(body.location).trim()) fields.location = String(body.location).trim();
    else if (!c.location || c.location === "—") fields.location = `${fields.map_center.lat.toFixed(5)}, ${fields.map_center.lng.toFixed(5)}`;
    try {
      Object.assign(fields, await roads.entranceFields(fields.boundary, mergedPlots.map((plot) => plot.geometry)));
    } catch (error) {
      console.error("entrance detection failed during colony mapping replacement", error);
      warnings.push("Road entry detection failed while updating the mapping; review the colony entrance.");
    }
    fields.entry_checked = true;
    if (!fields.entrance && !warnings.some((warning) => /entry gate not placed/i.test(warning))) {
      warnings.push("No mapped road found near the layout — entry gate not placed");
    }
    fields.import_source.warnings = warnings;
    Object.assign(update, fields);
    update.updated_at = nowIso();
    importSummary = {
      filename: geojsonFile?.originalname || layoutPdf?.originalname || companionFile?.originalname || "map",
      source_files: fields.import_source.sources,
      plots: mergedPlots.length,
      zones: mergedZones.length,
      greens: fields.greens.length,
      roads: fields.roads.length,
      validation: fields.import_source.validation,
      mode: fields.import_source.mode,
      plot_geometry_updated: !boundaryOnly,
      warnings,
    };

    const oldColony = { ...c };
    const oldZones = existingZones;
    let writesStarted = false;
    try {
      writesStarted = true;
      if (!boundaryOnly && mergedZones.length) {
        await db.collection("zones").bulkWrite(mergedZones.map((zone) => {
          const { _id, ...values } = zone;
          return { updateOne: { filter: { id: zone.id }, update: { $set: values }, upsert: true } };
        }));
      }
      if (!boundaryOnly) {
        const existingPlotIds = new Set(currentPlots.map((plot) => plot.id));
        const retainedPlotIds = new Set(mergedPlots.map((plot) => plot.id));
        const plotUpdates = mergedPlots.filter((plot) => existingPlotIds.has(plot.id));
        const newPlots = mergedPlots.filter((plot) => !existingPlotIds.has(plot.id));
        if (plotUpdates.length) {
          await db.collection("plots").bulkWrite(plotUpdates.map((plot) => {
            const { _id, ...values } = plot;
            return { updateOne: { filter: { id: plot.id, colony_id: String(c._id) }, update: { $set: values } } };
          }));
        }
        if (newPlots.length) await db.collection("plots").insertMany(newPlots);
        await db.collection("plots").deleteMany({ colony_id: String(c._id), id: { $nin: [...retainedPlotIds] } });
        await db.collection("zones").deleteMany({ colony_id: String(c._id), id: { $nin: mergedZones.map((zone) => zone.id) } });
      }
      await db.collection("colonies").updateOne({ _id: c._id }, { $set: update });
    } catch (error) {
      if (writesStarted) {
        try {
          await db.collection("plots").deleteMany({ colony_id: String(c._id) });
          if (currentPlots.length) await db.collection("plots").insertMany(currentPlots);
          await db.collection("zones").deleteMany({ colony_id: String(c._id) });
          if (oldZones.length) await db.collection("zones").insertMany(oldZones);
          const { _id, ...oldColonyFields } = oldColony;
          const unsetFields = Object.fromEntries(Object.keys(update)
            .filter((key) => !Object.prototype.hasOwnProperty.call(oldColony, key))
            .map((key) => [key, ""]));
          await db.collection("colonies").updateOne(
            { _id: c._id },
            { $set: oldColonyFields, ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}) },
          );
        } catch (rollbackError) {
          console.error("colony mapping replacement rollback failed", rollbackError);
          throw new HttpError(500, "Mapping update failed and automatic rollback was incomplete. Contact support before retrying.");
        }
      }
      console.error("colony mapping replacement failed", error);
      throw new HttpError(500, "Mapping update failed; the previous colony map was restored.");
    }
  } else {
    update.updated_at = nowIso();
    await db.collection("colonies").updateOne({ _id: c._id }, { $set: update });
  }
  await auditLog(req.user, "COLONY_UPDATED", "colony", String(c._id), {
    colonyId: String(c._id),
    metadata: {
      updated_fields: Object.keys(body),
      mapping_reimported: providedFiles === 3,
      ...(importSummary ? { source_files: importSummary.source_files, plot_count: importSummary.plots } : {}),
    },
    req,
  });
  const result = colonyOut(await db.collection("colonies").findOne({ _id: c._id }));
  if (importSummary) result.import_summary = importSummary;
  res.json(result);
}));

router.delete("/admin/colonies/:colonyId", getCurrentUser, requireAdmin, wrap(async (req, res) => {
  const db = dbHandle();
  const c = await loadOwnedColony(req.params.colonyId, req.user);
  const cid = String(c._id);
  await db.collection("plots").deleteMany({ colony_id: cid });
  await db.collection("zones").deleteMany({ colony_id: cid });
  await db.collection("registry").deleteMany({ colony_id: cid });
  await db.collection("gis_imports").deleteMany({ colony_id: cid });
  await db.collection("property_ownership_history").deleteMany({ colony_id: cid });
  await db.collection("property_shares").deleteMany({ colony_id: cid });
  await db.collection("property_media").deleteMany({ colony_id: cid });
  await db.collection("property_inquiries").deleteMany({ colony_id: cid });
  await db.collection("status_history").deleteMany({ colony_id: cid });
  await db.collection("colonies").deleteOne({ _id: c._id });
  await auditLog(req.user, "COLONY_DELETED", "colony", cid, { colonyId: cid, req });
  res.json({ ok: true, message: "Colony deleted successfully" });
}));

export default router;
