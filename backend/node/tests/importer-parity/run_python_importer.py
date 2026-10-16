"""Python Importer Wrapper Script for Importer Parity Comparison.
Executes backend/importer.py import_file() and returns structured JSON metrics.
"""
import sys
import os
import json
import time
from pathlib import Path

# Add backend directory to sys.path
root_dir = Path(__file__).resolve().parent.parent.parent.parent
backend_dir = root_dir / "backend"
sys.path.insert(0, str(backend_dir))

import importer

def compute_centroid(coords):
    # ring coordinates
    ring = coords[0] if isinstance(coords[0], list) and isinstance(coords[0][0], list) else coords
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return [sum(xs) / len(xs), sum(ys) / len(ys)]

def compute_bbox(coords):
    ring = coords[0] if isinstance(coords[0], list) and isinstance(coords[0][0], list) else coords
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return [min(xs), min(ys), max(xs), max(ys)]

def run_import(filepath, maps_link=""):
    start_time = time.perf_counter()
    with open(filepath, "rb") as f:
        data = f.read()

    filename = Path(filepath).name
    now_iso = "2026-10-03T12:00:00+00:00"
    colony_id = "test-colony"

    try:
        colony_fields, zone_docs, plot_docs, warnings = importer.import_file(
            data, filename, maps_link, colony_id, now_iso
        )
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        geojson = importer.to_geojson(
            {"name": "Test Colony", "boundary": colony_fields["boundary"], "greens": colony_fields.get("greens", []), "roads": colony_fields.get("roads", [])},
            zone_docs,
            plot_docs
        )

        plots_summary = []
        for p in plot_docs:
            geom = p["geometry"]
            c = compute_centroid(geom["coordinates"])
            b = compute_bbox(geom["coordinates"])
            plots_summary.append({
                "number": p["number"],
                "area_sqm": p["area_sqm"],
                "area_sqft": p["area_sqft"],
                "width_m": p["width_m"],
                "depth_m": p["depth_m"],
                "shape": p["shape"],
                "dimensions": p["dimensions"],
                "zone_id": p["zone_id"],
                "centroid": [round(c[0], 7), round(c[1], 7)],
                "bbox": [round(x, 7) for x in b],
            })

        boundary_bbox = compute_bbox(colony_fields["boundary"]["coordinates"])

        return {
            "success": True,
            "duration_ms": duration_ms,
            "filename": filename,
            "mode": colony_fields["import_source"]["mode"],
            "map_center": colony_fields["map_center"],
            "total_area_sqm": colony_fields.get("total_area_sqm", 0),
            "boundary_bbox": [round(x, 7) for x in boundary_bbox],
            "counts": {
                "plots": len(plot_docs),
                "zones": len(zone_docs),
                "greens": len(colony_fields.get("greens", [])),
                "roads": len(colony_fields.get("roads", [])),
            },
            "warnings": warnings,
            "plots": plots_summary,
            "geojson_features": len(geojson.get("features", [])),
        }
    except Exception as e:
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "success": False,
            "duration_ms": duration_ms,
            "filename": filename,
            "error": str(e),
            "error_type": type(e).__name__,
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Filepath argument required"}))
        sys.exit(1)

    filepath = sys.argv[1]
    maps_link = sys.argv[2] if len(sys.argv) > 2 else ""
    result = run_import(filepath, maps_link)
    print(json.dumps(result, indent=2))
