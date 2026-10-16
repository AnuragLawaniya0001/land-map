/**
 * Durga Enclave demo layout: irregular 5-corner parcel on open farmland south-west of
 * the Darapura main road (Padra, Vadodara). Local metre frame: +y points toward the main
 * road (the frame is rotated so the road runs along the top edge).
 *
 * Node.js port of backend/layout.py — output verified against the Python reference:
 * 64 plots (A:24 B:11 C:11 D:18), 4 zones, 28582 m² total area.
 */

export const CENTER = { lat: 22.222876, lng: 73.105581 };
export const LAT_PER_M = 1 / 110574;
export const ROT = (55.5 * Math.PI) / 180; // +y of local frame = bearing 55.5°

const rad = (d) => (d * Math.PI) / 180;

function rot(x, y, r = ROT) {
  return [x * Math.cos(r) + y * Math.sin(r), -x * Math.sin(r) + y * Math.cos(r)];
}

function lngLat(x, y, center = CENTER, rotation = ROT) {
  const [rx, ry] = rot(x, y, rotation);
  const lngPerM = 1 / (111320 * Math.cos(rad(center.lat)));
  return [round(center.lng + rx * lngPerM, 7), round(center.lat + ry * LAT_PER_M, 7)];
}

/** Python-style round(): ties go to the even digit. */
function round(value, digits = 0) {
  const f = 10 ** digits;
  const scaled = value * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) {
    r = floor % 2 === 0 ? floor : floor + 1;
  } else {
    r = Math.round(scaled);
  }
  return r / f;
}

export const LAYOUT_VERSION = 6;
export const MAIN_ROAD_Y = 110; // centreline of the asphalt main road in the local frame

// Pentagon parcel (clockwise). Top edge runs parallel to the main road.
export const BOUNDARY = [
  [-75, 78],
  [85, 88],
  [100, -40],
  [10, -105],
  [-95, -50],
];

// Roads: [name, x1, y1, x2, y2]
export const ROADS = [
  ["9 MT. WIDE ROAD", -4.5, 31, 4.5, 95], // spine from gate
  ["9 MT. WIDE ROAD", -100, 22, 100, 31], // top arterial
  ["7.5 MT. WIDE ROAD", -100, 49, 100, 56.5], // north internal
  ["7.5 MT. WIDE ROAD", -100, -33.5, 100, -26], // bottom arterial
  ["7.5 MT. WIDE ROAD", -60, -59, 62.5, -51.5], // south internal
  ["PARK RING ROAD", -35.5, -33.5, -28, 29.5], // ring left
  ["PARK RING ROAD", 28, -33.5, 35.5, 29.5], // ring right
  ["7.5 MT. WIDE ROAD", -60, -105, -52.5, 95], // west road
  ["7.5 MT. WIDE ROAD", 55, -105, 62.5, 97], // east road
  ["7.5 MT. WIDE ROAD", -4.5, -105, 4.5, -33.5], // spine south
];
export const ENTRY_ROAD = [-6, 84, 6, MAIN_ROAD_Y + 5]; // gate out to the main road
export const ENTRANCE = [0, 86];

export const ZONES = [
  ["A", "Zone A", "#35c7b4", [-100, 100, 31, 100]],
  ["B", "Zone B", "#f06b5f", [35.5, 110, -105, 31]],
  ["C", "Zone C", "#f2b84b", [-110, -35.5, -105, 31]],
  ["D", "Zone D", "#55a8ff", [-35.5, 35.5, -105, -33.5]],
];

// Plot rows. ["h", zone, x_start, x_end, y_front, depth, dir, width]
//            ["v", zone, y_start, y_end, x_front, depth, dir, height]
export const ROWS = [
  ["h", "A", -80, -60, 31, 18, +1, 12],
  ["h", "A", -52.5, -4.5, 31, 18, +1, 12],
  ["h", "A", 4.5, 55, 31, 18, +1, 12],
  ["h", "A", 62.5, 92, 31, 18, +1, 12],
  ["h", "A", -80, -60, 56.5, 40, +1, 13],
  ["h", "A", -52.5, -4.5, 56.5, 40, +1, 13],
  ["h", "A", 4.5, 55, 56.5, 40, +1, 13],
  ["h", "A", 62.5, 92, 56.5, 40, +1, 13],
  ["v", "B", -100, 22, 62.5, 45, +1, 12.5],
  ["v", "B", -26, 22, 55, 19.5, -1, 12],
  ["v", "C", -100, 22, -60, 30, -1, 12.5],
  ["v", "C", -26, 22, -52.5, 17, +1, 12],
  ["h", "D", -52.5, -4.5, -33.5, 18, -1, 12],
  ["h", "D", 4.5, 55, -33.5, 18, -1, 12],
  ["h", "D", -52.5, -4.5, -59, 19, -1, 12],
  ["h", "D", 4.5, 55, -59, 19, -1, 12],
];

// Hand-placed odd plots (triangles at the south tip), local metres
export const EXTRA_PLOTS = [
  ["D", [[4.5, -78], [26, -78], [4.5, -89]]],
  ["D", [[26, -78], [44, -78], [26, -89]]],
];

export const GREENS = [
  ["Central Park", [-28, 28, -26, 22]],
  ["Green Belt", [-110, -90, -105, 95]],
  ["Kids Corner", [-60, -4.5, -110, -78]],
];

export const STATUS_CYCLE = [
  "available", "available", "sold", "available", "hold", "available",
  "reserved", "sold", "available", "available", "blocked",
];

function inset(poly, factor) {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

/** Sutherland-Hodgman clip of subject polygon against convex clip polygon (clockwise). */
function clip(subject, clipper) {
  const inside = (p, a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 0;

  const intersect = (p1, p2, a, b) => {
    const [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = a, [x4, y4] = b;
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return p2;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  };

  let out = subject.slice();
  for (let i = 0; i < clipper.length; i++) {
    const a = clipper[i], b = clipper[(i + 1) % clipper.length];
    const inp = out;
    out = [];
    if (!inp.length) break;
    let s = inp[inp.length - 1];
    for (const e of inp) {
      if (inside(e, a, b)) {
        if (!inside(s, a, b)) out.push(intersect(s, e, a, b));
        out.push(e);
      } else if (inside(s, a, b)) {
        out.push(intersect(s, e, a, b));
      }
      s = e;
    }
  }
  return dedupe(out);
}

function dedupe(poly) {
  const res = [];
  for (const p of poly) {
    if (!res.length || Math.hypot(res[res.length - 1][0] - p[0], res[res.length - 1][1] - p[1]) > 1.5) {
      res.push([round(p[0], 2), round(p[1], 2)]);
    }
  }
  if (res.length > 1 && Math.hypot(res[0][0] - res[res.length - 1][0], res[0][1] - res[res.length - 1][1]) < 1.5) {
    res.pop();
  }
  return res;
}

function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function rect(x1, x2, y1, y2) {
  return [[x1, y2], [x2, y2], [x2, y1], [x1, y1]];
}

function shape(poly, raw) {
  if (poly.length === 3) return "triangular";
  if (poly.length === 4 && Math.abs(area(poly) - area(raw)) < 0.5) return "rectangular";
  return poly.length === 4 ? "diagonal" : "polygon";
}

export function toGeo(poly, center = CENTER, rotation = ROT) {
  const ring = poly.map(([x, y]) => lngLat(x, y, center, rotation));
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

export function pointGeo(x, y, center = CENTER, rotation = ROT) {
  return { type: "Point", coordinates: lngLat(x, y, center, rotation) };
}

export function buildLayout() {
  const wall = inset(BOUNDARY, 0.965); // compound-wall setback
  const zones = ZONES.map(([code, name, color, box]) => ({
    id: `zone-${code.toLowerCase()}`,
    code,
    name,
    color,
    geometry: clip(rect(...box), wall),
  }));
  const greens = GREENS.map(([name, box]) => ({ name, geometry: clip(rect(...box), wall) }));
  const roads = ROADS.map(([name, x1, y1, x2, y2]) => ({
    name,
    width_m: round(Math.min(x2 - x1, y2 - y1), 1),
    geometry: clip(rect(x1, x2, y1, y2), wall),
  }));

  const plots = [];
  for (const [kind, zone, s, e, front, depth, d, w] of ROWS) {
    let pos = s;
    while (pos + w * 0.45 < e) {
      const pos2 = Math.min(pos + w, e);
      const rear = front + d * depth;
      const lo = Math.min(front, rear), hi = Math.max(front, rear);
      const raw = kind === "h" ? rect(pos, pos2, lo, hi) : rect(lo, hi, pos, pos2);
      const poly = clip(raw, wall);
      if (poly.length >= 3 && area(poly) >= 70) {
        plots.push({ zone, poly, width_m: round(pos2 - pos, 2), depth_m: depth, shape: shape(poly, raw) });
      }
      pos = pos2;
    }
  }
  for (const [zone, tri] of EXTRA_PLOTS) {
    const poly = clip(tri, wall);
    plots.push({ zone, poly, width_m: round(Math.sqrt(area(poly)), 2), depth_m: 0, shape: shape(poly, tri) });
  }
  return { wall, zones, greens, roads, plots };
}

function dimensions(poly, shapeName) {
  let sides = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    sides.push(Math.hypot(x2 - x1, y2 - y1));
  }
  if (shapeName === "rectangular") sides = sides.slice(0, 2);
  return sides.map((s) => `${s.toFixed(1)}m`).join(" × ");
}

export function seedDocuments(colonyId, now, center = CENTER, rotDeg = null) {
  const rotation = rotDeg === null || rotDeg === undefined ? ROT : rad(rotDeg);
  const g = (poly) => toGeo(poly, center, rotation);
  const lay = buildLayout();
  const zoneDocs = [];
  lay.zones.forEach((z, i) => {
    zoneDocs.push({
      id: z.id,
      colony_id: colonyId,
      code: z.code,
      name: z.name,
      color: z.color,
      geometry: g(z.geometry),
      sort_order: i,
      created_at: now,
    });
  });
  const order = { A: 0, B: 1, C: 2, D: 3 };
  const plots = lay.plots.slice().sort((a, b) => order[a.zone] - order[b.zone]);
  const plotDocs = plots.map((p, i) => {
    const n = i + 1;
    const a = round(area(p.poly), 1);
    return {
      id: `plot-${n}`,
      colony_id: colonyId,
      zone_id: `zone-${p.zone.toLowerCase()}`,
      number: String(n),
      area_sqm: a,
      area_sqft: round(a * 10.7639, 1),
      area_sqyd: round(a * 1.19599, 1),
      width_m: p.width_m,
      depth_m: p.depth_m,
      shape: p.shape,
      sides: p.poly.length,
      dimensions: dimensions(p.poly, p.shape),
      status_id: STATUS_CYCLE[n % STATUS_CYCLE.length],
      geometry: g(p.poly),
      notes: "",
      created_at: now,
    };
  });
  const colonyFields = {
    layout_version: LAYOUT_VERSION,
    map_center: center,
    rotation_deg: round((rotation * 180) / Math.PI, 2),
    boundary: g(BOUNDARY),
    greens: lay.greens.map((gr) => ({ name: gr.name, geometry: g(gr.geometry) })),
    roads: lay.roads.map((r) => ({ name: r.name, width_m: r.width_m, geometry: g(r.geometry) })),
    entry_width_m: round(ENTRY_ROAD[2] - ENTRY_ROAD[0], 1),
    entry_road: g(rect(ENTRY_ROAD[0], ENTRY_ROAD[2], ENTRY_ROAD[1], ENTRY_ROAD[3])),
    entrance: pointGeo(ENTRANCE[0], ENTRANCE[1], center, rotation),
    entry_centerline: {
      type: "LineString",
      coordinates: [lngLat(0, 86, center, rotation), lngLat(0, MAIN_ROAD_Y + 2, center, rotation)],
    },
    total_area_sqm: round(area(BOUNDARY)),
  };
  return { colonyFields, zoneDocs, plotDocs };
}

export { area as polygonArea, clip as clipPolygon };
