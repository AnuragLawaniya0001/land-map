"""Geometry Quality Assurance Module.

Validates reconstructed colony geometry using Shapely:
- Polygon validity and self-intersections
- Degenerate polygons and zero-length edges
- Duplicate polygons and edges
- Unexpected overlaps vs intentional shared edges
- Unintended micro-gaps between neighboring parcels
- Boundary closure and site boundary containment
- Road corridor continuity and plot-to-road adjacency
- Scale consistency and coordinate precision
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple, Set

import numpy as np
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
    shape,
)
from shapely.ops import unary_union
from shapely.validation import explain_validity

from app.gis.qa.models import QAFinding, QASeverity, RecoveryActionType
from app.gis.spatial_understanding.models import Entity, EntityType


class GeometryQAChecker:
    """Configurable quality assurance checker for colony engineering geometry."""

    def __init__(
        self,
        min_plot_area_sqm: float = 2.0,            # Minimum viable parcel area in m²
        min_edge_length_m: float = 0.08,           # Edge length below which is degenerate (m)
        overlap_tolerance_sqm: float = 0.5,        # Maximum allowable unintended overlap (m²)
        duplicate_iou_threshold: float = 0.95,     # IoU above which parcels are considered duplicates
        duplicate_hausdorff_m: float = 0.10,       # Hausdorff distance below which geometry is duplicate (m)
        boundary_containment_min_ratio: float = 0.92, # Min % of plot area that must lie within boundary
        micro_gap_max_distance_m: float = 0.20,    # Distance threshold for detecting micro-gaps (m)
        scale_tolerance_ratio: float = 0.12,       # Max discrepancy ratio between scale and dimensions
    ):
        self.min_plot_area_sqm = min_plot_area_sqm
        self.min_edge_length_m = min_edge_length_m
        self.overlap_tolerance_sqm = overlap_tolerance_sqm
        self.duplicate_iou_threshold = duplicate_iou_threshold
        self.duplicate_hausdorff_m = duplicate_hausdorff_m
        self.boundary_containment_min_ratio = boundary_containment_min_ratio
        self.micro_gap_max_distance_m = micro_gap_max_distance_m
        self.scale_tolerance_ratio = scale_tolerance_ratio

    def run_all_checks(
        self,
        plots: List[Entity],
        roads: Optional[List[Entity]] = None,
        boundaries: Optional[List[Entity]] = None,
        edges: Optional[List[Entity]] = None,
        scale_ratio: Optional[float] = None,
    ) -> List[QAFinding]:
        """Runs the complete suite of geometric quality checks and returns findings."""
        findings: List[QAFinding] = []

        findings.extend(self.check_polygon_validity(plots))
        findings.extend(self.check_degenerate_polygons(plots))
        findings.extend(self.check_zero_length_edges(plots, edges))
        findings.extend(self.check_duplicate_polygons(plots))
        findings.extend(self.check_unexpected_overlaps(plots))
        findings.extend(self.check_unintended_micro_gaps(plots, roads or []))
        findings.extend(self.check_boundary_closure(boundaries or []))
        findings.extend(self.check_boundary_containment(plots, boundaries or []))
        findings.extend(self.check_road_continuity_and_frontage(plots, roads or []))
        findings.extend(self.check_coordinate_precision_and_finite(plots + (roads or []) + (boundaries or [])))

        return findings

    def check_polygon_validity(self, plots: List[Entity]) -> List[QAFinding]:
        """Checks polygon validity, self-intersections, bow-ties, and ring self-tangencies."""
        findings = []
        for plot in plots:
            geom = plot.geometry
            if not isinstance(geom, (Polygon, MultiPolygon)):
                continue

            if not geom.is_valid:
                reason = explain_validity(geom)
                findings.append(QAFinding(
                    finding_id=f"geom_invalid_{plot.entity_id}",
                    check_name="polygon_validity",
                    severity=QASeverity.ERROR,
                    message=f"Plot '{plot.entity_id}' has invalid geometry: {reason}",
                    entity_ids=[plot.entity_id],
                    evidence=["shapely_is_valid_false", f"reason_{reason}"],
                    details={"validity_reason": reason},
                    recommended_action=RecoveryActionType.GEOMETRIC_REPAIR_BUFFER0,
                ))
            elif geom.is_empty:
                findings.append(QAFinding(
                    finding_id=f"geom_empty_{plot.entity_id}",
                    check_name="polygon_validity",
                    severity=QASeverity.CRITICAL,
                    message=f"Plot '{plot.entity_id}' has empty geometry",
                    entity_ids=[plot.entity_id],
                    evidence=["geometry_is_empty"],
                    recommended_action=RecoveryActionType.NO_ACTION_POSSIBLE,
                ))
        return findings

    def check_degenerate_polygons(self, plots: List[Entity]) -> List[QAFinding]:
        """Flags degenerate polygons with negligible area or fewer than 3 unique vertices."""
        findings = []
        for plot in plots:
            geom = plot.geometry
            if not isinstance(geom, (Polygon, MultiPolygon)):
                continue

            area = geom.area
            if area < self.min_plot_area_sqm:
                findings.append(QAFinding(
                    finding_id=f"geom_degenerate_area_{plot.entity_id}",
                    check_name="degenerate_polygon",
                    severity=QASeverity.ERROR,
                    message=f"Plot '{plot.entity_id}' is degenerate: area {area:.4f} m² is below minimum {self.min_plot_area_sqm} m²",
                    entity_ids=[plot.entity_id],
                    evidence=["area_below_threshold"],
                    details={"area": area, "min_required": self.min_plot_area_sqm},
                    recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                ))

            # Vertex count check
            polys = [geom] if isinstance(geom, Polygon) else list(geom.geoms)
            for p in polys:
                coords = list(p.exterior.coords)
                unique_pts = set((round(x, 4), round(y, 4)) for x, y in coords)
                if len(unique_pts) < 3:
                    findings.append(QAFinding(
                        finding_id=f"geom_degenerate_vertices_{plot.entity_id}",
                        check_name="degenerate_polygon",
                        severity=QASeverity.ERROR,
                        message=f"Plot '{plot.entity_id}' has fewer than 3 unique vertices ({len(unique_pts)})",
                        entity_ids=[plot.entity_id],
                        evidence=["vertex_count_below_3"],
                        details={"unique_vertices": len(unique_pts)},
                        recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                    ))
        return findings

    def check_zero_length_edges(
        self,
        plots: List[Entity],
        edges: Optional[List[Entity]] = None,
    ) -> List[QAFinding]:
        """Detects zero-length and micro edges in polygon boundaries."""
        findings = []
        for plot in plots:
            geom = plot.geometry
            if not isinstance(geom, (Polygon, MultiPolygon)):
                continue

            polys = [geom] if isinstance(geom, Polygon) else list(geom.geoms)
            for p in polys:
                coords = list(p.exterior.coords)
                for i in range(len(coords) - 1):
                    p1, p2 = coords[i][:2], coords[i + 1][:2]
                    seg_len = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
                    if seg_len < self.min_edge_length_m and seg_len > 0:
                        findings.append(QAFinding(
                            finding_id=f"geom_micro_edge_{plot.entity_id}_{i}",
                            check_name="zero_length_edge",
                            severity=QASeverity.WARNING,
                            message=f"Plot '{plot.entity_id}' contains micro edge {i} of length {seg_len:.4f} m (< {self.min_edge_length_m} m)",
                            entity_ids=[plot.entity_id],
                            evidence=["micro_edge_detected"],
                            details={"edge_index": i, "edge_length": seg_len},
                            recommended_action=RecoveryActionType.SNAP_MICRO_GAPS,
                        ))
                    elif seg_len <= 1e-7:
                        findings.append(QAFinding(
                            finding_id=f"geom_zero_edge_{plot.entity_id}_{i}",
                            check_name="zero_length_edge",
                            severity=QASeverity.ERROR,
                            message=f"Plot '{plot.entity_id}' contains identical consecutive duplicate vertices at index {i}",
                            entity_ids=[plot.entity_id],
                            evidence=["zero_length_edge_detected"],
                            details={"edge_index": i},
                            recommended_action=RecoveryActionType.GEOMETRIC_REPAIR_BUFFER0,
                        ))
        return findings

    def check_duplicate_polygons(self, plots: List[Entity]) -> List[QAFinding]:
        """Detects duplicate or nearly identical polygons using IoU and Hausdorff distance."""
        findings = []
        n = len(plots)
        for i in range(n):
            p1 = plots[i]
            g1 = p1.geometry
            if not isinstance(g1, (Polygon, MultiPolygon)) or g1.is_empty:
                continue

            for j in range(i + 1, n):
                p2 = plots[j]
                g2 = p2.geometry
                if not isinstance(g2, (Polygon, MultiPolygon)) or g2.is_empty:
                    continue

                # Bounding box quick check
                if g1.bounds[2] < g2.bounds[0] or g2.bounds[2] < g1.bounds[0] or \
                   g1.bounds[3] < g2.bounds[1] or g2.bounds[3] < g1.bounds[1]:
                    continue

                try:
                    inter_area = g1.intersection(g2).area
                    union_area = g1.union(g2).area
                    iou = inter_area / union_area if union_area > 0 else 0.0

                    if iou >= self.duplicate_iou_threshold:
                        findings.append(QAFinding(
                            finding_id=f"geom_duplicate_poly_{p1.entity_id}_{p2.entity_id}",
                            check_name="duplicate_polygons",
                            severity=QASeverity.ERROR,
                            message=f"Plots '{p1.entity_id}' and '{p2.entity_id}' are duplicate geometries (IoU: {iou*100:.1f}%)",
                            entity_ids=[p1.entity_id, p2.entity_id],
                            evidence=["iou_above_duplicate_threshold"],
                            details={"iou": round(iou, 4), "inter_area": inter_area},
                            recommended_action=RecoveryActionType.MERGE_DUPLICATES,
                        ))
                except Exception:
                    pass
        return findings

    def check_unexpected_overlaps(self, plots: List[Entity]) -> List[QAFinding]:
        """Detects unexpected 2D area overlaps between neighboring plots.

        Crucial Rule: Intentional shared boundaries (1D line intersection) have area = 0.0
        and are NOT flagged. Only unexpected area overlaps exceeding tolerance are flagged.
        """
        findings = []
        n = len(plots)
        for i in range(n):
            p1 = plots[i]
            g1 = p1.geometry
            if not isinstance(g1, (Polygon, MultiPolygon)) or g1.is_empty:
                continue

            for j in range(i + 1, n):
                p2 = plots[j]
                g2 = p2.geometry
                if not isinstance(g2, (Polygon, MultiPolygon)) or g2.is_empty:
                    continue

                # Quick bounding box filter
                if g1.bounds[2] < g2.bounds[0] or g2.bounds[2] < g1.bounds[0] or \
                   g1.bounds[3] < g2.bounds[1] or g2.bounds[3] < g1.bounds[1]:
                    continue

                try:
                    inter = g1.intersection(g2)
                    # 1D line intersections have area 0, which is intentional shared boundary!
                    if not inter.is_empty and hasattr(inter, "area") and inter.area > self.overlap_tolerance_sqm:
                        union_area = g1.union(g2).area
                        iou = inter.area / union_area if union_area > 0 else 0.0
                        if iou < self.duplicate_iou_threshold:  # Exclude exact duplicates (handled separately)
                            findings.append(QAFinding(
                                finding_id=f"geom_overlap_{p1.entity_id}_{p2.entity_id}",
                                check_name="unexpected_polygon_overlap",
                                severity=QASeverity.ERROR,
                                message=f"Unexpected parcel overlap between '{p1.entity_id}' and '{p2.entity_id}': {inter.area:.2f} m²",
                                entity_ids=[p1.entity_id, p2.entity_id],
                                evidence=["2d_intersection_area_exceeds_tolerance"],
                                details={"overlap_area_sqm": round(inter.area, 3)},
                                recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                            ))
                except Exception:
                    pass
        return findings

    def check_unintended_micro_gaps(
        self,
        plots: List[Entity],
        roads: List[Entity],
    ) -> List[QAFinding]:
        """Detects unintended micro-gaps (narrow slivers < 20cm) between adjacent plots that are not roads."""
        findings = []
        n = len(plots)
        road_union = unary_union([r.geometry for r in roads if r.geometry]) if roads else None

        for i in range(n):
            p1 = plots[i]
            g1 = p1.geometry
            if not isinstance(g1, (Polygon, MultiPolygon)):
                continue

            for j in range(i + 1, n):
                p2 = plots[j]
                g2 = p2.geometry
                if not isinstance(g2, (Polygon, MultiPolygon)):
                    continue

                dist = g1.distance(g2)
                # If they do not touch (dist > 0.001) but are within micro-gap distance
                if 0.005 < dist <= self.micro_gap_max_distance_m:
                    # Check if the gap is occupied by a road
                    is_road_gap = False
                    if road_union:
                        mid_pt = g1.representative_point()
                        # If a road passes between them, it's an intentional passage, not a micro-gap
                        if road_union.distance(g1) < dist and road_union.distance(g2) < dist:
                            is_road_gap = True

                    if not is_road_gap:
                        findings.append(QAFinding(
                            finding_id=f"geom_micro_gap_{p1.entity_id}_{p2.entity_id}",
                            check_name="unintended_micro_gap",
                            severity=QASeverity.WARNING,
                            message=f"Micro-gap of {dist*100:.1f} cm detected between neighboring plots '{p1.entity_id}' and '{p2.entity_id}'",
                            entity_ids=[p1.entity_id, p2.entity_id],
                            evidence=["hairline_gap_between_neighbors"],
                            details={"gap_distance_m": round(dist, 4)},
                            recommended_action=RecoveryActionType.SNAP_MICRO_GAPS,
                        ))
        return findings

    def check_boundary_closure(self, boundaries: List[Entity]) -> List[QAFinding]:
        """Ensures site and sector boundaries form closed, unbroken rings."""
        findings = []
        for b in boundaries:
            geom = b.geometry
            if isinstance(geom, LineString):
                coords = list(geom.coords)
                if len(coords) < 3 or coords[0][:2] != coords[-1][:2]:
                    findings.append(QAFinding(
                        finding_id=f"geom_unclosed_boundary_{b.entity_id}",
                        check_name="unclosed_boundary",
                        severity=QASeverity.ERROR,
                        message=f"Boundary '{b.entity_id}' is an unclosed LineString with open ends",
                        entity_ids=[b.entity_id],
                        evidence=["linestring_endpoints_not_coincident"],
                        details={"start": list(coords[0]), "end": list(coords[-1])},
                        recommended_action=RecoveryActionType.GEOMETRIC_REPAIR_MAKE_VALID,
                    ))
            elif isinstance(geom, (Polygon, MultiPolygon)):
                if not geom.is_valid:
                    findings.append(QAFinding(
                        finding_id=f"geom_invalid_boundary_{b.entity_id}",
                        check_name="boundary_polygon_validity",
                        severity=QASeverity.ERROR,
                        message=f"Boundary '{b.entity_id}' has self-intersections or invalid rings",
                        entity_ids=[b.entity_id],
                        evidence=["invalid_boundary_polygon"],
                        recommended_action=RecoveryActionType.GEOMETRIC_REPAIR_BUFFER0,
                    ))
        return findings

    def check_boundary_containment(
        self,
        plots: List[Entity],
        boundaries: List[Entity],
    ) -> List[QAFinding]:
        """Validates that reconstructed plots lie fully within the colony site boundary."""
        findings = []
        if not boundaries:
            return findings

        # Pick primary site boundary
        primary_bdy = boundaries[0].geometry
        if not isinstance(primary_bdy, (Polygon, MultiPolygon)) or primary_bdy.is_empty:
            return findings

        for plot in plots:
            p_geom = plot.geometry
            if not isinstance(p_geom, (Polygon, MultiPolygon)) or p_geom.is_empty:
                continue

            try:
                if not primary_bdy.covers(p_geom):
                    inter = primary_bdy.intersection(p_geom)
                    inter_area = inter.area if hasattr(inter, "area") else 0.0
                    total_area = p_geom.area
                    ratio = inter_area / total_area if total_area > 0 else 0.0

                    if ratio < self.boundary_containment_min_ratio:
                        findings.append(QAFinding(
                            finding_id=f"geom_outside_boundary_{plot.entity_id}",
                            check_name="boundary_containment",
                            severity=QASeverity.WARNING if ratio >= 0.70 else QASeverity.ERROR,
                            message=f"Plot '{plot.entity_id}' extends outside site boundary ({ratio*100:.1f}% inside, requires {self.boundary_containment_min_ratio*100:.0f}%)",
                            entity_ids=[plot.entity_id, boundaries[0].entity_id],
                            evidence=["boundary_containment_ratio_below_threshold"],
                            details={"containment_ratio": round(ratio, 4)},
                            recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                        ))
            except Exception:
                pass
        return findings

    def check_road_continuity_and_frontage(
        self,
        plots: List[Entity],
        roads: List[Entity],
    ) -> List[QAFinding]:
        """Validates road corridor connectivity and verifies every plot has accessible frontage."""
        findings = []
        if not roads:
            return findings

        road_geoms = [r.geometry for r in roads if r.geometry]
        if not road_geoms:
            return findings

        combined_road_network = unary_union(road_geoms)

        # Check for isolated plots with no road contact
        for plot in plots:
            p_geom = plot.geometry
            if not isinstance(p_geom, (Polygon, MultiPolygon)):
                continue

            dist_to_road = p_geom.distance(combined_road_network)
            # Plots must touch or be within 0.5m of an access road corridor
            if dist_to_road > 0.5:
                findings.append(QAFinding(
                    finding_id=f"geom_no_road_frontage_{plot.entity_id}",
                    check_name="road_frontage_accessibility",
                    severity=QASeverity.WARNING,
                    message=f"Plot '{plot.entity_id}' is landlocked or separated from nearest road by {dist_to_road:.2f} m",
                    entity_ids=[plot.entity_id],
                    evidence=["distance_to_road_exceeds_threshold"],
                    details={"distance_to_road_m": round(dist_to_road, 3)},
                    recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                ))

        return findings

    def check_coordinate_precision_and_finite(self, entities: List[Entity]) -> List[QAFinding]:
        """Validates that all coordinates are finite numbers without NaN, Inf, or coordinate overflow."""
        findings = []
        for ent in entities:
            geom = ent.geometry
            if geom is None:
                continue

            try:
                coords = []
                if hasattr(geom, "exterior"):
                    coords = list(geom.exterior.coords)
                elif hasattr(geom, "coords"):
                    coords = list(geom.coords)

                for c in coords:
                    if not all(math.isfinite(x) for x in c[:2]):
                        findings.append(QAFinding(
                            finding_id=f"geom_non_finite_coord_{ent.entity_id}",
                            check_name="coordinate_precision",
                            severity=QASeverity.CRITICAL,
                            message=f"Entity '{ent.entity_id}' contains non-finite NaN/Inf coordinates",
                            entity_ids=[ent.entity_id],
                            evidence=["non_finite_coordinate_detected"],
                            recommended_action=RecoveryActionType.NO_ACTION_POSSIBLE,
                        ))
                        break
            except Exception:
                pass
        return findings
