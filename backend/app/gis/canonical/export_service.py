"""Canonical Colony Production Export Service.

Implements Phase 13: Production-ready spatial and tabular exports:
- GeoJSON: Standard RFC 7946 FeatureCollection with CRS & canonical attributes
- CSV: Tabular plot records with declared vs derived measurements and validation status
- QA JSON: Full audit report of pipeline run, QA findings, and confidence signals
- DXF: AutoCAD-compatible vector export (R2010) with organized layers (PLOTS, ROADS, BOUNDARY, LABELS).
"""

from __future__ import annotations

import csv
import io
import json
import logging
from typing import Any, Dict, List, Optional

import ezdxf

from app.gis.canonical.persistence import (
    _execute_find_list,
    get_active_canonical_dataset,
    get_canonical_dataset_by_version,
)

logger = logging.getLogger(__name__)


async def generate_geojson_export(
    db: Any,
    colony_id: str,
    version: Optional[int] = None,
    include_review_required: bool = True,
) -> Dict[str, Any]:
    """Generates a GeoJSON FeatureCollection of canonical plots and roads."""
    if version is None:
        active = await get_active_canonical_dataset(db, colony_id)
        if not active:
            raise ValueError(f"No active canonical dataset for colony {colony_id}")
        version = active["version"]

    dataset = await get_canonical_dataset_by_version(db, colony_id, int(version))
    plots = await _execute_find_list(
        db["canonical_plots"],
        {"colony_id": colony_id, "dataset_version": int(version)},
    )
    roads = await _execute_find_list(
        db["canonical_roads"],
        {"colony_id": colony_id, "dataset_version": int(version)},
    )

    features = []

    # 1. Plots
    for p in plots:
        status = p.get("semantic_validation_status", "verified")
        if not include_review_required and status != "verified":
            continue

        geom = p.get("geometry")
        if not geom:
            continue

        props = {
            "entity_type": "Plot",
            "id": p.get("id"),
            "original_number": p.get("original_number"),
            "normalized_number": p.get("normalized_number"),
            "validation_status": status,
            "frontage_declared": p.get("frontage_declared"),
            "depth_declared": p.get("depth_declared"),
            "area_declared": p.get("area_declared"),
            "declared_units": p.get("declared_units"),
            "frontage_derived": p.get("frontage_derived"),
            "depth_derived": p.get("depth_derived"),
            "area_derived": p.get("area_derived"),
            "derived_units": "m",
            "adjacent_road_ids": p.get("adjacent_road_ids") or [],
            "neighboring_plot_ids": p.get("neighboring_plot_ids") or [],
            "source_page": p.get("source_page", 1),
            "dataset_version": version,
        }
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": props,
        })

    # 2. Roads
    for r in roads:
        geom = r.get("geometry")
        if not geom:
            continue
        props = {
            "entity_type": "Road",
            "id": r.get("id"),
            "source_label": r.get("source_label"),
            "declared_width_m": r.get("declared_width_m"),
            "derived_width_m": r.get("derived_width_m"),
            "connected_plot_ids": r.get("adjacent_plot_ids") or [],
            "dataset_version": version,
        }
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": props,
        })

    crs_meta = dataset.get("crs_metadata") or {}
    crs_name = crs_meta.get("authority_code") or crs_meta.get("crs_type") or "LOCAL_2D"

    return {
        "type": "FeatureCollection",
        "crs": {
            "type": "name",
            "properties": {"name": f"urn:ogc:def:crs:{crs_name}"},
        },
        "metadata": {
            "colony_id": colony_id,
            "dataset_version": version,
            "plots_count": len([f for f in features if f["properties"]["entity_type"] == "Plot"]),
            "roads_count": len([f for f in features if f["properties"]["entity_type"] == "Road"]),
            "crs_metadata": crs_meta,
        },
        "features": features,
    }


async def generate_csv_export(
    db: Any,
    colony_id: str,
    version: Optional[int] = None,
    include_review_required: bool = True,
) -> str:
    """Generates CSV string of canonical plot attributes and measurements."""
    if version is None:
        active = await get_active_canonical_dataset(db, colony_id)
        if not active:
            raise ValueError(f"No active canonical dataset for colony {colony_id}")
        version = active["version"]

    plots = await _execute_find_list(
        db["canonical_plots"],
        {"colony_id": colony_id, "dataset_version": int(version)},
    )

    output = io.StringIO()
    writer = csv.writer(output)

    # Header
    writer.writerow([
        "colony_id",
        "dataset_version",
        "plot_id",
        "original_number",
        "normalized_number",
        "validation_status",
        "frontage_declared",
        "depth_declared",
        "area_declared",
        "declared_units",
        "frontage_derived_m",
        "depth_derived_m",
        "area_derived_sqm",
        "adjacent_roads",
        "shared_neighbors",
        "source_page",
    ])

    for p in plots:
        status = p.get("semantic_validation_status", "verified")
        if not include_review_required and status != "verified":
            continue

        writer.writerow([
            colony_id,
            version,
            p.get("id"),
            p.get("original_number") or p.get("number"),
            p.get("normalized_number") or "",
            status,
            p.get("frontage_declared") if p.get("frontage_declared") is not None else "",
            p.get("depth_declared") if p.get("depth_declared") is not None else "",
            p.get("area_declared") if p.get("area_declared") is not None else "",
            p.get("declared_units") or "",
            p.get("frontage_derived") if p.get("frontage_derived") is not None else "",
            p.get("depth_derived") if p.get("depth_derived") is not None else "",
            p.get("area_derived") if p.get("area_derived") is not None else "",
            ";".join(p.get("adjacent_road_ids") or []),
            ";".join(p.get("neighboring_plot_ids") or []),
            p.get("source_page", 1),
        ])

    return output.getvalue()


async def generate_qa_report_export(
    db: Any,
    colony_id: str,
    version: Optional[int] = None,
) -> Dict[str, Any]:
    """Generates complete JSON QA and provenance report."""
    if version is None:
        active = await get_active_canonical_dataset(db, colony_id)
        if not active:
            raise ValueError(f"No active canonical dataset for colony {colony_id}")
        version = active["version"]

    dataset = await get_canonical_dataset_by_version(db, colony_id, int(version))
    run = await db["processing_runs"].find_one(
        {"colony_id": colony_id, "canonical_dataset_version": int(version)}
    )
    corrections = await _execute_find_list(
        db["review_corrections"],
        {"colony_id": colony_id, "dataset_version": int(version)},
    )

    return {
        "report_type": "Canonical_Colony_QA_Provenance_Report",
        "colony_id": colony_id,
        "dataset_version": version,
        "dataset_metadata": dataset,
        "processing_run": run,
        "qa_quality_grade": dataset.get("qa_quality_grade", "A_VERIFIED"),
        "qa_findings_summary": dataset.get("qa_findings_summary", {}),
        "review_corrections_count": len(corrections),
        "review_corrections": corrections,
    }


async def generate_dxf_export(
    db: Any,
    colony_id: str,
    version: Optional[int] = None,
    include_review_required: bool = True,
) -> bytes:
    """Generates AutoCAD DXF (R2010) vector file using ezdxf."""
    if version is None:
        active = await get_active_canonical_dataset(db, colony_id)
        if not active:
            raise ValueError(f"No active canonical dataset for colony {colony_id}")
        version = active["version"]

    plots = await _execute_find_list(
        db["canonical_plots"],
        {"colony_id": colony_id, "dataset_version": int(version)},
    )
    roads = await _execute_find_list(
        db["canonical_roads"],
        {"colony_id": colony_id, "dataset_version": int(version)},
    )

    doc = ezdxf.new("R2010")
    msp = doc.modelspace()

    # Define CAD layers
    doc.layers.add("PLOTS", color=7)       # White/Black
    doc.layers.add("ROADS", color=8)       # Gray
    doc.layers.add("LABELS", color=2)      # Yellow
    doc.layers.add("BOUNDARY", color=1)    # Red

    # 1. Render Plots
    for p in plots:
        status = p.get("semantic_validation_status", "verified")
        if not include_review_required and status != "verified":
            continue

        geom = p.get("geometry")
        if not geom:
            continue

        rings = []
        if geom.get("type") == "Polygon":
            rings = geom.get("coordinates") or []
        elif geom.get("type") == "MultiPolygon":
            for poly in geom.get("coordinates") or []:
                rings.extend(poly)

        for ring in rings:
            if len(ring) >= 3:
                # Add 2D closed polygon
                pts = [(pt[0], pt[1]) for pt in ring]
                msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "PLOTS"})

        # Add Plot Number Label at centroid
        plot_num = p.get("original_number") or p.get("number")
        if plot_num and len(rings) > 0 and len(rings[0]) >= 3:
            pts = rings[0]
            cx = sum(pt[0] for pt in pts) / len(pts)
            cy = sum(pt[1] for pt in pts) / len(pts)
            msp.add_text(
                str(plot_num),
                dxfattribs={"layer": "LABELS", "height": 2.0},
            ).set_placement((cx, cy))

    # 2. Render Roads
    for r in roads:
        geom = r.get("geometry")
        if not geom:
            continue
        rings = []
        if geom.get("type") == "Polygon":
            rings = geom.get("coordinates") or []
        elif geom.get("type") == "MultiPolygon":
            for poly in geom.get("coordinates") or []:
                rings.extend(poly)

        for ring in rings:
            if len(ring) >= 3:
                pts = [(pt[0], pt[1]) for pt in ring]
                msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "ROADS"})

    stream = io.StringIO()
    doc.write(stream)
    return stream.getvalue().encode("utf-8")
