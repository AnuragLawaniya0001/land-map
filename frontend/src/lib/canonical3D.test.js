import assert from "node:assert/strict";
import test from "node:test";
import {
  gisTo3DCoord,
  coordinatesToThreeShape,
  preparePolygonForTriangulation,
  cleanPolygonRing,
  createPlot3DMesh,
  createRoad3DMesh,
  createLandUse3DMesh,
  createBoundary3DLine,
  createColonyBoundaryWall,
  createBuildingMassing,
  createLandscapeTrees,
  createAerialTerrainMesh,
  createPlotNumberSprite,
} from "./canonical3D.js";

const makePolyCoords = (x0, y0, x1, y1) => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ],
];

test("gisTo3DCoord normalizes coordinates relative to center", () => {
  const [x, z] = gisTo3DCoord(150, 250, 100, 200);
  assert.equal(x, 50);
  assert.equal(z, -50);
});

test("gisTo3DCoord converts geographic degrees into local meter coordinates", () => {
  const [x, z] = gisTo3DCoord(
    78.001,
    27.001,
    78,
    27,
    { crs_type: "geographic_wgs84", units: "deg" }
  );
  assert.ok(x > 99 && x < 100);
  assert.ok(z < -110 && z > -111);
});

test("gisTo3DCoord applies an explicit local-to-metre scale ratio", () => {
  assert.deepEqual(
    gisTo3DCoord(110, 220, 100, 200, { crs_type: "projected_metric", units: "m", scale_ratio: 0.05 }),
    [0.5, -1]
  );
});

test("coordinatesToThreeShape constructs valid THREE.Shape with exterior ring", () => {
  const coords = makePolyCoords(0, 0, 10, 10);
  const shape = coordinatesToThreeShape(coords, 0, 0);
  assert.ok(shape);
  // Redundant closing coordinate stripped, so 4 distinct corners produce 3 lineTo curves (closed by Shape)
  assert.equal(shape.curves.length, 3);
  assert.equal(shape.holes.length, 0);
});

test("coordinatesToThreeShape supports interior holes", () => {
  const exterior = makePolyCoords(0, 0, 100, 100)[0];
  const hole = [
    [20, 20],
    [40, 20],
    [40, 40],
    [20, 40],
    [20, 20],
  ];
  const shape = coordinatesToThreeShape([exterior, hole], 0, 0);
  assert.ok(shape);
  assert.equal(shape.holes.length, 1);
  assert.equal(shape.holes[0].curves.length, 3);
});

test("createPlot3DMesh produces extruded 3D group with canonical metadata", () => {
  const plot = {
    id: "plot-101",
    original_number: "42",
    semantic_validation_status: "verified",
    geometry: {
      type: "Polygon",
      coordinates: makePolyCoords(10, 10, 30, 30),
    },
  };

  const group = createPlot3DMesh(plot, 0, 0, 1.5, false);
  assert.ok(group);
  assert.equal(group.name, "plot-plot-101");
  assert.equal(group.userData.entityType, "Plot");
  assert.equal(group.userData.id, "plot-101");
  assert.equal(group.userData.plotNumber, "42");
  // Contains mesh and wireframe
  assert.ok(group.children.length >= 2);
});

test("createPlot3DMesh differentiates review_required and conflicted statuses", () => {
  const plotReview = {
    id: "plot-rev",
    semantic_validation_status: "review_required",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  };
  const groupReview = createPlot3DMesh(plotReview, 0, 0, 1.5, false);
  const meshRev = groupReview.children.find((c) => c.isMesh);
  assert.ok(meshRev);
  // Color should be warning yellow (0xfef08a)
  assert.equal(meshRev.material.color.getHex(), 0xfef08a);

  const plotConflicted = {
    id: "plot-conf",
    semantic_validation_status: "conflicted",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  };
  const groupConf = createPlot3DMesh(plotConflicted, 0, 0, 1.5, false);
  const meshConf = groupConf.children.find((c) => c.isMesh);
  assert.ok(meshConf);
  // Color should be red (0xfecaca)
  assert.equal(meshConf.material.color.getHex(), 0xfecaca);
});

test("createPlot3DMesh treats a missing review status as unverified", () => {
  const group = createPlot3DMesh({
    id: "plot-unreviewed",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  }, 0, 0, 1.5, false);
  const mesh = group.children.find((child) => child.isMesh);
  assert.equal(mesh.material.color.getHex(), 0xfef08a);
});

test("createPlot3DMesh uses every polygon in a canonical MultiPolygon", () => {
  const group = createPlot3DMesh({
    id: "plot-multipart",
    semantic_validation_status: "review_required",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        makePolyCoords(0, 0, 10, 10),
        makePolyCoords(20, 0, 30, 10),
      ],
    },
  }, 0, 0, 1.5, false);
  assert.equal(group.children.filter((child) => child.isMesh).length, 2);
});

test("createRoad3DMesh creates road geometry with z-fighting offset", () => {
  const road = {
    id: "road-r1",
    geometry: {
      type: "Polygon",
      coordinates: makePolyCoords(0, 0, 100, 20),
    },
  };

  const group = createRoad3DMesh(road, 0, 0);
  assert.ok(group);
  assert.equal(group.userData.entityType, "Road");
  const mesh = group.children.find((c) => c.isMesh);
  assert.ok(mesh);
  assert.equal(mesh.position.y, 0.02);
});

test("createRoad3DMesh handles MultiPolygon road corridors", () => {
  const group = createRoad3DMesh({
    id: "road-multipart",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        makePolyCoords(0, 0, 10, 4),
        makePolyCoords(20, 0, 30, 4),
      ],
    },
  }, 0, 0);
  assert.equal(group.children.filter((child) => child.isMesh).length, 2);
});

test("createRoad3DMesh retains LineString and MultiLineString centerlines", () => {
  for (const geometry of [
    { type: "LineString", coordinates: [[0, 0], [10, 10]] },
    { type: "MultiLineString", coordinates: [[[0, 0], [10, 10]], [[20, 0], [30, 10]]] },
  ]) {
    const group = createRoad3DMesh({ id: "road-centerline", geometry }, 0, 0);
    assert.equal(group.children.every((child) => child.isLine), true);
    assert.equal(group.children[0].userData.entityType, "Road");
  }
});

test("createLandUse3DMesh uses the source Polygon and MultiPolygon shapes", () => {
  const feature = {
    id: "park-1",
    name: "Garden",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        makePolyCoords(0, 0, 10, 10),
        makePolyCoords(20, 0, 30, 10),
      ],
    },
  };
  const group = createLandUse3DMesh(feature, 0, 0);
  assert.equal(group.userData.entityType, "LandUse");
  assert.equal(group.userData.canonicalLandUse, feature);
  assert.equal(group.children.filter((child) => child.isMesh).length, 2);
  assert.equal(createLandUse3DMesh({ geometry: { type: "LineString", coordinates: [] } }, 0, 0), null);
});

test("createBoundary3DLine creates boundary line elevated above road plane", () => {
  const boundary = {
    type: "Polygon",
    coordinates: makePolyCoords(0, 0, 200, 200),
  };

  const group = createBoundary3DLine(boundary, 0, 0);
  assert.ok(group);
  assert.equal(group.name, "boundary-perimeter");
  assert.ok(group.children.length >= 1);
});

test("createPlot3DMesh supports inventory status colors", () => {
  const plotSold = {
    id: "plot-sold-1",
    status_id: "sold",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  };
  const groupSold = createPlot3DMesh(plotSold, 0, 0, 1.5, false, null, { showStatusColors: true });
  const meshSold = groupSold.children.find((c) => c.isMesh);
  assert.ok(meshSold);
  assert.equal(meshSold.material.color.getHex(), 0xef4444);

  const plotHold = {
    id: "plot-hold-1",
    status_id: "hold",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  };
  const groupHold = createPlot3DMesh(plotHold, 0, 0, 1.5, false, null, { showStatusColors: true });
  const meshHold = groupHold.children.find((c) => c.isMesh);
  assert.ok(meshHold);
  assert.equal(meshHold.material.color.getHex(), 0xf59e0b);
});

test("createPlot3DMesh supports zone coloring", () => {
  const plotZone = {
    id: "plot-zone-b",
    zone_id: "zone-b",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  };
  const zonesById = {
    "zone-b": { id: "zone-b", code: "B", color: "#3b82f6" },
  };
  const group = createPlot3DMesh(plotZone, 0, 0, 1.5, false, null, { showZones: true, zonesById });
  const mesh = group.children.find((c) => c.isMesh);
  assert.ok(mesh);
  assert.equal(mesh.material.color.getHex(), 0x3b82f6);
});

test("createColonyBoundaryWall constructs 3D wall and structural piers", () => {
  const boundary = {
    type: "Polygon",
    coordinates: makePolyCoords(0, 0, 100, 100),
  };
  const group = createColonyBoundaryWall(boundary, 0, 0);
  assert.ok(group);
  assert.equal(group.name, "colony-boundary-wall");
  assert.ok(group.children.length >= 4);
});

test("createBuildingMassing generates multi-tier villa volumes", () => {
  const plot = {
    id: "plot-villa",
    geometry: { type: "Polygon", coordinates: makePolyCoords(10, 10, 30, 30) },
  };
  const villa = createBuildingMassing(plot, 0, 0);
  assert.ok(villa);
  assert.equal(villa.name, "building-plot-villa");
  // Multiple architectural meshes (ground floor, glass, upper floor, pergola)
  assert.ok(villa.children.length >= 3);
});

test("createLandscapeTrees generates vegetation meshes for green parcels", () => {
  const greens = [
    {
      id: "park-trees",
      geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 40, 40) },
    },
  ];
  const trees = createLandscapeTrees([], [], greens, 0, 0);
  assert.ok(trees);
  assert.equal(trees.name, "landscape-vegetation");
  assert.ok(trees.children.length >= 1);
});

test("createAerialTerrainMesh creates base ground plane with elevation", () => {
  const terrain = createAerialTerrainMesh({ cx: 0, cy: 0, span: 200, terrainEnabled: true });
  assert.ok(terrain);
  assert.equal(terrain.name, "aerial-terrain-base");
  assert.ok(terrain.children.length >= 1);
});

test("createPlotNumberSprite handles non-DOM environment gracefully", () => {
  const plot = {
    id: "plot-spr",
    number: "42",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  };
  // In Node.js environment without document, it should return null without throwing
  const sprite = createPlotNumberSprite(plot, 0, 0);
  assert.equal(sprite, null);
});

test("preparePolygonForTriangulation normalizes duplicate vertices and strips redundant closure", () => {
  const geomWithDuplicates = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [0, 0], // consecutive duplicate
        [10, 0],
        [10, 10],
        [10, 10], // consecutive duplicate
        [0, 10],
        [0, 0], // redundant closing coordinate
      ],
    ],
  };

  const res = preparePolygonForTriangulation(geomWithDuplicates, 0, 0);
  assert.ok(res.valid);
  assert.equal(res.shapes.length, 1);
  // 4 unique vertices produce 3 curves (closed by Shape)
  assert.equal(res.shapes[0].curves.length, 3);
});

test("preparePolygonForTriangulation supports concave (L-shaped) polygons", () => {
  const concaveGeom = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [20, 0],
        [20, 10],
        [10, 10],
        [10, 20],
        [0, 20],
        [0, 0],
      ],
    ],
  };

  const res = preparePolygonForTriangulation(concaveGeom, 0, 0);
  assert.ok(res.valid);
  assert.equal(res.shapes.length, 1);
  assert.equal(res.shapes[0].curves.length, 5);
});

test("preparePolygonForTriangulation safely discards degenerate zero-area holes without crashing", () => {
  // Simulates the exact bug in colonies 'pp' and 'shre' where holes had identical points
  const geomWithDegenerateHole = {
    type: "Polygon",
    coordinates: [
      // Exterior: 50x50 box
      [[0, 0], [50, 0], [50, 50], [0, 50], [0, 0]],
      // Degenerate hole: 6 identical vertices that crash Earcut eliminateHoles
      [[25, 25], [25, 25], [25, 25], [25, 25], [25, 25], [25, 25]],
    ],
  };

  const res = preparePolygonForTriangulation(geomWithDegenerateHole, 0, 0);
  assert.ok(res.valid);
  assert.equal(res.shapes.length, 1);
  // Degenerate hole must be discarded, so holes count is 0
  assert.equal(res.shapes[0].holes.length, 0);
});

test("preparePolygonForTriangulation rejects empty or degenerate polygons", () => {
  const degenerateLineGeom = {
    type: "Polygon",
    coordinates: [[[0, 0], [10, 0], [0, 0]]],
  };

  const res = preparePolygonForTriangulation(degenerateLineGeom, 0, 0);
  assert.equal(res.valid, false);
  assert.ok(res.reason.includes("degenerate"));
});

test("preparePolygonForTriangulation rejects non-finite coordinates", () => {
  const nanGeom = {
    type: "Polygon",
    coordinates: [[[0, 0], [NaN, 10], [10, 10], [0, 10], [0, 0]]],
  };

  const res = preparePolygonForTriangulation(nanGeom, 0, 0);
  assert.equal(res.valid, false);
  assert.ok(res.reason.includes("non-finite"));
});

test("preparePolygonForTriangulation handles MultiPolygon geometry", () => {
  const multiGeom = {
    type: "MultiPolygon",
    coordinates: [
      [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
    ],
  };

  const res = preparePolygonForTriangulation(multiGeom, 0, 0);
  assert.ok(res.valid);
  assert.equal(res.shapes.length, 2);
});

test("createPlot3DMesh isolates malformed plot without crashing valid plots in scene", () => {
  const validPlot = {
    id: "plot-valid",
    number: "1",
    geometry: { type: "Polygon", coordinates: makePolyCoords(0, 0, 10, 10) },
  };

  const invalidPlot = {
    id: "plot-invalid",
    number: "2",
    geometry: { type: "Polygon", coordinates: [[[0, 0], [NaN, 0], [0, 0]]] },
  };

  const rejectedLogs = [];
  const validMesh = createPlot3DMesh(validPlot, 0, 0, 1.4, false, null, {
    onGeometryRejected: (details) => rejectedLogs.push(details),
  });
  const invalidMesh = createPlot3DMesh(invalidPlot, 0, 0, 1.4, false, null, {
    onGeometryRejected: (details) => rejectedLogs.push(details),
  });

  // Valid plot renders successfully
  assert.ok(validMesh);
  assert.equal(validMesh.userData.id, "plot-valid");

  // Invalid plot returns null safely and records rejection reason
  assert.equal(invalidMesh, null);
  assert.equal(rejectedLogs.length, 1);
  assert.equal(rejectedLogs[0].entityId, "plot-invalid");
  assert.ok(rejectedLogs[0].reason);
});


