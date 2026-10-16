import { PNG } from "pngjs";

const Z = 17;
const TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const UA = { "User-Agent": "LiveMap/1.0 (colony entrance detection)" };

const ROAD_COLORS = [
  [255, 255, 255],
  [247, 250, 191],
  [252, 214, 164],
  [249, 178, 156],
  [232, 146, 162],
];
const TOL = 4;
const BACKGROUND = [242, 239, 233];

function pyRound(value, digits = 0) {
  const f = 10 ** digits;
  const scaled = value * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) r = floor % 2 === 0 ? floor : floor + 1;
  else r = Math.round(scaled);
  return r / f;
}

function tileXy(lat, lng) {
  const n = 2 ** Z;
  const fx = ((lng + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return [fx, fy];
}

function pxToLl(px, py, x0, y0) {
  const n = 2 ** Z;
  const X = x0 + px / 256;
  const Y = y0 + py / 256;
  const lng = (X / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n))) * 180) / Math.PI;
  return { lat, lng };
}

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; const yi = ring[i][1];
    const xj = ring[j][0]; const yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringPerimeter(ring) {
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

function pointAt(ring, dist) {
  let rem = dist;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (rem <= seg || i === ring.length - 1) {
      const t = seg > 0 ? rem / seg : 0;
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
    }
    rem -= seg;
  }
  return { x: ring[0][0], y: ring[0][1] };
}

function nearestOnRing(ring, x, y) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const vx = b[0] - a[0]; const vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((x - a[0]) * vx + (y - a[1]) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + vx * t; const py = a[1] + vy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < bestD) {
      bestD = d;
      best = { x: px, y: py };
    }
  }
  return { point: best, dist: bestD };
}

function polygonCentroid(ring) {
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) return { x: ring[0][0], y: ring[0][1] };
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

async function fetchTiles(x0, y0, tiles) {
  const size = 256 * tiles;
  const img = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i += 1) {
    img[i * 3] = BACKGROUND[0];
    img[i * 3 + 1] = BACKGROUND[1];
    img[i * 3 + 2] = BACKGROUND[2];
  }
  for (let i = 0; i < tiles; i += 1) {
    for (let j = 0; j < tiles; j += 1) {
      const res = await fetch(TILE.replace("{z}", Z).replace("{x}", String(x0 + i)).replace("{y}", String(y0 + j)), {
        headers: UA,
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      for (let row = 0; row < Math.min(256, png.height); row += 1) {
        for (let col = 0; col < Math.min(256, png.width); col += 1) {
          const src = (row * png.width + col) * 4;
          const dst = ((j * 256 + row) * size + (i * 256 + col)) * 3;
          img[dst] = png.data[src];
          img[dst + 1] = png.data[src + 1];
          img[dst + 2] = png.data[src + 2];
        }
      }
    }
  }
  return img;
}

function roadMask(img, size) {
  const raw = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i += 1) {
    const r = img[i * 3]; const g = img[i * 3 + 1]; const b = img[i * 3 + 2];
    for (const [cr, cg, cb] of ROAD_COLORS) {
      if (Math.abs(r - cr) <= TOL && Math.abs(g - cg) <= TOL && Math.abs(b - cb) <= TOL) {
        raw[i] = 1;
        break;
      }
    }
  }
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      if (!raw[i]) continue;
      let keep = 1;
      for (let dy = -1; dy <= 1 && keep; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          const ni = (ny < 0 || ny >= size || nx < 0 || nx >= size) ? i : ny * size + nx;
          if (!raw[ni]) {
            keep = 0;
            break;
          }
        }
      }
      mask[i] = keep;
    }
  }
  return mask;
}

export async function nearestRoad(boundaryRing, searchPx = 768) {
  const ring = boundaryRing.map(([lng, lat]) => [Number(lng), Number(lat)]);
  const c = polygonCentroid(ring);
  const [fx, fy] = tileXy(c.y, c.x);
  const tiles = Math.floor(searchPx / 256);
  const x0 = Math.floor(fx) - Math.floor(tiles / 2);
  const y0 = Math.floor(fy) - Math.floor(tiles / 2);
  const size = 256 * tiles;

  let img;
  try {
    img = await fetchTiles(x0, y0, tiles);
  } catch {
    return null;
  }
  const mask = roadMask(img, size);

  const roadPts = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (mask[y * size + x]) roadPts.push([x, y]);
    }
  }
  if (roadPts.length === 0) return null;

  const bpx = ring.map(([lng, lat]) => {
    const [tx, ty] = tileXy(lat, lng);
    return [(tx - x0) * 256, (ty - y0) * 256];
  });

  const step = Math.max(1, Math.floor(roadPts.length / 4000));
  const sample = [];
  for (let i = 0; i < roadPts.length; i += step) {
    const [x, y] = roadPts[i];
    if (!pointInRing(x, y, bpx)) sample.push([x, y]);
  }
  if (sample.length === 0) return null;

  let k = 0;
  let bestD = Infinity;
  for (let i = 0; i < sample.length; i += 1) {
    const d = nearestOnRing(bpx, sample[i][0], sample[i][1]).dist;
    if (d < bestD) {
      bestD = d;
      k = i;
    }
  }
  const [rx, ry] = sample[k];
  const gate = nearestOnRing(bpx, rx, ry).point;
  const mPerPx = (156543.03 * Math.cos((c.y * Math.PI) / 180)) / 2 ** Z;
  return {
    gate: pxToLl(gate.x, gate.y, x0, y0),
    road: pxToLl(rx, ry, x0, y0),
    dist_m: bestD * mPerPx,
  };
}

export async function entranceFields(boundaryGeo, plotGeos = [], widthM = 12.0) {
  const ring = boundaryGeo.coordinates[0].map(([lng, lat]) => [Number(lng), Number(lat)]);
  const hit = await nearestRoad(ring);
  if (!hit) return {};
  const { lat: rlat, lng: rlng } = hit.road;
  const kx = 111320 * Math.cos((rlat * Math.PI) / 180);
  const ky = 110574;
  const toM = (lng, lat) => [(lng - rlng) * kx, (lat - rlat) * ky];
  const bpoly = ring.map(([lng, lat]) => toM(lng, lat));
  const plots = plotGeos.filter(Boolean).map((g) => g.coordinates[0].map(([lng, lat]) => toM(lng, lat)));

  const cen = polygonCentroid(bpoly);
  const perimeter = ringPerimeter(bpoly);
  const n = Math.max(8, Math.floor(perimeter / 2));
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < n; i += 1) {
    const p = pointAt(bpoly, (i / n) * perimeter);
    const vx = cen.x - p.x;
    const vy = cen.y - p.y;
    const L = Math.hypot(vx, vy) || 1;
    const q = { x: p.x + (vx / L) * 8, y: p.y + (vy / L) * 8 };
    const blocked = plots.some((pl) => pointInRing(q.x, q.y, pl));
    const score = Math.hypot(p.x, p.y) + (blocked ? 400 : 0);
    if (score < bestScore) {
      best = p;
      bestScore = score;
    }
  }
  const glat = rlat + best.y / ky;
  const glng = rlng + best.x / kx;
  const dx = -best.x;
  const dy = -best.y;
  const L = Math.hypot(dx, dy);
  const out = {
    entrance: { type: "Point", coordinates: [pyRound(glng, 7), pyRound(glat, 7)] },
    entry_width_m: widthM,
    entry_distance_m: pyRound(L, 1),
  };
  if (L < 3 || L > 400) return out;

  const ux = dx / L;
  const uy = dy / L;
  const nx = (-uy * widthM) / 2;
  const ny = (ux * widthM) / 2;
  const ext = 4.0;
  const inset = 6.0;
  const pts = [
    [-ux * inset + nx, -uy * inset + ny],
    [ux * (L + ext) + nx, uy * (L + ext) + ny],
    [ux * (L + ext) - nx, uy * (L + ext) - ny],
    [-ux * inset - nx, -uy * inset - ny],
  ];
  const toLl = (x, y) => [pyRound(glng + x / kx, 7), pyRound(glat + y / ky, 7)];
  const ringOut = pts.map(([x, y]) => toLl(x, y));
  ringOut.push(ringOut[0]);
  out.entry_road = { type: "Polygon", coordinates: [ringOut] };
  out.entry_centerline = {
    type: "LineString",
    coordinates: [toLl(-ux * inset, -uy * inset), toLl(ux * (L + ext), uy * (L + ext))],
  };
  return out;
}
