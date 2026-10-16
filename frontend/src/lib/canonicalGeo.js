/**
 * Canonical Geospatial & Coordinate Transformation Utilities for 2D Vector Rendering.
 *
 * Handles GeoJSON geometry bounds, SVG path generation, aspect-ratio preservation,
 * viewport transformations, centroid calculations, and measurement formatting.
 */

/**
 * Computes bounding box [minX, minY, maxX, maxY] for any GeoJSON geometry or collection of features.
 */
export function computeGeometryBounds(features) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function processCoords(coords) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [x, y] = coords;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      return;
    }
    coords.forEach(processCoords);
  }

  if (Array.isArray(features)) {
    for (const feat of features) {
      const geom = feat?.geometry || feat;
      if (geom?.coordinates) {
        processCoords(geom.coordinates);
      }
    }
  } else if (features?.coordinates) {
    processCoords(features.coordinates);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return [0, 0, 1000, 1000];
  }

  // Ensure non-zero width and height
  if (maxX <= minX) maxX = minX + 10;
  if (maxY <= minY) maxY = minY + 10;

  return [minX, minY, maxX, maxY];
}

/**
 * Calculates centroid [x, y] of a 2D polygon ring.
 */
export function getPolygonCentroid(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return [0, 0];
  const n = ring.length;
  // Shift to local origin (first vertex) to eliminate floating-point catastrophic cancellation
  // on geographic WGS84 coordinates (e.g. 78.2543, 27.2230)
  const ox = ring[0][0];
  const oy = ring[0][1];
  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < n - 1; i++) {
    const x0 = ring[i][0] - ox;
    const y0 = ring[i][1] - oy;
    const x1 = ring[i + 1][0] - ox;
    const y1 = ring[i + 1][1] - oy;
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }

  area = area / 2;
  if (Math.abs(area) < 1e-12) {
    // Fallback to vertex average
    let sx = 0, sy = 0;
    const count = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n;
    for (let i = 0; i < count; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return [sx / count, sy / count];
  }

  return [ox + cx / (6 * area), oy + cy / (6 * area)];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function isPointInsidePolygon(point, rings) {
  return Boolean(
    rings?.[0]?.length &&
    pointInRing(point, rings[0]) &&
    !rings.slice(1).some((ring) => pointInRing(point, ring))
  );
}

function distanceToRing(point, ring) {
  let minDistance = Infinity;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared
      ? Math.max(0, Math.min(1, ((point[0] - x1) * dx + (point[1] - y1) * dy) / lengthSquared))
      : 0;
    minDistance = Math.min(
      minDistance,
      Math.hypot(point[0] - (x1 + t * dx), point[1] - (y1 + t * dy))
    );
  }
  return minDistance;
}

function getInteriorLabelPoint(rings) {
  const centroid = getPolygonCentroid(rings?.[0]);
  if (isPointInsidePolygon(centroid, rings)) return centroid;

  const [minX, minY, maxX, maxY] = computeGeometryBounds({
    type: "Polygon",
    coordinates: rings,
  });
  let bestPoint = null;
  let bestClearance = -1;
  const searchRings = rings.filter((ring) => Array.isArray(ring) && ring.length > 1);

  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const point = [
        minX + ((column + 0.5) / 16) * (maxX - minX),
        minY + ((row + 0.5) / 16) * (maxY - minY),
      ];
      if (!isPointInsidePolygon(point, rings)) continue;
      const clearance = Math.min(...searchRings.map((ring) => distanceToRing(point, ring)));
      if (clearance > bestClearance) {
        bestPoint = point;
        bestClearance = clearance;
      }
    }
  }

  return bestPoint || centroid;
}

export function getGeometryLabelPoint(geometry) {
  if (!geometry) return [0, 0];
  if (geometry.type === "Polygon") {
    return getInteriorLabelPoint(geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates || [];
    const largest = polygons.reduce((best, polygon) => {
      const ring = polygon?.[0] || [];
      const area = Math.abs(ring.reduce((sum, point, index) => {
        const next = ring[index + 1];
        if (!next) return sum;
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0));
      return area > best.area ? { area, ring } : best;
    }, { area: -1, ring: [] });
    const largestPolygon = polygons.find((polygon) => polygon?.[0] === largest.ring);
    return getInteriorLabelPoint(largestPolygon || [largest.ring]);
  }
  if (geometry.type === "LineString" && geometry.coordinates?.length) {
    const coordinates = geometry.coordinates;
    const lengths = coordinates.slice(1).map((point, index) =>
      Math.hypot(point[0] - coordinates[index][0], point[1] - coordinates[index][1])
    );
    const totalLength = lengths.reduce((sum, length) => sum + length, 0);
    if (totalLength === 0) return coordinates[0];
    let remaining = totalLength / 2;
    for (let index = 0; index < lengths.length; index += 1) {
      if (remaining <= lengths[index]) {
        const fraction = remaining / lengths[index];
        return [
          coordinates[index][0] + fraction * (coordinates[index + 1][0] - coordinates[index][0]),
          coordinates[index][1] + fraction * (coordinates[index + 1][1] - coordinates[index][1]),
        ];
      }
      remaining -= lengths[index];
    }
  }
  return [0, 0];
}

/**
 * Converts GeoJSON Polygon or MultiPolygon coordinates into an SVG path `d` string.
 * Supports optional invertY to convert GIS coordinates (Y pointing up) to SVG coordinates (Y pointing down).
 */
export function geoJsonToSvgPath(geometry, invertY = false, bounds = null) {
  if (!geometry || !geometry.coordinates) return "";
  const maxY = bounds ? bounds[3] : 0;

  function transformPt(pt) {
    const x = pt[0];
    const y = invertY && bounds ? bounds[1] + (maxY - pt[1]) : pt[1];
    return `${Number(x).toFixed(8)},${Number(y).toFixed(8)}`;
  }

  function ringToPath(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return "";
    const pts = ring.map(transformPt);
    return `M ${pts.join(" L ")} Z`;
  }

  if (geometry.type === "Polygon") {
    return geometry.coordinates.map(ringToPath).join(" ");
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((poly) => poly.map(ringToPath).join(" ")).join(" ");
  }

  if (geometry.type === "LineString") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) return "";
    const pts = geometry.coordinates.map(transformPt);
    return `M ${pts.join(" L ")}`;
  }

  if (geometry.type === "MultiLineString") {
    return geometry.coordinates
      .filter((line) => Array.isArray(line) && line.length >= 2)
      .map((line) => `M ${line.map(transformPt).join(" L ")}`)
      .join(" ");
  }

  return "";
}

/**
 * Formats a measurement string preserving declared units without fabricating missing values.
 */
export function formatMeasurement(val, unit = "") {
  if (val === null || val === undefined || Number.isNaN(val)) {
    return "Not specified";
  }
  const formattedVal = Number(val).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit ? `${formattedVal} ${unit}` : formattedVal;
}

/**
 * Normalizes plot query for search without altering canonical data.
 */
export function matchesPlotSearch(plot, query) {
  if (!query) return true;
  const q = String(query).trim().toLowerCase();
  const rawNum = String(
    plot.original_number || plot.number || plot.source_label || plot.name || ""
  ).toLowerCase();
  const normNum = String(plot.normalized_number || "").toLowerCase();
  const id = String(plot.id || "").toLowerCase();
  return rawNum.includes(q) || normNum.includes(q) || id.includes(q);
}

function isFinitePosition(position) {
  return Array.isArray(position) &&
    position.length >= 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]);
}

function isValidRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isFinitePosition)) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return false;
  const unique = new Set(ring.slice(0, -1).map(([x, y]) => `${x},${y}`));
  return unique.size >= 3;
}

export function isRenderableGeometry(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return false;
  if (geometry.type === "Polygon") {
    return geometry.coordinates.length > 0 && geometry.coordinates.every(isValidRing);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.length > 0 &&
      geometry.coordinates.every((polygon) =>
        Array.isArray(polygon) && polygon.length > 0 && polygon.every(isValidRing)
      );
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates.length >= 2 && geometry.coordinates.every(isFinitePosition);
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.length > 0 &&
      geometry.coordinates.every((line) =>
        Array.isArray(line) && line.length >= 2 && line.every(isFinitePosition)
      );
  }
  return false;
}

export function normalizeLegacyPlotsForReview(plots, colonyId) {
  if (!Array.isArray(plots)) return { plots: [], rejected: 0 };
  const normalized = [];
  let rejected = 0;

  plots.forEach((plot, index) => {
    if (!isRenderableGeometry(plot?.geometry)) {
      rejected += 1;
      return;
    }

    const id = plot.id || plot._id || `legacy-${colonyId}-${index + 1}`;
    const number = String(plot.original_number || plot.number || "").trim();
    normalized.push({
      ...plot,
      id: String(id),
      colony_id: String(plot.colony_id || colonyId),
      original_number: number,
      normalized_number: plot.normalized_number || number || null,
      semantic_validation_status: "review_required",
      geometry_valid: null,
      is_provisional_legacy: true,
      unresolved_warnings: [
        ...(Array.isArray(plot.unresolved_warnings) ? plot.unresolved_warnings : []),
        "Loaded from legacy plot storage; canonical verification has not been established.",
      ],
    });
  });

  return { plots: normalized, rejected };
}

export function normalizeLegacyLandUseForReview(features, colonyId) {
  if (!Array.isArray(features)) return { features: [], rejected: 0 };
  const normalized = [];
  let rejected = 0;

  features.forEach((feature, index) => {
    if (!["Polygon", "MultiPolygon"].includes(feature?.geometry?.type) ||
        !isRenderableGeometry(feature.geometry)) {
      rejected += 1;
      return;
    }
    normalized.push({
      ...feature,
      id: String(feature.id || feature._id || `legacy-open-space-${colonyId}-${index + 1}`),
      feature_class: feature.feature_class || feature.classification || "green_space",
      validation_status: "review_required",
      is_provisional_legacy: true,
    });
  });
  return { features: normalized, rejected };
}

/**
 * Computes plot dimensions (area in m² & yd², perimeter, edge lengths, facing direction).
 */
export function computePlotDimensionsAndOrientation(geometry, scaleMetersPerCoordinate = null, frontageEdges = []) {
  if (!geometry || !geometry.coordinates) return null;
  const ring = geometry.type === "Polygon"
    ? geometry.coordinates[0]
    : geometry.type === "MultiPolygon"
      ? geometry.coordinates[0]?.[0]
      : null;
  if (!Array.isArray(ring) || ring.length < 4) return null;

  // Shoelace area
  let areaCoord = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    areaCoord += (x0 * y1 - x1 * y0);
  }
  areaCoord = Math.abs(areaCoord) / 2;

  const scale = Number(scaleMetersPerCoordinate) > 0 ? Number(scaleMetersPerCoordinate) : 1;
  const areaSqM = areaCoord * (scale * scale);
  const areaSqYd = areaSqM * 1.19599;

  // Compute edges with length in meters
  const edges = [];
  let longestEdge = null;
  let maxEdgeLen = -1;

  for (let i = 0; i < ring.length - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const coordLen = Math.hypot(dx, dy);
    if (coordLen < 1e-9) continue;
    const lenM = coordLen * scale;
    const edgeObj = {
      index: i,
      p1,
      p2,
      dx,
      dy,
      coordLen,
      lenM,
      mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2],
      angleRad: Math.atan2(dy, dx),
    };
    edges.push(edgeObj);
    if (lenM > maxEdgeLen) {
      maxEdgeLen = lenM;
      longestEdge = edgeObj;
    }
  }

  // Determine facing direction (East, West, North, South)
  let facing = "East";
  if (frontageEdges && frontageEdges.length > 0) {
    // Frontage edge normal points outward into road
    const frontGeom = frontageEdges[0]?.geometry;
    if (frontGeom?.coordinates?.length >= 2) {
      const c = frontGeom.coordinates;
      const fDx = c[1][0] - c[0][0];
      const fDy = c[1][1] - c[0][1];
      // Normal vector
      const nx = -fDy;
      const ny = fDx;
      const angleDeg = ((Math.atan2(ny, nx) * 180) / Math.PI + 360) % 360;
      if (angleDeg >= 45 && angleDeg < 135) facing = "North";
      else if (angleDeg >= 135 && angleDeg < 225) facing = "West";
      else if (angleDeg >= 225 && angleDeg < 315) facing = "South";
      else facing = "East";
    }
  } else if (longestEdge) {
    const angleDeg = ((longestEdge.angleRad * 180) / Math.PI + 360) % 360;
    if ((angleDeg >= 45 && angleDeg <= 135) || (angleDeg >= 225 && angleDeg <= 315)) {
      facing = "East";
    } else {
      facing = "North";
    }
  }

  return {
    areaSqM: Math.round(areaSqM * 100) / 100,
    areaSqYd: Math.round(areaSqYd * 100) / 100,
    edges,
    facing,
  };
}

/**
 * Generates procedural surrounding landscape features (survey parcels, access tracks, contours)
 * centered around the colony boundary, creating a realistic custom master-plan map without 3rd party tile servers.
 */
export function generateProceduralLandscapeFeatures(datasetBounds) {
  const [minX, minY, maxX, maxY] = datasetBounds;
  const spanX = maxX - minX || 100;
  const spanY = maxY - minY || 100;

  // Outer bounds expanded by 1.8x
  const expandFactor = 1.8;
  const padX = spanX * expandFactor;
  const padY = spanY * expandFactor;
  const outerBounds = [minX - padX, minY - padY, maxX + padX, maxY + padY];

  const surveyParcels = [];
  const contourLines = [];
  const accessTracks = [];

  // Deterministic seed helper
  let seed = 42;
  const pseudoRandom = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };

  // 1. Surrounding cadastral survey parcels
  const gridCountX = 7;
  const gridCountY = 6;
  const stepX = (outerBounds[2] - outerBounds[0]) / gridCountX;
  const stepY = (outerBounds[3] - outerBounds[1]) / gridCountY;

  for (let ix = 0; ix < gridCountX; ix++) {
    for (let iy = 0; iy < gridCountY; iy++) {
      const px0 = outerBounds[0] + ix * stepX;
      const py0 = outerBounds[1] + iy * stepY;
      const px1 = px0 + stepX;
      const py1 = py0 + stepY;

      // Don't draw parcel directly over the colony core
      const centerX = (px0 + px1) / 2;
      const centerY = (py0 + py1) / 2;
      if (centerX > minX - spanX * 0.1 && centerX < maxX + spanX * 0.1 &&
          centerY > minY - spanY * 0.1 && centerY < maxY + spanY * 0.1) {
        continue;
      }

      const jitterX1 = (pseudoRandom() - 0.5) * stepX * 0.15;
      const jitterY1 = (pseudoRandom() - 0.5) * stepY * 0.15;
      const jitterX2 = (pseudoRandom() - 0.5) * stepX * 0.15;
      const jitterY2 = (pseudoRandom() - 0.5) * stepY * 0.15;

      surveyParcels.push({
        id: `surround-parcel-${ix}-${iy}`,
        path: `M ${px0 + jitterX1},${py0 + jitterY1} L ${px1 + jitterX2},${py0} L ${px1},${py1 + jitterY2} L ${px0},${py1} Z`,
        fill: ix % 2 === 0 ? "rgba(255, 255, 255, 0.012)" : "rgba(0, 0, 0, 0.15)",
        surveyNumber: `Survey ${100 + ix * 10 + iy}`,
        center: [centerX, centerY],
      });
    }
  }

  // 2. Surrounding natural topography contours
  const contourCount = 8;
  for (let c = 0; c < contourCount; c++) {
    const yRatio = c / contourCount;
    const cy = outerBounds[1] + yRatio * (outerBounds[3] - outerBounds[1]);
    const x0 = outerBounds[0];
    const xMid1 = outerBounds[0] + (outerBounds[2] - outerBounds[0]) * 0.33;
    const xMid2 = outerBounds[0] + (outerBounds[2] - outerBounds[0]) * 0.66;
    const x1 = outerBounds[2];

    const wave1 = Math.sin(c * 1.5) * spanY * 0.25;
    const wave2 = Math.cos(c * 2.1) * spanY * 0.22;

    contourLines.push({
      id: `contour-${c}`,
      d: `M ${x0},${cy} Q ${xMid1},${cy + wave1} ${(xMid1 + xMid2) / 2},${cy + (wave1 + wave2) / 2} T ${x1},${cy + wave2}`,
    });
  }

  // 3. Surrounding approach roads / tracks connecting to colony corners
  accessTracks.push(
    `M ${outerBounds[0]},${(minY + maxY) / 2} L ${minX},${(minY + maxY) / 2}`,
    `M ${maxX},${(minY + maxY) / 2} L ${outerBounds[2]},${(minY + maxY) / 2 + spanY * 0.2}`,
    `M ${(minX + maxX) / 2},${minY} L ${(minX + maxX) / 2 - spanX * 0.3},${outerBounds[1]}`,
    `M ${(minX + maxX) / 2},${maxY} L ${(minX + maxX) / 2 + spanX * 0.4},${outerBounds[3]}`
  );

  return {
    outerBounds,
    surveyParcels,
    contourLines,
    accessTracks,
  };
}

/**
 * Color and style tokens for canonical layers and validation statuses.
 * Matches luxury master layout aesthetic (reference NAKSHATRA):
 * - Dark satellite/cadastral charcoal canvas
 * - Warm bone/cream luxury plots with sharp dark borders
 * - Dark asphalt roads with white dashed centerlines and directional arrows
 * - Rich olive park & amenity spaces with tree foliage
 * - Electric blue active selection with detailed dimension callouts
 */
export const CANONICAL_THEME = {
  plan: {
    background: "#1e2229",        // Architectural drawing canvas
    boundaryFill: "#1e2227",
    grid: "rgba(255, 255, 255, 0.04)",
    contour: "rgba(255, 255, 255, 0.05)",
    landUseFill: "#5a8a37",       // Rich lush lawn grass
    landUseStroke: "#3a5b21",
    landUseText: "#ffffff",
  },
  boundary: {
    stroke: "#ffffff", // Solid perimeter boundary wall
    strokeWidth: 3,
    strokeDasharray: "none",
    fill: "none",
    outerGlow: "rgba(0, 0, 0, 0.6)",
  },
  road: {
    fill: "#323640", // Textured asphalt road
    stroke: "#ded7cb", // Concrete curb & 3' walkway border
    strokeWidth: 2,
    hoverFill: "#3e434f",
    centerline: "#ffffff", // White dashed road divider
    arrowColor: "#ffffff",
    textFill: "#f8fafc",
  },
  plot: {
    fill: "#f8f5ee",              // Luxury warm ivory bungalow paving
    stroke: "#2a2721",            // Crisp dark architectural boundary
    strokeWidth: 1.4,
    textFill: "#181b20",          // Sharp readable label
    hoverFill: "#ede5d8",
    selectedFill: "#82cebf",      // Vibrant mint/teal highlight
    selectedStroke: "#00c08b",    // Emerald outline
    selectedStrokeWidth: 3,
  },
  frontageEdge: {
    stroke: "#00c08b",
    strokeWidth: 3,
  },
  reviewRequired: {
    fill: "#f8f5ee", // Warm luxury ivory finish
    stroke: "#d97706", // Distinct warning amber border
    badgeBg: "bg-amber-100 text-amber-800 border-amber-300",
  },
  conflicted: {
    fill: "#fee2e2",
    stroke: "#dc2626",
    badgeBg: "bg-red-100 text-red-800 border-red-300",
  },
  verified: {
    fill: "#f8f5ee",
    stroke: "#2a2721",
    badgeBg: "bg-emerald-100 text-emerald-800 border-emerald-300",
  },
};

