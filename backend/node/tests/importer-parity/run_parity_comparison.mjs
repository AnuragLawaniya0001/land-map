import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import * as nodeImporter from "../../importer.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..", "..");

const pythonExe = path.join(rootDir, "backend", "venv", "Scripts", "python.exe");
const pyScript = path.join(__dirname, "run_python_importer.py");
const fixturesDir = path.join(rootDir, "backend", "tests", "fixtures");

// Helper to compute centroid & bbox of GeoJSON coordinates
function computeCentroid(coords) {
  const ring = Array.isArray(coords[0][0]) ? coords[0] : coords;
  let xs = ring.map((p) => p[0]);
  let ys = ring.map((p) => p[1]);
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
  return [nodeImporter.pyRound(cx, 7), nodeImporter.pyRound(cy, 7)];
}

function computeBbox(coords) {
  const ring = Array.isArray(coords[0][0]) ? coords[0] : coords;
  let xs = ring.map((p) => p[0]);
  let ys = ring.map((p) => p[1]);
  return [
    nodeImporter.pyRound(Math.min(...xs), 7),
    nodeImporter.pyRound(Math.min(...ys), 7),
    nodeImporter.pyRound(Math.max(...xs), 7),
    nodeImporter.pyRound(Math.max(...ys), 7),
  ];
}

// Haversine / meters distance between 2 [lng, lat] points
function distanceMeters(p1, p2) {
  const [lng1, lat1] = p1;
  const [lng2, lat2] = p2;
  const kx = 111320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const ky = 110574;
  const dx = (lng2 - lng1) * kx;
  const dy = (lat2 - lat1) * ky;
  return Math.hypot(dx, dy);
}

async function runPython(filePath, mapsLink = "") {
  try {
    const { stdout } = await execFileAsync(pythonExe, [pyScript, filePath, mapsLink]);
    return JSON.parse(stdout);
  } catch (e) {
    return {
      success: false,
      error: e.stderr || e.message,
      error_type: "ExecutionError",
    };
  }
}

async function runNode(filePath, mapsLink = "") {
  const filename = path.basename(filePath);
  const data = await fs.readFile(filePath);
  const now = "2026-10-03T12:00:00+00:00";
  const colonyId = "test-colony";

  const startTime = performance.now();
  try {
    const [fields, zoneDocs, plotDocs, warnings] = await nodeImporter.importFile(
      data, filename, mapsLink, colonyId, now
    );
    const durationMs = nodeImporter.pyRound(performance.now() - startTime, 2);
    const geojson = nodeImporter.toGeojson(
      { name: "Test Colony", boundary: fields.boundary, greens: fields.greens || [], roads: fields.roads || [] },
      zoneDocs,
      plotDocs
    );

    const plotsSummary = plotDocs.map((p) => {
      const c = computeCentroid(p.geometry.coordinates);
      const b = computeBbox(p.geometry.coordinates);
      return {
        number: p.number,
        area_sqm: p.area_sqm,
        area_sqft: p.area_sqft,
        width_m: p.width_m,
        depth_m: p.depth_m,
        shape: p.shape,
        dimensions: p.dimensions,
        zone_id: p.zone_id,
        centroid: c,
        bbox: b,
      };
    });

    const boundaryBbox = computeBbox(fields.boundary.coordinates);

    return {
      success: true,
      duration_ms: durationMs,
      filename,
      mode: fields.import_source.mode,
      map_center: fields.map_center,
      total_area_sqm: fields.total_area_sqm || 0,
      boundary_bbox: boundaryBbox,
      counts: {
        plots: plotDocs.length,
        zones: zoneDocs.length,
        greens: (fields.greens || []).length,
        roads: (fields.roads || []).length,
      },
      warnings,
      plots: plotsSummary,
      geojson_features: (geojson.features || []).length,
    };
  } catch (e) {
    const durationMs = nodeImporter.pyRound(performance.now() - startTime, 2);
    return {
      success: false,
      duration_ms: durationMs,
      filename,
      error: e.message,
      error_type: e.constructor ? e.constructor.name : "Error",
    };
  }
}

async function compareFile(filename, mapsLink = "") {
  const filePath = path.join(fixturesDir, filename);
  console.log(`\n==================================================`);
  console.log(`Running Importer Parity Test on: ${filename}`);
  console.log(`==================================================`);

  const pyRes = await runPython(filePath, mapsLink);
  const nodeRes = await runNode(filePath, mapsLink);

  const fileReport = {
    filename,
    file_size_bytes: (await fs.stat(filePath)).size,
    classification: "Synthetic Test Fixture",
    python_result: {
      success: pyRes.success,
      duration_ms: pyRes.duration_ms,
      mode: pyRes.mode,
      counts: pyRes.counts,
      error: pyRes.error,
    },
    node_result: {
      success: nodeRes.success,
      duration_ms: nodeRes.duration_ms,
      mode: nodeRes.mode,
      counts: nodeRes.counts,
      error: nodeRes.error,
    },
    parity: {
      success_match: pyRes.success === nodeRes.success,
      plot_count_match: false,
      area_diff_pct: null,
      matched_plots: 0,
      missing_in_node: [],
      extra_in_node: [],
      plot_comparisons: [],
    },
  };

  if (pyRes.success && nodeRes.success) {
    fileReport.parity.plot_count_match = pyRes.counts.plots === nodeRes.counts.plots;
    const pyArea = pyRes.total_area_sqm;
    const nodeArea = nodeRes.total_area_sqm;
    const areaDiffPct = pyArea > 0 ? Math.abs(nodeArea - pyArea) / pyArea * 100 : 0;
    fileReport.parity.area_diff_pct = nodeImporter.pyRound(areaDiffPct, 3);

    // Plot matching by plot number
    const pyMap = new Map(pyRes.plots.map((p) => [p.number, p]));
    const nodeMap = new Map(nodeRes.plots.map((p) => [p.number, p]));

    for (const [no, pyPlot] of pyMap.entries()) {
      if (nodeMap.has(no)) {
        const nodePlot = nodeMap.get(no);
        const distM = distanceMeters(pyPlot.centroid, nodePlot.centroid);
        const areaDiff = Math.abs(nodePlot.area_sqm - pyPlot.area_sqm);
        const areaDiffPctPlot = pyPlot.area_sqm > 0 ? (areaDiff / pyPlot.area_sqm) * 100 : 0;

        fileReport.parity.matched_plots += 1;
        fileReport.parity.plot_comparisons.push({
          number: no,
          status: "MATCH",
          py_area: pyPlot.area_sqm,
          node_area: nodePlot.area_sqm,
          area_diff_pct: nodeImporter.pyRound(areaDiffPctPlot, 2),
          centroid_dist_m: nodeImporter.pyRound(distM, 3),
          shape_match: pyPlot.shape === nodePlot.shape,
          py_shape: pyPlot.shape,
          node_shape: nodePlot.shape,
        });
      } else {
        fileReport.parity.missing_in_node.push(no);
      }
    }

    for (const no of nodeMap.keys()) {
      if (!pyMap.has(no)) {
        fileReport.parity.extra_in_node.push(no);
      }
    }
  }

  return fileReport;
}

async function main() {
  const files = [
    "layout_geo.pdf",
    "layout_latlng.dxf",
    "layout_scaled.pdf",
    "layout_utm_lines.dxf",
  ];

  const results = [];
  for (const file of files) {
    const rep = await compareFile(file);
    results.push(rep);
    console.log(`Result for ${file}:`);
    console.log(`  Python Success: ${rep.python_result.success} (${rep.python_result.duration_ms} ms)`);
    console.log(`  Node Success:   ${rep.node_result.success} (${rep.node_result.duration_ms} ms)`);
    if (rep.parity.success_match && rep.python_result.success) {
      console.log(`  Plots (Py/Node): ${rep.python_result.counts.plots} / ${rep.node_result.counts.plots}`);
      console.log(`  Matched Plots:   ${rep.parity.matched_plots}`);
      console.log(`  Area Diff (%):   ${rep.parity.area_diff_pct}%`);
    }
  }

  const outPath = path.join(__dirname, "parity_results.json");
  await fs.writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`\nParity comparison complete. Report saved to: ${outPath}`);
}

main().catch((e) => {
  console.error("Comparison test failed:", e);
  process.exit(1);
});
