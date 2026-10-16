"""Canonical Adapter.

Transforms Phase 1-5 spatial understanding graph outputs and Phase 6 QA reports
into durable canonical entities, ensuring strict separation between source-declared
and geometry-derived measurements, explicit CRS preservation, and full provenance.
"""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from typing import Any, Dict, List, Optional, Tuple

from shapely.geometry import shape, mapping, Polygon, LineString, MultiPolygon
from shapely.ops import substring
from pyproj import Geod

from app.gis.canonical.crs import (
    CRSType,
    CoordinateSystemMetadata,
    validate_and_normalize_geometry,
)
from app.gis.canonical.models import (
    CanonicalDataset,
    CanonicalDimensionAnnotation,
    CanonicalGeometryEdge,
    CanonicalPlot,
    CanonicalRelationshipType,
    CanonicalRoad,
    CanonicalSemanticRelationship,
    ProcessingRun,
)

_WGS84_GEOD = Geod(ellps="WGS84")


def _is_geographic(crs_metadata: CoordinateSystemMetadata) -> bool:
    return (
        crs_metadata.crs_type == CRSType.GEOGRAPHIC_WGS84
        or crs_metadata.units == "deg"
    )


def _length_m(geometry: Any, crs_metadata: CoordinateSystemMetadata) -> Optional[float]:
    if _is_geographic(crs_metadata):
        return abs(float(_WGS84_GEOD.geometry_length(geometry)))
    if crs_metadata.scale_ratio and crs_metadata.scale_ratio > 0:
        return float(geometry.length) * crs_metadata.scale_ratio
    if crs_metadata.units in ("m", "meter", "meters"):
        return float(geometry.length)
    return None


def _area_sqm(geometry: Any, crs_metadata: CoordinateSystemMetadata) -> Optional[float]:
    if _is_geographic(crs_metadata):
        area, _ = _WGS84_GEOD.geometry_area_perimeter(geometry)
        return abs(float(area))
    if crs_metadata.scale_ratio and crs_metadata.scale_ratio > 0:
        return float(geometry.area) * crs_metadata.scale_ratio ** 2
    if crs_metadata.units in ("m", "meter", "meters"):
        return float(geometry.area)
    return None


def _geometry_precision(crs_metadata: CoordinateSystemMetadata) -> int:
    return 8 if _is_geographic(crs_metadata) else 4


def _measurement_to_meters(
    value: Optional[float],
    unit: Optional[str],
    measurement_category: str,
) -> Optional[float]:
    if value is None or not unit:
        return None

    normalized_unit = unit.lower().replace(" ", "").replace(".", "")
    is_area = "area" in measurement_category.lower() or normalized_unit.startswith("sq")
    if is_area:
        area_factors = {
            "sqm": 1.0,
            "m2": 1.0,
            "sqmeter": 1.0,
            "sqmeters": 1.0,
            "sqmetre": 1.0,
            "sqmetres": 1.0,
            "sqft": 0.09290304,
            "ft2": 0.09290304,
            "sqyd": 0.83612736,
            "yd2": 0.83612736,
            "acre": 4046.8564224,
            "acres": 4046.8564224,
            "ha": 10000.0,
            "hectare": 10000.0,
            "hectares": 10000.0,
        }
        factor = area_factors.get(normalized_unit)
        return float(value) * factor if factor is not None else None

    length_factors = {
        "m": 1.0,
        "meter": 1.0,
        "meters": 1.0,
        "metre": 1.0,
        "metres": 1.0,
        "ft": 0.3048,
        "feet": 0.3048,
        "in": 0.0254,
        "inch": 0.0254,
        "inches": 0.0254,
        "cm": 0.01,
        "mm": 0.001,
    }
    factor = length_factors.get(normalized_unit)
    return float(value) * factor if factor is not None else None


def compute_sha256(data: Any) -> str:
    """Computes SHA-256 hash of bytes or dict data."""
    if isinstance(data, (bytes, bytearray)):
        return hashlib.sha256(data).hexdigest()
    if isinstance(data, str):
        return hashlib.sha256(data.encode("utf-8")).hexdigest()
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def extract_polygon_edges(
    poly_geom: Any,
    parent_id: str,
    parent_type: str = "Plot",
    adjacent_road_ids: Optional[List[str]] = None,
    road_geometries: Optional[Dict[str, Any]] = None,
    crs_metadata: Optional[CoordinateSystemMetadata] = None,
) -> List[CanonicalGeometryEdge]:
    """Decomposes polygon exterior into discrete canonical geometry edges."""
    edges: List[CanonicalGeometryEdge] = []
    if not poly_geom:
        return edges

    try:
        sh_poly = shape(poly_geom) if isinstance(poly_geom, dict) else poly_geom
        if isinstance(sh_poly, MultiPolygon):
            polys = list(sh_poly.geoms)
        elif isinstance(sh_poly, Polygon):
            polys = [sh_poly]
        else:
            return edges

        edge_idx = 0
        for p in polys:
            exterior = list(p.exterior.coords)
            for i in range(len(exterior) - 1):
                pt1 = exterior[i]
                pt2 = exterior[i + 1]
                edge_line = LineString([pt1, pt2])
                length = (
                    _length_m(edge_line, crs_metadata)
                    if crs_metadata is not None
                    else None
                )
                edge_id = f"edge-{parent_id}-{edge_idx}"
                classification = None
                if road_geometries and adjacent_road_ids:
                    for road_id in adjacent_road_ids:
                        road_geometry = road_geometries.get(str(road_id))
                        if road_geometry is None:
                            continue
                        shared_boundary = edge_line.intersection(road_geometry)
                        if (
                            shared_boundary.geom_type in ("LineString", "MultiLineString")
                            and crs_metadata is not None
                            and (_length_m(shared_boundary, crs_metadata) or 0) > 0.1
                        ):
                            classification = "frontage"
                            break

                edges.append(
                    CanonicalGeometryEdge(
                        id=edge_id,
                        parent_feature_id=parent_id,
                        parent_feature_type=parent_type,
                        geometry=mapping(edge_line),
                        measured_length_m=round(length, 4) if length is not None else None,
                        road_frontage_classification=classification,
                        geometry_valid=True,
                        provenance={
                            "edge_index": edge_idx,
                            "derived_from": parent_id,
                        },
                    )
                )
                edge_idx += 1
    except Exception:
        pass

    return edges


def build_canonical_entities_from_preview(
    colony_id: str,
    preview_data: Dict[str, Any],
    source_filename: str,
    source_data: Optional[bytes] = None,
    dataset_version: int = 1,
    pipeline_version: str = "2.0.0",
    run_id: Optional[str] = None,
    created_by: Optional[str] = None,
    now_iso: Optional[str] = None,
) -> Tuple[
    CanonicalDataset,
    ProcessingRun,
    List[CanonicalPlot],
    List[CanonicalRoad],
    List[CanonicalDimensionAnnotation],
    List[CanonicalSemanticRelationship],
]:
    """Builds canonical dataset entities from GIS import preview data and QA reports."""
    fields = preview_data.get("fields") or {}
    # Overlay hit regions can be heuristic detections from raster artwork; they
    # are not canonical plot inventory unless a reviewed import supplies them as
    # explicit plot records.
    plot_docs = preview_data.get("plots") or fields.get("plots") or []
    raw_roads = fields.get("roads") or preview_data.get("roads") or []
    su = preview_data.get("spatial_understanding") or {}
    qa_report = preview_data.get("qa_report") or {}

    source_hash = compute_sha256(source_data) if source_data else compute_sha256(preview_data)
    run_id = run_id or f"run-{uuid.uuid4().hex[:12]}"
    now = now_iso or "2026-10-10T00:00:00Z"

    # Coordinate Reference System Metadata
    source_crs = fields.get("crs_metadata") or {}
    scale_ratio = fields.get("scale_ratio", source_crs.get("scale_ratio"))
    source_mode = str((fields.get("import_source") or {}).get("mode") or "").lower()
    source_crs_type = source_crs.get("crs_type")
    known_geographic_modes = {
        "boundary_fitted",
        "calibrated",
        "geopdf",
        "kml",
        "kml_boundary",
        "latlng",
        "qgis",
    }

    # Dynamically verify if boundary coordinates are in WGS84 degrees (authoritative KML/GIS boundary)
    has_geo_coords = False
    bnd = fields.get("boundary")
    if bnd and isinstance(bnd, dict) and not scale_ratio:
        coords = bnd.get("coordinates")
        if coords:
            try:
                pt = coords[0]
                while isinstance(pt, (list, tuple)) and len(pt) > 0 and isinstance(pt[0], (list, tuple)):
                    pt = pt[0]
                if pt and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float)):
                    if -180 <= pt[0] <= 180 and -90 <= pt[1] <= 90 and (abs(pt[0]) > 0.1 or abs(pt[1]) > 0.1):
                        has_geo_coords = True
            except Exception:
                pass

    is_georeferenced = bool(
        has_geo_coords
        or fields.get("is_georeferenced")
        or source_crs.get("is_georeferenced")
        or source_crs_type == CRSType.GEOGRAPHIC_WGS84.value
        or source_mode in known_geographic_modes
        or source_mode.startswith(("utm", "fitted"))
    )
    if has_geo_coords or source_crs_type == CRSType.GEOGRAPHIC_WGS84.value:
        crs_type = CRSType.GEOGRAPHIC_WGS84
    elif source_crs_type:
        try:
            crs_type = CRSType(source_crs_type)
        except ValueError:
            crs_type = CRSType.GEOGRAPHIC_WGS84 if is_georeferenced else CRSType.LOCAL_DRAWING
    else:
        crs_type = CRSType.GEOGRAPHIC_WGS84 if is_georeferenced else (
            CRSType.PROJECTED_METRIC if scale_ratio else CRSType.LOCAL_DRAWING
        )
    units = "deg" if crs_type == CRSType.GEOGRAPHIC_WGS84 else ("m" if scale_ratio else "px")
    georeferencing_status = source_crs.get("georeferencing_status") or (
        ("authoritative_kml" if fields.get("boundary") else "provisional_shape_fit") if is_georeferenced else "unregistered"
    )
    geographic_verified = bool(source_crs.get("geographic_verified", has_geo_coords))
    epsg = source_crs.get("epsg") or (4326 if crs_type == CRSType.GEOGRAPHIC_WGS84 else None)
    crs_metadata = CoordinateSystemMetadata(
        crs_type=crs_type,
        units=units,
        scale_ratio=scale_ratio,
        is_georeferenced=is_georeferenced,
        scale_uncertain=scale_ratio is None,
        notes=source_crs.get("notes") or f"Processed via Pipeline {pipeline_version}",
        epsg=epsg,
        geographic_verified=geographic_verified,
        georeferencing_status=georeferencing_status,
    )

    canonical_plots: List[CanonicalPlot] = []
    canonical_roads: List[CanonicalRoad] = []
    canonical_dimensions: List[CanonicalDimensionAnnotation] = []
    canonical_relationships: List[CanonicalSemanticRelationship] = []
    road_geometries: Dict[str, Any] = {}

    # Map semantic answers and relationships
    semantic_answers = su.get("answers") or {}
    canonical_rels_su = su.get("canonical_relationships") or []
    rel_counter = 0

    # 1. Process Roads
    road_id_map: Dict[str, str] = {}
    for r_idx, r in enumerate(raw_roads):
        r_label = str(r.get("name") or r.get("source_label") or f"Road {r_idx + 1}")
        r_id = str(r.get("id") or f"road-{colony_id}-{r_idx + 1}")
        road_id_map[r_label] = r_id

        r_geom, r_valid, _ = validate_and_normalize_geometry(
            r.get("geometry"), precision=_geometry_precision(crs_metadata)
        )
        if r_geom:
            try:
                road_geometries[r_id] = shape(r_geom)
            except Exception:
                pass
        road_status = r.get("validation_status")
        if road_status not in ("verified", "candidate", "review_required", "conflicted"):
            road_status = "review_required"
        declared_w = r.get("declared_width_m") or r.get("width")
        derived_w = r.get("derived_width_m")
        derived_width_method = None
        if not derived_w and r_geom and r_geom.get("type") in ("Polygon", "MultiPolygon"):
            try:
                sh_r = shape(r_geom)
                area_sqm = _area_sqm(sh_r, crs_metadata)
                perimeter_m = _length_m(sh_r.boundary, crs_metadata)
                if area_sqm is not None and perimeter_m:
                    derived_w = round((2.0 * area_sqm) / perimeter_m, 2)
                    derived_width_method = "area_perimeter_approximation"
            except Exception:
                pass

        c_road = CanonicalRoad(
            id=r_id,
            colony_id=colony_id,
            dataset_version=dataset_version,
            source_label=r_label,
            geometry=r_geom or {},
            original_geometry=r.get("geometry"),
            crs_metadata=crs_metadata,
            declared_width_m=float(declared_w) if declared_w else None,
            derived_width_m=float(derived_w) if derived_w else None,
            declared_width_raw=str(r.get("declared_width_raw") or declared_w or ""),
            adjacent_plot_ids=r.get("adjacent_plot_ids") or [],
            frontage_relationships=r.get("frontage_relationships") or [],
            source_evidence=[f"Road element '{r_label}' extracted from vector/raster geometry"],
            validation_status=road_status if r_valid else "review_required",
            provenance={
                "extracted_index": r_idx,
                "run_id": run_id,
                **(
                    {"derived_width_method": derived_width_method}
                    if derived_width_method
                    else {}
                ),
            },
            created_at=now,
            updated_at=now,
        )
        canonical_roads.append(c_road)

    # 2. Process Plots
    for p_idx, p in enumerate(plot_docs):
        p_raw_number = str(p.get("original_number") or p.get("number") or "").strip()
        p_norm_number = str(p.get("normalized_number") or p_raw_number).strip() or None
        p_id = str(p.get("id") or f"plot-{colony_id}-{p_raw_number.lower() or p_idx + 1}")

        p_geom, p_valid, repair_note = validate_and_normalize_geometry(
            p.get("geometry"),
            precision=_geometry_precision(crs_metadata),
            ensure_polygon=True,
        )
        plot_status = p.get("semantic_validation_status")
        if plot_status not in ("verified", "candidate", "review_required", "conflicted"):
            plot_status = "review_required"

        # Derived calculations from pure geometry
        p_derived_area = None
        if p_geom:
            try:
                sh_p = shape(p_geom)
                area_sqm = _area_sqm(sh_p, crs_metadata)
                p_derived_area = round(area_sqm, 4) if area_sqm is not None else None
            except Exception:
                pass

        # Declared measurements from drawing text / annotations
        p_declared_area = p.get("area_declared")
        p_frontage_decl = p.get("frontage_declared")
        p_depth_decl = p.get("depth_declared")
        p_side_decl = p.get("side_declared") or {}

        # Adjacent roads and neighbors
        adj_roads = list(p.get("adjacent_road_ids") or [])
        adj_plots = list(p.get("neighboring_plot_ids") or [])

        # Check semantic questions answers
        if p_id in semantic_answers.get("adjacent_roads", {}):
            for road_label in semantic_answers["adjacent_roads"][p_id]:
                mapped_road_id = road_id_map.get(road_label, road_label)
                if mapped_road_id not in adj_roads:
                    adj_roads.append(mapped_road_id)

        if p_id in semantic_answers.get("shared_boundaries", {}):
            for neighbor_id in semantic_answers["shared_boundaries"][p_id]:
                if neighbor_id not in adj_plots:
                    adj_plots.append(neighbor_id)

        edges = extract_polygon_edges(
            p_geom,
            parent_id=p_id,
            parent_type="Plot",
            adjacent_road_ids=adj_roads,
            road_geometries=road_geometries,
            crs_metadata=crs_metadata,
        )

        # Only report frontage when a plot edge demonstrably shares a road boundary.
        derived_frontage = None
        if edges:
            frontage_edges = [e for e in edges if e.road_frontage_classification == "frontage"]
            if frontage_edges:
                edge_lengths = [e.measured_length_m for e in frontage_edges if e.measured_length_m is not None]
                if edge_lengths:
                    derived_frontage = round(sum(edge_lengths), 4)

        c_plot = CanonicalPlot(
            id=p_id,
            colony_id=colony_id,
            dataset_version=dataset_version,
            original_number=p_raw_number,
            normalized_number=p_norm_number,
            geometry=p_geom or {},
            original_geometry=p.get("geometry"),
            crs_metadata=crs_metadata,
            frontage_declared=float(p_frontage_decl) if p_frontage_decl is not None else None,
            depth_declared=float(p_depth_decl) if p_depth_decl is not None else None,
            side_declared={k: float(v) for k, v in p_side_decl.items()} if p_side_decl else {},
            area_declared=float(p_declared_area) if p_declared_area is not None else None,
            declared_units=p.get("declared_units") or p.get("unit"),
            frontage_derived=derived_frontage,
            depth_derived=None,
            side_derived={},
            area_derived=p_derived_area,
            adjacent_road_ids=adj_roads,
            neighboring_plot_ids=adj_plots,
            edges=edges,
            geometry_valid=p_valid,
            semantic_validation_status=plot_status if p_valid else "review_required",
            confidence_signals=p.get("confidence_signals") or {},
            unresolved_warnings=[repair_note] if repair_note else [],
            source_document_id=source_filename,
            source_page=int(p.get("source_page", 1)),
            provenance={
                "run_id": run_id,
                "repaired": bool(repair_note),
                "repair_note": repair_note,
                "derived_measurements": {
                    "area_method": "WGS84 ellipsoidal area" if _is_geographic(crs_metadata) else "scaled planar area" if crs_metadata.scale_ratio else "planar metric area",
                    "length_method": "WGS84 ellipsoidal length" if _is_geographic(crs_metadata) else "scaled planar length" if crs_metadata.scale_ratio else "planar metric length",
                } if crs_metadata.units == "m" or crs_metadata.scale_ratio or _is_geographic(crs_metadata) else {},
            },
            created_at=now,
            updated_at=now,
        )
        canonical_plots.append(c_plot)

        # Add adjacency relationships
        for road_id in adj_roads:
            rel_counter += 1
            canonical_relationships.append(
                CanonicalSemanticRelationship(
                    id=f"rel-{colony_id}-{rel_counter}",
                    colony_id=colony_id,
                    dataset_version=dataset_version,
                    relationship_type=CanonicalRelationshipType.PLOT_ADJACENT_TO_ROAD.value,
                    source_entity_id=p_id,
                    target_entity_id=road_id,
                    source_evidence=[f"Topological adjacency between Plot {p_raw_number} and {road_id}"],
                    validation_status="review_required",
                    confidence=0.0,
                    provenance={"run_id": run_id},
                    created_at=now,
                )
            )

        for neighbor_id in adj_plots:
            rel_counter += 1
            canonical_relationships.append(
                CanonicalSemanticRelationship(
                    id=f"rel-{colony_id}-{rel_counter}",
                    colony_id=colony_id,
                    dataset_version=dataset_version,
                    relationship_type=CanonicalRelationshipType.PLOT_ADJACENT_TO_PLOT.value,
                    source_entity_id=p_id,
                    target_entity_id=neighbor_id,
                    source_evidence=[f"Shared boundary between Plot {p_raw_number} and {neighbor_id}"],
                    validation_status="review_required",
                    confidence=0.0,
                    provenance={"run_id": run_id},
                    created_at=now,
                )
            )

    # 3. Process Canonical Dimensions and Spatial Understanding Relationships
    dim_counter = 0
    for cr in canonical_rels_su:
        dim_counter += 1
        dim_id = f"dim-{colony_id}-{dim_counter}"
        c_dim = CanonicalDimensionAnnotation(
            id=dim_id,
            colony_id=colony_id,
            dataset_version=dataset_version,
            original_text=str(cr.get("raw_text") or ""),
            parsed_value=float(cr["parsed_value"]) if cr.get("parsed_value") is not None else None,
            original_unit=cr.get("unit"),
            normalized_value_m=_measurement_to_meters(
                float(cr["parsed_value"]) if cr.get("parsed_value") is not None else None,
                cr.get("unit"),
                str(cr.get("measurement_type") or ""),
            ),
            normalized_unit=(
                "square_meter"
                if "area" in str(cr.get("measurement_type") or "").lower()
                or str(cr.get("unit") or "").lower().startswith("sq")
                else "meter"
                if _measurement_to_meters(
                    float(cr["parsed_value"]) if cr.get("parsed_value") is not None else None,
                    cr.get("unit"),
                    str(cr.get("measurement_type") or ""),
                ) is not None
                else None
            ),
            measurement_category=str(cr.get("measurement_type") or "unknown_measurement"),
            dimension_line_id=cr.get("dimension_line_id"),
            candidate_target_edges=cr.get("candidate_target_edges") or [],
            candidate_target_features=cr.get("candidate_target_features") or [],
            selected_target_id=(cr.get("candidate_target_features") or [None])[0],
            selected_target_type="feature" if cr.get("candidate_target_features") else None,
            association_status=str(cr.get("association_status") or "unresolved"),
            confidence=float(cr.get("confidence_signals", {}).get("aggregate", 0.0)) if isinstance(cr.get("confidence_signals"), dict) else 0.0,
            qa_issues=cr.get("qa_issues") or [],
            source_page=int(cr.get("source_page", 1)),
            evidence=cr.get("evidence") or [],
            provenance={"run_id": run_id, "su_entity_id": cr.get("entity_id")},
            created_at=now,
        )
        canonical_dimensions.append(c_dim)

        if c_dim.selected_target_id:
            rel_counter += 1
            canonical_relationships.append(
                CanonicalSemanticRelationship(
                    id=f"rel-{colony_id}-{rel_counter}",
                    colony_id=colony_id,
                    dataset_version=dataset_version,
                    relationship_type=CanonicalRelationshipType.DIMENSION_MEASURES_FEATURE.value,
                    source_entity_id=dim_id,
                    target_entity_id=c_dim.selected_target_id,
                    source_evidence=c_dim.evidence,
                    validation_status=c_dim.association_status,
                    confidence=c_dim.confidence,
                    provenance={"run_id": run_id},
                    created_at=now,
                )
            )

    # 4. Build ProcessingRun
    quality_grade = str(qa_report.get("quality_grade") or "C_REVIEW_NEEDED")
    findings = qa_report.get("findings") or []
    findings_summary: Dict[str, int] = {}
    for f in findings:
        sev = f.get("severity", "info")
        findings_summary[sev] = findings_summary.get(sev, 0) + 1

    proc_run = ProcessingRun(
        run_id=run_id,
        colony_id=colony_id,
        source_document_name=source_filename,
        source_sha256=source_hash,
        source_page_count=int(qa_report.get("page_number", 1)),
        pipeline_version=pipeline_version,
        config_version="v1",
        status="COMPLETED",
        qa_summary={
            "validation_passed": qa_report.get("validation_passed", False),
            "quality_grade": quality_grade,
            "overall_score": qa_report.get("overall_score"),
            "finding_count": len(findings),
        },
        quality_grade=quality_grade,
        retry_recovery_history=qa_report.get("recovery_records") or [],
        canonical_dataset_version=dataset_version,
        errors=[f["message"] for f in findings if f.get("severity") in ("error", "critical")],
        warnings=[f["message"] for f in findings if f.get("severity") == "warning"],
        metadata={"filename": source_filename},
        created_at=now,
        updated_at=now,
    )

    # 5. Build CanonicalDataset summary
    is_valid_run = qa_report.get("validation_passed", False) and quality_grade not in ("F_REJECTED", "D_UNRELIABLE")
    approval_status = "APPROVED" if is_valid_run else (
        "REVIEW_REQUIRED" if quality_grade == "C_REVIEW_NEEDED" else "REJECTED"
    )

    dataset = CanonicalDataset(
        colony_id=colony_id,
        version=dataset_version,
        is_active=False,  # Set to active during commit if approved
        approval_status=approval_status,
        source_sha256=source_hash,
        source_filename=source_filename,
        processing_run_id=run_id,
        crs_metadata=crs_metadata,
        plots_count=len(canonical_plots),
        roads_count=len(canonical_roads),
        relationships_count=len(canonical_relationships),
        dimensions_count=len(canonical_dimensions),
        qa_quality_grade=quality_grade,
        qa_findings_summary=findings_summary,
        summary={
            "plots_count": len(canonical_plots),
            "roads_count": len(canonical_roads),
            "dimensions_count": len(canonical_dimensions),
            "relationships_count": len(canonical_relationships),
        },
        created_at=now,
        created_by=created_by,
    )

    return (
        dataset,
        proc_run,
        canonical_plots,
        canonical_roads,
        canonical_dimensions,
        canonical_relationships,
    )
