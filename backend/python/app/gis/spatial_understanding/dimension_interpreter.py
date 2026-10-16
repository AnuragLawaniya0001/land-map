"""Dimension Annotation Interpreter.

Detects, interprets, and associates dimension annotations with geometric edges,
plots, roads, blocks, and boundaries. Classifies measurement types (frontage, depth,
side lengths, road widths, block lengths, etc.) and constructs the canonical
relationship schema conforming to Phase Specification Section 9.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from shapely.geometry import LineString, Point, Polygon, MultiPolygon
from shapely.ops import unary_union

from app.gis.spatial_understanding.models import (
    CanonicalRelationship,
    ConfidenceSignals,
    Entity,
    EntityType,
    MeasurementType,
    QAIssue,
    Relationship,
    RelationshipType,
    SemanticDrawingGraph,
    ValidationStatus,
)
from app.gis.spatial_understanding.topology import _edge_angle_deg, _is_parallel, _is_perpendicular
from app.gis.spatial_understanding.unit_parser import ParsedMeasurement, parse_measurement_text


def _project_point_on_line(p: Tuple[float, float], l1: Tuple[float, float], l2: Tuple[float, float]) -> Tuple[float, float, float]:
    """Projects point p onto line segment (l1, l2). Returns (proj_x, proj_y, t) where t is parameter."""
    dx = l2[0] - l1[0]
    dy = l2[1] - l1[1]
    denom = dx * dx + dy * dy
    if denom < 1e-12:
        return (l1[0], l1[1], 0.0)
    t = ((p[0] - l1[0]) * dx + (p[1] - l1[1]) * dy) / denom
    proj_x = l1[0] + t * dx
    proj_y = l1[1] + t * dy
    return (proj_x, proj_y, t)


class DimensionInterpreter:
    """Interprets and associates dimension annotations with drawing edges and features."""

    def __init__(
        self,
        alignment_angle_tol_deg: float = 10.0,
        max_edge_distance: float = 15.0,
        scale_tolerance: float = 0.15,
    ):
        self.alignment_angle_tol_deg = alignment_angle_tol_deg
        self.max_edge_distance = max_edge_distance
        self.scale_tolerance = scale_tolerance

    def interpret_dimensions(
        self,
        graph: SemanticDrawingGraph,
        scale_ratio: Optional[float] = None,  # drawing units per real-world unit (e.g. 1.0 or scale)
    ) -> None:
        """Finds all dimension entities and associates them with candidate edges/features."""
        dim_annotations = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.DIMENSION_ANNOTATION
        ]
        dim_lines = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.DIMENSION_LINE
        ]
        ext_lines = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.EXTENSION_LINE
        ]
        arrowheads = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.ARROWHEAD
        ]
        edges = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.EDGE
        ]
        plots = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.PLOT
        ]
        roads = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.ROAD
        ]
        boundaries = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.BOUNDARY
        ]

        for dim_ann in dim_annotations:
            raw_text = dim_ann.properties.get("raw_text") or dim_ann.properties.get("text", "")
            parsed = parse_measurement_text(raw_text)

            # 1. Handle Area annotations
            if parsed.is_area:
                self._handle_area_annotation(graph, dim_ann, parsed, plots)
                continue

            # 2. Match associated dimension line
            matched_dim_line = self._find_matching_dimension_line(dim_ann, dim_lines)

            # 3. Match arrowheads and extension lines
            arrow_evidence = self._find_arrowheads(matched_dim_line, arrowheads)
            ext_evidence = self._find_extension_lines(matched_dim_line, ext_lines)

            # 4. Check if dimension line crosses unrelated geometry
            cross_cut_issues = []
            if matched_dim_line:
                cross_cut_issues = self._check_cross_cutting_lines(graph, matched_dim_line, plots)

            # 5. Search candidate edges / spans
            candidate_results = self._find_candidate_targets(
                dim_ann=dim_ann,
                dim_line=matched_dim_line,
                parsed=parsed,
                edges=edges,
                plots=plots,
                roads=roads,
                boundaries=boundaries,
                scale_ratio=scale_ratio,
            )

            # 6. Build canonical relationship and record QA issues
            self._create_canonical_association(
                graph=graph,
                dim_ann=dim_ann,
                dim_line=matched_dim_line,
                parsed=parsed,
                candidate_results=candidate_results,
                arrow_evidence=arrow_evidence,
                ext_evidence=ext_evidence,
                cross_cut_issues=cross_cut_issues,
                scale_ratio=scale_ratio,
            )

    def _handle_area_annotation(
        self,
        graph: SemanticDrawingGraph,
        dim_ann: Entity,
        parsed: ParsedMeasurement,
        plots: List[Entity],
    ) -> None:
        """Associates area text (e.g. '150 SQ. YDS') with containing plot."""
        pt = None
        if isinstance(dim_ann.geometry, Point):
            pt = dim_ann.geometry
        elif "coordinates" in dim_ann.properties:
            coords = dim_ann.properties["coordinates"]
            pt = Point(coords[0], coords[1])

        target_plot_id = None
        if pt:
            for plot in plots:
                if isinstance(plot.geometry, (Polygon, MultiPolygon)) and plot.geometry.contains(pt):
                    target_plot_id = plot.entity_id
                    break

        evidence = ["area_unit_parsed"]
        if target_plot_id:
            evidence.append("plot_containment")

        status = ValidationStatus.VERIFIED.value if target_plot_id else ValidationStatus.REVIEW_REQUIRED.value
        candidate_features = [target_plot_id] if target_plot_id else []

        canonical = CanonicalRelationship(
            entity_id=dim_ann.entity_id,
            entity_type=EntityType.DIMENSION_ANNOTATION.value,
            raw_text=parsed.raw_text,
            parsed_value=parsed.parsed_value,
            unit=parsed.unit,
            measurement_type=MeasurementType.AREA.value,
            source_page=dim_ann.source_page,
            dimension_line_id=None,
            candidate_target_edges=[],
            candidate_target_features=candidate_features,
            association_status=status,
            evidence=evidence,
            qa_issues=[],
        )
        graph.canonical_relationships.append(canonical)

        if target_plot_id:
            plot = graph.get_entity(target_plot_id)
            if plot:
                plot.properties["recorded_area"] = parsed.parsed_value
                plot.properties["recorded_area_unit"] = parsed.unit

    def _find_matching_dimension_line(
        self,
        dim_ann: Entity,
        dim_lines: List[Entity],
    ) -> Optional[Entity]:
        """Finds the dimension line entity closest and parallel to the dimension annotation text."""
        # If explicitly referenced
        dl_id = dim_ann.properties.get("dimension_line_id")
        if dl_id:
            for dl in dim_lines:
                if dl.entity_id == dl_id:
                    return dl

        ann_geom = dim_ann.geometry
        if not ann_geom or not dim_lines:
            return None

        best_dl = None
        min_dist = float("inf")

        for dl in dim_lines:
            dist = dl.geometry.distance(ann_geom)
            if dist < min_dist and dist <= self.max_edge_distance:
                min_dist = dist
                best_dl = dl

        return best_dl

    def _find_arrowheads(
        self,
        dim_line: Optional[Entity],
        arrowheads: List[Entity],
    ) -> List[str]:
        """Detects arrowheads or tick marks at dimension line endpoints."""
        if not dim_line or not arrowheads:
            return ["missing_arrowheads"]

        geom = dim_line.geometry
        if not isinstance(geom, LineString):
            return ["missing_arrowheads"]

        coords = list(geom.coords)
        if len(coords) < 2:
            return ["missing_arrowheads"]

        p_start = Point(coords[0])
        p_end = Point(coords[-1])

        start_found = any(a.geometry.distance(p_start) <= 1.5 for a in arrowheads)
        end_found = any(a.geometry.distance(p_end) <= 1.5 for a in arrowheads)

        if start_found and end_found:
            return ["arrowheads_both_endpoints"]
        elif start_found or end_found:
            return ["arrowhead_single_endpoint"]
        return ["missing_arrowheads"]

    def _find_extension_lines(
        self,
        dim_line: Optional[Entity],
        ext_lines: List[Entity],
    ) -> List[str]:
        """Detects extension lines extending from dimension line endpoints."""
        if not dim_line or not ext_lines:
            return ["missing_extension_lines"]

        geom = dim_line.geometry
        if not isinstance(geom, LineString):
            return ["missing_extension_lines"]

        coords = list(geom.coords)
        if len(coords) < 2:
            return ["missing_extension_lines"]

        p_start = Point(coords[0])
        p_end = Point(coords[-1])

        found_start = any(el.geometry.distance(p_start) <= 1.5 for el in ext_lines)
        found_end = any(el.geometry.distance(p_end) <= 1.5 for el in ext_lines)

        if found_start and found_end:
            return ["extension_line_endpoint_match"]
        elif found_start or found_end:
            return ["extension_line_single_endpoint"]
        return ["missing_extension_lines"]

    def _check_cross_cutting_lines(
        self,
        graph: SemanticDrawingGraph,
        dim_line: Entity,
        plots: List[Entity],
    ) -> List[QAIssue]:
        """Checks if a dimension line inappropriately cuts across unrelated plot geometries."""
        issues = []
        geom = dim_line.geometry
        if not isinstance(geom, LineString):
            return issues

        for plot in plots:
            p_geom = plot.geometry
            if not isinstance(p_geom, (Polygon, MultiPolygon)):
                continue

            # Check if dimension line crosses through the interior of the polygon
            try:
                inter = geom.intersection(p_geom)
                if not inter.is_empty and inter.length > 0.5:
                    # If it's not parallel to any edge of the plot
                    plot_edges = [
                        e for e in graph.entities.values()
                        if e.entity_type == EntityType.EDGE and e.properties.get("parent_feature_id") == plot.entity_id
                    ]
                    dl_angle = _edge_angle_deg(geom.coords[0], geom.coords[-1])
                    any_parallel = any(
                        _is_parallel(dl_angle, pe.properties["angle_deg"], tolerance=10.0)
                        for pe in plot_edges
                    )
                    if not any_parallel:
                        issue = QAIssue(
                            issue_id=f"qa_crosscut_{dim_line.entity_id}_{plot.entity_id}",
                            issue_type="dimension_crosses_unrelated_geometry",
                            severity="medium",
                            message=f"Dimension line {dim_line.entity_id} cuts across plot {plot.entity_id} interior without edge alignment",
                            entity_ids=[dim_line.entity_id, plot.entity_id],
                        )
                        issues.append(issue)
            except Exception:
                pass
        return issues

    def _find_candidate_targets(
        self,
        dim_ann: Entity,
        dim_line: Optional[Entity],
        parsed: ParsedMeasurement,
        edges: List[Entity],
        plots: List[Entity],
        roads: List[Entity],
        boundaries: List[Entity],
        scale_ratio: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Finds candidate measured edges, features, and evaluates multi-span block lengths."""
        # 1. Road Width direct check
        if parsed.is_road_label or parsed.measurement_type == MeasurementType.ROAD_WIDTH:
            road_target = self._find_nearest_road(dim_ann, roads)
            if road_target:
                return {
                    "measurement_type": MeasurementType.ROAD_WIDTH,
                    "target_edges": [],
                    "target_features": [road_target.entity_id],
                    "confidence": 0.95,
                    "evidence": ["road_width_keyword_match"],
                    "is_multi_span": False,
                }

        # 2. Geometry search using dimension line or annotation text position
        ref_geom = dim_line.geometry if (dim_line and isinstance(dim_line.geometry, LineString)) else dim_ann.geometry
        if not ref_geom:
            return {
                "measurement_type": MeasurementType.UNKNOWN_MEASUREMENT,
                "target_edges": [],
                "target_features": [],
                "confidence": 0.0,
                "evidence": ["no_geometry_available"],
                "is_multi_span": False,
            }

        ref_coords = list(ref_geom.coords) if hasattr(ref_geom, "coords") else []
        dim_span_len = LineString(ref_coords).length if len(ref_coords) >= 2 else (parsed.parsed_value or 0.0)
        dim_angle = _edge_angle_deg(ref_coords[0], ref_coords[-1]) if len(ref_coords) >= 2 else 0.0

        # Check Multi-Plot Block Span:
        # Does this dimension line span across multiple contiguous plots?
        multi_span_result = self._check_multi_plot_span(
            ref_geom=ref_geom,
            dim_span_len=dim_span_len,
            parsed_val=parsed.parsed_value,
            dim_angle=dim_angle,
            plots=plots,
            edges=edges,
        )
        if multi_span_result:
            return multi_span_result

        # Check Single-Edge Candidates
        candidate_edges_scored: List[Tuple[float, Entity, str]] = []

        for edge in edges:
            e_geom = edge.geometry
            if not isinstance(e_geom, LineString):
                continue

            dist = ref_geom.distance(e_geom)
            if dist > self.max_edge_distance:
                continue

            e_angle = edge.properties.get("angle_deg", 0.0)
            if not _is_parallel(dim_angle, e_angle, tolerance=self.alignment_angle_tol_deg):
                continue

            # Length comparison
            e_len = edge.properties.get("length", e_geom.length)
            expected_len = parsed.parsed_value if (parsed.parsed_value is not None and not parsed.unit_uncertain) else dim_span_len

            # Score edge candidate
            # Closeness + angle alignment + span overlap
            dist_score = max(0.0, 1.0 - (dist / self.max_edge_distance))
            len_ratio = min(e_len, expected_len) / max(e_len, expected_len, 1e-5) if expected_len > 0 else 0.5
            score = 0.5 * dist_score + 0.5 * len_ratio

            evidence_desc = "dimension_line_alignment"
            candidate_edges_scored.append((score, edge, evidence_desc))

        if candidate_edges_scored:
            candidate_edges_scored.sort(key=lambda x: x[0], reverse=True)
            best_score, best_edge, ev = candidate_edges_scored[0]
            parent_id = best_edge.properties.get("parent_feature_id")
            parent_type = best_edge.properties.get("parent_feature_type")

            # Determine semantic measurement category
            meas_type = MeasurementType.PLOT_SIDE_LENGTH
            if parent_type == EntityType.BOUNDARY.value:
                meas_type = MeasurementType.BOUNDARY_LENGTH
            elif best_edge.properties.get("is_road_frontage"):
                meas_type = MeasurementType.PLOT_FRONTAGE
            elif parent_type == EntityType.PLOT.value:
                # Check if edge is perpendicular to road frontage -> plot_depth
                plot_edges = [e for e in edges if e.properties.get("parent_feature_id") == parent_id]
                frontage_edges = [e for e in plot_edges if e.properties.get("is_road_frontage")]
                if frontage_edges:
                    f_angle = frontage_edges[0].properties.get("angle_deg", 0.0)
                    if _is_perpendicular(f_angle, best_edge.properties.get("angle_deg", 0.0), tolerance=15.0):
                        meas_type = MeasurementType.PLOT_DEPTH

            candidate_features = [parent_id] if parent_id else []
            return {
                "measurement_type": meas_type,
                "target_edges": [best_edge.entity_id],
                "target_features": candidate_features,
                "confidence": round(best_score, 3),
                "evidence": [ev, "edge_endpoint_match"],
                "is_multi_span": False,
                "alternatives": [
                    {"edge_id": e.entity_id, "score": round(sc, 3)}
                    for sc, e, _ in candidate_edges_scored[1:4]
                ],
            }

        return {
            "measurement_type": MeasurementType.UNKNOWN_MEASUREMENT,
            "target_edges": [],
            "target_features": [],
            "confidence": 0.3,
            "evidence": ["no_parallel_edge_within_tolerance"],
            "is_multi_span": False,
        }

    def _check_multi_plot_span(
        self,
        ref_geom: Any,
        dim_span_len: float,
        parsed_val: Optional[float],
        dim_angle: float,
        plots: List[Entity],
        edges: List[Entity],
    ) -> Optional[Dict[str, Any]]:
        """Checks if a dimension spans across multiple contiguous plots (Block length / combined frontage)."""
        if not isinstance(ref_geom, LineString):
            return None

        coords = list(ref_geom.coords)
        if len(coords) < 2:
            return None

        p_start = Point(coords[0])
        p_end = Point(coords[-1])

        # Find plots intersecting or close to the span
        intersecting_plots = []
        for plot in plots:
            p_geom = plot.geometry
            if not isinstance(p_geom, (Polygon, MultiPolygon)):
                continue
            if p_geom.distance(ref_geom) <= 3.0:
                intersecting_plots.append(plot)

        if len(intersecting_plots) >= 2:
            # Check if dimension endpoints correspond to the outer extremes of the combined cluster
            combined_poly = unary_union([p.geometry for p in intersecting_plots])
            dist_start = combined_poly.distance(p_start)
            dist_end = combined_poly.distance(p_end)

            if dist_start <= 3.0 and dist_end <= 3.0:
                target_plot_ids = [p.entity_id for p in intersecting_plots]
                return {
                    "measurement_type": MeasurementType.BLOCK_LENGTH,
                    "target_edges": [],
                    "target_features": target_plot_ids,
                    "confidence": 0.90,
                    "evidence": [
                        "multi_plot_span",
                        "endpoint_block_corners_match",
                        "annotation_applies_to_multiple_features",
                    ],
                    "is_multi_span": True,
                }
        return None

    def _find_nearest_road(self, dim_ann: Entity, roads: List[Entity]) -> Optional[Entity]:
        geom = dim_ann.geometry
        if not geom or not roads:
            return None
        best = None
        min_dist = float("inf")
        for r in roads:
            d = r.geometry.distance(geom)
            if d < min_dist:
                min_dist = d
                best = r
        return best if min_dist <= 25.0 else None

    def _create_canonical_association(
        self,
        graph: SemanticDrawingGraph,
        dim_ann: Entity,
        dim_line: Optional[Entity],
        parsed: ParsedMeasurement,
        candidate_results: Dict[str, Any],
        arrow_evidence: List[str],
        ext_evidence: List[str],
        cross_cut_issues: List[QAIssue],
        scale_ratio: Optional[float] = None,
    ) -> None:
        """Constructs canonical relationship record, validates consistency, and logs QA issues."""
        meas_type = candidate_results["measurement_type"]
        target_edges = candidate_results.get("target_edges", [])
        target_features = candidate_results.get("target_features", [])
        evidence = list(candidate_results.get("evidence", []))
        confidence_val = candidate_results.get("confidence", 0.5)

        # Merge evidence
        evidence.extend(arrow_evidence)
        evidence.extend(ext_evidence)
        if dim_line:
            evidence.append("dimension_line_geometry_present")

        qa_issues_list: List[Dict[str, Any]] = []

        # Add cross cut issues
        for ci in cross_cut_issues:
            graph.add_qa_issue(ci)
            qa_issues_list.append(ci.to_dict())

        # Check for unparsed or uncertain unit
        if parsed.unit_uncertain and parsed.parsed_value is not None:
            qa_unit = QAIssue(
                issue_id=f"qa_unit_uncertain_{dim_ann.entity_id}",
                issue_type="uncertain_dimension_unit",
                severity="low",
                message=f"Dimension '{parsed.raw_text}' has numeric value {parsed.parsed_value} but unspecified unit",
                entity_ids=[dim_ann.entity_id],
            )
            graph.add_qa_issue(qa_unit)
            qa_issues_list.append(qa_unit.to_dict())

        # Check scale consistency if scale_ratio is provided
        if scale_ratio and parsed.parsed_value and target_edges:
            edge = graph.get_entity(target_edges[0])
            if edge:
                geom_len = edge.properties.get("length", 0.0)
                expected_geom_len = parsed.parsed_value * scale_ratio
                diff_ratio = abs(geom_len - expected_geom_len) / max(expected_geom_len, 1e-5)
                if diff_ratio > self.scale_tolerance:
                    qa_scale = QAIssue(
                        issue_id=f"qa_scale_mismatch_{dim_ann.entity_id}_{edge.entity_id}",
                        issue_type="dimension_scale_mismatch",
                        severity="medium",
                        message=f"Dimension {parsed.parsed_value} differs from drawing edge geometry {geom_len:.2f} by {diff_ratio*100:.1f}%",
                        entity_ids=[dim_ann.entity_id, edge.entity_id],
                        details={"parsed_value": parsed.parsed_value, "edge_length": geom_len},
                    )
                    graph.add_qa_issue(qa_scale)
                    qa_issues_list.append(qa_scale.to_dict())
                else:
                    evidence.append("scale_consistent")

        # Determine association validation status
        if cross_cut_issues:
            status = ValidationStatus.CONFLICTED
        elif not target_edges and not target_features:
            status = ValidationStatus.UNRESOLVED
        elif qa_issues_list:
            status = ValidationStatus.REVIEW_REQUIRED
        elif candidate_results.get("is_multi_span"):
            status = ValidationStatus.VERIFIED
        elif confidence_val >= 0.70 and ("dimension_line_alignment" in evidence or meas_type == MeasurementType.ROAD_WIDTH):
            status = ValidationStatus.VERIFIED
        else:
            status = ValidationStatus.CANDIDATE

        canonical = CanonicalRelationship(
            entity_id=dim_ann.entity_id,
            entity_type=EntityType.DIMENSION_ANNOTATION.value,
            raw_text=parsed.raw_text,
            parsed_value=parsed.parsed_value,
            unit=parsed.unit,
            measurement_type=meas_type.value,
            source_page=dim_ann.source_page,
            dimension_line_id=dim_line.entity_id if dim_line else None,
            candidate_target_edges=target_edges,
            candidate_target_features=target_features,
            association_status=status.value,
            evidence=evidence,
            qa_issues=qa_issues_list,
            confidence_signals=ConfidenceSignals(
                text_recognition=1.0 if not parsed.unit_uncertain else 0.85,
                entity_classification=0.95,
                label_to_feature=1.0,
                dimension_to_edge=confidence_val,
                geometry_validity=1.0 if not cross_cut_issues else 0.5,
                geographic_alignment=1.0,
            ).to_dict(),
            candidate_alternatives=candidate_results.get("alternatives", []),
        )
        graph.canonical_relationships.append(canonical)

        # Create relationship in graph
        for feat_id in target_features:
            rel_type = (
                RelationshipType.ANNOTATION_APPLIES_TO_MULTIPLE_FEATURES
                if candidate_results.get("is_multi_span")
                else RelationshipType.DIMENSION_MEASURES_FEATURE
            )
            rel = Relationship(
                relationship_id=f"rel_dim_{dim_ann.entity_id}_{feat_id}",
                relationship_type=rel_type,
                source_entity_id=dim_ann.entity_id,
                target_entity_id=feat_id,
                validation_status=status,
                evidence=evidence,
                properties={
                    "parsed_value": parsed.parsed_value,
                    "unit": parsed.unit,
                    "measurement_type": meas_type.value,
                },
            )
            graph.add_relationship(rel)

        for edge_id in target_edges:
            rel = Relationship(
                relationship_id=f"rel_dim_edge_{dim_ann.entity_id}_{edge_id}",
                relationship_type=RelationshipType.DIMENSION_MEASURES_EDGE,
                source_entity_id=dim_ann.entity_id,
                target_entity_id=edge_id,
                validation_status=status,
                evidence=evidence,
                properties={
                    "parsed_value": parsed.parsed_value,
                    "unit": parsed.unit,
                    "measurement_type": meas_type.value,
                },
            )
            graph.add_relationship(rel)
