import express from "express";
import authRoutes from "./auth.routes.js";
import publicRoutes from "./public.routes.js";
import usersRoutes from "./users.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import coloniesRoutes from "./colonies.routes.js";
import plotsRoutes from "./plots.routes.js";
import registryRoutes from "./registry.routes.js";
import auditRoutes from "./audit.routes.js";
import gisRoutes from "./gis.routes.js";
import sharesRoutes from "./shares.routes.js";
import mediaRoutes from "./media.routes.js";
import inquiriesRoutes from "./inquiries.routes.js";
import ownerRoutes from "./owner.routes.js";
import gisImportRoutes from "./gis_import.routes.js";
import publicPortalRoutes from "./public_portal.routes.js";
import ownershipRoutes from "./ownership.routes.js";

const api = express.Router();

api.use("/auth", authRoutes);
api.use(authRoutes);
api.use(publicRoutes);
api.use(usersRoutes);
api.use(dashboardRoutes);
api.use(coloniesRoutes);
api.use(plotsRoutes);
api.use(registryRoutes);
api.use(auditRoutes);
api.use(gisRoutes);
api.use(sharesRoutes);
api.use(mediaRoutes);
api.use(inquiriesRoutes);
api.use(ownerRoutes);
api.use(gisImportRoutes);
api.use(publicPortalRoutes);
api.use(ownershipRoutes);

api.get("/health", (req, res) => res.json({ ok: true }));

export default api;

