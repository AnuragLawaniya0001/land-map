// Geo helpers for Leaflet rendering (GeoJSON [lng,lat] -> Leaflet [lat,lng])
export const toLeaflet = (geo) => geo?.coordinates?.[0]?.map(([lng, lat]) => [lat, lng]) || [];

const validRing = (coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length < 4) return false;
  const validPoints = coordinates.every((point) =>
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 90,
  );
  if (!validPoints) return false;
  const distinct = new Set(coordinates.slice(0, -1).map(([lng, lat]) => `${lng},${lat}`));
  return distinct.size >= 3 &&
    coordinates[0][0] === coordinates.at(-1)[0] &&
    coordinates[0][1] === coordinates.at(-1)[1];
};

export const isSelectablePlotGeometry = (geometry) => {
  if (geometry?.type === "Polygon") {
    return Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length > 0 &&
      geometry.coordinates.every(validRing);
  }
  if (geometry?.type === "MultiPolygon") {
    return Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length > 0 &&
      geometry.coordinates.every((polygon) =>
        Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing),
      );
  }
  return false;
};

export const getUnrepresentedPdfPlots = (existingPlots = [], pdfPlots = []) => {
  const normalizeNumber = (number) =>
    String(number ?? "").trim().toUpperCase().replace(/[\s/-]/g, "");
  const representedNumbers = new Set(
    existingPlots.map((plot) => normalizeNumber(plot.number)).filter(Boolean),
  );
  const includedNumbers = new Set();
  return pdfPlots.filter((plot) => {
    if (!isSelectablePlotGeometry(plot.geometry)) return false;
    const number = normalizeNumber(plot.number);
    if (!number) return existingPlots.length === 0;
    if (representedNumbers.has(number) || includedNumbers.has(number)) return false;
    includedNumbers.add(number);
    return true;
  });
};

const coordinatesToLatLngs = (coordinates) => {
  if (Array.isArray(coordinates) && coordinates.length >= 2 &&
      Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])) {
    return [coordinates[1], coordinates[0]];
  }
  return Array.isArray(coordinates) ? coordinates.map(coordinatesToLatLngs) : [];
};

export const geoJSONToLatLngs = (geometry) =>
  isSelectablePlotGeometry(geometry) ? coordinatesToLatLngs(geometry.coordinates) : [];

const pointOnSegment = (x, y, a, b) => {
  const cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
  if (Math.abs(cross) > 1e-10) return false;
  return x >= Math.min(a[0], b[0]) - 1e-10 &&
    x <= Math.max(a[0], b[0]) + 1e-10 &&
    y >= Math.min(a[1], b[1]) - 1e-10 &&
    y <= Math.max(a[1], b[1]) + 1e-10;
};

const ringContainsPoint = (ringCoordinates, longitude, latitude) => {
  let inside = false;
  for (let index = 0, previous = ringCoordinates.length - 1;
    index < ringCoordinates.length;
    previous = index, index += 1) {
    const a = ringCoordinates[previous];
    const b = ringCoordinates[index];
    if (pointOnSegment(longitude, latitude, a, b)) return true;
    const crosses = (a[1] > latitude) !== (b[1] > latitude);
    if (crosses && longitude < ((b[0] - a[0]) * (latitude - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
};

export const geoJSONContainsPoint = (geometry, point) => {
  if (!Array.isArray(point) || point.length < 2 ||
      !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
  const [latitude, longitude] = point;
  const polygons = geometry?.type === "Polygon"
    ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  return polygons.some((rings) => {
    if (!Array.isArray(rings) || !rings.length || !validRing(rings[0])) return false;
    if (!ringContainsPoint(rings[0], longitude, latitude)) return false;
    return !rings.slice(1).some((hole) =>
      validRing(hole) && ringContainsPoint(hole, longitude, latitude),
    );
  });
};

export const findPlotAtPoint = (plots, point, landBoundary) => {
  if (!geoJSONContainsPoint(landBoundary, point)) return null;
  const hits = (plots || []).filter((plot) => {
    const geometry = plot.selectionGeometry || plot.geometry;
    if (!isSelectablePlotGeometry(geometry)) return false;
    const bounds = geoJSONBounds(geometry);
    return bounds &&
      point[0] >= bounds[0][0] && point[0] <= bounds[1][0] &&
      point[1] >= bounds[0][1] && point[1] <= bounds[1][1] &&
      geoJSONContainsPoint(geometry, point);
  });
  hits.sort((left, right) => {
    const leftBounds = geoJSONBounds(left.selectionGeometry || left.geometry);
    const rightBounds = geoJSONBounds(right.selectionGeometry || right.geometry);
    const leftArea = (leftBounds[1][0] - leftBounds[0][0]) *
      (leftBounds[1][1] - leftBounds[0][1]);
    const rightArea = (rightBounds[1][0] - rightBounds[0][0]) *
      (rightBounds[1][1] - rightBounds[0][1]);
    return leftArea - rightArea ||
      String(left.id || left.number).localeCompare(String(right.id || right.number));
  });
  return hits[0] || null;
};

export const geoJSONBounds = (geometry) => {
  const polygons = geometry?.type === "Polygon"
    ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  const points = polygons.flat(2).filter((point) =>
    Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
  if (!points.length) return null;
  return [
    [Math.min(...points.map((point) => point[1])), Math.min(...points.map((point) => point[0]))],
    [Math.max(...points.map((point) => point[1])), Math.max(...points.map((point) => point[0]))],
  ];
};

const toMercator = (longitude, latitude) => {
  const radius = 6378137;
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return [
    radius * longitude * Math.PI / 180,
    radius * Math.log(Math.tan(Math.PI / 4 + clampedLatitude * Math.PI / 360)),
  ];
};

const fromMercator = (x, y) => {
  const radius = 6378137;
  return [
    x / radius * 180 / Math.PI,
    (2 * Math.atan(Math.exp(y / radius)) - Math.PI / 2) * 180 / Math.PI,
  ];
};

export const transformOverlayGeometry = (geometry, bounds, transform = {}) => {
  if (!isSelectablePlotGeometry(geometry) || !Array.isArray(bounds) || bounds.length !== 2) {
    return geometry;
  }
  const rotation = Number(transform.rotation_deg || 0) * Math.PI / 180;
  const scaleX = Number(transform.scale_x ?? 1);
  const scaleY = Number(transform.scale_y ?? 1);
  const translateX = Number(transform.translation_x_m || 0);
  const translateY = Number(transform.translation_y_m || 0);
  if (![rotation, scaleX, scaleY, translateX, translateY].every(Number.isFinite)) return geometry;

  const northWest = toMercator(bounds[0][1], bounds[1][0]);
  const southEast = toMercator(bounds[1][1], bounds[0][0]);
  const centerX = (northWest[0] + southEast[0]) / 2;
  const centerY = (northWest[1] + southEast[1]) / 2;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);

  const transformCoordinates = (coordinates) => {
    if (Array.isArray(coordinates) && coordinates.length >= 2 &&
        Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])) {
      const [x, y] = toMercator(coordinates[0], coordinates[1]);
      const dx = (x - centerX) * scaleX;
      const dy = (y - centerY) * scaleY;
      return fromMercator(
        centerX + dx * cosine + dy * sine + translateX,
        centerY - dx * sine + dy * cosine + translateY,
      );
    }
    return Array.isArray(coordinates) ? coordinates.map(transformCoordinates) : coordinates;
  };
  return { ...geometry, coordinates: transformCoordinates(geometry.coordinates) };
};

export const transformOverlayPoint = (coordinates, bounds, transform = {}) => {
  if (!Array.isArray(coordinates) || coordinates.length < 2 ||
      !coordinates.slice(0, 2).every(Number.isFinite) ||
      !Array.isArray(bounds) || bounds.length !== 2) return coordinates;
  const rotation = Number(transform.rotation_deg || 0) * Math.PI / 180;
  const scaleX = Number(transform.scale_x ?? 1);
  const scaleY = Number(transform.scale_y ?? 1);
  const translateX = Number(transform.translation_x_m || 0);
  const translateY = Number(transform.translation_y_m || 0);
  if (![rotation, scaleX, scaleY, translateX, translateY].every(Number.isFinite)) {
    return coordinates;
  }
  const northWest = toMercator(bounds[0][1], bounds[1][0]);
  const southEast = toMercator(bounds[1][1], bounds[0][0]);
  const centerX = (northWest[0] + southEast[0]) / 2;
  const centerY = (northWest[1] + southEast[1]) / 2;
  const [x, y] = toMercator(coordinates[0], coordinates[1]);
  const dx = (x - centerX) * scaleX;
  const dy = (y - centerY) * scaleY;
  return fromMercator(
    centerX + dx * Math.cos(rotation) + dy * Math.sin(rotation) + translateX,
    centerY - dx * Math.sin(rotation) + dy * Math.cos(rotation) + translateY,
  );
};

export const ring = (positions) => {
  if (!positions?.length) return [];
  const [a, b] = [positions[0], positions[positions.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? positions.slice(0, -1) : positions;
};

export const centroid = (positions) => {
  const pts = ring(positions);
  if (!pts.length) return null;
  const s = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
};

const M_PER_LAT = 110574;
const mPerLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

export const distM = (a, b) => {
  const lat = (a[0] + b[0]) / 2;
  const dy = (b[0] - a[0]) * M_PER_LAT;
  const dx = (b[1] - a[1]) * mPerLng(lat);
  return Math.hypot(dx, dy);
};

// Dimension labels for every edge, placed just inside the plot along the edge (offset metres inward)
export const edgeDims = (positions, offset = 1.4) => {
  const pts = ring(positions);
  const c = centroid(pts);
  if (!c || pts.length < 3) return [];
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const lat = (a[0] + b[0]) / 2;
    const kx = mPerLng(lat);
    const dx = (b[1] - a[1]) * kx;
    const dy = (b[0] - a[0]) * M_PER_LAT;
    const len = Math.hypot(dx, dy) || 1;
    let nx = dy / len, ny = -dx / len;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const toC = [(c[1] - mid[1]) * kx, (c[0] - mid[0]) * M_PER_LAT];
    if (nx * toC[0] + ny * toC[1] < 0) { nx = -nx; ny = -ny; } // point inward
    const shift = (p) => [p[0] + (ny * offset) / M_PER_LAT, p[1] + (nx * offset) / kx];
    let angle = (-Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    return { key: i, mid: shift(mid), label: `${(len * 3.28084).toFixed(1)} ft`, len, angle };
  });
};

export const estimatePlotDimensions = (geometry) => {
  const polygon = geometry?.type === "Polygon"
    ? geometry.coordinates?.[0]
    : geometry?.type === "MultiPolygon"
      ? geometry.coordinates?.[0]?.[0]
      : null;
  if (!Array.isArray(polygon) || polygon.length < 4) return null;

  const latitude = polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length;
  const centerLng = polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length;
  const centerLat = latitude;
  const points = polygon.slice(0, -1).map(([lng, lat]) => [
    (lng - centerLng) * mPerLng(latitude),
    (lat - centerLat) * M_PER_LAT,
  ]);
  let bestArea = Infinity;
  let bestWidth = 0;
  let bestHeight = 0;

  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const rotated = points.map(([x, y]) => [
      x * cosine + y * sine,
      -x * sine + y * cosine,
    ]);
    const width = Math.max(...rotated.map(([x]) => x)) - Math.min(...rotated.map(([x]) => x));
    const height = Math.max(...rotated.map(([, y]) => y)) - Math.min(...rotated.map(([, y]) => y));
    const area = width * height;
    if (area < bestArea) {
      bestArea = area;
      bestWidth = Math.min(width, height);
      bestHeight = Math.max(width, height);
    }
  }
  if (!Number.isFinite(bestArea) || bestWidth <= 0 || bestHeight <= 0) return null;
  return {
    width_m: bestWidth,
    depth_m: bestHeight,
    dimensions: `Approx. ${bestWidth.toFixed(1)} m × ${bestHeight.toFixed(1)} m`,
    shape: "polygon",
  };
};

export const areaConversions = (sqm) => ({
  sqm: Math.round(sqm),
  sqft: Math.round(sqm * 10.7639),
  sqyd: Math.round(sqm * 1.19599),
});

export const fmt = (n) => Number(n).toLocaleString("en-IN");
export const mToFt = (m) => m * 3.28084;

// Pixels per metre at a given Leaflet zoom / latitude (Web Mercator)
export const pxPerMeter = (zoom, lat) => (256 * Math.pow(2, zoom)) / (40075016.686 * Math.cos((lat * Math.PI) / 180));

// Bounding box of a polygon in metres + screen angle/length of its longest edge
export const polyMetrics = (positions) => {
  const pts = ring(positions);
  if (pts.length < 3) return null;
  const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = mPerLng(lat);
  const w = (Math.max(...lngs) - Math.min(...lngs)) * kx;
  const h = (Math.max(...lats) - Math.min(...lats)) * M_PER_LAT;
  let best = { len: 0, angle: 0 };
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * M_PER_LAT;
    const len = Math.hypot(dx, dy);
    if (len > best.len) {
      let angle = (-Math.atan2(dy, dx) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      best = { len, angle };
    }
  });
  // thickness across the longest edge ≈ area / longest edge
  let area = 0;
  pts.forEach((a, i) => { const b = pts[(i + 1) % pts.length]; area += a[1] * kx * b[0] * M_PER_LAT - b[1] * kx * a[0] * M_PER_LAT; });
  area = Math.abs(area) / 2;
  return { w, h, area, longest: best.len, angle: best.angle, thickness: best.len ? area / best.len : Math.min(w, h), center: centroid(pts) };
};

// Font size (px) that keeps `chars` characters inside a box of lenPx × thickPx
export const fitFont = (lenPx, thickPx, chars, { max = 60, fill = 0.8 } = {}) =>
  Math.min(max, (thickPx * fill) / 1.1, (lenPx * fill) / (chars * 0.62));

export const waDigits = (num) => (num || "").replace(/\D/g, "");

export const waLink = (companyNumber, text) =>
  `https://wa.me/${waDigits(companyNumber)}?text=${encodeURIComponent(text)}`;
