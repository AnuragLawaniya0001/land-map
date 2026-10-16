import assert from "node:assert/strict";
import test from "node:test";
import {
  findPlotAtPoint,
  estimatePlotDimensions,
  getUnrepresentedPdfPlots,
  geoJSONBounds,
  geoJSONToLatLngs,
  isSelectablePlotGeometry,
  transformOverlayPoint,
  transformOverlayGeometry,
} from "./geo.js";

const polygon = (west, south, east, north) => ({
  type: "Polygon",
  coordinates: [[
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]],
});

const site = polygon(78, 27, 78.004, 27.004);

test("a click inside a plot selects that plot and not its neighbor", () => {
  const plots = [
    { id: "a", number: "A1", geometry: polygon(78.0001, 27.0001, 78.001, 27.001) },
    { id: "b", number: "A2", geometry: polygon(78.0011, 27.0001, 78.002, 27.001) },
  ];

  assert.equal(findPlotAtPoint(plots, [27.0005, 78.0005], site)?.id, "a");
  assert.equal(findPlotAtPoint(plots, [27.0005, 78.0015], site)?.id, "b");
});

test("clicks on roads or outside the land boundary do not select a plot", () => {
  const plots = [{ id: "a", geometry: polygon(78.0001, 27.0001, 78.001, 27.001) }];

  assert.equal(findPlotAtPoint(plots, [27.002, 78.002], site), null);
  assert.equal(findPlotAtPoint(plots, [26.99, 78.0005], site), null);
});

test("overlapping polygons resolve to the smallest geometry then stable ID", () => {
  const plots = [
    { id: "large", geometry: polygon(78, 27, 78.002, 27.002) },
    { id: "z", geometry: polygon(78.0005, 27.0005, 78.0015, 27.0015) },
    { id: "a", geometry: polygon(78.0005, 27.0005, 78.0015, 27.0015) },
  ];

  assert.equal(findPlotAtPoint(plots, [27.001, 78.001], site)?.id, "a");
});

test("holes exclude clicks and MultiPolygon geometries retain their nested shape", () => {
  const withHole = {
    type: "Polygon",
    coordinates: [
      polygon(78, 27, 78.004, 27.004).coordinates[0],
      polygon(78.001, 27.001, 78.003, 27.003).coordinates[0],
    ],
  };
  const multi = {
    type: "MultiPolygon",
    coordinates: [
      polygon(78, 27, 78.001, 27.001).coordinates,
      polygon(78.002, 27.002, 78.003, 27.003).coordinates,
    ],
  };

  assert.equal(findPlotAtPoint([{ id: "hole", geometry: withHole }], [27.002, 78.002], site), null);
  assert.equal(isSelectablePlotGeometry(multi), true);
  assert.deepEqual(geoJSONBounds(multi), [[27, 78], [27.003, 78.003]]);
  assert.deepEqual(geoJSONToLatLngs(multi)[1][0][0], [27.002, 78.002]);
});

test("bad or non-polygon label-only geometry is not selectable", () => {
  const invalid = {
    type: "Polygon",
    coordinates: [[[78, 27], [78, 27], [78, 27]]],
  };

  assert.equal(isSelectablePlotGeometry(invalid), false);
  assert.equal(findPlotAtPoint([{ id: "label", geometry: { type: "Point", coordinates: [78.001, 27.001] } }], [27.001, 78.001], site), null);
});

test("plot hit geometry follows saved overlay calibration in Web Mercator", () => {
  const original = polygon(78.001, 27.001, 78.002, 27.002);
  const bounds = [[27, 78], [27.004, 78.004]];
  const translated = transformOverlayGeometry(original, bounds, {
    rotation_deg: 0,
    scale_x: 1,
    scale_y: 1,
    translation_x_m: 20,
    translation_y_m: 0,
  });
  const originalWest = geoJSONBounds(original)[0][1];
  const translatedBounds = geoJSONBounds(translated);
  const translatedWest = translatedBounds[0][1];
  const clickLatitude = (translatedBounds[0][0] + translatedBounds[1][0]) / 2;
  const clickLongitude = (translatedBounds[0][1] + translatedBounds[1][1]) / 2;

  assert.ok(translatedWest > originalWest);
  assert.equal(findPlotAtPoint(
    [{ id: "calibrated", geometry: original, selectionGeometry: translated }],
    [clickLatitude, clickLongitude],
    site,
  )?.id, "calibrated");
});

test("PDF regions add only plots missing from existing selectable records", () => {
  const existingPlots = [
    { id: "saved-1", number: "A-1", geometry: polygon(78, 27, 78.001, 27.001) },
  ];
  const pdfPlots = [
    { id: "pdf-1", number: "A1", geometry: polygon(78, 27, 78.001, 27.001) },
    { id: "pdf-2", number: "A2", geometry: polygon(78.001, 27, 78.002, 27.001) },
    { id: "pdf-invalid", number: "A3", geometry: { type: "Point", coordinates: [78, 27] } },
  ];

  const missingPlots = getUnrepresentedPdfPlots(existingPlots, pdfPlots);
  const selectablePlots = [...existingPlots, ...missingPlots];

  assert.deepEqual(missingPlots.map((plot) => plot.id), ["pdf-2"]);
  assert.equal(findPlotAtPoint(selectablePlots, [27.0005, 78.0015], site)?.id, "pdf-2");
});

test("extracted PDF annotation points use the same saved calibration as overlay polygons", () => {
  const bounds = [[27, 78], [27.004, 78.004]];
  const transform = {
    rotation_deg: 4,
    scale_x: 1.02,
    scale_y: 0.98,
    translation_x_m: 12,
    translation_y_m: -8,
  };
  const point = [78.001, 27.001];
  const polygonGeometry = polygon(78.001, 27.001, 78.002, 27.002);
  const transformedPolygon = transformOverlayGeometry(polygonGeometry, bounds, transform);
  const transformedPoint = transformOverlayPoint(point, bounds, transform);

  assert.deepEqual(transformedPoint, transformedPolygon.coordinates[0][0]);
});

test("detected plot geometry reports approximate length and width for the detail panel", () => {
  const dimensions = estimatePlotDimensions(polygon(78, 27, 78.0001, 27.0002));

  assert.ok(dimensions);
  assert.ok(dimensions.width_m > 9 && dimensions.width_m < 11);
  assert.ok(dimensions.depth_m > 21 && dimensions.depth_m < 23);
  assert.match(dimensions.dimensions, /^Approx\./);
});
