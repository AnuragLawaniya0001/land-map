import assert from "node:assert/strict";
import test from "node:test";
import {
  computeGeometryBounds,
  getPolygonCentroid,
  getGeometryLabelPoint,
  isPointInsidePolygon,
  geoJsonToSvgPath,
  formatMeasurement,
  matchesPlotSearch,
  isRenderableGeometry,
  normalizeLegacyPlotsForReview,
  normalizeLegacyLandUseForReview,
  CANONICAL_THEME,
} from "./canonicalGeo.js";

const makePoly = (minX, minY, maxX, maxY) => ({
  type: "Polygon",
  coordinates: [[
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ]],
});

test("computeGeometryBounds accurately calculates bounds for single and multiple features", () => {
  const p1 = makePoly(100, 200, 300, 400);
  const bounds = computeGeometryBounds(p1);
  assert.deepEqual(bounds, [100, 200, 300, 400]);

  const p2 = makePoly(50, 150, 200, 250);
  const combinedBounds = computeGeometryBounds([
    { geometry: p1 },
    { geometry: p2 },
  ]);
  assert.deepEqual(combinedBounds, [50, 150, 300, 400]);
});

test("computeGeometryBounds handles negative coordinates and non-zero origins without distortion", () => {
  const negPoly = makePoly(-500, -250, -100, -50);
  const bounds = computeGeometryBounds(negPoly);
  assert.deepEqual(bounds, [-500, -250, -100, -50]);
});

test("computeGeometryBounds gracefully handles empty or invalid geometries with fallback", () => {
  const emptyBounds = computeGeometryBounds([]);
  assert.deepEqual(emptyBounds, [0, 0, 1000, 1000]);

  const nullBounds = computeGeometryBounds(null);
  assert.deepEqual(nullBounds, [0, 0, 1000, 1000]);
});

test("getPolygonCentroid calculates exact center of a polygon ring", () => {
  const poly = makePoly(0, 0, 100, 100);
  const [cx, cy] = getPolygonCentroid(poly.coordinates[0]);
  assert.equal(Math.round(cx), 50);
  assert.equal(Math.round(cy), 50);
});

test("getPolygonCentroid falls back to midpoint for degenerate zero-area rings", () => {
  const degenerate = [[10, 20], [10, 20], [10, 20]];
  const [cx, cy] = getPolygonCentroid(degenerate);
  assert.equal(cx, 10);
  assert.equal(cy, 20);
});

test("getGeometryLabelPoint supports Polygon and MultiPolygon geometry", () => {
  assert.deepEqual(getGeometryLabelPoint(makePoly(0, 0, 10, 10)), [5, 5]);
  const multi = {
    type: "MultiPolygon",
    coordinates: [
      makePoly(20, 20, 21, 21).coordinates,
      makePoly(0, 0, 10, 10).coordinates,
    ],
  };
  assert.deepEqual(getGeometryLabelPoint(multi), [5, 5]);
});

test("getGeometryLabelPoint places labels inside concave polygons and outside holes", () => {
  const concave = {
    type: "Polygon",
    coordinates: [[
      [0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10], [0, 0],
    ]],
  };
  const labelPoint = getGeometryLabelPoint(concave);
  assert.equal(isPointInsidePolygon(labelPoint, concave.coordinates), true);

  const withHole = {
    type: "Polygon",
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
    ],
  };
  assert.equal(isPointInsidePolygon(getGeometryLabelPoint(withHole), withHole.coordinates), true);
});

test("getGeometryLabelPoint places road labels at the line midpoint by distance", () => {
  const road = { type: "LineString", coordinates: [[0, 0], [2, 0], [2, 8]] };
  assert.deepEqual(getGeometryLabelPoint(road), [2, 3]);
});

test("geoJsonToSvgPath generates valid SVG path strings for Polygons", () => {
  const poly = makePoly(10, 20, 30, 40);
  const path = geoJsonToSvgPath(poly);
  assert.ok(path.startsWith("M 10.00000000,20.00000000 L 30.00000000,20.00000000"));
  assert.ok(path.endsWith("Z"));
});

test("geoJsonToSvgPath preserves small WGS84 plot coordinates", () => {
  const path = geoJsonToSvgPath(makePoly(78.2437, 27.2365, 78.2438, 27.2366));
  assert.ok(path.includes("78.24370000,27.23650000"));
  assert.ok(path.includes("78.24380000,27.23660000"));
});

test("geoJsonToSvgPath supports invertY coordinate transformation", () => {
  const bounds = [0, 0, 100, 100];
  const poly = makePoly(0, 20, 50, 80);
  const normalPath = geoJsonToSvgPath(poly, false, bounds);
  const invertedPath = geoJsonToSvgPath(poly, true, bounds);

  // In standard SVG, Y=20 maps to inverted Y = 100 - 20 = 80
  assert.ok(normalPath.includes("0.00000000,20.00000000"));
  assert.ok(invertedPath.includes("0.00000000,80.00000000"));
});

test("geoJsonToSvgPath handles LineStrings correctly", () => {
  const line = {
    type: "LineString",
    coordinates: [[0, 0], [50, 50], [100, 100]],
  };
  const path = geoJsonToSvgPath(line);
  assert.equal(
    path,
    "M 0.00000000,0.00000000 L 50.00000000,50.00000000 L 100.00000000,100.00000000"
  );
});

test("geoJsonToSvgPath renders all MultiLineString paths", () => {
  assert.equal(
    geoJsonToSvgPath({
      type: "MultiLineString",
      coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]],
    }),
    "M 0.00000000,0.00000000 L 1.00000000,1.00000000 M 2.00000000,2.00000000 L 3.00000000,3.00000000"
  );
});

test("formatMeasurement never fabricates zero for missing values", () => {
  assert.equal(formatMeasurement(null, "m"), "Not specified");
  assert.equal(formatMeasurement(undefined, "sq.m"), "Not specified");
  assert.equal(formatMeasurement(NaN, "m"), "Not specified");
  // Zero itself is an explicit zero, not missing
  assert.equal(formatMeasurement(0, "m"), "0 m");
  // Valid numeric values
  assert.equal(formatMeasurement(12.5, "m"), "12.5 m");
  assert.equal(formatMeasurement(250.75, "sq.m"), "250.75 sq.m");
});

test("matchesPlotSearch performs robust normalized search without altering canonical data", () => {
  const plot = {
    id: "plot-uuid-101",
    original_number: "Plot 42-A",
    normalized_number: "42A",
  };

  assert.equal(matchesPlotSearch(plot, "42"), true);
  assert.equal(matchesPlotSearch(plot, "42a"), true);
  assert.equal(matchesPlotSearch(plot, "42-a"), true);
  assert.equal(matchesPlotSearch(plot, "uuid-101"), true);
  assert.equal(matchesPlotSearch(plot, "999"), false);
  assert.equal(matchesPlotSearch(plot, ""), true); // empty query matches all
  assert.equal(matchesPlotSearch({ source_label: "Parcel 17-B" }, "17-b"), true);
});

test("legacy plots with valid polygon geometry normalize as review-only candidates", () => {
  const legacy = {
    _id: "legacy-plot-1",
    number: "Plot 1",
    status_id: "available",
    geometry: makePoly(10, 20, 30, 40),
  };
  const result = normalizeLegacyPlotsForReview([legacy], "colony-1");

  assert.equal(result.rejected, 0);
  assert.equal(result.plots.length, 1);
  assert.equal(result.plots[0].id, "legacy-plot-1");
  assert.equal(result.plots[0].original_number, "Plot 1");
  assert.equal(result.plots[0].semantic_validation_status, "review_required");
  assert.equal(result.plots[0].geometry_valid, null);
  assert.equal(result.plots[0].is_provisional_legacy, true);
});

test("legacy plot normalization rejects open, non-finite, and unsupported geometries", () => {
  const result = normalizeLegacyPlotsForReview([
    { id: "open", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } },
    { id: "nan", geometry: makePoly(0, 0, Number.NaN, 1) },
    { id: "point", geometry: { type: "Point", coordinates: [0, 0] } },
  ], "colony-1");

  assert.equal(result.plots.length, 0);
  assert.equal(result.rejected, 3);
  assert.equal(isRenderableGeometry(makePoly(0, 0, 1, 1)), true);
});

test("legacy open-space features retain source geometry as review-only candidates", () => {
  const sourceGeometry = makePoly(0, 0, 5, 5);
  const result = normalizeLegacyLandUseForReview([
    { id: "park-1", name: "Garden", geometry: sourceGeometry },
    { id: "invalid-line", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
  ], "colony-1");
  assert.equal(result.features.length, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.features[0].id, "park-1");
  assert.equal(result.features[0].geometry, sourceGeometry);
  assert.equal(result.features[0].validation_status, "review_required");
});

test("CANONICAL_THEME provides distinct visual tokens for validation statuses", () => {
  assert.ok(CANONICAL_THEME.plot);
  assert.ok(CANONICAL_THEME.road);
  assert.ok(CANONICAL_THEME.boundary);
  assert.ok(CANONICAL_THEME.reviewRequired);
  assert.ok(CANONICAL_THEME.conflicted);
  assert.notEqual(CANONICAL_THEME.reviewRequired.stroke, CANONICAL_THEME.plot.stroke);
  assert.notEqual(CANONICAL_THEME.conflicted.stroke, CANONICAL_THEME.plot.stroke);
});
