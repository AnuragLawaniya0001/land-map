import crypto from "node:crypto";
import { serializeDoc } from "../middleware/auth.js";
import * as layout from "../gis/layout.js";

const DURGA_CENTER = layout.CENTER;
const DURGA_ROAD = "Village road off Vasna–Padra Road, Darapura";
export const DEFAULT_WHATSAPP = "+91 90000 00000";

export const slugify = (text) => {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || `item-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
};

export function colonyOut(c) {
  const out = serializeDoc(c);
  if (out.map_center === undefined) out.map_center = DURGA_CENTER;
  if (out.whatsapp_number === undefined) out.whatsapp_number = DEFAULT_WHATSAPP;
  out.map_road = DURGA_ROAD;
  return out;
}
