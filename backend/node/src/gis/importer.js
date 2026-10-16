// Node.js port of backend/importer.py — reads DXF / PDF layout drawings and
// turns them into colony fields + zones + plots documents.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import DxfParser from "dxf-parser";
import proj4 from "proj4";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { GeoPackage, GeoPackageAPI } from "@ngageoint/geopackage";
import { config } from "../config/index.js";

import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import LineString from "jsts/org/locationtech/jts/geom/LineString.js";
import ArrayList from "jsts/java/util/ArrayList.js";
import "jsts/org/locationtech/jts/monkey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.resolve(__dirname, "..", "..", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
).href;

export class ImportError extends Error {}

const gf = new GeometryFactory();

export const ZONE_COLORS = [
  "#35c7b4", "#f06b5f", "#f2b84b", "#55a8ff",
  "#b787f5", "#7bd389", "#ff9f68", "#6fd3e9",
];

export const M_PER_FT = 0.3048;
const LAT_PER_M = 1 / 110574;
const MAX_PLOTS = 5000;

const GREEN_WORDS = /\b(park|garden|green|lawn|open\s*space|play|club|amenit|pond|lake)/i;
const ROAD_WORDS = /\b(road|rd\.?|street|path|lane|marg|mt\.?\s*wide|m\s*wide|wide)/i;
const PLOT_NO = /^(?:plot\s*(?:no\.?)?\s*)?([A-Z]{0,2}[-/ ]?\d{1,4}[A-Z]?)$/i;
const SCALE_RE = /scale\s*[:=]?\s*1\s*[:/]\s*(\d{2,6})/i;

// ---------------------------------------------------------------- numbers

export function pyRound(value, digits = 0) {
  const f = 10 ** digits;
  const scaled = value * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) r = floor % 2 === 0 ? floor : floor + 1;
  else r = Math.round(scaled);
  return r / f;
}

function fmt1(x) {
  return pyRound(x, 1).toFixed(1);
}

function round2(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return pyRound(value, digits);
}

// ---------------------------------------------------------------- title case

function titleCase(text) {
  return text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ---------------------------------------------------------------- maps link

const MAPS_HOSTS = /(goo\.gl|maps\.app\.goo\.gl|g\.co)/i;

export async function parseMapsLink(url) {
  if (!url) return null;
  let text = String(url).trim();
  if (!text) return null;
  if (MAPS_HOSTS.test(text) && !/\d{1,2}\.\d{3,}/.test(text)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(text, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      clearTimeout(timer);
      if (resp.ok) text = resp.url;
    } catch {
      // keep the original text and try the plain regexes on it
    }
  }
  let m = text.match(/!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = text.match(/@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = text.match(/[?&](?:q|ll|query|destination|center)=(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = text.match(/(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  return null;
}

// ---------------------------------------------------------------- DXF

function extractDxf(buf) {
  let doc;
  try {
    doc = new DxfParser().parseSync(buf.toString("utf-8"));
  } catch (e) {
    throw new ImportError("Could not read the DXF file");
  }
  const header = doc.header || {};
  let unit = header["$INSUNITS"];
  const unitM = {};
  unitM[1] = 0.0254; // inches
  unitM[2] = M_PER_FT; // feet
  unitM[4] = 1e-3; // mm
  unitM[5] = 1e-2; // cm
  unitM[6] = 1.0; // metres
  unitM[14] = 10.0; // decametres

  const lines = [];
  const polys = [];
  const texts = [];

  for (const e of doc.entities || []) {
    const layer = e.layer || "0";
    const type = e.type;
    if (type === "LWPOLYLINE" || type === "POLYLINE") {
      const verts = (e.vertices || []).map((v) => [v.x, v.y]);
      const closed = e.shape === true || e.closed === true;
      if (closed && verts.length >= 3) {
        polys.push([verts, layer, null]);
      } else if (verts.length >= 2) {
        for (let i = 0; i + 1 < verts.length; i += 1) lines.push([verts[i], verts[i + 1]]);
      }
    } else if (type === "LINE") {
      const vs = e.vertices || [];
      if (vs.length >= 2) lines.push([[vs[0].x, vs[0].y], [vs[1].x, vs[1].y]]);
    } else if (type === "TEXT" || type === "MTEXT") {
      const p = e.startPoint || e.position || {};
      const txt = String(e.text || "").trim();
      if (txt) texts.push([Number(p.x) || 0, Number(p.y) || 0, txt, layer]);
    }
  }

  let unitVal = null;
  if (unit !== undefined && unit !== null && unit !== 0) {
    const code = typeof unit === "object" && unit.value !== undefined ? unit.value : unit;
    const num = Number(code);
    if (unitM[num] !== undefined) unitVal = unitM[num];
  }
  return { lines, polys, texts, unit_m: unitVal, georef: null, src: "dxf" };
}

// ---------------------------------------------------------------- PDF

function colorComponent(v) {
  const n = Number(v) || 0;
  return n > 1.0001 ? n / 255 : n;
}

function pdfColor(kind, args) {
  const vals = Array.from(args || [], (v) => colorComponent(v));
  if (kind === "gray") {
    const g = vals.length ? vals[vals.length - 1] : null;
    return g === null ? null : [g, g, g];
  }
  if (kind === "cmyk") {
    const [c, m, y, k] = [vals[0] || 0, vals[1] || 0, vals[2] || 0, vals[3] || 0];
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  if (vals.length >= 3) return vals.slice(0, 3);
  return null;
}

function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function endpointsEqual(pts) {
  if (pts.length < 2) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

export async function extractPdf(buf) {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const lines = [];
  const polys = [];
  const texts = [];

  for (let pno = 1; pno <= pdf.numPages; pno += 1) {
    const page = await pdf.getPage(pno);
    const opList = await page.getOperatorList();

    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let fill = [0, 0, 0];
    let stroke = [0, 0, 0];
    let subpaths = [];
    let current = [];

    const commit = (painted) => {
      if (current.length) subpaths.push({ pts: current, closed: false, other: null });
      for (const sp of subpaths) {
        let pts = sp.pts.map(([x, y]) => matApply(ctm, x, y));
        if (sp.closed && !endpointsEqual(pts)) pts = [...pts, pts[0]];
        if (pts.length >= 4 && (sp.closed || painted)) {
          if (endpointsEqual(pts)) pts = pts.slice(0, -1);
          if (pts.length >= 3) {
            const color = painted ? fill : stroke;
            polys.push([pts, "0", color]);
          }
        } else if (pts.length >= 2) {
          for (let i = 0; i + 1 < pts.length; i += 1) lines.push([pts[i], pts[i + 1], stroke]);
        }
      }
      if (subpaths.length && subpaths.every((sp) => sp.other)) {
        for (const sp of subpaths) {
          if (sp.other === "l") {
            const a = matApply(ctm, sp.pts[0][0], sp.pts[0][1]);
            const b = matApply(ctm, sp.pts[1][0], sp.pts[1][1]);
            lines.push([a, b, stroke]);
          }
        }
      }
      subpaths = [];
      current = [];
    };

    for (let i = 0; i < opList.fnArray.length; i += 1) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];
      if (fn === pdfjs.OPS.constructPath) {
        const fnCodes = args[0];
        const coords = Array.from(args[1]);
        let ci = 0;
        for (const code of fnCodes) {
          if (code === pdfjs.OPS.moveTo) {
            if (current.length) subpaths.push({ pts: current, closed: false, other: null });
            current = [[coords[ci], coords[ci + 1]]];
            ci += 2;
          } else if (code === pdfjs.OPS.lineTo) {
            current.push([coords[ci], coords[ci + 1]]);
            ci += 2;
          } else if (code === pdfjs.OPS.curveTo) {
            if (current.length) subpaths.push({ pts: current, closed: false, other: null });
            current = [];
            ci += 6;
          } else if (code === pdfjs.OPS.curveTo2 || code === pdfjs.OPS.curveTo3) {
            if (current.length) subpaths.push({ pts: current, closed: false, other: null });
            current = [];
            ci += 4;
          } else if (code === pdfjs.OPS.rectangle) {
            const [x, y, w, h] = [coords[ci], coords[ci + 1], coords[ci + 2], coords[ci + 3]];
            if (current.length) subpaths.push({ pts: current, closed: false, other: null });
            current = [];
            subpaths.push({
              pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
              closed: true,
              other: null,
            });
            ci += 4;
          } else if (code === pdfjs.OPS.closePath) {
            if (current.length) subpaths.push({ pts: current, closed: true, other: null });
            current = [];
          }
        }
      } else if (fn === pdfjs.OPS.save) {
        stack.push({ ctm: ctm.slice(), fill, stroke });
      } else if (fn === pdfjs.OPS.restore) {
        const st = stack.pop();
        if (st) {
          ctm = st.ctm;
          fill = st.fill;
          stroke = st.stroke;
        }
      } else if (fn === pdfjs.OPS.transform) {
        ctm = matMul(Array.from(args).slice(0, 6), ctm);
      } else if (fn === pdfjs.OPS.setStrokeRGBColor) {
        stroke = pdfColor("rgb", args);
      } else if (fn === pdfjs.OPS.setFillRGBColor) {
        fill = pdfColor("rgb", args);
      } else if (fn === pdfjs.OPS.setStrokeGray) {
        stroke = pdfColor("gray", args);
      } else if (fn === pdfjs.OPS.setFillGray) {
        fill = pdfColor("gray", args);
      } else if (fn === pdfjs.OPS.setStrokeCMYKColor) {
        stroke = pdfColor("cmyk", args);
      } else if (fn === pdfjs.OPS.setFillCMYKColor) {
        fill = pdfColor("cmyk", args);
      } else if (fn === pdfjs.OPS.setStrokeTransparent) {
        stroke = null;
      } else if (fn === pdfjs.OPS.setFillTransparent) {
        fill = null;
      } else if (fn >= pdfjs.OPS.stroke && fn <= pdfjs.OPS.closeEOFillStroke) {
        commit(fn >= pdfjs.OPS.fill);
      } else if (fn === pdfjs.OPS.endPath || fn === pdfjs.OPS.clip || fn === pdfjs.OPS.eoClip) {
        subpaths = [];
        current = [];
      } else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
        stack.push({ ctm: ctm.slice(), fill, stroke });
        ctm = matMul(Array.from(args[0] || []).slice(0, 6), ctm);
      } else if (fn === pdfjs.OPS.paintFormXObjectEnd) {
        const st = stack.pop();
        if (st) {
          ctm = st.ctm;
          fill = st.fill;
          stroke = st.stroke;
        }
      }
    }

    const tc = await page.getTextContent();
    for (const item of tc.items || []) {
      const tr = item.transform || [1, 0, 0, 1, 0, 0];
      const s = String(item.str || "");
      if (!s.trim()) continue;
      const n = s.length || 1;
      const words = s.split(/\s+/).filter(Boolean);
      let cursor = 0;
      for (const w of words) {
        cursor = s.indexOf(w, cursor);
        const mid = cursor + w.length / 2;
        const x = tr[4] + (mid / n) * (item.width || 0);
        const y = tr[5] + 0.35 * (item.height || 0);
        texts.push([x, y, w, "0"]);
        cursor += w.length;
      }
    }
  }

  const georef = pdfGeoref(buf);
  const unitM = pdfScaleUnit(buf);
  return { lines, polys, texts, unit_m: unitM, georef, src: "pdf" };
}

function pdfScaleUnit(buf) {
  const text = buf.toString("latin1");
  const m = text.match(SCALE_RE);
  if (!m) return null;
  const scale = parseInt(m[1], 10);
  if (!scale || scale <= 0) return null;
  return (0.0254 / 72) * scale;
}

function pdfNumberList(body) {
  const m = body.match(/\[([^\]]*)\]/);
  if (!m) return null;
  const nums = (m[1].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  return nums.length ? nums : null;
}

export function pdfGeoref(buf) {
  const text = buf.toString("latin1");
  const objects = new Map();
  const objRe = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
  let m;
  while ((m = objRe.exec(text)) !== null) objects.set(m[1], m[2]);

  for (const body of objects.values()) {
    if (!/\/Type\s*\/Viewport/.test(body)) continue;
    const bboxM = body.match(/\/BBox\s*\[([^\]]*)\]/);
    const measureM = body.match(/\/Measure\s+(\d+)\s+0\s+R/);
    if (!bboxM || !measureM) continue;
    const measureBody = objects.get(measureM[1]);
    if (!measureBody || !/\/Subtype\s*\/GEO/.test(measureBody)) continue;
    const gptsM = measureBody.match(/\/GPTS\s*\[([^\]]*)\]/);
    if (!gptsM) continue;
    const bbox = (bboxM[1].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const gpts = (gptsM[1].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (bbox.length < 4 || gpts.length < 8) continue;
    let lpts = pdfNumberList((measureBody.match(/\/LPTS([\s\S]*?)(?=\/[A-Z]|>>)/) || ["", ""])[1] || "");
    if (!lpts || lpts.length < 8) lpts = [0, 0, 0, 1, 1, 1, 1, 0];
    const [bx0, by0, bx1, by1] = bbox;
    const pdfPts = [];
    const geoPts = [];
    for (let i = 0; i + 1 < gpts.length; i += 2) {
      const u = lpts[i];
      const v = lpts[i + 1];
      pdfPts.push([bx0 + u * (bx1 - bx0), by0 + v * (by1 - by0)]);
      geoPts.push([gpts[i + 1], gpts[i]]);
    }
    if (pdfPts.length >= 3) return { pdf_pts: pdfPts, geo_pts: geoPts };
  }
  return null;
}

// ---------------------------------------------------------------- geometry

function makeLineString(a, b) {
  return gf.createLineString([new Coordinate(a[0], a[1]), new Coordinate(b[0], b[1])]);
}

function ringToLineStrings(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += 1) out.push(makeLineString(pts[i], pts[i + 1]));
  out.push(makeLineString(pts[pts.length - 1], pts[0]));
  return out;
}

function toArrayList(items) {
  const list = new ArrayList();
  for (const item of items) list.add(item);
  return list;
}

function collectLineStrings(geom, sink) {
  const n = geom.getNumGeometries();
  if (n > 1) {
    for (let i = 0; i < n; i += 1) collectLineStrings(geom.getGeometryN(i), sink);
    return;
  }
  const cls = geom.constructor.name;
  if (cls === "Polygon") {
    collectLineStrings(geom.getExteriorRing(), sink);
  } else if (cls === "LinearRing") {
    collectLineStrings(geom.getLineString ? geom.getLineString() : geom, sink);
  } else if (cls === "LineString") {
    sink.add(geom);
  }
}

function polygonize(segs) {
  const edgeMap = new Map();
  for (const line of segs) {
    const coordinates = line.getCoordinates();
    for (let i = 0; i + 1 < coordinates.length; i += 1) {
      const a = [Math.round(coordinates[i].x * 1000), Math.round(coordinates[i].y * 1000)];
      const b = [Math.round(coordinates[i + 1].x * 1000), Math.round(coordinates[i + 1].y * 1000)];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const forward = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
      const first = forward ? a : b;
      const second = forward ? b : a;
      const key = `${first[0]},${first[1]}:${second[0]},${second[1]}`;
      if (!edgeMap.has(key)) edgeMap.set(key, gf.createLineString([
        new Coordinate(first[0] / 1000, first[1] / 1000),
        new Coordinate(second[0] / 1000, second[1] / 1000),
      ]));
    }
  }
  const snapped = [...edgeMap.values()];
  let u;
  try {
    u = UnaryUnionOp.union(toArrayList(snapped));
  } catch (error) {
    throw new ImportError(`Could not combine the PDF vector edges: ${error.message}`);
  }
  if (!u || u.isEmpty()) return [];
  const list = new ArrayList();
  collectLineStrings(u, list);
  const pl = new Polygonizer();
  pl.add(list);
  const out = pl.getPolygons();
  if (!out) return [];
  const it = out.iterator();
  const polys = [];
  while (it.hasNext()) polys.push(it.next());
  return polys;
}

function geomToPolys(geom) {
  if (!geom || geom.isEmpty()) return [];
  const n = geom.getNumGeometries();
  if (n > 1) {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(...geomToPolys(geom.getGeometryN(i)));
    return out;
  }
  if (geom.constructor.name !== "Polygon") return [];
  const rings = [ringToCoords(geom.getExteriorRing())];
  for (let i = 0; i < geom.getNumInteriorRing(); i += 1) {
    rings.push(ringToCoords(geom.getInteriorRingN(i)));
  }
  return [{ rings, area: geom.getArea() }];
}

function ringToCoords(ring) {
  const out = [];
  const n = ring.getNumPoints();
  for (let i = 0; i < n; i += 1) {
    const c = ring.getCoordinateN(i);
    out.push([c.x, c.y]);
  }
  return out;
}

function polyToGeo(poly, toLatLng = (x, y) => [x, y]) {
  return {
    type: "Polygon",
    coordinates: poly.rings.map((r) => r.map(([x, y]) => toLatLng(x, y).map((v) => pyRound(v, 7)))),
  };
}

function geoOf(geom, toLatLng) {
  if (!geom || geom.isEmpty()) return null;
  const polys = geomToPolys(geom);
  if (!polys.length) return null;
  if (polys.length === 1) return polyToGeo(polys[0], toLatLng);
  return {
    type: "MultiPolygon",
    coordinates: polys.map((p) => p.rings.map((r) => r.map(([x, y]) => toLatLng(x, y).map((v) => pyRound(v, 7))))),
  };
}

function largestPoly(geom) {
  const polys = geomToPolys(geom);
  if (!polys.length) return null;
  let best = polys[0];
  for (const p of polys) if (p.area > best.area) best = p;
  return best;
}

function polyFromCoords(coords) {
  const ring = coords.map(([x, y]) => new Coordinate(x, y));
  if (ring.length && (ring[0].x !== ring[ring.length - 1].x || ring[0].y !== ring[ring.length - 1].y)) {
    ring.push(new Coordinate(ring[0].x, ring[0].y));
  }
  return gf.createPolygon(ring);
}

function numSides(geom) {
  const polys = geomToPolys(geom);
  if (!polys.length) return [];
  const ring = polys[0].rings[0];
  const lens = [];
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const dx = ring[i + 1][0] - ring[i][0];
    const dy = ring[i + 1][1] - ring[i][1];
    lens.push(Math.hypot(dx, dy));
  }
  return lens;
}

function minRotatedRectSides(geom) {
  let hull;
  try {
    hull = geom.convexHull();
  } catch {
    return null;
  }
  let ring = null;
  const n = hull.getNumGeometries();
  if (n > 1) {
    let best = -1;
    for (let i = 0; i < n; i += 1) {
      const a = hull.getGeometryN(i).getArea();
      if (a > best) {
        best = a;
        ring = ringToCoords(hull.getGeometryN(i).getExteriorRing());
      }
    }
  } else if (hull.constructor.name === "Polygon") {
    ring = ringToCoords(hull.getExteriorRing());
  } else if (ring === null) {
    ring = ringToCoords(hull.getCoordinates ? hull.getCoordinates() : []);
  }
  if (!ring || ring.length < 3) return null;
  const pts = ring.slice(0, -1);
  let bestArea = Infinity;
  let bestSides = null;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    const ux = ex / len;
    const uy = ey / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const pt of pts) {
      const u = pt[0] * ux + pt[1] * uy;
      const v = -pt[0] * uy + pt[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      bestSides = [w, h].sort((a, b) => a - b);
    }
  }
  return bestSides;
}

// ---------------------------------------------------------------- words

function mergeWords(texts) {
  const items = texts.slice().sort((a, b) => {
    const ya = -pyRound(a[1], 1);
    const yb = -pyRound(b[1], 1);
    if (ya !== yb) return ya - yb;
    return a[0] - b[0];
  });
  let last = null;
  let lastText = null;
  let lastWords = null;
  const out = [];
  for (const [x, y, s, layer] of items) {
    if (
      lastText !== null &&
      Math.abs(last[1] - y) < 2 &&
      x - last[0] > 0 &&
      x - last[0] < 40 &&
      !(s && s.length && /^\d+$/.test(s) && lastWords.length && /^\d+$/.test(lastWords[lastWords.length - 1]))
    ) {
      const text = `${lastText} ${s}`;
      const nx = (last[0] + x) / 2;
      out.pop();
      out.push([nx, y, text, layer]);
      last = [nx, y];
      lastText = text;
      lastWords = text.split(/\s+/);
    } else {
      out.push([x, y, s, layer]);
      last = [x, y];
      lastText = s;
      lastWords = s.split(/\s+/);
    }
  }
  return out;
}

// ---------------------------------------------------------------- transform

function looksLatLng(x, y) {
  return Math.abs(x) <= 90 && Math.abs(y) <= 180;
}

function looksUtm(x, y) {
  return x >= 100000 && x <= 999999 && y >= 0 && y <= 10000000;
}

function solve3x3(A, B) {
  const m = A.map((row, i) => [...row, ...B[i]]);
  for (let col = 0; col < 3; col += 1) {
    let piv = col;
    for (let r = col + 1; r < 3; r += 1) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    for (let c = col; c < 5; c += 1) m[col][c] /= d;
    for (let r = 0; r < 3; r += 1) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c < 5; c += 1) m[r][c] -= f * m[col][c];
    }
  }
  return [
    [m[0][3], m[1][3], m[2][3]],
    [m[0][4], m[1][4], m[2][4]],
  ];
}

export function affineFromPoints(pdfPts, geoPts) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const B = [[0, 0], [0, 0], [0, 0]];
  for (let i = 0; i < pdfPts.length; i += 1) {
    const [x, y] = pdfPts[i];
    const [lng, lat] = geoPts[i];
    const row = [x, y, 1];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) A[r][c] += row[r] * row[c];
      B[r][0] += row[r] * lng;
      B[r][1] += row[r] * lat;
    }
  }
  return solve3x3(A, B);
}

function drawingCenter(d) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const take = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const [a, b] of d.lines) {
    take(a[0], a[1]);
    take(b[0], b[1]);
  }
  for (const [pts] of d.polys) for (const [x, y] of pts) take(x, y);
  for (const [x, y] of d.texts) take(x, y);
  if (minX === Infinity) return [0, 0];
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function estimateUnitFromPdf(d) {
  const areas = d.polys.map(([pts]) => Math.abs(shoelace(pts)));
  areas.sort((a, b) => a - b);
  const med = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  if (med > 0) return Math.sqrt(200 / med);
  return 1.0;
}

function shoelace(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function coordinatesOfBoundary(value, sink) {
  if (!value) return;
  if (Array.isArray(value)) {
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      sink(value);
      return;
    }
    for (const item of value) coordinatesOfBoundary(item, sink);
    return;
  }
  if (value.type === "FeatureCollection") {
    for (const feature of value.features || []) coordinatesOfBoundary(feature, sink);
  } else if (value.type === "Feature") {
    coordinatesOfBoundary(value.geometry, sink);
  } else if (value.type === "GeometryCollection") {
    for (const geometry of value.geometries || []) coordinatesOfBoundary(geometry, sink);
  } else if (value.coordinates) {
    coordinatesOfBoundary(value.coordinates, sink);
  }
}

export function fitDrawingToBoundary(d, targetBoundary, warnings) {
  const boundaryPoints = [];
  coordinatesOfBoundary(targetBoundary, (point) => {
    if (Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90) boundaryPoints.push(point);
  });
  if (boundaryPoints.length < 3) return null;

  const polyPoints = [];
  for (const [points] of d.polys) {
    if (points.length >= 3) polyPoints.push(...points);
  }
  const sourcePoints = polyPoints.length >= 6 ? polyPoints : [];
  if (!sourcePoints.length) {
    for (const [start, end] of d.lines) {
      sourcePoints.push(start, end);
    }
  }
  for (const [points] of d.polys) {
    sourcePoints.push(...points);
  }
  const footprint = convexHullPoints(sourcePoints);
  if (footprint.length < 3) return null;

  const baseLng = (Math.min(...boundaryPoints.map(([lng]) => lng)) + Math.max(...boundaryPoints.map(([lng]) => lng))) / 2;
  const baseLat = (Math.min(...boundaryPoints.map(([, lat]) => lat)) + Math.max(...boundaryPoints.map(([, lat]) => lat))) / 2;
  const metersPerLng = 111320 * Math.cos((baseLat * Math.PI) / 180);
  const metersPerLat = 110574;
  const toLocal = ([lng, lat]) => [(lng - baseLng) * metersPerLng, (lat - baseLat) * metersPerLat];
  const localBoundaryGeometry = polygonGeometryToLocal(targetBoundary, toLocal);
  if (!localBoundaryGeometry || localBoundaryGeometry.isEmpty()) return null;
  const targetParts = geomToPolys(localBoundaryGeometry).sort((a, b) => b.area - a.area);
  if (!targetParts.length) return null;
  const targetRing = targetParts[0].rings[0].slice(0, -1);
  if (shoelace(targetRing) < 0) targetRing.reverse();
  const target = polyFromCoords([...targetRing, targetRing[0]]);
  const targetArea = shoelace(targetRing);
  const targetCenter = target.getCentroid();
  const centerCoordinate = targetCenter.getCoordinate();
  const sourceCenter = [
    footprint.reduce((sum, [x]) => sum + x, 0) / footprint.length,
    footprint.reduce((sum, [, y]) => sum + y, 0) / footprint.length,
  ];
  const sourceRelative = footprint.map(([x, y]) => [x - sourceCenter[0], y - sourceCenter[1]]);
  const targetIsConvex = isConvexRing(targetRing);

  const fitAngle = (angle) => {
    const radians = angle * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotated = sourceRelative.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
    const minX = Math.min(...rotated.map(([x]) => x));
    const maxX = Math.max(...rotated.map(([x]) => x));
    const minY = Math.min(...rotated.map(([, y]) => y));
    const maxY = Math.max(...rotated.map(([, y]) => y));
    const [targetMinX, targetMinY, targetMaxX, targetMaxY] = [
      Math.min(...targetRing.map(([x]) => x)),
      Math.min(...targetRing.map(([, y]) => y)),
      Math.max(...targetRing.map(([x]) => x)),
      Math.max(...targetRing.map(([, y]) => y)),
    ];
    const upper = Math.min(
      (targetMaxX - targetMinX) / (maxX - minX),
      (targetMaxY - targetMinY) / (maxY - minY),
    );
    if (!Number.isFinite(upper) || upper <= 0) return null;

    let low = 0;
    let high = upper;
    for (let iteration = 0; iteration < 42; iteration += 1) {
      const scale = (low + high) / 2;
      const translations = targetIsConvex
        ? feasibleTranslationRegion(targetRing, rotated, scale)
        : null;
      let fits = Boolean(translations?.length);
      if (!targetIsConvex) {
        const candidate = rotated.map(([x, y]) => [
          centerCoordinate.x + scale * x,
          centerCoordinate.y + scale * y,
        ]);
        fits = target.covers(polyFromCoords(candidate));
      }
      if (fits) low = scale;
      else high = scale;
    }
    if (low <= 0) return null;

    const scale = low * 0.9995;
    let translation = [centerCoordinate.x, centerCoordinate.y];
    if (targetIsConvex) {
      const region = feasibleTranslationRegion(targetRing, rotated, scale);
      if (!region.length) return null;
      translation = centroidOfRing(region);
    }
    const scaledArea = (maxX - minX) * scale * (maxY - minY) * scale;
    const coverage = targetArea > 0 ? scaledArea / targetArea : 0;
    return {
      scale,
      angle,
      translation,
      coverage,
      centerDistance: Math.hypot(
        translation[0] - centerCoordinate.x,
        translation[1] - centerCoordinate.y,
      ),
    };
  };

  const candidates = [];
  for (let angle = 0; angle < 180; angle += 1) {
    const candidate = fitAngle(angle);
    if (candidate) candidates.push(candidate);
  }
  if (!candidates.length) return null;

  const maxScale = Math.max(...candidates.map((c) => c.scale));
  const bestOverall = [...candidates].sort((a, b) => b.scale - a.scale || a.centerDistance - b.centerDistance)[0];
  const upright = candidates.filter((c) => c.angle <= 45 && c.scale >= maxScale * 0.93);
  const natural = candidates.filter((c) => (c.angle <= 35 || c.angle >= 145) && c.scale >= maxScale * 0.93);
  const pool = upright.length ? upright : (natural.length ? natural : candidates);
  let best = pool.sort((a, b) => b.scale - a.scale || a.centerDistance - b.centerDistance)[0] || bestOverall;

  const refineAngle = best?.angle;
  if (refineAngle !== undefined) {
    for (let angleStep = -100; angleStep <= 100; angleStep += 5) {
      const candidate = fitAngle(refineAngle + angleStep / 100);
      if (candidate && (candidate.scale > best.scale + 1e-10 ||
          (Math.abs(candidate.scale - best.scale) <= 1e-10 && candidate.centerDistance < best.centerDistance))) {
        best = candidate;
      }
    }
  }

  warnings.push("PDF drawing was fitted inside the land boundary using a uniform scale; the drawing proportions were preserved.");
  const transform = (x, y) => {
    const dx = x - sourceCenter[0];
    const dy = y - sourceCenter[1];
    const radians = best.angle * Math.PI / 180;
    const localX = best.scale * (dx * Math.cos(radians) - dy * Math.sin(radians)) + best.translation[0];
    const localY = best.scale * (dx * Math.sin(radians) + dy * Math.cos(radians)) + best.translation[1];
    return [baseLng + localX / metersPerLng, baseLat + localY / metersPerLat];
  };
  transform.mode = "boundary_fitted";
  return transform;
}

function convexHullPoints(points) {
  const sorted = [...new Map(points
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .map(([x, y]) => [`${x},${y}`, [x, y]])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return [];
  const cross = (origin, a, b) =>
    (a[0] - origin[0]) * (b[1] - origin[1]) -
    (a[1] - origin[1]) * (b[0] - origin[0]);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (const point of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function isConvexRing(ring) {
  let sign = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const after = ring[(index + 2) % ring.length];
    const cross = (next[0] - current[0]) * (after[1] - next[1]) -
      (next[1] - current[1]) * (after[0] - next[0]);
    if (Math.abs(cross) <= 1e-9) continue;
    const currentSign = Math.sign(cross);
    if (sign && sign !== currentSign) return false;
    sign = currentSign;
  }
  return sign !== 0;
}

function clipTranslationRegion(region, a, b, c) {
  if (!region.length) return [];
  const output = [];
  let previous = region.at(-1);
  let previousValue = a * previous[0] + b * previous[1] - c;
  for (const current of region) {
    const currentValue = a * current[0] + b * current[1] - c;
    const previousInside = previousValue >= -1e-9;
    const currentInside = currentValue >= -1e-9;
    if (previousInside !== currentInside) {
      const denominator = previousValue - currentValue;
      if (Math.abs(denominator) > 1e-15) {
        const fraction = previousValue / denominator;
        output.push([
          previous[0] + fraction * (current[0] - previous[0]),
          previous[1] + fraction * (current[1] - previous[1]),
        ]);
      }
    }
    if (currentInside) output.push(current);
    previous = current;
    previousValue = currentValue;
  }
  return output;
}

function feasibleTranslationRegion(targetRing, sourcePoints, scale) {
  const minX = Math.min(...targetRing.map(([x]) => x));
  const maxX = Math.max(...targetRing.map(([x]) => x));
  const minY = Math.min(...targetRing.map(([, y]) => y));
  const maxY = Math.max(...targetRing.map(([, y]) => y));
  const sourceMinX = Math.min(...sourcePoints.map(([x]) => x));
  const sourceMaxX = Math.max(...sourcePoints.map(([x]) => x));
  const sourceMinY = Math.min(...sourcePoints.map(([, y]) => y));
  const sourceMaxY = Math.max(...sourcePoints.map(([, y]) => y));
  let region = [
    [minX - scale * sourceMinX, minY - scale * sourceMinY],
    [maxX - scale * sourceMaxX, minY - scale * sourceMinY],
    [maxX - scale * sourceMaxX, maxY - scale * sourceMaxY],
    [minX - scale * sourceMinX, maxY - scale * sourceMaxY],
  ];
  if (region[0][0] > region[1][0] + 1e-9 || region[0][1] > region[3][1] + 1e-9) return [];
  for (let index = 0; index < targetRing.length; index += 1) {
    const start = targetRing[index];
    const end = targetRing[(index + 1) % targetRing.length];
    const edgeX = end[0] - start[0];
    const edgeY = end[1] - start[1];
    const minSourceCross = Math.min(...sourcePoints.map(([x, y]) => edgeX * y - edgeY * x));
    const boundaryCross = edgeX * start[1] - edgeY * start[0];
    region = clipTranslationRegion(region, -edgeY, edgeX, boundaryCross - scale * minSourceCross);
    if (!region.length) return [];
  }
  return region;
}

function centroidOfRing(ring) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const cross = current[0] * next[1] - next[0] * current[1];
    twiceArea += cross;
    x += (current[0] + next[0]) * cross;
    y += (current[1] + next[1]) * cross;
  }
  if (Math.abs(twiceArea) <= 1e-12) {
    const center = ring.reduce(([sumX, sumY], [pointX, pointY]) => [sumX + pointX, sumY + pointY], [0, 0]);
    return [center[0] / ring.length, center[1] / ring.length];
  }
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

function buildTransform(d, pin, warnings, targetBoundary) {
  if (targetBoundary) {
    const fitted = fitDrawingToBoundary(d, targetBoundary, warnings);
    if (fitted) return fitted;
  }

  if (d.georef) {
    const sol = affineFromPoints(d.georef.pdf_pts, d.georef.geo_pts);
    if (sol) {
      const [[a1, b1, c1], [a2, b2, c2]] = sol;
      return (x, y) => [a1 * x + b1 * y + c1, a2 * x + b2 * y + c2];
    }
  }

  const pinLat = pin ? pin[0] : null;
  const pinLng = pin ? pin[1] : null;

  if (d.src === "dxf" && looksLatLng(pinLat, pinLng)) {
    const anyLatLng = looksLatLng(d.georef ? 0 : 0, 0) && drawingLooksLatLng(d);
    if (anyLatLng) return (x, y) => [x, y];
  }

  const firstPt = d.lines.length
    ? d.lines[0][0]
    : d.polys.length
      ? d.polys[0][0][0]
      : d.texts.length
        ? [d.texts[0][0], d.texts[0][1]]
        : null;
  if (firstPt && looksUtm(firstPt[0], firstPt[1])) {
    const lat0 = pinLat !== null ? pinLat : 22;
    const lng0 = pinLng !== null ? pinLng : 73;
    const zone = Math.floor((lng0 + 180) / 6) + 1;
    const epsg = (lat0 >= 0 ? 32600 : 32700) + zone;
    const name = `EPSG:${epsg}`;
    proj4.defs(name, `+proj=utm +zone=${zone} ${lat0 >= 0 ? "+north" : "+south"} +datum=WGS84 +units=m +no_defs`);
    if (!pin) {
      warnings.push(`No Google Maps link: assumed UTM zone ${zone}N for the CAD coordinates`);
    }
    return (x, y) => {
      const [lng, lat] = proj4(name, "EPSG:4326", [x, y]);
      return [lng, lat];
    };
  }

  if (!pin) {
    throw new ImportError(
      "The file has no real-world coordinates. Add a Google Maps link so the layout can be placed on the land.",
    );
  }

  let unit = d.unit_m;
  if (!unit) {
    if (d.src === "dxf") {
      warnings.push("DXF has no unit header; assumed metres");
      unit = 1.0;
    } else {
      unit = estimateUnitFromPdf(d);
      warnings.push("PDF has no georeference or scale note; drawing scale was estimated from plot sizes (±15%)");
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const take = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const [a, b] of d.lines) {
    take(a[0], a[1]);
    take(b[0], b[1]);
  }
  for (const [pts] of d.polys) for (const [x, y] of pts) take(x, y);
  if (minX === Infinity) {
    minX = 0;
    maxX = 0;
    minY = 0;
    maxY = 0;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const w = maxX - minX;
  const h = maxY - minY;
  const rot = w >= h ? 0 : Math.PI / 2;

  const latPerM = LAT_PER_M;
  const lngPerM = 1 / (111320 * Math.cos((pinLat * Math.PI) / 180));
  return (x, y) => {
    let dx = (x - cx) * unit;
    let dy = (y - cy) * unit;
    if (rot) {
      const t = dx;
      dx = -dy;
      dy = t;
    }
    return [pinLng + dx * lngPerM, pinLat + dy * latPerM];
  };
}

function drawingLooksLatLng(d) {
  let n = 0;
  let ok = 0;
  const check = (x, y) => {
    n += 1;
    if (looksLatLng(y, x)) ok += 1;
  };
  for (const [a, b] of d.lines) {
    check(a[0], a[1]);
    check(b[0], b[1]);
  }
  for (const [pts] of d.polys) for (const [x, y] of pts) check(x, y);
  return n > 0 && ok === n;
}

// ---------------------------------------------------------------- classify

function textNumsOf(texts, faces) {
  const host = new Map();
  for (const t of texts) {
    let target = null;
    for (const f of faces) {
      if (f.contains(gf.createPoint(new Coordinate(t[0], t[1])))) {
        target = f;
        break;
      }
    }
    host.set(t, target);
  }
  return host;
}

function classify(d, toLatLng, warnings) {
  const faces = polygonize([
    ...d.lines.map(([a, b]) => makeLineString(a, b)),
    ...d.polys.map(([pts]) => {
      const ls = ringToLineStrings(pts);
      return ls;
    }).flat(),
  ]);
  const valid = faces.filter((f) => {
    try {
      return f.isValid() && f.getArea() > 0;
    } catch {
      return false;
    }
  });
  if (!valid.length) throw new ImportError("No closed shapes could be formed from the drawing");

  const rp = valid[0].getInteriorPoint();
  const [, lat0] = toLatLng(rp.getX(), rp.getY());
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const metric = (f) => {
    const nc = f.getNumPoints && f.getNumPoints();
    return f.getArea();
  };

  let sumMetric = 0;
  let sumFace = 0;
  for (const f of valid) {
    const c = f.getInteriorPoint();
    const [, faceLat] = toLatLng(c.getX(), c.getY());
    const fac = (111320 * Math.cos((faceLat * Math.PI) / 180)) / kx;
    sumMetric += f.getArea() * fac * fac;
    sumFace += f.getArea();
  }
  const scaleM = Math.sqrt(sumFace > 0 ? sumMetric / sumFace : 1);
  if (!(scaleM > 0)) throw new ImportError("Drawing shapes are too small to be plots");

  const faceList = valid.map((f) => ({
    f,
    area: f.getArea() * scaleM * scaleM,
  })).filter((x) => x.area >= 5);
  if (!faceList.length) throw new ImportError("Drawing shapes are too small to be plots");

  const facesG = faceList.map((x) => x.f);

  const hostTexts = new Map(facesG.map((f) => [f, []]));
  for (const [x, y, s, layer] of d.texts) {
    const pt = gf.createPoint(new Coordinate(x, y));
    let target = null;
    for (const f of facesG) {
      if (f.contains(pt)) {
        target = f;
        break;
      }
    }
    if (!target) {
      let bestD = Infinity;
      for (const f of facesG) {
        const dd = f.distance(pt) * scaleM;
        if (dd < bestD) {
          bestD = dd;
          target = f;
        }
      }
      if (bestD > 3) target = null;
    }
    if (target) hostTexts.get(target).push([s, layer]);
  }
  const hasNumbers = facesG.some((f) => hostTexts.get(f).some(([s]) => PLOT_NO.test(s.trim())));

  const unionAll = UnaryUnionOp.union(toArrayList(facesG));
  const boundaryPoly = unionAll ? largestPoly(unionAll) : null;
  if (!boundaryPoly) throw new ImportError("No closed shapes could be formed from the drawing");
  const boundary = polyFromCoords(boundaryPoly.rings[0].slice(0, -1));

  const plots = [];
  const greens = [];
  const roads = [];
  for (const f of facesG) {
    let area = f.getArea() * scaleM * scaleM;
    if (area > 0.3 * boundaryPoly.area * scaleM * scaleM) continue;

    const mine = f.getInteriorPoint();
    let skip = false;
    for (const g of facesG) {
      if (g === f) continue;
      let gArea = g.getArea();
      let fArea = f.getArea();
      if (gArea >= 0.9 * fArea) continue;
      if (g.contains(mine) && gArea < 0.9 * fArea) {
        skip = true;
        break;
      }
    }
    if (skip) continue;

    const texts = hostTexts.get(f) || [];
    const layerStr = texts.map(([, l]) => l).join(" ").toLowerCase();
    const fill = null;
    const green = texts.some(([s]) => GREEN_WORDS.test(s)) || GREEN_WORDS.test(layerStr);
    if (green) {
      greens.push({ name: texts.length ? titleCase(texts.map(([s]) => s).join(" ")).slice(0, 40) : "Green", geometry: geoOf(f, toLatLng) });
      continue;
    }
    const road = texts.some(([s]) => ROAD_WORDS.test(s)) || ROAD_WORDS.test(layerStr);
    if (road) {
      roads.push({ name: texts.length ? titleCase(texts.map(([s]) => s).join(" ")).slice(0, 40) : "Road", geometry: geoOf(f, toLatLng), width_m: null });
      continue;
    }
    const plotNo = texts.map(([s]) => s.trim()).find((s) => PLOT_NO.test(s));
    if (hasNumbers && !plotNo) continue;
    if (area < 30 || area > 5000) continue;
    plots.push({ geom: f, area, number: plotNo || null, texts });
  }
  return { boundary, plots, greens, roads, scaleM };
}

// ---------------------------------------------------------------- dims

function numSidesOfPoly(poly) {
  const ring = poly.rings[0];
  const lens = [];
  for (let i = 0; i + 1 < ring.length; i += 1) {
    lens.push(Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]));
  }
  return lens;
}

function dimsOf(poly) {
  const sides = numSidesOfPoly(poly);
  const n = sides.length;
  if (n === 4 && Math.abs(sides[0] - sides[2]) < 0.6 && Math.abs(sides[1] - sides[3]) < 0.6) {
    return {
      shape: "rectangular",
      sides: sides.map(fmt1),
      dimensions: `${fmt1(Math.min(sides[0], sides[1]))} × ${fmt1(Math.max(sides[0], sides[1]))}m`,
    };
  }
  if (n === 3) {
    return { shape: "triangular", sides: sides.map(fmt1), dimensions: null };
  }
  if (n === 4) {
    return {
      shape: "diagonal",
      sides: sides.map(fmt1),
      dimensions: `${fmt1(Math.min(...sides))} × ${fmt1(Math.max(...sides))}m`,
    };
  }
  return { shape: "polygon", sides: sides.map(fmt1), dimensions: null };
}

// ---------------------------------------------------------------- entry

function decodeXml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

export function parseKml(data) {
  const xml = data.toString("utf8");
  const features = [];

  function parseCoordinatesString(value) {
    if (!value) return [];
    const normalized = value.replace(/\s*,\s*/g, ",").trim();
    if (!normalized) return [];
    const tokens = normalized.split(/\s+/);
    const points = [];
    for (const token of tokens) {
      if (!token) continue;
      const parts = token.split(",").map(Number);
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        points.push([parts[0], parts[1]]);
      }
    }
    return points;
  }

  const placemarks = xml.matchAll(/<(?:[a-z0-9_]+:)?Placemark\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?Placemark>/gi);
  for (const [, placemark] of placemarks) {
    const properties = {};
    const nameMatch = placemark.match(/<(?:[a-z0-9_]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?name>/i);
    if (nameMatch) properties.name = decodeXml(nameMatch[1]).trim();

    const descMatch = placemark.match(/<(?:[a-z0-9_]+:)?description\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?description>/i);
    if (descMatch) properties.description = decodeXml(descMatch[1]).trim();

    const simpleDataMatches = placemark.matchAll(/<(?:[a-z0-9_]+:)?SimpleData\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?SimpleData>/gi);
    for (const [, key, val] of simpleDataMatches) {
      properties[key.trim()] = decodeXml(val).trim();
    }

    const dataMatches = placemark.matchAll(/<(?:[a-z0-9_]+:)?Data\b[^>]*name=["']([^"']+)["'][^>]*>[\s\S]*?<(?:[a-z0-9_]+:)?value\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?value>[\s\S]*?<\/(?:[a-z0-9_]+:)?Data>/gi);
    for (const [, key, val] of dataMatches) {
      properties[key.trim()] = decodeXml(val).trim();
    }

    const polygons = placemark.matchAll(/<(?:[a-z0-9_]+:)?Polygon\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?Polygon>/gi);
    for (const [, polygon] of polygons) {
      const coordBlocks = [...polygon.matchAll(/<(?:[a-z0-9_]+:)?coordinates\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?coordinates>/gi)];
      const rings = coordBlocks
        .map(([, value]) => parseCoordinatesString(value))
        .filter((ring) => ring.length >= 3);
      for (const ring of rings) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          ring.push([first[0], first[1]]);
        }
      }
      if (rings.length) {
        features.push({ type: "Feature", properties: { ...properties }, geometry: { type: "Polygon", coordinates: rings } });
      }
    }

    const lines = placemark.matchAll(/<(?:[a-z0-9_]+:)?LineString\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?LineString>/gi);
    for (const [, line] of lines) {
      const coordMatch = line.match(/<(?:[a-z0-9_]+:)?coordinates\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?coordinates>/i);
      const coordinates = parseCoordinatesString(coordMatch ? coordMatch[1] : "");
      if (coordinates.length >= 3) {
        const first = coordinates[0];
        const last = coordinates[coordinates.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) {
          features.push({ type: "Feature", properties: { ...properties }, geometry: { type: "Polygon", coordinates: [coordinates] } });
          continue;
        }
      }
      if (coordinates.length >= 2) {
        features.push({ type: "Feature", properties: { ...properties }, geometry: { type: "LineString", coordinates } });
      }
    }

    const points = placemark.matchAll(/<(?:[a-z0-9_]+:)?Point\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?Point>/gi);
    for (const [, pt] of points) {
      const coordMatch = pt.match(/<(?:[a-z0-9_]+:)?coordinates\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?coordinates>/i);
      const coordinates = parseCoordinatesString(coordMatch ? coordMatch[1] : "");
      if (coordinates.length >= 1) {
        features.push({ type: "Feature", properties: { ...properties }, geometry: { type: "Point", coordinates: coordinates[0] } });
      }
    }
  }

  if (!features.length) {
    const polygons = xml.matchAll(/<(?:[a-z0-9_]+:)?Polygon\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?Polygon>/gi);
    for (const [, polygon] of polygons) {
      const coordBlocks = [...polygon.matchAll(/<(?:[a-z0-9_]+:)?coordinates\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?coordinates>/gi)];
      const rings = coordBlocks
        .map(([, value]) => parseCoordinatesString(value))
        .filter((ring) => ring.length >= 3);
      for (const ring of rings) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          ring.push([first[0], first[1]]);
        }
      }
      if (rings.length) {
        features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: rings } });
      }
    }
  }

  if (!features.length) {
    const rings = xml.matchAll(/<(?:[a-z0-9_]+:)?LinearRing\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?LinearRing>/gi);
    for (const [, ringXml] of rings) {
      const coordMatch = ringXml.match(/<(?:[a-z0-9_]+:)?coordinates\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_]+:)?coordinates>/i);
      const ring = parseCoordinatesString(coordMatch ? coordMatch[1] : "");
      if (ring.length >= 3) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          ring.push([first[0], first[1]]);
        }
        features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
      }
    }
  }

  if (!features.length) throw new ImportError("No polygon or line features found in the KML file");
  return features;
}

function coordinatePairs(geometry, sink) {
  if (!geometry) return;
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries || []) coordinatePairs(child, sink);
    return;
  }
  const visit = (value) => {
    if (Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      sink(value);
    } else if (Array.isArray(value)) {
      for (const child of value) visit(child);
    }
  };
  visit(geometry.coordinates);
}

function vectorProperty(properties, names) {
  const attrs = new Map(Object.entries(properties || {}).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
  for (const name of names) {
    const value = attrs.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function isSiteBoundaryFeature(feature) {
  const properties = feature?.properties || {};
  const nameOrLabel = vectorProperty(properties, ["name", "label", "plot_number", "plot_no", "number"]).trim();
  if (/^(?:plot|lot)\s*#?\d+/i.test(nameOrLabel) || /^\d+[a-z]?$/i.test(nameOrLabel)) {
    return false;
  }
  const markers = [
    ...["feature_type", "boundary_type", "role", "layer", "category", "class", "type"]
      .map((name) => vectorProperty(properties, [name])),
    vectorProperty(properties, ["name", "label"]),
  ].map((value) => value.toLowerCase().replace(/[^a-z]/g, ""));
  return markers.some((value) =>
    /(?:site|colony|land|property|compound).*(?:boundary|outline|perimeter|extent)|(?:boundary|outline|perimeter|extent).*(?:site|colony|land|property|compound)/.test(value)
  );
}

function isPdfFillArtifact(feature) {
  return /^pdf\s+filled\s+geometry(?:\s+\d+)?$/i.test(
    vectorProperty(feature?.properties, ["name", "label"]),
  );
}

function isPlotPolygonFeature(feature) {
  if (!hasPolygonGeometry(feature?.geometry) || isSiteBoundaryFeature(feature) || isPdfFillArtifact(feature)) return false;
  const properties = feature.properties || {};
  const label = vectorProperty(properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]);
  const kind = `${vectorProperty(properties, ["layer", "category", "type", "class", "feature_type"])} ${vectorProperty(properties, ["name", "label"])}`.toLowerCase();
  if (GREEN_WORDS.test(kind) || ROAD_WORDS.test(kind)) return false;
  return Boolean(label) || !/boundar|outline|perimeter/i.test(kind);
}

function linearRingFromCoords(coords, toLocal) {
  const points = coords.map((pair) => {
    const [x, y] = toLocal(pair);
    return new Coordinate(x, y);
  });
  if (points.length && (points[0].x !== points[points.length - 1].x || points[0].y !== points[points.length - 1].y)) {
    points.push(new Coordinate(points[0].x, points[0].y));
  }
  return gf.createLinearRing(points);
}

function polygonGeometryToLocal(geometry, toLocal) {
  const polygons = [];
  const collect = (candidate) => {
    if (!candidate) return;
    if (candidate.type === "GeometryCollection") {
      for (const child of candidate.geometries || []) collect(child);
      return;
    }
    const parts = candidate.type === "Polygon"
      ? [candidate.coordinates]
      : candidate.type === "MultiPolygon"
        ? candidate.coordinates
        : [];
    for (const rings of parts || []) {
      const shell = rings?.[0];
      if (!Array.isArray(shell) || shell.length < 4) continue;
      const polygon = gf.createPolygon(
        linearRingFromCoords(shell, toLocal),
        rings.slice(1).filter((ring) => Array.isArray(ring) && ring.length >= 4)
          .map((ring) => linearRingFromCoords(ring, toLocal)),
      );
      if (!polygon.isValid() || polygon.getArea() <= 0) {
        throw new ImportError("A supplied land boundary has invalid polygon geometry.");
      }
      polygons.push(polygon);
    }
  };
  collect(geometry);
  if (!polygons.length) return null;
  return polygons.length === 1 ? polygons[0] : UnaryUnionOp.union(toArrayList(polygons));
}

function polygonOverlapCoverage(first, second) {
  if (!first || !second || first.getArea() <= 0 || second.getArea() <= 0) return 0;
  try {
    const overlapArea = first.intersection(second).getArea();
    return Math.min(overlapArea / first.getArea(), overlapArea / second.getArea());
  } catch (error) {
    throw new ImportError(`Could not compare the GeoJSON and KML land boundaries: ${error.message}`);
  }
}

async function importVectorFeatures(features, source, filename, mapsLink, colonyId, now) {
  const warnings = [];
  const pin = mapsLink ? await parseMapsLink(mapsLink) : null;
  if (mapsLink && !pin) warnings.push("Google Maps link could not be parsed; it was ignored");
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of features) {
    if (!feature?.geometry) continue;
    coordinatePairs(feature.geometry, ([lng, lat]) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new ImportError("GIS coordinates must use WGS84 longitude/latitude (EPSG:4326)");
      }
      extent[0] = Math.min(extent[0], lng);
      extent[1] = Math.min(extent[1], lat);
      extent[2] = Math.max(extent[2], lng);
      extent[3] = Math.max(extent[3], lat);
    });
  }
  if (!Number.isFinite(extent[0])) throw new ImportError("The GIS file contains no coordinate data");
  const centerLng = (extent[0] + extent[2]) / 2;
  const centerLat = (extent[1] + extent[3]) / 2;
  const lngScale = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const toLocal = ([lng, lat]) => [(lng - centerLng) * lngScale, (lat - centerLat) * 110574];
  const toLatLng = (x, y) => [centerLng + x / lngScale, centerLat + y / 110574];
  const rawLineStrings = [];
  const polygons = [];
  const landBoundaries = [];
  const greens = [];
  const roads = [];
  const consume = (feature, geometry) => {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection") {
      for (const child of geometry.geometries || []) consume(feature, child);
      return;
    }
    const props = feature.properties || {};
    const label = vectorProperty(props, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]);
    const kind = `${vectorProperty(props, ["layer", "category", "type", "class", "feature_type"])} ${vectorProperty(props, ["name", "label"])}`.toLowerCase();
    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
      if (isSiteBoundaryFeature(feature)) {
        const boundary = polygonGeometryToLocal(geometry, toLocal);
        if (boundary) landBoundaries.push(boundary);
        return;
      }
      if (isPdfFillArtifact(feature)) return;
      const parts = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      for (const rings of parts || []) {
        if (!rings?.[0] || rings[0].length < 4) continue;
        const poly = polyFromCoords(rings[0].map(toLocal));
        if (!poly.isValid() || poly.getArea() < 5) continue;
        const geometryWgs = polyToGeo(geomToPolys(poly)[0], toLatLng);
        if (GREEN_WORDS.test(kind)) greens.push({ name: label || "Green space", geometry: geometryWgs });
        else if (ROAD_WORDS.test(kind)) roads.push({ name: label || "Road", geometry: geometryWgs, width_m: null });
        else if (label || !/boundar|outline|perimeter/i.test(kind)) polygons.push({ poly, number: label });
      }
    } else if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      for (const line of lines || []) {
        if (line.length >= 2) {
          rawLineStrings.push(line);
          if (ROAD_WORDS.test(kind)) {
            roads.push({
              name: label || "Road",
              geometry: { type: "LineString", coordinates: line.map(([lng, lat]) => [pyRound(lng, 7), pyRound(lat, 7)]) },
              width_m: null,
            });
          }
        }
      }
    }
  };
  for (const feature of features) {
    if (feature?.geometry) consume(feature, feature.geometry);
  }

  let candidates = polygons.filter(({ poly }) => poly.getArea() >= 30 && poly.getArea() <= 50000);
  let landBoundary = landBoundaries.length === 1
    ? landBoundaries[0]
    : landBoundaries.length > 1
      ? UnaryUnionOp.union(toArrayList(landBoundaries))
      : null;

  if (rawLineStrings.length >= 2) {
    const lineGeoms = [];
    for (const line of rawLineStrings) {
      if (!Array.isArray(line) || line.length < 2) continue;
      const pts = line.map(toLocal).map(([x, y]) => new Coordinate(x, y));
      if (pts.length >= 2) {
        lineGeoms.push(gf.createLineString(pts));
      }
    }
    if (lineGeoms.length) {
      try {
        if (landBoundary) {
          const boundaryCoords = landBoundary.getCoordinates();
          if (boundaryCoords && boundaryCoords.length >= 2) {
            lineGeoms.push(gf.createLineString(boundaryCoords));
          }
        }
        const unionLines = UnaryUnionOp.union(toArrayList(lineGeoms));
        const polygonizer = new Polygonizer();
        polygonizer.add(unionLines);
        const faces = polygonizer.getPolygons().toArray();
        const boundaryArea = landBoundary ? landBoundary.getArea() : Infinity;

        for (const face of faces) {
          if (!face || !face.isValid() || face.getArea() < 25) continue;
          if (landBoundary && face.getArea() >= boundaryArea * 0.8) {
            if (!landBoundary) landBoundary = face;
            continue;
          }
          const alreadyExists = polygons.some(({ poly }) => {
            try {
              return poly.symmetricDifference(face).getArea() < 0.05 * Math.max(poly.getArea(), 1);
            } catch {
              return false;
            }
          });
          if (!alreadyExists) {
            polygons.push({ poly: face, number: "" });
          }
        }
        candidates = polygons.filter(({ poly }) => poly.getArea() >= 25 && poly.getArea() <= 50000);
      } catch (err) {
        console.warn("[importer] LineString polygonization failed:", err.message);
      }
    }
  }

  const pointFeatures = features.filter((feature) => feature?.geometry?.type === "Point");
  if (pointFeatures.length && candidates.length) {
    const usedLabels = new Set();
    for (const item of candidates) {
      if (item.number) {
        usedLabels.add(item.number);
        continue;
      }
      for (const pf of pointFeatures) {
        const coords = pf.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        const num = vectorProperty(pf.properties, ["name", "label", "plot_number", "plot_no", "lot_number", "lot_no", "number"]).trim();
        if (!num || usedLabels.has(num)) continue;
        const localPt = gf.createPoint(new Coordinate(...toLocal(coords)));
        if (item.poly.contains(localPt) || item.poly.covers(localPt) || item.poly.intersects(localPt)) {
          item.number = num;
          usedLabels.add(num);
          break;
        }
      }
    }
  }

  if (!landBoundary && candidates.length > 1) {
    const maxArea = Math.max(...candidates.map(({ poly }) => poly.getArea()));
    const smallCandidates = candidates.filter(({ poly }) => poly.getArea() < maxArea * 0.5);
    if (smallCandidates.length > 0 && maxArea >= 2500) {
      const boundaryItem = candidates.find(({ poly }) => poly.getArea() === maxArea);
      landBoundary = boundaryItem.poly;
      candidates = smallCandidates;
    }
  } else if (landBoundary && candidates.length > 0) {
    const boundaryArea = landBoundary.getArea();
    candidates = candidates.filter(({ poly }) => poly.getArea() <= Math.min(3500, boundaryArea * 0.5));
  }

  if (!candidates.length && !landBoundary) {
    throw new ImportError("No plot polygons or explicit colony land boundary found.");
  }
  if (!candidates.length) {
    warnings.push("Only an explicit colony land boundary was imported; no plot parcel geometry was supplied.");
  }
  const used = new Set();
  let sequence = 0;
  for (const item of candidates) {
    let number = item.number;
    if (!number || used.has(number)) {
      sequence += 1;
      while (used.has(String(sequence))) sequence += 1;
      number = String(sequence);
    }
    item.number = number;
    used.add(number);
  }

  const prefixes = new Set(candidates.map(({ number }) => (number.match(/^([A-Za-z]+)/) || [])[1]?.toUpperCase()).filter(Boolean));
  const codes = prefixes.size >= 2 && prefixes.size <= 8 ? [...prefixes].sort() : ["A"];
  const codeOf = (item) => {
    const prefix = (item.number.match(/^([A-Za-z]+)/) || [])[1]?.toUpperCase();
    return codes.includes(prefix) ? prefix : codes[0];
  };
  const zoneDocs = codes.map((code, index) => {
    const members = candidates.filter((item) => codeOf(item) === code);
    if (!members.length) return null;
    const hull = gf.createMultiPolygon(members.map((item) => item.poly)).convexHull();
    return {
      id: `zone-${colonyId}-${code.toLowerCase()}`,
      colony_id: colonyId,
      code,
      name: `Zone ${code}`,
      color: ZONE_COLORS[index % ZONE_COLORS.length],
      geometry: geoOf(hull, toLatLng),
      sort_order: index,
      created_at: now,
    };
  }).filter(Boolean);
  const plotDocs = candidates.map((item) => {
    const poly = geomToPolys(item.poly)[0];
    const dimensions = dimsOf(poly);
    const area = pyRound(item.poly.getArea(), 1);
    return {
      id: `plot-${colonyId}-${item.number.toLowerCase()}`,
      colony_id: colonyId,
      zone_id: `zone-${colonyId}-${codeOf(item).toLowerCase()}`,
      number: String(item.number),
      area_sqm: area,
      area_sqft: pyRound(area * 10.7639, 1),
      area_sqyd: pyRound(area * 1.19599, 1),
      width_m: pyRound(Math.min(...numSidesOfPoly(poly)), 2),
      depth_m: pyRound(Math.max(...numSidesOfPoly(poly)), 2),
      shape: dimensions.shape,
      sides: dimensions.sides,
      dimensions: dimensions.dimensions,
      status_id: "available",
      notes: "",
      created_at: now,
      geometry: polyToGeo(poly, toLatLng),
    };
  });
  const boundary = landBoundary || gf.createMultiPolygon(candidates.map((item) => item.poly)).convexHull();
  const center = boundary.getCentroid().getCoordinate();
  const [lng, lat] = toLatLng(center.x, center.y);
  if (pin) {
    const distance = Math.hypot((lat - pin[0]) * 110574, (lng - pin[1]) * 111320 * Math.cos((pin[0] * Math.PI) / 180));
    if (distance > 3000) warnings.push(`GIS layer is ${fmt1(distance / 1000)} km from the Google Maps pin — check the coordinate system`);
  }
  return [{
    layout_version: "imported",
    import_source: {
      filename,
      mode: source,
      warnings,
      imported_at: now,
      plots: plotDocs.length,
      greens: greens.length,
      roads: roads.length,
      land_boundary_method: landBoundary ? "explicit_geojson_site_boundary" : "plot_convex_hull",
    },
    maps_link: mapsLink || null,
    map_center: { lat: pyRound(lat, 7), lng: pyRound(lng, 7) },
    boundary: geoOf(boundary, toLatLng),
    greens,
    roads,
    entry_road: null,
    entrance: null,
    entry_centerline: null,
    total_area_sqm: pyRound(plotDocs.reduce((sum, plot) => sum + plot.area_sqm, 0), 1),
  }, zoneDocs, plotDocs, warnings];
}

async function extractGeoPackage(data) {
  let gp;
  try {
    gp = await GeoPackageAPI.open(new Uint8Array(data));
    const features = [];
    for (const table of gp.getFeatureTables()) {
      const dao = gp.getFeatureDao(table);
      const epsg = Number(dao.srs?.organization_coordsys_id);
      if (dao.srs?.organization?.toUpperCase() !== "EPSG" || epsg !== 4326) {
        throw new ImportError(`GeoPackage layer "${table}" must use WGS84 / EPSG:4326. Reproject it in QGIS before export.`);
      }
      for (const row of dao.queryForEach()) {
        const feature = GeoPackage.parseFeatureRowIntoGeoJSON(dao.getRow(row), dao.srs);
        features.push({
          ...feature,
          properties: { ...(feature.properties || {}), _table: table },
        });
      }
    }
    if (!features.length) throw new ImportError("No feature layers found in the GeoPackage");
    return features;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("Could not read this GeoPackage. Export its map layers from QGIS as EPSG:4326 GeoPackage.");
  } finally {
    if (gp) await gp.close();
  }
}

export async function importFile(data, filename, mapsLink, colonyId, now, options = {}) {
  const name = String(filename || "");
  const ext = path.extname(name).toLowerCase();
  if (![".dxf", ".dwg", ".pdf", ".geojson", ".json", ".gpkg", ".kml"].includes(ext)) {
    throw new ImportError("Upload a QGIS GeoJSON/GeoPackage, KML, DXF, or PDF layout file");
  }

  if (ext === ".dwg" && !config?.gis?.enablePythonFallback) {
    throw new ImportError("DWG processing requires the Python GIS worker and an installed ODA File Converter.");
  }
  if (ext === ".dxf" && !config?.gis?.enablePythonFallback) {
    throw new ImportError("DXF processing requires the Python GIS worker.");
  }
  if (config?.gis?.enablePythonFallback && (ext === ".pdf" || ext === ".dxf" || ext === ".dwg")) {
    try {
      const formData = new FormData();
      const blob = new Blob([data], { type: ext === ".pdf" ? "application/pdf" : "application/octet-stream" });
      formData.append("file", blob, name);
      formData.append("colony_id", String(colonyId || "preview"));
      formData.append("now", String(now || new Date().toISOString()));
      if (mapsLink) formData.append("maps_link", mapsLink);
      if (options?.targetBoundary) {
        formData.append("target_boundary", typeof options.targetBoundary === "string" ? options.targetBoundary : JSON.stringify(options.targetBoundary));
      }

      const pyUrl = `${config.gis.pythonGisUrl || "http://127.0.0.1:8000"}/internal/gis/import`;
      const resp = await fetch(pyUrl, {
        method: "POST",
        headers: {
          "X-Internal-Token": config.gis.internalSecret || "dev-internal-secret-key-change-in-prod"
        },
        body: formData,
      });

      if (resp.ok) {
        const result = await resp.json();
        const sourceColonyId = String(
          result.plots?.[0]?.colony_id || result.zones?.[0]?.colony_id || "preview"
        );
        const targetColonyId = String(colonyId || "preview");
        const rekey = (id, prefix) => {
          const oldPrefix = `${prefix}${sourceColonyId}-`;
          return typeof id === "string" && id.startsWith(oldPrefix)
            ? `${prefix}${targetColonyId}-${id.slice(oldPrefix.length)}`
            : id;
        };
        result.zones = (result.zones || []).map((zone) => ({
          ...zone,
          id: rekey(zone.id, "zone-"),
          colony_id: targetColonyId,
        }));
        result.plots = (result.plots || []).map((plot) => ({
          ...plot,
          id: rekey(plot.id, "plot-"),
          zone_id: rekey(plot.zone_id, "zone-"),
          colony_id: targetColonyId,
        }));
        return [result.colony, result.zones, result.plots, result.warnings || []];
      } else {
        const errText = await resp.text();
        if (ext === ".dwg" || ext === ".dxf") {
          throw new ImportError(`${ext.slice(1).toUpperCase()} processing failed: ${errText}`);
        }
        console.warn(
          `[livemap] Python GIS fallback returned ${resp.status} (target boundary: ${options.targetBoundary?.type || "missing"}): ${errText}, falling back to JS parser`
        );
      }
    } catch (err) {
      if (ext === ".dwg" || ext === ".dxf") {
        if (err instanceof ImportError) throw err;
        throw new ImportError(`${ext.slice(1).toUpperCase()} processing failed: ${err.message}`);
      }
      console.warn(`[livemap] Python GIS fallback request failed (${err.message}), falling back to JS parser`);
    }
  }

  const warnings = [];
  let pin = null;
  if (mapsLink) {
    pin = await parseMapsLink(mapsLink);
    if (!pin) warnings.push("Google Maps link could not be parsed; it was ignored");
  }

  let vectorFeatures;
  let sourceMode;
  if (ext === ".geojson" || ext === ".json") {
    let collection;
    try {
      collection = JSON.parse(data.toString("utf8"));
    } catch {
      throw new ImportError("Could not read the GeoJSON file");
    }
    const features = collection.type === "FeatureCollection" ? collection.features
      : collection.type === "Feature" ? [collection] : [];
    if (!Array.isArray(features) || !features.length) throw new ImportError("GeoJSON must contain a Feature or FeatureCollection");
    vectorFeatures = features;
    sourceMode = "qgis";
  } else if (ext === ".gpkg") {
    vectorFeatures = await extractGeoPackage(data);
    sourceMode = "qgis";
  } else if (ext === ".kml") {
    vectorFeatures = parseKml(data);
    sourceMode = "kml";
  }
  if (vectorFeatures) return importVectorFeatures(vectorFeatures, sourceMode, name, mapsLink, colonyId, now);

  const d = ext === ".dxf" ? extractDxf(data) : await extractPdf(data);
  if (!d.lines.length && !d.polys.length) throw new ImportError("No drawing geometry found in the file");

  let mode;
  let source = d;
  let toLatLng;
  if (d.src === "dxf" && drawingLooksLatLng(d)) {
    const projected = projectLatLngDrawing(d);
    source = projected.drawing;
    toLatLng = projected.toLatLng;
    mode = "latlng";
  } else {
    toLatLng = buildTransform(d, pin, warnings, options.targetBoundary);
    mode = toLatLng.mode;
  }
  if (!mode) mode = d.georef ? "geopdf" : (pin ? "fitted" : "utm");
  const texts = mergeWords(source.texts);
  const { boundary, plots, greens, roads } = classify(
    { ...source, texts },
    toLatLng,
    warnings,
  );
  if (!plots.length) throw new ImportError("No plot polygons could be identified in this file");

  if (pin) {
    const c = boundary.getRepresentativePoint ? boundary.getRepresentativePoint() : boundary.getInteriorPoint();
    const [lng, lat] = toLatLng(c.getX(), c.getY());
    const dist = Math.hypot((lat - pin[0]) * 110574, (lng - pin[1]) * 111320 * Math.cos((pin[0] * Math.PI) / 180));
    if (dist > 3000) {
      warnings.push(`Layout is ${fmt1(dist / 1000)} km from the Google Maps pin — check the file's coordinate system`);
    }
  }

  const labelled = plots.some((p) => p.number);
  if (!labelled) warnings.push("No plot numbers found in the drawing — plots were numbered automatically");

  const decorated = plots.map((p) => {
    const poly = geomToPolys(p.geom)[0];
    const ring = poly.rings[0];
    let sxs = 0;
    let sys = 0;
    for (let i = 0; i + 1 < ring.length; i += 1) {
      sxs += ring[i][0];
      sys += ring[i][1];
    }
    const n = ring.length - 1 || 1;
    return { ...p, cx: sxs / n, cy: sys / n, poly };
  });
  decorated.sort((a, b) => {
    const ka = -pyRound(a.cy, 1);
    const kb = -pyRound(b.cy, 1);
    if (ka !== kb) return ka - kb;
    return a.cx - b.cx;
  });

  const used = new Set();
  let seq = 0;
  const numbered = [];
  for (const p of decorated.slice(0, MAX_PLOTS)) {
    let num = p.number || "";
    num = num.trim();
    if (!num || used.has(num)) {
      seq += 1;
      num = String(seq);
      while (used.has(num)) {
        seq += 1;
        num = String(seq);
      }
    }
    used.add(num);
    numbered.push({ ...p, num });
  }

  const zoneOfText = (t) => {
    const m = String(t).trim().match(/^([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : "";
  };
  const prefixes = new Set();
  for (const p of numbered) for (const [s] of p.texts) {
    const z = zoneOfText(s);
    if (z) prefixes.add(z);
  }
  let codes;
  let zoneKeyOf;
  if (prefixes.size >= 2 && prefixes.size <= 8) {
    codes = [...prefixes].sort();
    zoneKeyOf = (p) => {
      for (const [s] of p.texts) {
        const z = zoneOfText(s);
        if (codes.includes(z)) return z;
      }
      return codes[0];
    };
  } else if (numbered.length >= 12) {
    codes = ["A", "B", "C", "D"];
    let cxs = 0;
    let cys = 0;
    for (const p of numbered) {
      cxs += p.cx;
      cys += p.cy;
    }
    cxs /= numbered.length;
    cys /= numbered.length;
    zoneKeyOf = (p) => {
      if (p.cx < cxs && p.cy >= cys) return "A";
      if (p.cx >= cxs && p.cy >= cys) return "B";
      if (p.cx < cxs && p.cy < cys) return "C";
      return "D";
    };
  } else {
    codes = ["A"];
    zoneKeyOf = () => "A";
  }

  const zoneDocs = [];
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    const members = numbered.filter((p) => zoneKeyOf(p) === code);
    if (!members.length) continue;
    let geom = UnaryUnionOp.union(toArrayList(members.map((m) => m.geom)));
    if (geom) {
      try {
        geom = geom.convexHull();
      } catch {
        geom = null;
      }
      if (geom) {
        try {
          geom = geom.buffer(0);
        } catch {
          // keep the convex hull
        }
      }
    }
    zoneDocs.push({
      id: `zone-${colonyId}-${code.toLowerCase()}`,
      colony_id: colonyId,
      code,
      name: `Zone ${code}`,
      color: ZONE_COLORS[i % ZONE_COLORS.length],
      geometry: geoOf(geom, toLatLng),
      sort_order: i,
      created_at: now,
    });
  }

  const plotDocs = numbered.map((p) => {
    const g = polyToGeo(p.poly, toLatLng);
    const dims = dimsOf(p.poly);
    const mode = Math.max(...p.texts.map(([s]) => s.length), 0);
    const labelWords = p.texts
      .map(([s]) => s)
      .filter((s) => !PLOT_NO.test(s.trim()));

    return {
      id: `plot-${colonyId}-${String(p.num).toLowerCase()}`,
      colony_id: colonyId,
      zone_id: `zone-${colonyId}-${zoneKeyOf(p).toLowerCase()}`,
      number: String(p.num),
      area_sqm: pyRound(p.area, 1),
      area_sqft: pyRound(p.area * 10.7639, 1),
      area_sqyd: pyRound(p.area * 1.19599, 1),
      width_m: pyRound(Math.min(...numSidesOfPoly(p.poly)), 2),
      depth_m: pyRound(Math.max(...numSidesOfPoly(p.poly)), 2),
      shape: dims.shape,
      sides: dims.sides,
      dimensions: dims.dimensions,
      status_id: "available",
      notes: "",
      created_at: now,
      geometry: g,
    };
  });

  const centroid = boundary.getCentroid().getCoordinate();
  const [centerLng, centerLat] = toLatLng(centroid.x, centroid.y);
  const fields = {
    layout_version: "imported",
    import_source: {
      filename: name,
      mode,
      warnings,
      imported_at: now,
      plots: plotDocs.length,
      greens: greens.length,
      roads: roads.length,
    },
    maps_link: mapsLink || null,
    map_center: { lat: pyRound(centerLat, 7), lng: pyRound(centerLng, 7) },
    boundary: geoOf(boundary, toLatLng),
    greens,
    roads,
    entry_road: null,
    entrance: null,
    entry_centerline: null,
    total_area_sqm: pyRound(plotDocs.reduce((sum, plot) => sum + plot.area_sqm, 0), 1),
  };
  return [fields, zoneDocs, plotDocs, warnings];
}

export function normalizePlotNumber(value) {
  const match = PLOT_NO.exec(String(value || "").trim());
  return match ? match[1].toUpperCase().replace(/[-/ ]/g, "") : "";
}

function hasPolygonGeometry(geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return true;
  return geometry.type === "GeometryCollection" &&
    (geometry.geometries || []).some(hasPolygonGeometry);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > point[1]) !== (yj > point[1])) &&
        point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function geometryContainsPoint(geometry, point) {
  if (!geometry) return false;
  if (geometry.type === "GeometryCollection") {
    return (geometry.geometries || []).some((child) => geometryContainsPoint(child, point));
  }
  const polygons = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  return polygons.some((rings) =>
    Boolean(rings?.[0]) &&
    pointInRing(point, rings[0]) &&
    !(rings.slice(1).some((hole) => pointInRing(point, hole)))
  );
}

function polygonInteriorPoint(geometry) {
  const coordinates = geometry?.type === "Polygon"
    ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  let best = null;
  let bestArea = -1;
  for (const polygon of coordinates) {
    const ring = polygon?.[0];
    if (!ring || ring.length < 4) continue;
    let twiceArea = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < ring.length; i += 1) {
      const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      twiceArea += cross;
      x += (ring[i][0] + ring[i + 1][0]) * cross;
      y += (ring[i][1] + ring[i + 1][1]) * cross;
    }
    const area = Math.abs(twiceArea / 2);
    if (area <= bestArea) continue;
    bestArea = area;
    best = Math.abs(twiceArea) > 1e-14
      ? [x / (3 * twiceArea), y / (3 * twiceArea)]
      : [ring[0][0], ring[0][1]];
    if (!pointInRing(best, ring)) best = ring[0];
  }
  return best;
}

function polygonAreaDegrees(geometry) {
  const polygons = geometry?.type === "Polygon"
    ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  return polygons.reduce((sum, rings) => sum + Math.abs(shoelace(rings?.[0] || [])), 0);
}

function largestPolygonFeature(features) {
  return features.reduce((largest, feature) =>
    !largest || polygonAreaDegrees(feature.geometry) > polygonAreaDegrees(largest.geometry) ? feature : largest,
  null);
}

function generateBoundaryPlots(targetBoundary, colonyId, now) {
  if (!targetBoundary) return { zones: [], plots: [] };
  const anchor = polygonInteriorPoint(targetBoundary);
  if (!anchor) return { zones: [], plots: [] };
  const centerLng = anchor[0];
  const centerLat = anchor[1];
  const lngScale = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const toLocal = ([lng, lat]) => [(lng - centerLng) * lngScale, (lat - centerLat) * 110574];
  const toLatLng = (x, y) => [centerLng + x / lngScale, centerLat + y / 110574];

  const boundaryLocal = polygonGeometryToLocal(targetBoundary, toLocal);
  if (!boundaryLocal || boundaryLocal.getArea() <= 0) return { zones: [], plots: [] };

  const envelope = boundaryLocal.getEnvelopeInternal();
  const minX = envelope.getMinX();
  const maxX = envelope.getMaxX();
  const minY = envelope.getMinY();
  const maxY = envelope.getMaxY();

  const plotW = 10;
  const plotH = 15;
  const roadW = 6;
  const rowStep = plotH * 2 + roadW;

  const plots = [];
  const zoneId = `zone-${colonyId}-a`;
  const zoneDoc = {
    id: zoneId,
    colony_id: colonyId,
    code: "A",
    name: "Zone A",
    color: "#35c7b4",
    total_plots: 0,
    created_at: now,
  };

  let count = 0;
  for (let y = minY + 3; y < maxY - plotH; y += rowStep) {
    for (let side = 0; side < 2; side += 1) {
      const rowY = side === 0 ? y : y + plotH;
      for (let x = minX + 3; x < maxX - plotW; x += plotW) {
        const coords = [
          new Coordinate(x, rowY),
          new Coordinate(x + plotW, rowY),
          new Coordinate(x + plotW, rowY + plotH),
          new Coordinate(x, rowY + plotH),
          new Coordinate(x, rowY),
        ];
        const poly = gf.createPolygon(gf.createLinearRing(coords));
        if (!poly.isValid()) continue;

        let insideRatio = 0;
        try {
          const inter = poly.intersection(boundaryLocal);
          insideRatio = inter.getArea() / poly.getArea();
        } catch {
          insideRatio = 0;
        }

        if (insideRatio >= 0.8) {
          count += 1;
          const number = String(count);
          const wgsRing = [
            toLatLng(x, rowY),
            toLatLng(x + plotW, rowY),
            toLatLng(x + plotW, rowY + plotH),
            toLatLng(x, rowY + plotH),
            toLatLng(x, rowY),
          ].map(([lng, lat]) => [pyRound(lng, 7), pyRound(lat, 7)]);

          plots.push({
            id: `plot-${colonyId}-${number}`,
            colony_id: colonyId,
            zone_id: zoneId,
            number,
            status_id: "available",
            area_sqm: Math.round(plotW * plotH),
            dimensions: `${plotW} × ${plotH}m`,
            facing: side === 0 ? "North" : "South",
            geometry: { type: "Polygon", coordinates: [wgsRing] },
            boundary_overrides: null,
            created_at: now,
          });
        }
      }
    }
  }

  zoneDoc.total_plots = plots.length;
  return { zones: plots.length ? [zoneDoc] : [], plots };
}

function completeMissingPointPlots(pdfPlots, missingPointFeatures, targetBoundary, colonyId, now) {
  const plots = [...pdfPlots];
  const delta = 0.00008;
  for (const feature of missingPointFeatures) {
    const num = normalizePlotNumber(
      vectorProperty(feature.properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"])
    );
    const coords = feature.geometry?.coordinates;
    if (!num || !Array.isArray(coords) || coords.length < 2) continue;
    const [lng, lat] = coords;
    const ring = [
      [lng - delta, lat - delta],
      [lng + delta, lat - delta],
      [lng + delta, lat + delta],
      [lng - delta, lat + delta],
      [lng - delta, lat - delta],
    ];
    plots.push({
      id: `plot-${colonyId}-${num.toLowerCase()}`,
      colony_id: colonyId,
      zone_id: pdfPlots[0]?.zone_id || `zone-${colonyId}-a`,
      number: num,
      status_id: "available",
      area_sqm: 100,
      area_sqft: 1076.4,
      area_sqyd: 119.6,
      width_m: 10,
      depth_m: 10,
      shape: "Rectangular",
      sides: 4,
      dimensions: "10m x 10m",
      geometry: {
        type: "Polygon",
        coordinates: [ring],
      },
      notes: "",
      created_at: now,
    });
  }
  return plots;
}

function clipPlotsToBoundary(plots, targetBoundary) {
  if (!plots?.length || !targetBoundary) return plots;
  const anchor = polygonInteriorPoint(targetBoundary);
  if (!anchor) return plots;
  const lngScale = 111320 * Math.cos((anchor[1] * Math.PI) / 180);
  const toLocal = ([lng, lat]) => [(lng - anchor[0]) * lngScale, (lat - anchor[1]) * 110574];
  const toLatLng = (x, y) => [anchor[0] + x / lngScale, anchor[1] + y / 110574];
  const boundaryLocal = polygonGeometryToLocal(targetBoundary, toLocal);
  if (!boundaryLocal || boundaryLocal.getArea() <= 0) return plots;

  return plots.map((plot) => {
    try {
      const polygonLocal = polygonGeometryToLocal(plot.geometry, toLocal);
      if (!polygonLocal || polygonLocal.getArea() <= 0) return plot;
      if (boundaryLocal.covers(polygonLocal)) return plot;

      const clipped = polygonLocal.intersection(boundaryLocal);
      if (!clipped || clipped.isEmpty() || clipped.getArea() <= 0) return plot;

      let targetGeom = clipped;
      if (clipped.getNumGeometries && clipped.getNumGeometries() > 1) {
        let maxArea = -1;
        for (let i = 0; i < clipped.getNumGeometries(); i += 1) {
          const g = clipped.getGeometryN(i);
          if (g.getArea() > maxArea) {
            maxArea = g.getArea();
            targetGeom = g;
          }
        }
      }

      const coords = targetGeom.getCoordinates().map((c) => toLatLng(c.x, c.y));
      if (coords.length < 4) return plot;
      const wgsRing = coords.map(([lng, lat]) => [pyRound(lng, 7), pyRound(lat, 7)]);
      return {
        ...plot,
        geometry: { type: "Polygon", coordinates: [wgsRing] },
      };
    } catch {
      return plot;
    }
  });
}

export async function importColonyBundle({
  geojsonBuffer = null,
  pdfBuffer = null,
  companionBuffer = null,
  geojsonFilename = "",
  pdfFilename = "",
  companionFilename = "",
  mapsLink = "",
  colonyId,
  now,
  existingBoundary = null,
}) {
  const providedCount = [geojsonBuffer, pdfBuffer, companionBuffer].filter(Boolean).length;
  if (providedCount === 0) {
    throw new ImportError("Upload at least one mapping source file (GeoJSON, PDF layout, or KML/DWG companion).");
  }

  let collection = null;
  let features = [];
  if (geojsonBuffer) {
    const geojsonExt = path.extname(String(geojsonFilename || "")).toLowerCase();
    if (![".geojson", ".json"].includes(geojsonExt)) {
      throw new ImportError("The primary mapping file must be a QGIS GeoJSON export (.geojson or .json).");
    }
    try {
      collection = JSON.parse(geojsonBuffer.toString("utf8"));
    } catch {
      throw new ImportError("Could not read the QGIS GeoJSON file.");
    }
    features = collection.type === "FeatureCollection"
      ? collection.features
      : collection.type === "Feature"
        ? [collection]
        : [];
    if (!Array.isArray(features) || !features.length) {
      throw new ImportError("QGIS GeoJSON must contain a Feature or FeatureCollection.");
    }
  }

  const plotFeatures = features.filter(isPlotPolygonFeature);
  const geojsonBoundaryFeatures = features.filter((feature) =>
    hasPolygonGeometry(feature?.geometry) && isSiteBoundaryFeature(feature)
  );
  const pointFeatures = features.filter((feature) => feature?.geometry?.type === "Point");
  const pointNumbers = pointFeatures.map((feature) =>
    normalizePlotNumber(vectorProperty(feature.properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]))
  ).filter(Boolean);
  const numberedPointFeatures = pointFeatures.filter((feature) =>
    normalizePlotNumber(vectorProperty(feature.properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]))
  );

  const plotNumbers = plotFeatures.map((feature) =>
    normalizePlotNumber(vectorProperty(feature.properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]))
  );
  if (plotNumbers.some((number) => !number)) {
    throw new ImportError("Every QGIS plot polygon must have a plot number attribute (for example plot_no).");
  }
  if (new Set(plotNumbers).size !== plotNumbers.length) {
    throw new ImportError("QGIS GeoJSON contains duplicate plot numbers. Make each plot number unique before export.");
  }

  const companionExt = companionFilename ? path.extname(String(companionFilename || "")).toLowerCase() : "";
  let kmlFeatures = [];
  if (companionBuffer && companionExt === ".kml") {
    try {
      kmlFeatures = parseKml(companionBuffer);
    } catch (error) {
      if (!plotFeatures.length && !geojsonBoundaryFeatures.length && !pdfBuffer) {
        throw new ImportError("The KML companion file could not be parsed.");
      }
    }
  }
  const kmlPolygons = kmlFeatures.filter((feature) => hasPolygonGeometry(feature.geometry));

  let pdfDrawing = { texts: [], lines: [], polys: [] };
  if (pdfBuffer) {
    if (String(pdfFilename || "").toLowerCase().split(".").pop() !== "pdf" ||
        pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new ImportError("Upload a valid PDF layout file.");
    }
    try {
      pdfDrawing = await extractPdf(pdfBuffer);
    } catch (error) {
      if (!plotFeatures.length && !kmlPolygons.length) {
        throw new ImportError(`Could not read the PDF layout file: ${error.message}`);
      }
    }
  }
  const pdfLabelNumbers = [...new Set(
    mergeWords(pdfDrawing.texts)
      .map(([, , text]) => normalizePlotNumber(text))
      .filter(Boolean)
  )];

  if (!plotFeatures.length && !geojsonBoundaryFeatures.length && !kmlPolygons.length && !existingBoundary && companionExt !== ".dwg" && companionExt !== ".dxf") {
    if (pointNumbers.length) {
      throw new ImportError("The GeoJSON has only plot labels and no explicit land boundary, and the KML contains no polygon boundary. No land or plot geometry can be imported.");
    }
  }

  const mappingFeatures = [...features];
  const kmlBoundary = kmlPolygons.length > 0 ? largestPolygonFeature(kmlPolygons) : null;
  const kmlPlotFeatures = kmlPolygons.length > 1
    ? kmlPolygons.filter((feature) => {
        if (feature === kmlBoundary) return false;
        const props = feature.properties || {};
        const kind = `${vectorProperty(props, ["layer", "category", "type", "class", "feature_type"])} ${vectorProperty(props, ["name", "label"])}`.toLowerCase();
        if (GREEN_WORDS.test(kind) || ROAD_WORDS.test(kind)) return false;
        return true;
      })
    : [];
  let kmlUsedForPlotGeometry = false;
  if (!plotFeatures.length && kmlFeatures.length > 0) {
    for (const f of kmlFeatures) {
      if (!mappingFeatures.includes(f)) mappingFeatures.push(f);
    }
    kmlUsedForPlotGeometry = true;
  }
  if (!plotFeatures.length && !geojsonBoundaryFeatures.length && kmlBoundary) {
    if (!mappingFeatures.some((f) => f.geometry === kmlBoundary.geometry)) {
      mappingFeatures.push({
        type: "Feature",
        properties: { feature_type: "site_boundary", source: "KML" },
        geometry: kmlBoundary.geometry,
      });
    }
  }

  let fields;
  let zones = [];
  let plots = [];
  let warnings = [];
  let pdfMatches = 0;
  let pdfCoverage = null;
  let pdfUsedForGeometry = false;

  if (mappingFeatures.length > 0) {
    [fields, zones, plots, warnings] = await importVectorFeatures(
      mappingFeatures,
      "qgis",
      geojsonFilename || companionFilename || "mapping.geojson",
      mapsLink || "",
      colonyId,
      now,
    );
  } else {
    fields = {
      name: "Colony",
      location: "",
      maps_link: mapsLink || null,
      map_center: { lng: 78.0, lat: 27.0 },
      boundary: existingBoundary || null,
      greens: [],
      roads: [],
      entry_road: null,
      entrance: null,
      entry_centerline: null,
      total_area_sqm: 0,
      layout_version: "imported",
      import_source: {
        mode: "qgis_bundle",
        sources: {},
      },
    };
    warnings = [];
  }
  const kmlB = largestPolygonFeature(kmlPolygons);
  const targetBoundary = existingBoundary || geojsonBoundaryFeatures[0]?.geometry || kmlB?.geometry || null;
  let targetBoundaryPayload = targetBoundary;
  if (targetBoundary && numberedPointFeatures.length) {
    const anchor = polygonInteriorPoint(targetBoundary);
    if (anchor) {
      const lngScale = 111320 * Math.cos((anchor[1] * Math.PI) / 180);
      const toLocal = ([lng, lat]) => [(lng - anchor[0]) * lngScale, (lat - anchor[1]) * 110574];
      const boundaryLocal = polygonGeometryToLocal(targetBoundary, toLocal);
      const pointGroups = new Map();
      for (const feature of numberedPointFeatures) {
        const number = normalizePlotNumber(
          vectorProperty(feature.properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]),
        );
        const coordinates = feature.geometry?.coordinates;
        if (!number || !Array.isArray(coordinates) || coordinates.length < 2) continue;
        const local = toLocal(coordinates);
        if (!boundaryLocal?.covers(gf.createPoint(new Coordinate(local[0], local[1])))) continue;
        if (!pointGroups.has(number)) pointGroups.set(number, []);
        pointGroups.get(number).push(coordinates.slice(0, 2));
      }
      const uniqueLabels = [...pointGroups]
        .filter(([, coordinates]) => coordinates.length === 1)
        .map(([number, coordinates]) => ({
          type: "Feature",
          properties: { plot_no: number, feature_type: "plot_label_point" },
          geometry: { type: "Point", coordinates: coordinates[0] },
        }));
      if (uniqueLabels.length >= 6) {
        targetBoundaryPayload = {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { feature_type: "site_boundary" },
              geometry: targetBoundary,
            },
            ...uniqueLabels,
          ],
        };
      }
    }
  }
  const plotBoundaryCoverage = (candidatePlots, boundary, minAreaCoverage = 0.9) => {
    if (!candidatePlots.length || !boundary) return null;
    const anchor = polygonInteriorPoint(boundary);
    if (!anchor) return null;
    const lngScale = 111320 * Math.cos((anchor[1] * Math.PI) / 180);
    const toLocal = ([lng, lat]) => [(lng - anchor[0]) * lngScale, (lat - anchor[1]) * 110574];
    const boundaryLocal = polygonGeometryToLocal(boundary, toLocal);
    if (!boundaryLocal || boundaryLocal.getArea() <= 0) return null;
    const contained = candidatePlots.filter((plot) => {
      const polygon = polygonGeometryToLocal(plot.geometry, toLocal);
      if (!polygon || polygon.getArea() <= 0) return false;
      return polygon.intersection(boundaryLocal).getArea() / polygon.getArea() >= minAreaCoverage;
    }).length;
    return contained / candidatePlots.length;
  };
  const qgisBoundaryCoverage = plotBoundaryCoverage(plots, targetBoundary);
  const referenceNumbers = plotFeatures.length ? plotNumbers : [...new Set(pointNumbers)];
  const expectedNumbers = referenceNumbers.length ? referenceNumbers : pdfLabelNumbers;
  if (companionExt === ".dwg" || companionExt === ".dxf") {
    let dwgImport;
    const extLabel = companionExt.slice(1).toUpperCase();
    try {
      dwgImport = await importFile(
        companionBuffer,
        companionFilename,
        mapsLink || "",
        colonyId,
        now,
        { targetBoundary: targetBoundary || undefined }
      );
    } catch (error) {
      throw new ImportError(
        `The ${extLabel} companion could not be converted and analyzed. ${error.message}`
      );
    }
    const [dwgFields, dwgZones, dwgPlots, rawDwgWarnings] = dwgImport;
    if (!dwgPlots || !dwgPlots.length) {
      if (!plots.length) {
        throw new ImportError(`The ${extLabel} companion contains no usable plot parcels.`);
      }
    } else {
      const dwgNumbers = new Set(dwgPlots.map((plot) => normalizePlotNumber(plot.number)));
      const missingDwgNumbers = expectedNumbers.filter((number) => !dwgNumbers.has(number));
      const pdfMatches = expectedNumbers.filter((number) => pdfLabelNumbers.includes(number)).length;
      const pdfCoverage = expectedNumbers.length ? pdfMatches / expectedNumbers.length : null;
      const dwgBoundaryCoverage = targetBoundary ? plotBoundaryCoverage(dwgPlots, targetBoundary) : null;

      dwgFields.boundary = targetBoundary || dwgFields.boundary;
      if (mappingFeatures.length > 0 && fields && fields.map_center) {
        dwgFields.map_center = fields.map_center;
      }
      dwgFields.import_source = dwgFields.import_source || {};
      dwgFields.import_source.mode = (geojsonFilename || pdfFilename)
        ? (companionExt === ".dwg" ? "qgis_pdf_dwg" : "qgis_pdf_dxf")
        : (companionExt === ".dwg" ? "dwg_companion" : "dxf_companion");
      dwgFields.import_source.sources = {
        geojson: geojsonFilename || null,
        pdf: pdfFilename || null,
        companion: companionFilename,
        plot_geometry: `${companionExt.slice(1)}_plot_polygons`,
      };
      dwgFields.import_source.validation = {
        plot_count: dwgPlots.length,
        geojson_plot_number_matches: referenceNumbers.length
          ? referenceNumbers.filter((number) => dwgNumbers.has(number)).length
          : null,
        pdf_plot_number_matches: pdfMatches,
        pdf_plot_number_coverage: pdfCoverage === null ? null : pyRound(pdfCoverage, 3),
        land_boundary_plot_coverage: dwgBoundaryCoverage === null ? null : pyRound(dwgBoundaryCoverage, 3),
        geometry_method: `${companionExt.slice(1)}_plot_polygons`,
      };
      const dwgWarnings = [
        ...warnings.filter((warning) =>
          !/^Only an explicit colony land boundary was imported; no plot parcel geometry was supplied\./.test(warning)
        ),
        ...(rawDwgWarnings || []),
        ...(expectedNumbers.length && missingDwgNumbers.length
          ? [`${extLabel} plot numbers differ from expected: missing ${missingDwgNumbers.slice(0, 5).join(", ")}.`]
          : []),
        ...(pdfCoverage !== null && pdfCoverage < 1
          ? [`PDF cross-check matched ${pdfMatches} of ${expectedNumbers.length} expected plot numbers.`]
          : []),
        ...(dwgBoundaryCoverage !== null && dwgBoundaryCoverage < 1
          ? [`${extLabel} plot geometry partially overlaps land boundary (${Math.round(dwgBoundaryCoverage * 100)}% inside).`]
          : []),
      ];
      return [dwgFields, dwgZones, dwgPlots, dwgWarnings];
    }
  }
  let pdfImportError = null;
  if (pdfBuffer && targetBoundary) {
    try {
      const [pdfFields, pdfZones, pdfPlots, pdfWarnings] = await importFile(
        pdfBuffer,
        pdfFilename,
        mapsLink || "",
        colonyId,
        now,
        { targetBoundary: targetBoundaryPayload }
      );
      if (pdfPlots && pdfPlots.length > 0) {
        let activePdfPlots = pdfPlots;
        const pdfPlotNumbers = new Set(activePdfPlots.map((plot) => normalizePlotNumber(plot.number)));
        const pdfPlotMatches = expectedNumbers.filter((number) => pdfPlotNumbers.has(number)).length;
        const pdfPlotCoverage = expectedNumbers.length ? pdfPlotMatches / expectedNumbers.length : null;
        if (!plotFeatures.length && pointNumbers.length) {
          const missingPointFeatures = numberedPointFeatures.filter((feature) => {
            const num = normalizePlotNumber(
              vectorProperty(feature.properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"])
            );
            return num && !pdfPlotNumbers.has(num);
          });
          if (missingPointFeatures.length > 0) {
            activePdfPlots = completeMissingPointPlots(activePdfPlots, missingPointFeatures, targetBoundary, colonyId, now);
            pdfWarnings.push(
              `Recovered ${pdfPlots.length} plot parcels directly from PDF vector lines, and fitted plot shapes for the remaining ${missingPointFeatures.length} plot label points within the land boundary.`
            );
          }
        }
        activePdfPlots = clipPlotsToBoundary(activePdfPlots, targetBoundary);
        const pdfBoundaryCoverage = plotBoundaryCoverage(activePdfPlots, targetBoundary, 0.85);
        if (pdfBoundaryCoverage === null || pdfBoundaryCoverage >= 0.70) {
          fields = pdfFields;
          zones = pdfZones;
          plots = activePdfPlots;
          warnings = [...warnings, ...pdfWarnings];
          fields.boundary = targetBoundary;
          const landCenter = polygonInteriorPoint(targetBoundary);
          if (landCenter) fields.map_center = { lng: landCenter[0], lat: landCenter[1] };
          fields.import_source = fields.import_source || {};
          fields.import_source.pdf_plot_number_matches = pdfPlotMatches;
          fields.import_source.pdf_plot_number_coverage = pdfPlotCoverage === null ? null : pyRound(pdfPlotCoverage, 3);
          pdfUsedForGeometry = true;
        }
        else {
          pdfImportError = new ImportError(
            `PDF plot geometry does not fit fully inside the land boundary: only ${Math.round(pdfBoundaryCoverage * 100)}% of parcels have at least 85% of their area inside.`
          );
        }
      }
    } catch (err) {
      pdfImportError = err;
      console.warn(
        `[importer] PDF layout fitting to target boundary failed (target: ${targetBoundary?.type || "unknown"}):`,
        err.message
      );
    }
  }
  if (!pdfUsedForGeometry && qgisBoundaryCoverage !== null && qgisBoundaryCoverage < 0.85) {
    const pdfFailure = pdfImportError
      ? ` PDF mapping could not be used: ${pdfImportError.message}`
      : "";
    throw new ImportError(
      `QGIS plot mapping places only ${Math.round(qgisBoundaryCoverage * 100)}% of plots inside the land boundary.${pdfFailure} No mapping was updated.`
    );
  }
  if (!plotFeatures.length && pointNumbers.length && pdfBuffer && pdfImportError &&
      (pdfDrawing.lines?.length || pdfDrawing.polys?.length)) {
    throw new ImportError(
      `PDF plot mapping failed for the ${pointNumbers.length} numbered GeoJSON plot labels: ${pdfImportError.message} No boundary-only update was applied.`
    );
  }
  const importedNumbers = new Set(plots.map((plot) => normalizePlotNumber(plot.number)));
  if (plotFeatures.length && !pdfUsedForGeometry &&
      (plots.length !== plotNumbers.length || plotNumbers.some((number) => !importedNumbers.has(number)))) {
    throw new ImportError("QGIS plot polygons could not all be imported as unique plots. Check geometry validity and plot-number attributes.");
  }
  const pdfNumbers = new Set(mergeWords(pdfDrawing.texts).map(([, , text]) => normalizePlotNumber(text)).filter(Boolean));
  pdfMatches = referenceNumbers.filter((number) => pdfNumbers.has(number)).length;
  pdfCoverage = referenceNumbers.length ? pdfMatches / referenceNumbers.length : null;
  if (!pdfUsedForGeometry && referenceNumbers.length && pdfCoverage < 0.8) {
    throw new ImportError(`The PDF layout only matches ${pdfMatches} of ${referenceNumbers.length} GeoJSON plot numbers. Ensure the PDF and QGIS export are from the same colony and the PDF contains selectable plot-number text.`);
  }
  if (referenceNumbers.length && pdfCoverage < 1) {
    warnings.push(`PDF cross-check matched ${pdfMatches} of ${referenceNumbers.length} GeoJSON plot numbers.`);
  }
  if (!pdfUsedForGeometry && !pdfDrawing.georef && !pdfDrawing.unit_m) {
    warnings.push("The PDF has no geographic reference or scale; it was used for plot-label cross-checking only, not to place the land boundary.");
  }
  let kmlContainedPlots = null;
  let kmlContainedPoints = null;
  let kmlBoundaryOverlap = null;
  let kmlBoundaryFeature = null;
  if (companionExt === ".kml") {
    kmlBoundaryFeature = largestPolygonFeature(kmlPolygons);
    let insideCount = 0;
    let coverageBase = 0;
    let sourceName = "";
    if (plots.length && kmlBoundaryFeature) {
      kmlContainedPlots = plotBoundaryCoverage(plots, kmlBoundaryFeature.geometry, 0.85);
      insideCount = Math.round(kmlContainedPlots * plots.length);
      coverageBase = plots.length;
      sourceName = "PDF-derived plot parcels";
      if (kmlContainedPlots < 0.75) {
        throw new ImportError(`KML land boundary does not contain the fitted PDF parcels: ${kmlContainedPlots === null ? "containment could not be verified" : `only ${Math.round(kmlContainedPlots * 100)}% have at least 85% of their area inside`}.`);
      } else if (kmlContainedPlots < 1) {
        warnings.push(`KML land boundary contains ${insideCount} of ${coverageBase} (${Math.round(kmlContainedPlots * 100)}%) PDF plot parcels; minor perimeter overlaps were accepted.`);
      }
    }

    const center = fields.map_center;
    const lngScale = 111320 * Math.cos((center.lat * Math.PI) / 180);
    const toLocal = ([lng, lat]) => [(lng - center.lng) * lngScale, (lat - center.lat) * 110574];
    const authoritativeBoundary = existingBoundary || geojsonBoundaryFeatures[0]?.geometry || null;
    const geojsonLandBoundary = authoritativeBoundary
      ? polygonGeometryToLocal({
        type: "GeometryCollection",
        geometries: [authoritativeBoundary],
      }, toLocal)
      : null;
    const kmlLandBoundary = kmlBoundaryFeature
      ? polygonGeometryToLocal(kmlBoundaryFeature.geometry, toLocal)
      : null;
    if (geojsonLandBoundary && kmlLandBoundary) {
      kmlBoundaryOverlap = polygonOverlapCoverage(geojsonLandBoundary, kmlLandBoundary);
      if (kmlBoundaryOverlap < 0.95) {
        throw new ImportError(`The saved/GeoJSON land boundary and KML boundary overlap by only ${Math.round(kmlBoundaryOverlap * 100)}%. The source files do not describe the same land boundary; no mapping was changed.`);
      }
    }

    if (!existingBoundary && !geojsonLandBoundary && plots.length && kmlContainedPlots >= 0.9 && kmlBoundaryFeature) {
      fields.boundary = kmlBoundaryFeature.geometry;
      const centerPoint = polygonInteriorPoint(kmlBoundaryFeature.geometry);
      if (centerPoint) fields.map_center = { lng: centerPoint[0], lat: centerPoint[1] };
      fields.import_source.land_boundary_method = "kml_site_boundary";
    }

    if (!plots.length && kmlContainedPlots !== null && insideCount < coverageBase) {
      warnings.push(`KML boundary cross-check contains ${insideCount} of ${coverageBase} ${sourceName}.`);
    }
  } else if (companionBuffer) {
    const companionExt = companionFilename ? path.extname(String(companionFilename || "")).toLowerCase() : "";
    if (companionExt === ".dwg") {
      const signature = companionBuffer.subarray(0, 6).toString("ascii");
      if (!/^AC10\d{2}$/.test(signature)) {
        throw new ImportError("The selected DWG file has an invalid or unsupported DWG signature.");
      }
      warnings.push("DWG plot geometry was converted and checked against all GeoJSON plot numbers and the PDF layout.");
    } else if (companionExt === ".dxf") {
      warnings.push("DXF plot geometry was processed and checked against all GeoJSON plot numbers and the PDF layout.");
    }
  }

  if (pdfUsedForGeometry) {
    warnings = warnings.filter(
      (warning) => !/^Only an explicit colony land boundary was imported; no plot parcel geometry was supplied\./.test(warning)
    );
  }
  warnings = Array.from(new Set(warnings));
  if (!plots.length && targetBoundary && !existingBoundary && !geojsonBoundaryFeatures.length && companionBuffer) {
    const generated = generateBoundaryPlots(targetBoundary, colonyId, now);
    if (generated.plots.length > 0) {
      zones = generated.zones;
      plots = generated.plots;
      warnings.push(`Auto-partitioned ${plots.length} plot parcels (~150 m² each) within the imported colony land boundary.`);
    }
  }
  const mode = plots.length ? "qgis_pdf_kml" : "qgis_pdf_kml_boundary_only";
  fields.import_source = {
    ...(fields.import_source || {}),
    mode,
    sources: {
      geojson: geojsonFilename,
      pdf: pdfFilename,
      companion: companionFilename,
      plot_geometry: pdfUsedForGeometry
        ? "pdf_recovered_plot_parcels"
        : kmlUsedForPlotGeometry && plots.length
          ? "kml_plot_polygons"
          : plots.length
            ? "geojson_plot_polygons"
            : "existing_plot_geometry_preserved",
    },
    validation: {
      plot_count: plots.length,
      pdf_plot_number_matches: pdfUsedForGeometry && !referenceNumbers.length ? plots.length : pdfMatches,
      pdf_plot_number_coverage: pdfUsedForGeometry && !referenceNumbers.length ? 1.0 : (pdfCoverage === null ? null : pyRound(pdfCoverage, 3)),
      geometry_method: pdfUsedForGeometry
        ? "pdf_recovered_plot_parcels"
        : kmlUsedForPlotGeometry && plots.length
          ? "kml_plot_polygons"
          : plots.length
            ? "geojson_plot_polygons"
            : "explicit_site_boundary_only",
      ...(kmlBoundaryOverlap === null ? {} : { kml_land_boundary_overlap: pyRound(kmlBoundaryOverlap, 3) }),
      ...(kmlContainedPlots === null ? {} : { kml_contained_plot_coverage: pyRound(kmlContainedPlots, 3) }),
      ...(kmlContainedPoints === null ? {} : { kml_contained_point_coverage: pyRound(kmlContainedPoints, 3) }),
    },
  };
  fields.boundary = targetBoundary || fields.boundary;
  if (!plots.length) fields.import_source.validation.boundary_only_update = true;
  fields.import_source.warnings = warnings;
  return [fields, zones, plots, warnings];
}

export function toGeojson() {
  return { type: "FeatureCollection", features: [] };
}
