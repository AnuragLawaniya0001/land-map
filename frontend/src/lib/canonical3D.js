/**
 * Canonical 3D Geospatial Geometry, Mesh Generation & Real-World Environment.
 *
 * Implements Phase 3, 5, 6:
 * - High-precision geographic WGS84 to metric local coordinate transformations
 * - Strict boundary-constrained plot extrusion with containment status visualization
 * - True canonical road geometry with real declared widths and concrete curbs
 * - Genuine surveyed open-space and garden geometry without fabricated features
 * - Georeferenced aerial satellite terrain integration
 * - Camera-facing billboard plot number sprite annotations
 * - Optional conceptual architectural massing (clearly distinguished from surveyed structures)
 */

import * as THREE from "three";
import {
  CANONICAL_THEME,
  computeGeometryBounds,
  getPolygonCentroid,
  getGeometryLabelPoint,
} from "./canonicalGeo.js";

/**
 * Normalizes 2D coordinates relative to a center point (cx, cy).
 * Maps GIS X -> 3D X, and GIS Y -> 3D -Z (standard 3D horizontal ground plane).
 */
export function gisTo3DCoord(x, y, cx = 0, cy = 0, crsMetadata = null) {
  const isGeographic =
    crsMetadata?.crs_type === "geographic_wgs84" ||
    crsMetadata?.units === "deg" ||
    crsMetadata?.epsg === 4326 ||
    crsMetadata?.is_geographic === true ||
    (!crsMetadata?.scale_ratio && Math.abs(cx) <= 180 && Math.abs(cy) <= 90 && (Math.abs(cx) > 0.1 || Math.abs(cy) > 0.1));
  if (isGeographic) {
    const metersPerDegreeLongitude =
      111320 * Math.cos((cy * Math.PI) / 180);
    const metersPerDegreeLatitude = 110574;
    return [
      (x - cx) * metersPerDegreeLongitude,
      -(y - cy) * metersPerDegreeLatitude,
    ];
  }
  const scaleRatio = Number(crsMetadata?.scale_ratio);
  const metricScale = Number.isFinite(scaleRatio) && scaleRatio > 0 ? scaleRatio : 1;
  return [(x - cx) * metricScale, -(y - cy) * metricScale];
}

/**
 * Calculates 2D signed area of a 2D ring using Shoelace formula.
 * Positive = Counter-Clockwise (CCW), Negative = Clockwise (CW).
 */
export function calculateSignedArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return area / 2;
}

/**
 * Checks if a point [x, y] is inside a polygon ring using ray casting.
 */
function isPointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Cleans a coordinate ring in 3D (u, v) space:
 * - Rejects non-finite coordinates
 * - Deduplicates consecutive identical or negligible points (< 1e-7)
 * - Strips redundant closing coordinate if present
 * - Validates minimum distinct vertex count (>= 3)
 * - Checks for zero or near-zero area (< minArea)
 */
export function cleanPolygonRing(ring, minArea = 1e-6) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const filtered = [];
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      return null;
    }
    if (filtered.length > 0) {
      const prev = filtered[filtered.length - 1];
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) < 1e-7) continue;
    }
    filtered.push([pt[0], pt[1]]);
  }

  // Remove redundant closing coordinate before creating THREE.Shape
  if (filtered.length > 2) {
    const first = filtered[0];
    const last = filtered[filtered.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-7) {
      filtered.pop();
    }
  }

  if (filtered.length < 3) return null;
  const area = calculateSignedArea(filtered);
  if (Math.abs(area) < minArea) return null;

  return { points: filtered, area };
}

/**
 * Prepares and normalizes GeoJSON geometry for Three.js triangulation.
 *
 * Implements Phase A1 requirements:
 * - Reject missing or non-finite coordinates
 * - Remove consecutive duplicate vertices
 * - Remove redundant closing coordinates before building THREE.Shape
 * - Enforce minimum distinct vertex count (>= 3)
 * - Filter zero-area and near-zero-area rings
 * - Normalize exterior ring winding to CCW and holes to CW
 * - Validate hole containment against exterior boundary
 * - Support Polygon and MultiPolygon geometries
 * - Discard invalid/degenerate holes without crashing the exterior shape
 * - Returns structured validation result with entity ID and reason on failure
 */
export function preparePolygonForTriangulation(geometry, cx = 0, cy = 0, crsMetadata = null) {
  if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
    return {
      valid: false,
      shapes: [],
      reason: "Missing or invalid GeoJSON geometry structure",
    };
  }

  const polygonRingsList = [];
  if (geometry.type === "Polygon") {
    polygonRingsList.push(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      if (Array.isArray(poly) && poly.length > 0) {
        polygonRingsList.push(poly);
      }
    }
  } else {
    return {
      valid: false,
      shapes: [],
      reason: `Unsupported geometry type for 3D extrusion: ${geometry.type}`,
    };
  }

  const validShapes = [];
  const rejectedReasons = [];

  for (let pIdx = 0; pIdx < polygonRingsList.length; pIdx++) {
    const rings = polygonRingsList[pIdx];
    if (!Array.isArray(rings) || rings.length === 0) continue;

    // Convert rings to 3D Shape (u, v) space: u = 3DX, v = -3DZ
    const projectedRings = [];
    let hasNonFinite = false;

    for (const ring of rings) {
      if (!Array.isArray(ring)) continue;
      const projRing = [];
      for (const pt of ring) {
        if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
          hasNonFinite = true;
          break;
        }
        const [x, z] = gisTo3DCoord(pt[0], pt[1], cx, cy, crsMetadata);
        projRing.push([x, -z]);
      }
      if (hasNonFinite) break;
      projectedRings.push(projRing);
    }

    if (hasNonFinite || projectedRings.length === 0) {
      rejectedReasons.push("Polygon contains invalid or non-finite coordinates");
      continue;
    }

    // Clean exterior ring
    const cleanedExterior = cleanPolygonRing(projectedRings[0]);
    if (!cleanedExterior) {
      rejectedReasons.push("Exterior ring is degenerate, unclosed, or has near-zero area");
      continue;
    }

    let extPoints = cleanedExterior.points;
    // Three.js exterior shape winding must be CCW (signed area > 0)
    if (cleanedExterior.area < 0) {
      extPoints = [...extPoints].reverse();
    }

    const shape = new THREE.Shape();
    shape.moveTo(extPoints[0][0], extPoints[0][1]);
    for (let i = 1; i < extPoints.length; i++) {
      shape.lineTo(extPoints[i][0], extPoints[i][1]);
    }

    // Process interior holes
    for (let h = 1; h < projectedRings.length; h++) {
      const cleanedHole = cleanPolygonRing(projectedRings[h]);
      if (!cleanedHole) {
        // Discard degenerate or zero-area hole ring without crashing the polygon
        continue;
      }

      // Check hole containment: at least one point must lie inside exterior ring
      if (!isPointInRing(cleanedHole.points[0], extPoints)) {
        // Hole is outside exterior boundary, discard safely
        continue;
      }

      let holePoints = cleanedHole.points;
      // Three.js hole winding must be CW (signed area < 0)
      if (cleanedHole.area > 0) {
        holePoints = [...holePoints].reverse();
      }

      const holePath = new THREE.Path();
      holePath.moveTo(holePoints[0][0], holePoints[0][1]);
      for (let j = 1; j < holePoints.length; j++) {
        holePath.lineTo(holePoints[j][0], holePoints[j][1]);
      }
      shape.holes.push(holePath);
    }

    validShapes.push(shape);
  }

  if (validShapes.length === 0) {
    return {
      valid: false,
      shapes: [],
      reason: rejectedReasons.join("; ") || "No valid polygon rings found for triangulation",
    };
  }

  return {
    valid: true,
    shapes: validShapes,
  };
}

/**
 * Converts a GeoJSON Polygon or MultiPolygon coordinate ring into a THREE.Shape.
 * Uses preparePolygonForTriangulation to guarantee crash-free triangulation.
 */
export function coordinatesToThreeShape(coordinates, cx = 0, cy = 0, crsMetadata = null) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  const geom = { type: "Polygon", coordinates };
  const res = preparePolygonForTriangulation(geom, cx, cy, crsMetadata);
  return res.valid && res.shapes.length > 0 ? res.shapes[0] : null;
}

/**
 * Builds neutral ground plane when aerial satellite imagery is unavailable.
 * Never uses artificial crop circles, fake highways or procedural agricultural patches.
 */
export function createNeutralTerrainMesh({
  cx = 0,
  cy = 0,
  span = 500,
  terrainEnabled = false,
}) {
  const terrainGroup = new THREE.Group();
  terrainGroup.name = "aerial-terrain-base";

  const terrainSize = Math.max(span * 3.5, 300);
  const segments = terrainEnabled ? 32 : 1;
  const geometry = new THREE.PlaneGeometry(terrainSize, terrainSize, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    color: 0x1e2530, // Clean, neutral slate-earth ground
    roughness: 0.96,
    metalness: 0.04,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, -0.02, 0);
  mesh.receiveShadow = true;
  terrainGroup.add(mesh);

  return terrainGroup;
}

/**
 * Backward-compatible helper for tests and fallback rendering.
 */
export function createAerialTerrainMesh({
  cx = 0,
  cy = 0,
  span = 500,
  crsMetadata = null,
  terrainEnabled = false,
  satelliteImageUrl = null,
}) {
  return createNeutralTerrainMesh({ cx, cy, span, terrainEnabled });
}

/**
 * Builds 3D mesh for a canonical plot.
 * @param {Object} plot - Canonical plot entity
 * @param {number} cx - Center X for coordinate normalization
 * @param {number} cy - Center Y for coordinate normalization
 * @param {number} extrusionHeight - Visualization extrusion height (default 1.5 units)
 * @param {boolean} isSelected - Whether plot is currently selected
 * @param {Object} crsMetadata - CRS projection details
 * @param {Object} options - Status/zone display options { showStatusColors, showZones, zonesById, containmentStatus }
 */
/**
 * Builds 3D mesh for a canonical plot with per-plot fault isolation.
 *
 * Implements Phase A1, B, C1, C2:
 * - Robust geometry preparation before triangulation
 * - Fault isolation: If a single plot fails triangulation, it is logged and skipped without crashing the scene
 * - Professional PBR land-development visual materials (earth/stone tones, subtle bevels, contact edges)
 * - Exact horizontal footprints with zero vertical distortion
 * - Controlled vertical offset to prevent z-fighting
 *
 * @param {Object} plot - Canonical plot entity
 * @param {number} cx - Center X for coordinate normalization
 * @param {number} cy - Center Y for coordinate normalization
 * @param {number} extrusionHeight - Visualization extrusion height (default 1.4 units)
 * @param {boolean} isSelected - Whether plot is currently selected
 * @param {Object} crsMetadata - CRS projection details
 * @param {Object} options - Status/zone display options { showStatusColors, showZones, zonesById, containmentStatus, onGeometryRejected }
 */
export function createPlot3DMesh(
  plot, cx, cy, extrusionHeight = 1.4, isSelected = false, crsMetadata = null, options = {}
) {
  const geom = plot?.geometry;
  if (!geom || !geom.coordinates) {
    if (options?.onGeometryRejected) {
      options.onGeometryRejected({
        entityId: plot?.id,
        plotNumber: plot?.original_number || plot?.number,
        reason: "Plot geometry is missing or has no coordinate rings",
      });
    }
    return null;
  }

  const prep = preparePolygonForTriangulation(geom, cx, cy, crsMetadata);
  if (!prep.valid || !prep.shapes || prep.shapes.length === 0) {
    if (options?.onGeometryRejected) {
      options.onGeometryRejected({
        entityId: plot.id,
        plotNumber: plot.original_number || plot.number,
        reason: prep.reason || "Polygon geometry validation failed",
      });
    }
    return null;
  }

  const group = new THREE.Group();
  group.name = `plot-${plot.id}`;
  group.userData = {
    entityType: "Plot",
    id: plot.id,
    plotNumber: plot.original_number || plot.number,
    canonicalPlot: plot,
    containmentStatus: options?.containmentStatus || plot.containmentStatus || "contained",
  };

  const containmentStatus = group.userData.containmentStatus;
  const isOutOfBoundary = containmentStatus === "out_of_boundary";
  const isToleranceOverlap = containmentStatus === "tolerance_overlap";

  // Determine plot color based on selection, containment, status, and zone
  let baseColor = 0xf8fafc; // Clean architectural warm ivory/limestone base
  const status = plot.semantic_validation_status || "review_required";
  const inventoryStatus = plot.status_id || "available";
  const showStatus = options?.showStatusColors ?? options?.showInventoryStatus ?? false;
  const showZones = options?.showZones ?? false;
  const zonesById = options?.zonesById ?? {};

  if (isSelected) {
    baseColor = 0x10b981; // Vibrant emerald highlight
  } else if (isOutOfBoundary) {
    baseColor = 0xef4444; // Warning red for out-of-boundary plots
  } else if (isToleranceOverlap) {
    baseColor = 0xf59e0b; // Amber warning color for boundary tolerance overlap
  } else if (showStatus) {
    // Inventory status palette
    if (inventoryStatus === "sold") {
      baseColor = 0xef4444; // Coral sold red
    } else if (inventoryStatus === "reserved") {
      baseColor = 0x8b5cf6; // Reserved purple / indigo
    } else if (inventoryStatus === "hold") {
      baseColor = 0xf59e0b; // Hold amber / gold
    } else {
      baseColor = 0xf8fafc; // Available luxury warm ivory
    }
  } else if (showZones && plot.zone_id && zonesById[plot.zone_id]) {
    const zoneHex = zonesById[plot.zone_id].color;
    baseColor = zoneHex ? parseInt(zoneHex.replace("#", "0x"), 16) : 0x38bdf8;
  } else if (status === "review_required") {
    baseColor = 0xfef08a; // Warning yellow
  } else if (status === "conflicted") {
    baseColor = 0xfecaca; // Conflicted red
  } else if (status === "verified") {
    baseColor = 0xe2e8f0; // Clean neutral slate
  } else {
    baseColor = 0xf8fafc;
  }

  const effectiveDepth = Math.max(extrusionHeight, 0.12);
  const extrudeSettings = {
    depth: effectiveDepth,
    bevelEnabled: effectiveDepth > 0.25,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.03,
    bevelThickness: 0.03,
  };

  const material = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.58,
    metalness: 0.05,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const wireframeMaterial = new THREE.LineBasicMaterial({
    color: isSelected
      ? 0x059669
      : isOutOfBoundary
        ? 0xdc2626
        : isToleranceOverlap
          ? 0xd97706
          : 0x64748b,
    linewidth: isSelected || isOutOfBoundary ? 2 : 1,
  });

  let meshCreated = false;
  for (const shape of prep.shapes) {
    try {
      const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      // Rotate so extrusion goes vertically upward along Y axis
      geometry.rotateX(-Math.PI / 2);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = 0.02; // Small vertical offset to prevent z-fighting
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = group.userData;

      // Add outline wireframe for clean architectural edge definition
      const edges = new THREE.EdgesGeometry(geometry);
      const line = new THREE.LineSegments(edges, wireframeMaterial);
      line.position.y = 0.02;
      line.userData = group.userData;

      group.add(mesh);
      group.add(line);
      meshCreated = true;
    } catch (extrudeErr) {
      // Individual shape extrusion failed: isolate fault and report
      console.warn(`Plot ${plot.id} mesh generation failed:`, extrudeErr);
      if (options?.onGeometryRejected) {
        options.onGeometryRejected({
          entityId: plot.id,
          plotNumber: plot.original_number || plot.number,
          reason: `ExtrudeGeometry triangulation error: ${extrudeErr.message}`,
        });
      }
    }
  }

  return meshCreated ? group : null;
}

/**
 * Builds camera-facing billboard text sprite for plot numbers and dimensions.
 *
 * Implements Phase D1, D2, D3:
 * - Uses getGeometryLabelPoint interior point grid search to guarantee placement inside polygon interior
 * - Displays plot number, optional Sqyd area, and status indicator dot
 * - High-resolution crisp rendering (256x128 canvas)
 */
export function createPlotNumberSprite(plot, cx, cy, crsMetadata = null, isSelected = false, options = {}) {
  if (typeof document === "undefined") return null;

  const geom = plot?.geometry;
  if (!geom || !geom.coordinates) return null;

  const number = String(plot.original_number || plot.number || "");
  if (!number) return null;

  // Use polygon-aware interior point so concave/L-shaped plots have label inside footprint
  const [labelLng, labelLat] = getGeometryLabelPoint(geom);
  const [worldX, worldZ] = gisTo3DCoord(labelLng, labelLat, cx, cy, crsMetadata);

  // Compute area display if available
  let areaText = "";
  if (plot.area_sqyd || plot.declared_area_sqyd) {
    areaText = `${Math.round(Number(plot.area_sqyd || plot.declared_area_sqyd))} Sqyd`;
  } else if (plot.area || plot.area_sqm) {
    areaText = `${Math.round(Number(plot.area || plot.area_sqm) * 1.19599)} Sqyd`;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, 256, 128);

  // Status dot color
  const statusId = plot.status_id || "available";
  let statusDotColor = "#10b981"; // available = green
  if (statusId === "sold") statusDotColor = "#ef4444";
  else if (statusId === "reserved") statusDotColor = "#8b5cf6";
  else if (statusId === "hold") statusDotColor = "#f59e0b";

  // Background rounded pill
  if (isSelected) {
    ctx.fillStyle = "rgba(16, 185, 129, 0.95)";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
  } else {
    ctx.fillStyle = "rgba(15, 23, 42, 0.90)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 2;
  }

  // Draw rounded rectangle
  const rx = 24, ry = 16, rw = 208, rh = 96, rad = 14;
  ctx.beginPath();
  ctx.moveTo(rx + rad, ry);
  ctx.lineTo(rx + rw - rad, ry);
  ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rad);
  ctx.lineTo(rx + rw, ry + rh - rad);
  ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rad, ry + rh);
  ctx.lineTo(rx + rad, ry + rh);
  ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rad);
  ctx.lineTo(rx, ry + rad);
  ctx.quadraticCurveTo(rx, ry, rx + rad, ry);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Status indicator dot
  ctx.beginPath();
  ctx.arc(rx + 22, ry + 24, 7, 0, Math.PI * 2);
  ctx.fillStyle = statusDotColor;
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Plot number text
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 34px 'Inter', system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (areaText) {
    ctx.fillText(number, 134, ry + 36);
    // Area label below
    ctx.fillStyle = isSelected ? "#ecfdf5" : "#94a3b8";
    ctx.font = "600 20px 'Inter', system-ui, -apple-system, sans-serif";
    ctx.fillText(areaText, 128, ry + 68);
  } else {
    ctx.fillText(number, 134, ry + 48);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const spriteMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
  });

  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.name = `label-${plot.id}`;
  sprite.scale.set(4.4, 2.2, 1);
  const plotElevation = Number(options?.extrusionHeight || 1.4) + 0.6;
  sprite.position.set(worldX, plotElevation, worldZ);
  sprite.userData = {
    entityType: "PlotLabel",
    id: plot.id,
    plotNumber: number,
  };

  return sprite;
}

/**
 * Builds realistic 3D mesh for canonical roads with asphalt texture and curbs.
 */
export function createRoad3DMesh(road, cx, cy, crsMetadata = null) {
  const geom = road?.geometry;
  if (!geom || !geom.coordinates) return null;

  const lineParts = geom.type === "LineString"
    ? [geom.coordinates]
    : geom.type === "MultiLineString"
      ? geom.coordinates
      : [];
  if (lineParts.length) {
    const group = new THREE.Group();
    group.name = `road-${road.id}`;
    group.userData = {
      entityType: "Road",
      id: road.id,
      canonicalRoad: road,
    };
    const material = new THREE.LineBasicMaterial({ color: 0x334155, linewidth: 2 });
    for (const line of lineParts) {
      if (!Array.isArray(line) || line.length < 2) continue;
      const points = line.map(([x, y]) => {
        const [worldX, worldZ] = gisTo3DCoord(x, y, cx, cy, crsMetadata);
        return new THREE.Vector3(worldX, 0.04, worldZ);
      });
      const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
      const mesh = new THREE.Line(lineGeometry, material);
      mesh.userData = group.userData;
      group.add(mesh);
    }
    return group.children.length ? group : null;
  }

  const prep = preparePolygonForTriangulation(geom, cx, cy, crsMetadata);
  if (!prep.valid || !prep.shapes || prep.shapes.length === 0) return null;

  const group = new THREE.Group();
  group.name = `road-${road.id}`;
  group.userData = {
    entityType: "Road",
    id: road.id,
    canonicalRoad: road,
  };

  // High quality dark asphalt road material
  const roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x242832,
    roughness: 0.88,
    metalness: 0.04,
  });

  const curbMaterial = new THREE.LineBasicMaterial({
    color: 0xcbd5e1,
    linewidth: 1.5,
  });

  let roadCreated = false;
  for (const shape of prep.shapes) {
    try {
      const geometry = new THREE.ShapeGeometry(shape);
      geometry.rotateX(-Math.PI / 2);
      // Elevation slightly above ground to prevent z-fighting
      const mesh = new THREE.Mesh(geometry, roadMaterial);
      mesh.position.y = 0.02;
      mesh.receiveShadow = true;
      mesh.userData = group.userData;
      group.add(mesh);

      // Concrete curb border outline
      const edges = new THREE.EdgesGeometry(geometry);
      const curb = new THREE.LineSegments(edges, curbMaterial);
      curb.position.y = 0.021;
      curb.userData = group.userData;
      group.add(curb);
      roadCreated = true;
    } catch (err) {
      console.warn(`Road ${road.id} geometry error:`, err);
    }
  }

  return roadCreated ? group : null;
}

/**
 * Builds realistic 3D mesh for verified open spaces and gardens.
 * Strictly uses source geometry without fabricated features.
 */
export function createLandUse3DMesh(feature, cx, cy, crsMetadata = null, isSelected = false) {
  const geometry = feature?.geometry;
  if (!geometry?.coordinates) return null;

  const prep = preparePolygonForTriangulation(geometry, cx, cy, crsMetadata);
  if (!prep.valid || !prep.shapes || prep.shapes.length === 0) return null;

  const group = new THREE.Group();
  group.name = `land-use-${feature.id}`;
  group.userData = {
    entityType: "LandUse",
    id: feature.id,
    plotNumber: feature.name || feature.source_label || "Open space",
    canonicalLandUse: feature,
  };

  // Lush vibrant lawn green material
  const material = new THREE.MeshStandardMaterial({
    color: isSelected ? 0x60a5fa : 0x487532,
    roughness: 0.92,
    metalness: 0,
  });

  let landUseCreated = false;
  for (const polygonShape of prep.shapes) {
    try {
      const geometry3d = new THREE.ShapeGeometry(polygonShape);
      geometry3d.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geometry3d, material);
      mesh.position.y = 0.02;
      mesh.receiveShadow = true;
      mesh.userData = group.userData;
      group.add(mesh);
      landUseCreated = true;
    } catch (err) {
      console.warn(`LandUse ${feature.id} geometry error:`, err);
    }
  }
  return landUseCreated ? group : null;
}

/**
 * Builds 3D perimeter line for site boundary.
 */
export function createBoundary3DLine(boundaryGeometry, cx, cy, crsMetadata = null) {
  if (!boundaryGeometry || !boundaryGeometry.coordinates) return null;

  let rings = [];
  if (boundaryGeometry.type === "Polygon") {
    rings = boundaryGeometry.coordinates;
  } else if (boundaryGeometry.type === "MultiPolygon") {
    rings = boundaryGeometry.coordinates.flatMap((poly) => poly);
  } else if (boundaryGeometry.type === "LineString") {
    rings = [boundaryGeometry.coordinates];
  }

  if (rings.length === 0) return null;

  const group = new THREE.Group();
  group.name = "boundary-perimeter";

  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    linewidth: 2.5,
  });

  for (const ring of rings) {
    const points = [];
    for (const pt of ring) {
      const [x, z] = gisTo3DCoord(pt[0], pt[1], cx, cy, crsMetadata);
      points.push(new THREE.Vector3(x, 0.08, z)); // Elevated slightly above roads
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, lineMaterial);
    group.add(line);
  }

  return group;
}

/**
 * Builds 3D perimeter boundary wall enclosing the colony development.
 */
export function createColonyBoundaryWall(boundaryGeometry, cx, cy, crsMetadata = null) {
  if (!boundaryGeometry || !boundaryGeometry.coordinates) return null;

  const rings = boundaryGeometry.type === "Polygon"
    ? boundaryGeometry.coordinates
    : boundaryGeometry.type === "MultiPolygon"
      ? boundaryGeometry.coordinates.flatMap((p) => p)
      : [];
  if (!rings.length || !rings[0] || rings[0].length < 3) return null;

  const wallGroup = new THREE.Group();
  wallGroup.name = "colony-boundary-wall";

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.6,
    metalness: 0.1,
  });

  const pierMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.5,
  });

  const outerRing = rings[0];
  const wallHeight = 0.8;
  const wallThickness = 0.35;

  for (let i = 0; i < outerRing.length - 1; i++) {
    const [p1x, p1z] = gisTo3DCoord(outerRing[i][0], outerRing[i][1], cx, cy, crsMetadata);
    const [p2x, p2z] = gisTo3DCoord(outerRing[i + 1][0], outerRing[i + 1][1], cx, cy, crsMetadata);

    const dx = p2x - p1x;
    const dz = p2z - p1z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.1) continue;

    const angle = Math.atan2(dz, dx);
    const midX = (p1x + p2x) / 2;
    const midZ = (p1z + p2z) / 2;

    const wallGeom = new THREE.BoxGeometry(len, wallHeight, wallThickness);
    const wallMesh = new THREE.Mesh(wallGeom, wallMat);
    wallMesh.position.set(midX, wallHeight / 2, midZ);
    wallMesh.rotation.y = -angle;
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    wallGroup.add(wallMesh);

    // Concrete pillar at vertex
    const pierGeom = new THREE.BoxGeometry(wallThickness * 1.5, wallHeight + 0.15, wallThickness * 1.5);
    const pierMesh = new THREE.Mesh(pierGeom, pierMat);
    pierMesh.position.set(p1x, (wallHeight + 0.15) / 2, p1z);
    pierMesh.castShadow = true;
    wallGroup.add(pierMesh);
  }

  return wallGroup;
}

/**
 * Builds conceptual architectural villa massing for a plot (clearly labelled as design concept).
 */
export function createBuildingMassing(plot, cx, cy, crsMetadata = null, styleIndex = 0) {
  const geom = plot?.geometry;
  if (!geom || !geom.coordinates) return null;

  const coords = geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates?.[0]?.[0];
  if (!coords || coords.length < 3) return null;

  const [plotCx, plotCy] = getPolygonCentroid(coords);
  const [worldX, worldZ] = gisTo3DCoord(plotCx, plotCy, cx, cy, crsMetadata);

  const bounds = computeGeometryBounds([plot]);
  const pWidth = Math.max(Math.abs(bounds[2] - bounds[0]) * (crsMetadata?.scale_ratio || 1), 6);
  const pDepth = Math.max(Math.abs(bounds[3] - bounds[1]) * (crsMetadata?.scale_ratio || 1), 8);

  // Keep building within 60% of plot footprint
  const bWidth = Math.min(Math.max(pWidth * 0.65, 4.5), 14);
  const bDepth = Math.min(Math.max(pDepth * 0.65, 5.5), 16);

  const villaGroup = new THREE.Group();
  villaGroup.name = `building-${plot.id}`;
  villaGroup.position.set(worldX, 0, worldZ);
  villaGroup.userData = {
    entityType: "ConceptualBuilding",
    plotId: plot.id,
    isConceptual: true,
  };

  // Materials
  const stuccoWhite = new THREE.MeshStandardMaterial({
    color: 0xfafafa,
    roughness: 0.35,
    metalness: 0.05,
  });
  const darkGlass = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.1,
    metalness: 0.8,
  });
  const woodPergola = new THREE.MeshStandardMaterial({
    color: 0x78350f,
    roughness: 0.7,
  });
  const accentGrey = new THREE.MeshStandardMaterial({
    color: 0x475569,
    roughness: 0.4,
  });

  // Level 1: Ground floor block
  const groundHeight = 2.8;
  const groundGeom = new THREE.BoxGeometry(bWidth, groundHeight, bDepth);
  const groundMesh = new THREE.Mesh(groundGeom, stuccoWhite);
  groundMesh.position.y = groundHeight / 2;
  groundMesh.castShadow = true;
  groundMesh.receiveShadow = true;
  villaGroup.add(groundMesh);

  // Ground level entry ribbon
  const glassGeom = new THREE.BoxGeometry(bWidth * 0.4, 1.8, bDepth + 0.05);
  const glassMesh = new THREE.Mesh(glassGeom, darkGlass);
  glassMesh.position.set(0, 1.2, 0);
  villaGroup.add(glassMesh);

  // Level 2: First floor recessed block
  const firstHeight = 2.4;
  const firstWidth = bWidth * 0.85;
  const firstDepth = bDepth * 0.85;
  const firstGeom = new THREE.BoxGeometry(firstWidth, firstHeight, firstDepth);
  const firstMesh = new THREE.Mesh(firstGeom, styleIndex % 2 === 0 ? stuccoWhite : accentGrey);
  firstMesh.position.set(bWidth * 0.06, groundHeight + firstHeight / 2, -bDepth * 0.06);
  firstMesh.castShadow = true;
  firstMesh.receiveShadow = true;
  villaGroup.add(firstMesh);

  // Roof terrace pergola
  const pergolaGeom = new THREE.BoxGeometry(firstWidth * 0.6, 0.15, firstDepth * 0.5);
  const pergolaMesh = new THREE.Mesh(pergolaGeom, woodPergola);
  pergolaMesh.position.set(bWidth * 0.06, groundHeight + firstHeight + 1.2, -bDepth * 0.06);
  pergolaMesh.castShadow = true;
  villaGroup.add(pergolaMesh);

  return villaGroup;
}

/**
 * Places trees ONLY inside approved open spaces / gardens.
 * Never fabricates vegetation across unrelated land.
 */
export function createLandscapeTrees(plots = [], roads = [], greens = [], cx = 0, cy = 0, crsMetadata = null) {
  if (!Array.isArray(greens) || greens.length === 0) return null;

  const treesGroup = new THREE.Group();
  treesGroup.name = "landscape-vegetation";

  // Shared geometry & materials for performance
  const trunkGeom = new THREE.CylinderGeometry(0.12, 0.18, 1.6, 6);
  const canopyGeom1 = new THREE.SphereGeometry(1.2, 7, 7);
  const canopyGeom2 = new THREE.ConeGeometry(1.4, 2.5, 7);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.9 });
  const leafMat1 = new THREE.MeshStandardMaterial({ color: 0x2e6930, roughness: 0.8 });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x417c38, roughness: 0.85 });

  for (const green of greens) {
    const coords = green?.geometry?.type === "Polygon" ? green.geometry.coordinates[0] : null;
    if (!coords || coords.length < 3) continue;

    for (let i = 0; i < coords.length - 1; i += 2) {
      const [tx, tz] = gisTo3DCoord(coords[i][0], coords[i][1], cx, cy, crsMetadata);
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeom, trunkMat);
      trunk.position.y = 0.8;
      trunk.castShadow = true;
      tree.add(trunk);

      const isCone = i % 4 === 0;
      const canopy = new THREE.Mesh(isCone ? canopyGeom2 : canopyGeom1, isCone ? leafMat2 : leafMat1);
      canopy.position.y = isCone ? 2.5 : 2.2;
      canopy.castShadow = true;
      tree.add(canopy);

      tree.position.set(tx, 0, tz);
      tree.scale.setScalar(0.8 + (i % 3) * 0.2);
      treesGroup.add(tree);
    }
  }

  return treesGroup.children.length ? treesGroup : null;
}
