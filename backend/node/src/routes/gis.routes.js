import express from "express";
import config from "../config/index.js";
import { getDb } from "../db/mongo.js";
import { getCurrentUser, requireAdmin } from "../middleware/auth.js";
import multer from "multer";

const router = express.Router();
const upload = multer({ limits: { fileSize: config.storage.maxSizeBytes } });

// POST /api/admin/gis/import — Dispatch GIS processing to Python worker service
router.post(
  "/admin/gis/import",
  getCurrentUser,
  requireAdmin,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ detail: "No PDF or DXF file uploaded" });
      }

      if (!config.gis.enablePythonFallback) {
        return res.status(400).json({
          detail: "Python GIS service is disabled in configuration (ENABLE_PYTHON_GIS_FALLBACK=false)",
        });
      }

      const formData = new FormData();
      const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
      formData.append("file", blob, req.file.originalname);
      if (req.body.maps_link) {
        formData.append("maps_link", req.body.maps_link);
      }

      const pythonRes = await fetch(`${config.gis.pythonGisUrl}/internal/gis/import`, {
        method: "POST",
        headers: {
          "X-Internal-Token": config.gis.internalSecret,
        },
        body: formData,
        signal: AbortSignal.timeout(60000),
      });

      if (!pythonRes.ok) {
        const errJson = await pythonRes.json().catch(() => ({}));
        return res.status(pythonRes.status).json({
          detail: errJson.detail || "Python GIS processing service error",
        });
      }


      const gisData = await pythonRes.json();
      return res.json(gisData);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
