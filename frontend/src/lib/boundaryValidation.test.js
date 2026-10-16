import assert from "node:assert/strict";
import test from "node:test";
import {
  validateColonyBoundaryGeometry,
  evaluatePlotBoundaryContainment,
  validateColonyLayoutContainment,
} from "./boundaryValidation.js";

const makePoly = (minX, minY, maxX, maxY) => ({
  type: "Polygon",
  coordinates: [
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ],
  ],
});

test("validateColonyBoundaryGeometry accepts valid closed perimeter", () => {
  const boundary = makePoly(78.25, 27.22, 78.26, 27.23);
  const result = validateColonyBoundaryGeometry(boundary);
  assert.equal(result.isValid, true);
  assert.equal(result.isClosed, true);
  assert.equal(result.vertexCount, 5);
});

test("validateColonyBoundaryGeometry rejects degenerate or unclosed boundary", () => {
  const emptyRes = validateColonyBoundaryGeometry(null);
  assert.equal(emptyRes.isValid, false);

  const degenerate = {
    type: "Polygon",
    coordinates: [[[78.25, 27.22], [78.26, 27.23]]],
  };
  const degRes = validateColonyBoundaryGeometry(degenerate);
  assert.equal(degRes.isValid, false);
});

test("evaluatePlotBoundaryContainment identifies fully contained plots", () => {
  const boundary = makePoly(78.0, 27.0, 78.1, 27.1);
  const plot = {
    id: "p1",
    number: "1",
    geometry: makePoly(78.02, 27.02, 78.04, 27.04),
  };
  const res = evaluatePlotBoundaryContainment(plot, boundary);
  assert.equal(res.status, "contained");
  assert.equal(res.centroidInside, true);
  assert.equal(res.insideFraction, 1);
});

test("evaluatePlotBoundaryContainment identifies out-of-boundary plots", () => {
  const boundary = makePoly(78.0, 27.0, 78.1, 27.1);
  const outsidePlot = {
    id: "p-out",
    number: "99",
    geometry: makePoly(78.15, 27.15, 78.18, 27.18),
  };
  const res = evaluatePlotBoundaryContainment(outsidePlot, boundary);
  assert.equal(res.status, "out_of_boundary");
  assert.equal(res.centroidInside, false);
});

test("validateColonyLayoutContainment aggregates layout statistics and exceptions", () => {
  const boundary = makePoly(78.0, 27.0, 78.1, 27.1);
  const plots = [
    { id: "p1", number: "1", geometry: makePoly(78.01, 27.01, 78.03, 27.03) },
    { id: "p2", number: "2", geometry: makePoly(78.04, 27.04, 78.06, 27.06) },
    { id: "p3", number: "3", geometry: makePoly(78.15, 27.15, 78.18, 27.18) }, // outside
  ];

  const result = validateColonyLayoutContainment(boundary, plots);
  assert.equal(result.boundaryValid, true);
  assert.equal(result.totalPlots, 3);
  assert.equal(result.containedPlots, 2);
  assert.equal(result.outOfBoundaryPlots, 1);
  assert.equal(result.containmentRate, 67);
  assert.equal(result.plotContainmentById["p1"].status, "contained");
  assert.equal(result.plotContainmentById["p3"].status, "out_of_boundary");
  assert.ok(result.issues.some((i) => i.entityId === "p3"));
});
