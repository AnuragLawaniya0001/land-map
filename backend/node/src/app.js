import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config/index.js";
import { errorHandler } from "./utils/errors.js";
import apiRouter from "./routes/index.js";

export const app = express();

app.set("trust proxy", true);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

app.use("/api", apiRouter);
app.use("/api", (req, res) => res.status(404).json({ detail: "Not Found" }));

const frontendIndex = path.join(config.frontendDist, "index.html");
if (config.serveFrontend && fs.existsSync(frontendIndex)) {
  app.use(express.static(config.frontendDist));
  app.get("*", (req, res) => res.sendFile(frontendIndex));
} else {
  app.get("*", (req, res) => res.status(404).json({ detail: "Not Found" }));
}

app.use(errorHandler);
