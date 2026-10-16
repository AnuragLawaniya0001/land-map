/**
 * Strict Boundary Containment & Spatial Registration Validation Engine.
 *
 * Implements Phase 4:
 * - Authoritative KML boundary polygon validation
 * - Plot-by-plot containment analysis against boundary geometry
 * - Auditable classification: contained, tolerance_overlap, out_of_boundary
 * - Geometry repair and exception reporting
 * - Comprehensive QA telemetry for geospatial dashboard
 */

import { geoJSONContainsPoint, isSelectablePlotGeometry } from "./geo.js";
import { getPolygonCentroid } from "./canonicalGeo.js";

/**
 * Validates a GeoJSON polygon or multipolygon boundary.
 */
export function validateColonyBoundaryGeometry(boundary) {
  if (!boundary || !boundary.coordinates) {
    return {
      isValid: false,
      reason: "Boundary geometry is missing or has no coordinate rings.",
      ringCount: 0,
      vertexCount: 0,
    };
  }

  const rings = boundary.type === "Polygon"
    ? boundary.coordinates
    : boundary.type === "MultiPolygon"
      ? boundary.coordinates.flatMap((r) => r)
      : [];

  if (rings.length === 0 || !Array.isArray(rings[0]) || rings[0].length < 4) {
    return {
      isValid: false,
      reason: "Boundary outer perimeter has fewer than 4 vertices (unclosed ring).",
      ringCount: rings.length,
      vertexCount: rings[0]?.length || 0,
    };
  }

  // Verify ring closure
  const first = rings[0][0];
  const last = rings[0][rings[0].length - 1];
  const isClosed = Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6;

  return {
    isValid: true,
    isClosed,
    ringCount: rings.length,
    vertexCount: rings[0].length,
    type: boundary.type,
  };
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (!lenSq) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function minDistanceToRing(px, py, ring) {
  let minD = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    minD = Math.min(minD, distanceToSegment(px, py, ring[i][0], ring[i + 1][0], ring[i + 1][1]));
  }
  return minD;
}

/**
 * Evaluates whether an individual plot polygon is contained within the boundary.
 *
 * Implements Phase E requirements:
 * - Uses exact containment calculations and metric distance tolerance (<= 0.5m)
 * - Prevents boundary-edge floating-point rounding errors from falsely flagging edge plots
 * - Categorizes into: contained, tolerance_overlap, partially_outside, out_of_boundary, invalid_geometry
 * - Reports maximum violation distance in meters
 */
export function evaluatePlotBoundaryContainment(plot, boundaryGeometry, toleranceMeters = 0.5) {
  const geom = plot?.geometry;
  if (!isSelectablePlotGeometry(geom) || !boundaryGeometry) {
    return {
      status: "unverified",
      insideFraction: 0,
      centroidInside: false,
      maxViolationDistanceM: 0,
      reason: "Missing geometry or boundary",
    };
  }

  const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates?.[0];
  const exteriorRing = rings?.[0];
  if (!Array.isArray(exteriorRing) || exteriorRing.length < 3) {
    return {
      status: "invalid_geometry",
      insideFraction: 0,
      centroidInside: false,
      maxViolationDistanceM: 0,
      reason: "Degenerate polygon ring",
    };
  }

  const boundaryRings = boundaryGeometry.type === "Polygon"
    ? boundaryGeometry.coordinates
    : boundaryGeometry.type === "MultiPolygon"
      ? boundaryGeometry.coordinates.flatMap((r) => r)
      : [];

  const boundaryOuter = boundaryRings[0] || [];

  // Determine coordinate system: geographic degrees or projected meters
  const isGeographic = exteriorRing.some((pt) => Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90 && (Math.abs(pt[0]) > 0.1 || Math.abs(pt[1]) > 0.1));
  const metersPerUnit = isGeographic ? 111320 : 1;

  // Test centroid
  const [cLng, cLat] = getPolygonCentroid(exteriorRing);
  const centroidInside = geoJSONContainsPoint(boundaryGeometry, [cLat, cLng]);

  // Test vertices against boundary
  let strictlyInsideCount = 0;
  let toleranceCount = 0;
  let outsideCount = 0;
  let maxViolationDist = 0;
  const testVertices = exteriorRing.slice(0, exteriorRing.length > 3 && exteriorRing[0][0] === exteriorRing[exteriorRing.length - 1][0] ? exteriorRing.length - 1 : exteriorRing.length);

  for (const pt of testVertices) {
    const isStrictlyIn = geoJSONContainsPoint(boundaryGeometry, [pt[1], pt[0]]);
    if (isStrictlyIn) {
      strictlyInsideCount++;
    } else {
      // Calculate distance to boundary perimeter
      const distUnits = boundaryOuter.length >= 3 ? minDistanceToRing(pt[0], pt[1], boundaryOuter) : Infinity;
      const distM = distUnits * metersPerUnit;
      if (distM <= toleranceMeters) {
        toleranceCount++;
      } else {
        outsideCount++;
        maxViolationDist = Math.max(maxViolationDist, distM);
      }
    }
  }

  const total = testVertices.length;
  const insideFraction = (strictlyInsideCount + toleranceCount) / total;

  if (outsideCount === 0 && centroidInside) {
    if (toleranceCount === 0) {
      return {
        status: "contained",
        insideFraction: 1.0,
        centroidInside: true,
        maxViolationDistanceM: 0,
        reason: "Plot is completely contained within approved colony boundary.",
      };
    }
    return {
      status: "tolerance_overlap",
      insideFraction: 1.0,
      centroidInside: true,
      maxViolationDistanceM: 0,
      reason: `Centroid is inside boundary; boundary-edge vertices align within ${toleranceMeters}m surveying tolerance.`,
    };
  }

  if (centroidInside && insideFraction >= 0.70) {
    return {
      status: "partially_outside",
      insideFraction,
      centroidInside: true,
      maxViolationDistanceM: maxViolationDist,
      reason: `Plot extends partially outside boundary (max edge violation: ${maxViolationDist.toFixed(2)}m).`,
    };
  }

  return {
    status: "out_of_boundary",
    insideFraction,
    centroidInside,
    maxViolationDistanceM: maxViolationDist,
    reason: `Plot violates boundary constraint: ${outsideCount} vertices outside (max violation: ${maxViolationDist.toFixed(2)}m).`,
  };
}

/**
 * Validates complete colony layout against authoritative KML boundary.
 */
export function validateColonyLayoutContainment(boundaryGeometry, plots = [], roads = []) {
  const boundaryCheck = validateColonyBoundaryGeometry(boundaryGeometry);
  if (!boundaryCheck.isValid) {
    return {
      boundaryValid: false,
      boundaryReason: boundaryCheck.reason,
      totalPlots: plots.length,
      containedPlots: 0,
      tolerancePlots: 0,
      outOfBoundaryPlots: plots.length,
      containmentRate: 0,
      issues: [{ severity: "error", message: `Invalid boundary: ${boundaryCheck.reason}` }],
      plotContainmentById: {},
    };
  }

  const plotContainmentById = {};
  let containedCount = 0;
  let toleranceCount = 0;
  let outOfBoundaryCount = 0;
  const issues = [];

  for (const plot of plots) {
    const res = evaluatePlotBoundaryContainment(plot, boundaryGeometry);
    plotContainmentById[plot.id] = res;

    if (res.status === "contained") {
      containedCount++;
    } else if (res.status === "tolerance_overlap") {
      toleranceCount++;
    } else {
      outOfBoundaryCount++;
      issues.push({
        severity: res.status === "partially_outside" ? "warning" : "critical",
        entityId: plot.id,
        plotNumber: plot.original_number || plot.number,
        message: `Plot ${plot.original_number || plot.number || plot.id}: ${res.reason}`,
      });
    }
  }

  const containmentRate = plots.length > 0
    ? Math.round(((containedCount + toleranceCount) / plots.length) * 100)
    : 100;

  return {
    boundaryValid: true,
    totalPlots: plots.length,
    containedPlots: containedCount,
    tolerancePlots: toleranceCount,
    outOfBoundaryPlots: outOfBoundaryCount,
    containmentRate,
    issues,
    plotContainmentById,
  };
}
