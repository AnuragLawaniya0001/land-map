import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { config } from "../config/index.js";
import { HttpError, wrap } from "../utils/errors.js";
import { getCurrentUser, requireAdmin, loadOwnedColony, auditLog } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import * as importer from "../gis/importer.js";
import * as roads from "../gis/roads.js";

const router = express.Router();

// 1. POST /api/admin/colonies/:colonyId/gis-imports — Upload source file & initiate GIS parsing
router.post(
  "/admin/colonies/:colonyId/gis-imports",
  getCurrentUser,
  requireAdmin,
  upload.fields([
    { name: "cad_file", maxCount: 1 },
    { name: "layout_pdf", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]),
  wrap(async (req, res) => {
    const { colonyId } = req.params;
    const colony = await loadOwnedColony(colonyId, req.user);
    
    const qgisFile = req.files?.file?.[0];
    const layoutPdf = req.files?.layout_pdf?.[0];
    const companionFile = req.files?.cad_file?.[0];
    const companionExt = (companionFile?.originalname || "").toLowerCase().split(".").pop();
    const providedSources = [qgisFile, layoutPdf, companionFile].filter(Boolean);
    if (providedSources.length === 0) {
      throw new HttpError(400, "Upload at least one mapping file (GeoJSON, PDF layout, or KML/DWG companion).");
    }
    let file = qgisFile || layoutPdf || companionFile;
    const existingBoundary = colony?.boundary || null;
    let targetBoundary = existingBoundary;

    if (companionFile && companionExt === "kml" && !existingBoundary) {
      try {
        const kmlFeatures = importer.parseKml(companionFile.buffer);
        const polygon = kmlFeatures.find((feature) => feature?.geometry?.type === "Polygon");
        if (polygon) targetBoundary = polygon.geometry;
      } catch (e) {
        // ignore invalid KML parse if other files present
      }
    }

    for (const source of providedSources) {
      if (source.buffer.length > config.maxLayoutBytes) {
        throw new HttpError(413, `File too large (max ${Math.round(config.maxLayoutBytes / (1024 * 1024))} MB)`);
      }
    }

    const fname = (file.originalname || "").toLowerCase();
    const importMode = String(req.body?.import_mode || "").toLowerCase();
    const qgisExtensions = [".geojson", ".json", ".gpkg"];
    const allowedExtensions = importMode === "qgis"
      ? qgisExtensions
      : importMode === "pdf_pair"
        ? [".pdf", ".kml", ".dwg"]
        : [".pdf", ".dxf", ...qgisExtensions, ".kml"];
    if (!allowedExtensions.some((ext) => fname.endsWith(ext))) {
      throw new HttpError(400, importMode === "qgis"
        ? "QGIS mode requires a GeoJSON or GeoPackage file."
        : importMode === "pdf_pair"
          ? "PDF mode requires a PDF layout with one KML or DWG companion."
          : "Upload a QGIS GeoJSON/GeoPackage, KML, DXF, or PDF file.");
    }

    const db = dbHandle();
    const importId = new ObjectId();
    const now = new Date().toISOString().replace("Z", "+00:00");

    // Process file through GIS parser to extract intermediate preview
    let fields, zoneDocs, plotDocs, warnings;
    try {
      if (layoutPdf) {
        if (!targetBoundary) {
          throw new HttpError(422, "PDF+companion preview requires a colony land boundary so plot geometry can be fitted and checked.");
        }
        const savedPlots = await db.collection("plots")
          .find({ colony_id: String(colony._id) }, { projection: { number: 1, geometry: 1 } })
          .toArray();
        const pointFeatures = savedPlots.flatMap((plot) => {
          const geometry = plot.geometry;
          const ring = geometry?.type === "Polygon"
            ? geometry.coordinates?.[0]
            : geometry?.type === "MultiPolygon"
              ? geometry.coordinates?.[0]?.[0]
              : null;
          const coordinate = ring?.[0];
          if (!plot.number || !Array.isArray(coordinate) || coordinate.length < 2) return [];
          return [{
            type: "Feature",
            properties: { plot_number: String(plot.number) },
            geometry: { type: "Point", coordinates: coordinate },
          }];
        });
        const geojsonFeatures = [{
          type: "Feature",
          properties: { feature_type: "site_boundary" },
          geometry: targetBoundary,
        }, ...pointFeatures];
        [fields, zoneDocs, plotDocs, warnings] = await importer.importColonyBundle({
          geojsonBuffer: qgisFile?.buffer || (targetBoundary ? Buffer.from(JSON.stringify({ type: "FeatureCollection", features: geojsonFeatures })) : null),
          pdfBuffer: layoutPdf?.buffer || null,
          companionBuffer: companionFile?.buffer || null,
          geojsonFilename: qgisFile?.originalname || "saved-colony-boundary.geojson",
          pdfFilename: layoutPdf?.originalname || "",
          companionFilename: companionFile?.originalname || "",
          mapsLink: req.body?.maps_link || "",
          colonyId: String(colony._id),
          now,
          existingBoundary: targetBoundary,
        });
      } else {
        [fields, zoneDocs, plotDocs, warnings] = await importer.importFile(
          file.buffer,
          file.originalname,
          req.body?.maps_link || "",
          String(colony._id),
          now,
          { targetBoundary }
        );
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof importer.ImportError) throw new HttpError(422, e.message);
      throw new HttpError(422, `Could not parse GIS layout drawing: ${e.message}`);
    }
    if (layoutPdf) {
      fields.import_source.reference_filename = layoutPdf.originalname;
      if (existingBoundary && companionExt !== "dwg") {
        fields.boundary = existingBoundary;
        fields.map_center = colony.map_center || fields.map_center;
        warnings.push("The existing colony land boundary was kept. Plot geometry was extracted from the PDF; KML coordinates were not used to reposition it.");
      }
      if (existingBoundary && companionExt === "dwg") {
        fields.boundary = existingBoundary;
        fields.map_center = colony.map_center || fields.map_center;
        warnings.push("The existing colony land boundary was kept. DWG plot geometry was checked against the PDF labels and fitted within this boundary.");
      }
    }

    // Intermediate GIS Preview Document
    const importDoc = {
      _id: importId,
      owner_id: req.user.id,
      colony_id: String(colony._id),
      filename: file.originalname,
      mime: file.mimetype,
      size: file.buffer.length,
      status: "PREVIEW_READY", // DRAFT -> PARSING -> PREVIEW_READY -> CALIBRATED -> VALIDATED -> COMMITTED
      preview_data: {
        fields,
        zones: zoneDocs,
        plots: plotDocs,
        warnings,
        stats: {
          plots_count: plotDocs.length,
          zones_count: zoneDocs.length,
          greens_count: fields.greens?.length || 0,
          roads_count: fields.roads?.length || 0,
        },
      },
      calibration: null,
      validation: {
        is_valid: true,
        errors: [],
      },
      created_at: now,
      updated_at: now,
    };

    await db.collection("gis_imports").insertOne(importDoc);

    await auditLog(req.user, "GIS_IMPORT_CREATED", "gis_import", String(importId), {
      colonyId: String(colony._id),
      metadata: { filename: file.originalname, plots_count: plotDocs.length },
      req,
    });

    res.status(201).json({
      id: String(importId),
      colony_id: String(colony._id),
      filename: file.originalname,
      status: importDoc.status,
      stats: importDoc.preview_data.stats,
      warnings,
      created_at: now,
    });
  })
);

// 2. GET /api/admin/gis-imports/:importId — Fetch GIS Import Preview session
router.get(
  "/admin/gis-imports/:importId",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const { importId } = req.params;
    if (!ObjectId.isValid(importId)) throw new HttpError(404, "GIS Import session not found");

    const db = dbHandle();
    const imp = await db.collection("gis_imports").findOne({ _id: new ObjectId(importId) });
    if (!imp) throw new HttpError(404, "GIS Import session not found");

    // Tenant isolation verification
    await loadOwnedColony(imp.colony_id, req.user);

    res.json({
      id: String(imp._id),
      colony_id: imp.colony_id,
      filename: imp.filename,
      status: imp.status,
      preview_data: imp.preview_data,
      calibration: imp.calibration,
      validation: imp.validation,
      created_at: imp.created_at,
      committed_at: imp.committed_at || null,
    });
  })
);

// 3. POST /api/admin/gis-imports/:importId/calibrate — Legacy endpoint; recalibration is unsupported
router.post(
  "/admin/gis-imports/:importId/calibrate",
  getCurrentUser,
  requireAdmin,
  wrap(async () => {
    throw new HttpError(
      501,
      "Coordinate recalibration is unsupported. Import a georeferenced PDF/DXF or provide a Google Maps pin during upload.",
    );
  })
);

// 4. POST /api/admin/gis-imports/:importId/validate — Run validation rules before production commit
router.post(
  "/admin/gis-imports/:importId/validate",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const { importId } = req.params;
    if (!ObjectId.isValid(importId)) throw new HttpError(404, "GIS Import session not found");

    const db = dbHandle();
    const imp = await db.collection("gis_imports").findOne({ _id: new ObjectId(importId) });
    if (!imp) throw new HttpError(404, "GIS Import session not found");

    const colony = await loadOwnedColony(imp.colony_id, req.user);

    const errors = [];
    const warnings = [];

    const plots = imp.preview_data?.plots || [];
    if (plots.length === 0) {
      errors.push("No plots detected in the GIS import layout drawing");
    }

    // Duplicate plot number detection
    const numsSeen = new Set();
    const dupNums = new Set();
    for (const p of plots) {
      if (numsSeen.has(p.number)) dupNums.add(p.number);
      numsSeen.add(p.number);
    }
    if (dupNums.size > 0) {
      errors.push(`Duplicate plot numbers detected in import: ${Array.from(dupNums).join(", ")}`);
    }

    // Production conflict check: Check if target colony already has existing plots
    const existingPlotsCount = await db.collection("plots").countDocuments({ colony_id: String(colony._id) });
    if (existingPlotsCount > 0) {
      warnings.push(`Target colony currently has ${existingPlotsCount} production plots. Committing will merge preview plots.`);
    }

    const isValid = errors.length === 0;
    const now = new Date().toISOString().replace("Z", "+00:00");
    const validation = {
      is_valid: isValid,
      errors,
      warnings,
      validated_at: now,
    };

    const newStatus = isValid ? "VALIDATED" : "CALIBRATION_REQUIRED";

    await db.collection("gis_imports").updateOne(
      { _id: new ObjectId(importId) },
      {
        $set: {
          validation,
          status: newStatus,
          updated_at: now,
        },
      }
    );

    res.json({
      id: String(imp._id),
      status: newStatus,
      validation,
    });
  })
);

// 5. POST /api/admin/gis-imports/:importId/commit — Explicit Admin Production Commit
router.post(
  "/admin/gis-imports/:importId/commit",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const { importId } = req.params;
    if (!ObjectId.isValid(importId)) throw new HttpError(404, "GIS Import session not found");

    const db = dbHandle();
    const imp = await db.collection("gis_imports").findOne({ _id: new ObjectId(importId) });
    if (!imp) throw new HttpError(404, "GIS Import session not found");

    const colony = await loadOwnedColony(imp.colony_id, req.user);

    if (imp.status === "COMMITTED") {
      throw new HttpError(400, "Import session already committed to production");
    }

    if (!imp.validation?.is_valid) {
      throw new HttpError(400, "Import validation failed. Clear all validation errors before committing.");
    }

    const now = new Date().toISOString().replace("Z", "+00:00");
    const fields = imp.preview_data?.fields || {};
    const zoneDocs = imp.preview_data?.zones || [];
    const plotDocs = imp.preview_data?.plots || [];

    // Safely write to production MongoDB collections
    if (zoneDocs.length > 0) {
      await db.collection("zones").insertMany(zoneDocs);
    }
    if (plotDocs.length > 0) {
      await db.collection("plots").insertMany(plotDocs);
    }

    // Update Colony boundary, map center & entrance fields
    try {
      const entrance = await roads.entranceFields(fields.boundary, plotDocs.map((p) => p.geometry));
      Object.assign(fields, entrance);
    } catch {
      // Keep existing fields if entrance calc fails
    }

    await db.collection("colonies").updateOne(
      { _id: new ObjectId(colony._id) },
      {
        $set: {
          boundary: fields.boundary,
          map_center: fields.map_center,
          zoom: fields.zoom,
          ...(fields.greens?.length ? { greens: fields.greens } : {}),
          ...(fields.roads?.length ? { roads: fields.roads } : {}),
          entry_road: fields.entry_road,
          entrance: fields.entrance,
          entry_centerline: fields.entry_centerline,
          entry_checked: true,
          layout_version: fields.layout_version,
          import_source: fields.import_source,
          ...(fields.maps_link ? { maps_link: fields.maps_link } : {}),
          updated_at: now,
        },
      }
    );

    await db.collection("gis_imports").updateOne(
      { _id: new ObjectId(importId) },
      {
        $set: {
          status: "COMMITTED",
          committed_at: now,
          updated_at: now,
        },
      }
    );

    await auditLog(req.user, "GIS_IMPORT_COMMITTED", "gis_import", String(importId), {
      colonyId: String(colony._id),
      metadata: { plots_inserted: plotDocs.length, zones_inserted: zoneDocs.length },
      req,
    });

    res.json({
      success: true,
      id: String(imp._id),
      colony_id: String(colony._id),
      status: "COMMITTED",
      committed_at: now,
      summary: {
        plots_inserted: plotDocs.length,
        zones_inserted: zoneDocs.length,
      },
    });
  })
);

// 6. POST /api/admin/gis-imports/:importId/cancel — Cancel & discard GIS Import Preview
router.post(
  "/admin/gis-imports/:importId/cancel",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const { importId } = req.params;
    if (!ObjectId.isValid(importId)) throw new HttpError(404, "GIS Import session not found");

    const db = dbHandle();
    const imp = await db.collection("gis_imports").findOne({ _id: new ObjectId(importId) });
    if (!imp) throw new HttpError(404, "GIS Import session not found");

    await loadOwnedColony(imp.colony_id, req.user);

    if (imp.status === "COMMITTED") {
      throw new HttpError(400, "Cannot cancel a committed GIS import");
    }

    const now = new Date().toISOString().replace("Z", "+00:00");
    await db.collection("gis_imports").updateOne(
      { _id: new ObjectId(importId) },
      {
        $set: {
          status: "CANCELLED",
          updated_at: now,
        },
      }
    );

    await auditLog(req.user, "GIS_IMPORT_CANCELLED", "gis_import", String(importId), {
      colonyId: imp.colony_id,
      req,
    });

    res.json({
      success: true,
      id: String(imp._id),
      status: "CANCELLED",
    });
  })
);

export default router;
