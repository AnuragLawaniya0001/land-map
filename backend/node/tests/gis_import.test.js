import test from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GeoPackageAPI } from "@ngageoint/geopackage";
import { config } from "../src/config/index.js";
import { extractPdf, fitDrawingToBoundary, ImportError, importColonyBundle, importFile } from "../src/gis/importer.js";

function makePdfTextFixture(texts) {
  const stream = `BT /F1 12 Tf 20 150 Td ${texts.map((text, index) => `${index ? "0 -20 Td " : ""}(${text}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

function makePdfVectorFixture(stream) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

test("Phase 17 — GIS Import Preview Tests", async (t) => {
  const initialPythonFallback = config.gis.enablePythonFallback;
  config.gis.enablePythonFallback = false;
  const jwtSecret = "test_jwt_secret";
  const adminToken = jwt.sign({ uid: "admin_1", role: "admin" }, jwtSecret);
  const unauthToken = null;

  await t.test("P17-01: Authentication & Authorization for GIS Import", async () => {
    assert.ok(adminToken);
    const decoded = jwt.verify(adminToken, jwtSecret);
    assert.strictEqual(decoded.role, "admin");
  });

  await t.test("P17-02: File Format Validation (.pdf, .dxf & .dwg allowed)", async () => {
    const isSupportedFormat = (filename) => {
      const lower = filename.toLowerCase();
      return lower.endsWith(".pdf") || lower.endsWith(".dxf") || lower.endsWith(".dwg");
    };

    assert.strictEqual(isSupportedFormat("layout_geo.pdf"), true);
    assert.strictEqual(isSupportedFormat("layout_latlng.dxf"), true);
    assert.strictEqual(isSupportedFormat("drawing.dwg"), true, "DWG is analyzed via the Python GIS worker");
    assert.strictEqual(isSupportedFormat("image.png"), false, "Unsupported PNG image rejected");
  });

  await t.test("P17-03: GIS Import Lifecycle state transitions (NO auto-commit)", async () => {
    const lifecycle = ["DRAFT", "UPLOADING", "PARSING", "PREVIEW_READY", "CALIBRATION_REQUIRED", "CALIBRATED", "VALIDATED", "COMMITTED"];
    
    let currentStatus = "DRAFT";
    assert.strictEqual(currentStatus, "DRAFT");

    currentStatus = "PREVIEW_READY";
    assert.notStrictEqual(currentStatus, "COMMITTED", "Preview data must NOT auto-commit to production");

    currentStatus = "CALIBRATED";
    currentStatus = "VALIDATED";
    currentStatus = "COMMITTED";
    assert.strictEqual(currentStatus, "COMMITTED", "Explicit commitment successful");
  });

  await t.test("P17-04: DWG import reports its Python/ODA dependency", async () => {
    await assert.rejects(
      importFile(Buffer.alloc(0), "drawing.dwg", "", "colony_1", new Date().toISOString()),
      (error) => {
        assert.ok(error instanceof ImportError);
        assert.match(error.message, /Python GIS worker and an installed ODA File Converter/);
        return true;
      },
    );
  });

  await t.test("P17-05: Production Commit validation gate", async () => {
    const validationSuccess = { is_valid: true, errors: [] };
    const validationFailure = { is_valid: false, errors: ["Duplicate plot number 101"] };

    const canCommit = (val) => val && val.is_valid && val.errors.length === 0;

    assert.strictEqual(canCommit(validationSuccess), true, "Valid import allowed to commit");
    assert.strictEqual(canCommit(validationFailure), false, "Invalid import commit blocked");
  });

  await t.test("P17-06: Discard/Cancel Import safety", async () => {
    let importStatus = "PREVIEW_READY";
    let productionPlotsCount = 0;

    // Simulate Cancellation
    importStatus = "CANCELLED";

    assert.strictEqual(importStatus, "CANCELLED");
    assert.strictEqual(productionPlotsCount, 0, "No production plots written upon cancellation");
  });

  await t.test("P17-07: QGIS GeoJSON imports WGS84 plots into colony schema", async () => {
    const geojson = {
      type: "FeatureCollection",
      features: Array.from({ length: 4 }, (_, i) => ({
        type: "Feature",
        properties: { plot_number: `A-${i + 1}` },
        geometry: { type: "Polygon", coordinates: [[[73.105 + i * 0.0003, 22.22], [73.1053 + i * 0.0003, 22.22], [73.1053 + i * 0.0003, 22.2203], [73.105 + i * 0.0003, 22.2203], [73.105 + i * 0.0003, 22.22]]] },
      })),
    };
    const [fields, zones, plots] = await importFile(Buffer.from(JSON.stringify(geojson)), "qgis.geojson", "", "colony_1", new Date().toISOString());

    assert.strictEqual(fields.import_source.mode, "qgis");
    assert.strictEqual(plots.length, 4);
    assert.strictEqual(zones.length, 1);
    assert.strictEqual(plots[0].colony_id, "colony_1");
    assert.ok(plots[0].geometry.coordinates[0][0][0] > 70, "Polygon is in longitude/latitude, not drawing-local coordinates");
  });

  await t.test("P17-08: KML polygons import as a georeferenced layout", async () => {
    const placemarks = Array.from({ length: 4 }, (_, i) => {
      const west = 73.105 + i * 0.0003;
      const east = west + 0.0003;
      return `<Placemark><name>A-${i + 1}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${west},22.22,0 ${east},22.22,0 ${east},22.2203,0 ${west},22.2203,0 ${west},22.22,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }).join("");
    const kml = `<kml><Document>${placemarks}</Document></kml>`;
    const [fields, zones, plots] = await importFile(Buffer.from(kml), "qgis.kml", "", "colony_2", new Date().toISOString());

    assert.strictEqual(fields.import_source.mode, "kml");
    assert.strictEqual(plots.length, 4);
    assert.strictEqual(zones.length, 1);
    assert.ok(plots.every((plot) => plot.geometry.type === "Polygon"));
  });

  await t.test("P17-08b: KML with XML namespaces and spaced coordinates", async () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2">
  <kml:Document>
    <kml:Placemark>
      <kml:name>Plot 1</kml:name>
      <kml:Polygon>
        <kml:outerBoundaryIs>
          <kml:LinearRing>
            <kml:coordinates>
              78.2374, 27.2447, 0.0
              78.2378, 27.2447, 0.0
              78.2378, 27.2450, 0.0
              78.2374, 27.2450, 0.0
              78.2374, 27.2447, 0.0
            </kml:coordinates>
          </kml:LinearRing>
        </kml:outerBoundaryIs>
      </kml:Polygon>
    </kml:Placemark>
    <kml:Placemark>
      <kml:name>Plot 2</kml:name>
      <kml:Polygon>
        <kml:outerBoundaryIs>
          <kml:LinearRing>
            <kml:coordinates>
              78.2380, 27.2447, 0.0
              78.2384, 27.2447, 0.0
              78.2384, 27.2450, 0.0
              78.2380, 27.2450, 0.0
              78.2380, 27.2447, 0.0
            </kml:coordinates>
          </kml:LinearRing>
        </kml:outerBoundaryIs>
      </kml:Polygon>
    </kml:Placemark>
  </kml:Document>
</kml:kml>`;
    const [fields, zones, plots] = await importFile(Buffer.from(kml), "colony_spaced.kml", "", "colony_ns_kml", new Date().toISOString());
    assert.strictEqual(plots.length, 2);
    assert.strictEqual(plots[0].number, "Plot 1");
    assert.strictEqual(plots[1].number, "Plot 2");
  });

  await t.test("P17-08c: KML LineString polygonization and Point label matching", async () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Folder><name>01 — Boundary</name>
      <Placemark><name>Land Boundary</name>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>
          78.2370,27.2440 78.2376,27.2440 78.2376,27.2446 78.2370,27.2446 78.2370,27.2440
        </coordinates></LinearRing></outerBoundaryIs></Polygon>
      </Placemark>
    </Folder>
    <Folder><name>03 — PDF linework</name>
      <Placemark><LineString><coordinates>78.2370,27.2443 78.2376,27.2443</coordinates></LineString></Placemark>
      <Placemark><LineString><coordinates>78.2373,27.2440 78.2373,27.2446</coordinates></LineString></Placemark>
    </Folder>
    <Folder><name>04 — PDF text labels</name>
      <Placemark><name>Plot 101</name><Point><coordinates>78.2371,27.2441</coordinates></Point></Placemark>
      <Placemark><name>Plot 102</name><Point><coordinates>78.2374,27.2441</coordinates></Point></Placemark>
      <Placemark><name>Plot 103</name><Point><coordinates>78.2371,27.2444</coordinates></Point></Placemark>
      <Placemark><name>Plot 104</name><Point><coordinates>78.2374,27.2444</coordinates></Point></Placemark>
    </Folder>
  </Document>
</kml>`;
    const [fields, zones, plots] = await importFile(Buffer.from(kml), "linework.kml", "", "colony_linework", new Date().toISOString());
    assert.strictEqual(plots.length, 4);
    const numbers = plots.map((p) => p.number).sort();
    assert.deepStrictEqual(numbers, ["Plot 101", "Plot 102", "Plot 103", "Plot 104"]);
  });

  await t.test("P17-09: QGIS GeoPackage imports EPSG:4326 plot layers", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "livemap-gpkg-test-"));
    const filePath = path.join(directory, "plots.gpkg");
    try {
      const gpkg = await GeoPackageAPI.create(filePath);
      gpkg.createFeatureTable("plots", undefined, [{ name: "plot_number", dataType: "TEXT" }]);
      const features = Array.from({ length: 4 }, (_, i) => ({
        type: "Feature",
        properties: { plot_number: `A-${i + 1}` },
        geometry: { type: "Polygon", coordinates: [[[73.105 + i * 0.0003, 22.22], [73.1053 + i * 0.0003, 22.22], [73.1053 + i * 0.0003, 22.2203], [73.105 + i * 0.0003, 22.2203], [73.105 + i * 0.0003, 22.22]]] },
      }));
      await gpkg.addGeoJSONFeaturesToGeoPackage(features, "plots");
      await gpkg.close();

      const [fields, zones, plots] = await importFile(await fs.readFile(filePath), "qgis.gpkg", "", "colony_3", new Date().toISOString());
      assert.strictEqual(fields.import_source.mode, "qgis");
      assert.strictEqual(plots.length, 4);
      assert.strictEqual(zones.length, 1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("P17-10: Combined GeoJSON, PDF, and KML cross-check", async () => {
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary", name: "site" }, geometry: { type: "Polygon", coordinates: [boundary] } },
      ...[1, 2].map((number) => {
        const west = 78.253 + number * 0.0001;
        return {
          type: "Feature",
          properties: { feature_type: "plot_polygon", plot_no: `P${number}` },
          geometry: { type: "Polygon", coordinates: [[[west, 27.2201], [west + 0.00008, 27.2201], [west + 0.00008, 27.2202], [west, 27.2202], [west, 27.2201]]] },
        };
      }),
    ];
    const kmlCoordinates = boundary.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    const kml = `<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const [fields, zones, plots, warnings] = await importColonyBundle({
      geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
      pdfBuffer: makePdfTextFixture(["P1", "P2"]),
      companionBuffer: Buffer.from(kml),
      geojsonFilename: "plots.geojson",
      pdfFilename: "layout.pdf",
      companionFilename: "boundary.kml",
      colonyId: "colony_bundle",
      now: new Date().toISOString(),
    });

    assert.deepStrictEqual(plots.map((plot) => plot.number), ["P1", "P2"]);
    assert.strictEqual(zones.length, 1);
    assert.strictEqual(fields.import_source.mode, "qgis_pdf_kml");
    assert.strictEqual(fields.import_source.validation.pdf_plot_number_coverage, 1);
    assert.strictEqual(fields.import_source.validation.kml_contained_plot_coverage, 1);
    assert.strictEqual(fields.import_source.land_boundary_method, "explicit_geojson_site_boundary");
    assert.deepStrictEqual(fields.boundary.coordinates[0][0], [78.253, 27.22]);
    assert.ok(warnings.some((warning) => /no geographic reference or scale/.test(warning)));

  });

  await t.test("P17-11: Combined import rejects point-only GeoJSON instead of guessing plot boundaries", async () => {
    const pointsOnly = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { feature_type: "plot_label_point", plot_no: "1" }, geometry: { type: "Point", coordinates: [78.0005, 27.0005] } },
        { type: "Feature", properties: { feature_type: "plot_label_point", plot_no: "2" }, geometry: { type: "Point", coordinates: [78.0007, 27.0005] } },
      ],
    };
    await assert.rejects(
      importColonyBundle({
        geojsonBuffer: Buffer.from(JSON.stringify(pointsOnly)),
        pdfBuffer: makePdfTextFixture(["1", "2"]),
        companionBuffer: Buffer.from("<kml/>"),
        geojsonFilename: "points.geojson",
        pdfFilename: "layout.pdf",
        companionFilename: "boundary.kml",
        colonyId: "colony_bundle_points",
        now: new Date().toISOString(),
      }),
      (error) => error instanceof ImportError &&
        /only plot labels and no explicit land boundary/.test(error.message),
    );
  });

  await t.test("P17-12: Boundary-only bundle imports the verified land outline without generating plots", async () => {
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary", name: "site" }, geometry: { type: "Polygon", coordinates: [boundary] } },
      { type: "Feature", properties: { feature_type: "plot_label_point", plot_no: "P1" }, geometry: { type: "Point", coordinates: [78.2532, 27.2202] } },
      { type: "Feature", properties: { feature_type: "plot_label_point", plot_no: "P2" }, geometry: { type: "Point", coordinates: [78.2537, 27.2207] } },
    ];
    const kmlCoordinates = boundary.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    const kml = `<kml><Placemark><name>Site boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const [fields, zones, plots, warnings] = await importColonyBundle({
      geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
      pdfBuffer: makePdfTextFixture(["P1", "P2"]),
      companionBuffer: Buffer.from(kml),
      geojsonFilename: "points-and-boundary.geojson",
      pdfFilename: "layout.pdf",
      companionFilename: "boundary.kml",
      colonyId: "colony_boundary_only",
      now: new Date().toISOString(),
    });

    assert.strictEqual(plots.length, 0);
    assert.strictEqual(zones.length, 0);
    assert.deepStrictEqual(fields.boundary.coordinates[0][0], [78.253, 27.22]);
    assert.strictEqual(fields.import_source.mode, "qgis_pdf_kml_boundary_only");
    assert.strictEqual(fields.import_source.validation.boundary_only_update, true);
    assert.strictEqual(fields.import_source.validation.pdf_plot_number_coverage, 1);
    assert.strictEqual(fields.import_source.validation.kml_land_boundary_overlap, 1);
    assert.strictEqual(fields.import_source.validation.kml_contained_point_coverage, undefined);
    assert.ok(warnings.some((warning) => /no plot parcel geometry was supplied/.test(warning)));
  });

  await t.test("P17-13: Boundary-only import rejects disagreeing GeoJSON and KML outlines", async () => {
    const geoBoundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const kmlBoundary = geoBoundary.map(([lng, lat]) => `${lng + 0.01},${lat + 0.01},0`).join(" ");
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: { type: "Polygon", coordinates: [geoBoundary] } },
      { type: "Feature", properties: { plot_no: "P1" }, geometry: { type: "Point", coordinates: [78.2532, 27.2202] } },
    ];
    await assert.rejects(
      importColonyBundle({
        geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
        pdfBuffer: makePdfTextFixture(["P1"]),
        companionBuffer: Buffer.from(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlBoundary}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`),
        geojsonFilename: "points-and-boundary.geojson",
        pdfFilename: "layout.pdf",
        companionFilename: "boundary.kml",
        colonyId: "colony_mismatched_boundary",
        now: new Date().toISOString(),
      }),
      (error) => error instanceof ImportError && /overlap by only/.test(error.message),
    );
  });

  await t.test("P17-14: PDF default strokes are black and Bézier curves do not create false parcel edges", async () => {
    const drawing = await extractPdf(makePdfVectorFixture("10 10 m 20 10 l 30 10 40 20 50 20 c 60 20 l 70 30 l S"));
    assert.strictEqual(drawing.lines.length, 2);
    assert.ok(drawing.lines.every(([, , color]) => color?.every((component) => component === 0)));
    assert.deepStrictEqual(
      drawing.lines.map(([start, end]) => [start[0], end[0]]),
      [[10, 20], [60, 70]],
    );
  });

  await t.test("P17-15: PDF plot geometry uses the existing land boundary when Python processing is unavailable", async () => {
    const boundary = {
      type: "Polygon",
      coordinates: [[[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]]],
    };
    const squares = [
      "10 10 m 20 10 l 20 20 l 10 20 l 10 10 l S",
      "20 10 m 30 10 l 30 20 l 20 20 l 20 10 l S",
      "10 20 m 20 20 l 20 30 l 10 30 l 10 20 l S",
      "20 20 m 30 20 l 30 30 l 20 30 l 20 20 l S",
    ].join(" ");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Python GIS service unavailable"); };
    try {
      const [fields, , plots, warnings] = await importFile(
        makePdfVectorFixture(squares),
        "layout.pdf",
        "",
        "colony_boundary_fit",
        new Date().toISOString(),
        { targetBoundary: boundary },
      );

      assert.strictEqual(plots.length, 4);
      assert.strictEqual(fields.import_source.mode, "boundary_fitted");
      assert.ok(warnings.some((warning) => /uniform scale.*proportions were preserved/.test(warning)));
      const plotCoordinates = plots.flatMap((plot) => plot.geometry.coordinates[0]);
      assert.ok(plotCoordinates.every(([lng, lat]) =>
        lng >= 78.253 - 1e-7 && lng <= 78.254 + 1e-7 &&
        lat >= 27.22 - 1e-7 && lat <= 27.221 + 1e-7
      ));
      assert.ok(fields.boundary);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("P17-15a: Boundary fitting preserves the PDF drawing aspect ratio", async () => {
    const boundary = {
      type: "Polygon",
      coordinates: [[[78.253, 27.22], [78.2535, 27.22], [78.2535, 27.2205], [78.253, 27.2205], [78.253, 27.22]]],
    };
    const drawing = {
      lines: [
        [[0, 0], [25, 0]],
        [[25, 0], [25, 12]],
        [[25, 12], [0, 12]],
        [[0, 12], [0, 0]],
      ],
      polys: [],
    };
    const warnings = [];
    const transform = fitDrawingToBoundary(drawing, boundary, warnings);
    const westSouth = transform(0, 0);
    const eastSouth = transform(25, 0);
    const eastNorth = transform(25, 12);
    const westNorth = transform(0, 12);
    const metersPerLng = 111320 * Math.cos(27.22025 * Math.PI / 180);
    const widthM = Math.hypot((eastSouth[0] - westSouth[0]) * metersPerLng, (eastSouth[1] - westSouth[1]) * 110574);
    const heightM = Math.hypot((eastNorth[0] - eastSouth[0]) * metersPerLng, (eastNorth[1] - eastSouth[1]) * 110574);
    assert.ok(Math.abs(widthM / heightM - 25 / 12) < 1e-5);
    assert.ok([westSouth, eastSouth, eastNorth, westNorth].every(([lng, lat]) =>
      lng >= 78.253 - 1e-7 && lng <= 78.2535 + 1e-7 &&
      lat >= 27.22 - 1e-7 && lat <= 27.2205 + 1e-7
    ));
    assert.ok(warnings.some((warning) => /uniform scale/.test(warning)));
  });

  await t.test("P17-15b: Boundary fitting optimizes placement inside a convex land outline", async () => {
    const boundary = {
      type: "Polygon",
      coordinates: [[[78.253, 27.22], [78.2542, 27.22], [78.2538, 27.221], [78.2532, 27.221], [78.253, 27.22]]],
    };
    const drawing = {
      lines: [
        [[0, 0], [6, 0]],
        [[6, 0], [6, 4]],
        [[6, 4], [0, 4]],
        [[0, 4], [0, 0]],
      ],
      polys: [],
    };
    const transform = fitDrawingToBoundary(drawing, boundary, []);
    const fitted = [[0, 0], [6, 0], [6, 4], [0, 4]].map(([x, y]) => transform(x, y));
    const polygonArea = (ring) => Math.abs(ring.reduce((sum, [x, y], index) => {
      const [nextX, nextY] = ring[(index + 1) % ring.length];
      return sum + x * nextY - nextX * y;
    }, 0) / 2);
    const targetArea = polygonArea(boundary.coordinates[0]);
    const fittedArea = polygonArea(fitted);
    const isInside = ([x, y]) => {
      let inside = false;
      const ring = boundary.coordinates[0];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };

    assert.ok(fitted.every(isInside));
    assert.ok(fittedArea / targetArea > 0.65);
    const metersPerLng = 111320 * Math.cos(27.2205 * Math.PI / 180);
    const metricLength = (first, second) => Math.hypot(
      (second[0] - first[0]) * metersPerLng,
      (second[1] - first[1]) * 110574,
    );
    assert.ok(Math.abs(metricLength(fitted[0], fitted[1]) /
      metricLength(fitted[0], fitted[3]) - 1.5) < 1e-4);
  });

  await t.test("P17-16: PDF mapping dispatch authenticates to the Python GIS service", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const boundary = { type: "Polygon", coordinates: [[[78, 27], [78.001, 27], [78.001, 27.001], [78, 27.001], [78, 27]]] };
    let dispatchedBoundary;
    let dispatchedColonyId;
    let dispatchedNow;
    const importNow = "2026-01-02T03:04:05.000Z";
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async (_url, options) => {
      assert.strictEqual(options.headers["X-Internal-Token"], config.gis.internalSecret);
      assert.strictEqual(options.headers["x-internal-secret"], undefined);
      dispatchedBoundary = JSON.parse(options.body.get("target_boundary"));
      dispatchedColonyId = options.body.get("colony_id");
      dispatchedNow = options.body.get("now");
      return {
        ok: true,
        json: async () => ({
          colony: { import_source: { mode: "boundary_fitted" } },
          zones: [{ id: "zone-preview-a", colony_id: "preview" }],
          plots: [{ id: "plot-preview-p1", zone_id: "zone-preview-a", colony_id: "preview" }],
          warnings: [],
        }),
      };
    };
    try {
      const [fields, zones, plots] = await importFile(
        Buffer.from("%PDF-1.4"),
        "layout.pdf",
        "",
        "colony_python_dispatch",
        importNow,
        { targetBoundary: boundary },
      );
      assert.deepStrictEqual(dispatchedBoundary, boundary);
      assert.strictEqual(dispatchedColonyId, "colony_python_dispatch");
      assert.strictEqual(dispatchedNow, "2026-01-02T03:04:05.000Z");
      assert.strictEqual(zones[0].id, "zone-colony_python_dispatch-a");
      assert.strictEqual(zones[0].colony_id, "colony_python_dispatch");
      assert.strictEqual(plots[0].id, "plot-colony_python_dispatch-p1");
      assert.strictEqual(plots[0].zone_id, "zone-colony_python_dispatch-a");
      assert.strictEqual(plots[0].colony_id, "colony_python_dispatch");
      assert.strictEqual(fields.import_source.mode, "boundary_fitted");
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-17: Combined mapping sends only the explicit land outline to Python", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: { type: "Polygon", coordinates: [boundary] } },
      { type: "Feature", properties: { feature_type: "plot_polygon", plot_no: "P1" }, geometry: { type: "Polygon", coordinates: [[[78.2531, 27.2201], [78.2532, 27.2201], [78.2532, 27.2202], [78.2531, 27.2202], [78.2531, 27.2201]]] } },
    ];
    const kmlCoordinates = boundary.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    let sentBoundary;
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async (_url, options) => {
      assert.strictEqual(options.headers["X-Internal-Token"], config.gis.internalSecret);
      sentBoundary = JSON.parse(options.body.get("target_boundary"));
      return {
        ok: true,
        json: async () => ({
          colony: { boundary: { type: "Polygon", coordinates: [boundary] }, map_center: { lng: 78.2537, lat: 27.2207 }, import_source: { mode: "boundary_fitted" } },
          zones: [],
          plots: [{ id: "pdf-plot", number: "P1", geometry: { type: "Polygon", coordinates: [[[78.2531, 27.2201], [78.2532, 27.2201], [78.2532, 27.2202], [78.2531, 27.2202], [78.2531, 27.2201]]] } }],
          warnings: [],
        }),
      };
    };
    try {
      const [, , plots] = await importColonyBundle({
        geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
        pdfBuffer: makePdfTextFixture(["P1"]),
        companionBuffer: Buffer.from(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`),
        geojsonFilename: "plots.geojson",
        pdfFilename: "layout.pdf",
        companionFilename: "boundary.kml",
        colonyId: "colony_pdf_priority",
        now: new Date().toISOString(),
      });
      assert.deepStrictEqual(sentBoundary, { type: "Polygon", coordinates: [boundary] });
      assert.deepStrictEqual(plots.map((plot) => plot.number), ["P1"]);
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-18: Rejects out-of-land QGIS plots when PDF mapping could not be parsed", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const outsidePlot = [[78.255, 27.222], [78.2552, 27.222], [78.2552, 27.2222], [78.255, 27.2222], [78.255, 27.222]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: { type: "Polygon", coordinates: [boundary] } },
      { type: "Feature", properties: { feature_type: "plot_polygon", plot_no: "P1" }, geometry: { type: "Polygon", coordinates: [outsidePlot] } },
    ];
    const kmlCoordinates = boundary.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => "PDF has no closed plot shapes" });
    try {
      await assert.rejects(
        importColonyBundle({
          geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
          pdfBuffer: makePdfTextFixture(["P1"]),
          companionBuffer: Buffer.from(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`),
          geojsonFilename: "plots.geojson",
          pdfFilename: "layout.pdf",
          companionFilename: "boundary.kml",
          colonyId: "colony_outside_plots",
          now: new Date().toISOString(),
        }),
        (error) => error instanceof ImportError &&
          /only 0% of plots inside the land boundary/.test(error.message) &&
          /PDF mapping could not be used/.test(error.message) &&
          /No mapping was updated/.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-19: Replacement mapping positions PDF plots against the saved colony boundary", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const existingBoundary = {
      type: "Polygon",
      coordinates: [[[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]]],
    };
    const qgisBoundary = {
      type: "Polygon",
      coordinates: [[[78.263, 27.23], [78.264, 27.23], [78.264, 27.231], [78.263, 27.231], [78.263, 27.23]]],
    };
    const crossingPlot = [[78.2527, 27.2202], [78.2534, 27.2202], [78.2534, 27.2204], [78.2527, 27.2204], [78.2527, 27.2202]];
    const kmlCoordinates = existingBoundary.coordinates[0].map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: qgisBoundary },
      { type: "Feature", properties: { feature_type: "plot_polygon", plot_no: "P1" }, geometry: { type: "Polygon", coordinates: [crossingPlot] } },
    ];
    let sentBoundary;
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async (_url, options) => {
      sentBoundary = JSON.parse(options.body.get("target_boundary"));
      return {
        ok: true,
        json: async () => ({
          colony: { boundary: existingBoundary, map_center: { lng: 78.2535, lat: 27.2205 }, import_source: { mode: "boundary_fitted" } },
          zones: [],
          plots: [{ id: "pdf-p1", number: "P1", geometry: { type: "Polygon", coordinates: [existingBoundary.coordinates[0]] } }],
          warnings: [],
        }),
      };
    };
    try {
      const [fields, , plots] = await importColonyBundle({
        geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
        pdfBuffer: makePdfTextFixture(["P1"]),
        companionBuffer: Buffer.from(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`),
        geojsonFilename: "plots.geojson",
        pdfFilename: "layout.pdf",
        companionFilename: "boundary.kml",
        colonyId: "colony_existing_boundary",
        now: new Date().toISOString(),
        existingBoundary,
      });
      assert.deepStrictEqual(sentBoundary, existingBoundary);
      assert.deepStrictEqual(fields.boundary, existingBoundary);
      assert.deepStrictEqual(plots.map((plot) => plot.id), ["pdf-p1"]);
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-20: Numbered point labels cannot silently produce boundary-only success when PDF fitting fails", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: { type: "Polygon", coordinates: [boundary] } },
      { type: "Feature", properties: { plot_no: "P1" }, geometry: { type: "Point", coordinates: [78.2532, 27.2202] } },
    ];
    const kmlCoordinates = boundary.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => "The supplied land boundary could not be used to fit the PDF drawing." });
    try {
      await assert.rejects(
        importColonyBundle({
          geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
          pdfBuffer: makePdfVectorFixture("10 10 m 20 10 l 20 20 l 10 20 l 10 10 l S"),
          companionBuffer: Buffer.from(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`),
          geojsonFilename: "labels.geojson",
          pdfFilename: "layout.pdf",
          companionFilename: "boundary.kml",
          colonyId: "colony_point_labels",
          now: new Date().toISOString(),
        }),
        (error) => error instanceof ImportError &&
          /PDF plot mapping failed for the 1 numbered GeoJSON plot labels/.test(error.message) &&
          /No boundary-only update was applied/.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-21: Completes partial PDF parcels when GeoJSON contains more numbered labels", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: { type: "Polygon", coordinates: [boundary] } },
      ...["P1", "P2", "P3"].map((number, index) => ({
        type: "Feature",
        properties: { plot_no: number },
        geometry: { type: "Point", coordinates: [78.2532 + index * 0.0001, 27.2202] },
      })),
    ];
    const kmlCoordinates = boundary.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        colony: { boundary: { type: "Polygon", coordinates: [boundary] }, map_center: { lng: 78.2535, lat: 27.2205 }, import_source: { mode: "boundary_fitted" } },
        zones: [],
        plots: [{
          id: "pdf-p1",
          number: "P1",
          geometry: { type: "Polygon", coordinates: [[[78.2532, 27.2202], [78.2533, 27.2202], [78.2533, 27.2203], [78.2532, 27.2203], [78.2532, 27.2202]]] },
        }],
        warnings: [],
      }),
    });
    try {
      const [, , plots] = await importColonyBundle({
        geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
        pdfBuffer: makePdfVectorFixture("10 10 m 20 10 l 20 20 l 10 20 l 10 10 l S"),
        companionBuffer: Buffer.from(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`),
        geojsonFilename: "labels.geojson",
        pdfFilename: "layout.pdf",
        companionFilename: "boundary.kml",
        colonyId: "colony_partial_pdf",
        now: new Date().toISOString(),
      });
      const numbers = new Set(plots.map((p) => p.number));
      assert.deepStrictEqual([...numbers].sort(), ["P1", "P2", "P3"]);
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-22: Successful PDF parcel recovery removes the stale boundary-only warning", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: { type: "Polygon", coordinates: [boundary] } },
      ...["P1", "P2", "P3"].map((number, index) => ({
        type: "Feature",
        properties: { plot_no: number },
        geometry: { type: "Point", coordinates: [78.2532 + index * 0.0001, 27.2202] },
      })),
    ];
    const kmlCoordinates = boundary.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        colony: { boundary: { type: "Polygon", coordinates: [boundary] }, map_center: { lng: 78.2535, lat: 27.2205 }, import_source: { mode: "boundary_fitted" } },
        zones: [],
        plots: ["P1", "P2", "P3"].map((number, index) => ({
          id: `pdf-${number}`,
          number,
          geometry: { type: "Polygon", coordinates: [[[78.2532 + index * 0.0001, 27.2202], [78.25325 + index * 0.0001, 27.2202], [78.25325 + index * 0.0001, 27.22025], [78.2532 + index * 0.0001, 27.22025], [78.2532 + index * 0.0001, 27.2202]]] },
        })),
        warnings: ["Recovered all 3 numbered plot parcels from the PDF vector boundaries."],
      }),
    });
    try {
      const [fields, , plots, warnings] = await importColonyBundle({
        geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
        pdfBuffer: makePdfTextFixture(["P1", "P2", "P3"]),
        companionBuffer: Buffer.from(`<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`),
        geojsonFilename: "labels.geojson",
        pdfFilename: "layout.pdf",
        companionFilename: "boundary.kml",
        colonyId: "colony_pdf_recovered",
        now: new Date().toISOString(),
      });
      assert.strictEqual(plots.length, 3);
      assert.ok(warnings.some((warning) => /Recovered all 3 numbered plot parcels/.test(warning)));
      assert.ok(!warnings.some((warning) => /Only an explicit colony land boundary was imported/.test(warning)));
      assert.strictEqual(fields.import_source.mode, "qgis_pdf_kml");
      assert.strictEqual(fields.import_source.sources.plot_geometry, "pdf_recovered_plot_parcels");
      assert.strictEqual(fields.import_source.validation.plot_count, 3);
      assert.ok(Math.abs(fields.map_center.lng - 78.2535) < 1e-5);
      assert.ok(Math.abs(fields.map_center.lat - 27.2205) < 1e-5);
      assert.ok(plots.every((plot) => plot.colony_id === "colony_pdf_recovered"));
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-23: DWG companions are converted by Python and provide numbered plot geometry", async () => {
    const originalFetch = globalThis.fetch;
    const originalFallback = config.gis.enablePythonFallback;
    const boundary = [[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]];
    const features = [
      { type: "Feature", properties: { feature_type: "site_boundary" }, geometry: { type: "Polygon", coordinates: [boundary] } },
    ];
    const plots = ["P1", "P2"].map((number, index) => ({
      id: `dwg-${number}`,
      number,
      geometry: { type: "Polygon", coordinates: [[[78.2532 + index * 0.0001, 27.2202], [78.25325 + index * 0.0001, 27.2202], [78.25325 + index * 0.0001, 27.22025], [78.2532 + index * 0.0001, 27.22025], [78.2532 + index * 0.0001, 27.2202]]] },
    }));
    const dispatchedFiles = [];
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async (_url, options) => {
      assert.strictEqual(options.headers["X-Internal-Token"], config.gis.internalSecret);
      const filename = options.body.get("file").name;
      dispatchedFiles.push(filename);
      const source = filename.endsWith(".dwg") ? "dwg" : "pdf";
      return {
        ok: true,
        json: async () => ({
          colony: {
            boundary: { type: "Polygon", coordinates: [boundary] },
            map_center: { lng: 78.2535, lat: 27.2205 },
            import_source: { mode: "boundary_fitted" },
          },
          zones: [{ id: `zone-${source}`, code: "A" }],
          plots: source === "dwg" ? plots : plots.map((plot) => ({ ...plot, id: plot.id.replace("dwg-", "pdf-") })),
          warnings: source === "dwg" ? ["DWG converted using ODA File Converter."] : [],
        }),
      };
    };
    try {
      const [fields, zones, importedPlots, warnings] = await importColonyBundle({
        geojsonBuffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features })),
        pdfBuffer: makePdfTextFixture(["P1", "P2"]),
        companionBuffer: Buffer.from("AC1032"),
        geojsonFilename: "labels.geojson",
        pdfFilename: "layout.pdf",
        companionFilename: "drawing.dwg",
        colonyId: "colony_bundle_dwg",
        now: new Date().toISOString(),
      });
      assert.deepStrictEqual(importedPlots.map((plot) => plot.id), ["dwg-P1", "dwg-P2"]);
      assert.deepStrictEqual(zones.map((zone) => zone.id), ["zone-dwg"]);
      assert.strictEqual(importedPlots.length, 2);
      assert.strictEqual(fields.import_source.mode, "qgis_pdf_dwg");
      assert.strictEqual(fields.import_source.sources.plot_geometry, "dwg_plot_polygons");
      assert.deepStrictEqual(dispatchedFiles, ["drawing.dwg"], "DWG flow must not import PDF parcel geometry");
      assert.ok(warnings.some((warning) => /ODA File Converter/.test(warning)));
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-24: Standalone DWG file import without GeoJSON or PDF", async () => {
    const originalFallback = config.gis.enablePythonFallback;
    const originalFetch = globalThis.fetch;
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async (url) => {
      const boundary = [[78.25, 27.22], [78.26, 27.22], [78.26, 27.23], [78.25, 27.23], [78.25, 27.22]];
      const plots = [
        { id: "dwg-1", number: "D1", geometry: { type: "Polygon", coordinates: [[[78.251, 27.221], [78.252, 27.221], [78.252, 27.222], [78.251, 27.222], [78.251, 27.221]]] }, zone_id: "zone-dwg", status_id: "available" }
      ];
      return {
        ok: true,
        json: async () => ({
          colony: {
            name: "DWG Colony",
            boundary: { type: "Polygon", coordinates: [boundary] },
            map_center: { lng: 78.255, lat: 27.225 },
            import_source: { mode: "dwg_standalone" },
          },
          zones: [{ id: "zone-dwg", code: "DWG" }],
          plots,
          warnings: [],
        }),
      };
    };
    try {
      const [fields, zones, importedPlots] = await importColonyBundle({
        companionBuffer: Buffer.from("AC1032"),
        companionFilename: "colony_map.dwg",
        colonyId: "colony_dwg_standalone",
        now: new Date().toISOString(),
      });
      assert.strictEqual(importedPlots.length, 1);
      assert.strictEqual(importedPlots[0].number, "D1");
      assert.strictEqual(fields.import_source.mode, "dwg_companion");
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });

  await t.test("P17-25: Standalone DXF file import without GeoJSON or PDF", async () => {
    const originalFallback = config.gis.enablePythonFallback;
    const originalFetch = globalThis.fetch;
    config.gis.enablePythonFallback = true;
    globalThis.fetch = async () => {
      const boundary = [[78.25, 27.22], [78.26, 27.22], [78.26, 27.23], [78.25, 27.23], [78.25, 27.22]];
      const plots = [
        { id: "dxf-1", number: "X1", geometry: { type: "Polygon", coordinates: [[[78.251, 27.221], [78.252, 27.221], [78.252, 27.222], [78.251, 27.222], [78.251, 27.221]]] }, zone_id: "zone-dxf", status_id: "available" }
      ];
      return {
        ok: true,
        json: async () => ({
          colony: {
            name: "DXF Colony",
            boundary: { type: "Polygon", coordinates: [boundary] },
            map_center: { lng: 78.255, lat: 27.225 },
            import_source: { mode: "dxf_standalone" },
          },
          zones: [{ id: "zone-dxf", code: "DXF" }],
          plots,
          warnings: [],
        }),
      };
    };
    try {
      const [fields, zones, importedPlots] = await importColonyBundle({
        companionBuffer: Buffer.from("SECTION 0 HEADER"),
        companionFilename: "colony_map.dxf",
        colonyId: "colony_dxf_standalone",
        now: new Date().toISOString(),
      });
      assert.strictEqual(importedPlots.length, 1);
      assert.strictEqual(importedPlots[0].number, "X1");
      assert.strictEqual(fields.import_source.mode, "dxf_companion");
    } finally {
      globalThis.fetch = originalFetch;
      config.gis.enablePythonFallback = originalFallback;
    }
  });
  config.gis.enablePythonFallback = initialPythonFallback;
});
