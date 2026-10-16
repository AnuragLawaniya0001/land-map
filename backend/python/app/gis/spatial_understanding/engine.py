"""Spatial Understanding and Measurement Association Engine.

Main orchestrator that converts extracted colony drawing geometry and annotations
into an evidence-backed Semantic Drawing Graph, answers semantic questions, and
exports canonical relationship schemas.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple, Union

from shapely.geometry import LineString, Point, Polygon, MultiPolygon, shape

from app.gis.spatial_understanding.dimension_interpreter import DimensionInterpreter
from app.gis.spatial_understanding.evidence_fusion import EvidenceFusionEngine
from app.gis.spatial_understanding.label_associator import LabelAssociator
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
from app.gis.spatial_understanding.topology import TopologyBuilder
from app.gis.spatial_understanding.unit_parser import parse_measurement_text

logger = logging.getLogger(__name__)


class SpatialUnderstandingEngine:
    """Master engine for colony engineering drawing understanding."""

    def __init__(
        self,
        topology_tolerance: float = 0.08,
        alignment_angle_tol_deg: float = 10.0,
        max_edge_distance: float = 15.0,
        scale_tolerance: float = 0.15,
    ):
        self.topology_builder = TopologyBuilder(tolerance=topology_tolerance)
        self.label_associator = LabelAssociator(search_radius=max_edge_distance * 1.5)
        self.dimension_interpreter = DimensionInterpreter(
            alignment_angle_tol_deg=alignment_angle_tol_deg,
            max_edge_distance=max_edge_distance,
            scale_tolerance=scale_tolerance,
        )
        self.evidence_fusion = EvidenceFusionEngine()

    def process_drawing(
        self,
        plots: Optional[List[Dict[str, Any]]] = None,
        roads: Optional[List[Dict[str, Any]]] = None,
        parks: Optional[List[Dict[str, Any]]] = None,
        boundaries: Optional[List[Dict[str, Any]]] = None,
        lines: Optional[List[Dict[str, Any]]] = None,
        text_elements: Optional[List[Dict[str, Any]]] = None,
        dimension_annotations: Optional[List[Dict[str, Any]]] = None,
        scale_ratio: Optional[float] = None,
        vlm_proposals: Optional[List[Dict[str, Any]]] = None,
        source_page: int = 1,
    ) -> SemanticDrawingGraph:
        """Processes drawing elements and constructs the full semantic drawing model."""
        graph = SemanticDrawingGraph()
        graph.metadata = {
            "source_page": source_page,
            "scale_ratio": scale_ratio,
        }

        # 1. Ingest Plots
        if plots:
            for idx, p in enumerate(plots):
                pid = p.get("id") or p.get("plot_id") or f"plot_{idx+1}"
                geom = self._to_shapely(p.get("geometry") or p.get("poly"))
                if geom:
                    ent = Entity(
                        entity_id=pid,
                        entity_type=EntityType.PLOT,
                        geometry=geom,
                        properties=dict(p),
                        source_page=source_page,
                        validation_status=ValidationStatus.VERIFIED,
                    )
                    graph.add_entity(ent)

        # 2. Ingest Roads
        if roads:
            for idx, r in enumerate(roads):
                rid = r.get("id") or r.get("road_id") or f"road_{idx+1}"
                geom = self._to_shapely(r.get("geometry") or r.get("line") or r.get("poly"))
                if geom:
                    ent = Entity(
                        entity_id=rid,
                        entity_type=EntityType.ROAD,
                        geometry=geom,
                        properties=dict(r),
                        source_page=source_page,
                        validation_status=ValidationStatus.VERIFIED,
                    )
                    graph.add_entity(ent)

        # 3. Ingest Parks / Open Space
        if parks:
            for idx, pk in enumerate(parks):
                pkid = pk.get("id") or f"park_{idx+1}"
                geom = self._to_shapely(pk.get("geometry") or pk.get("poly"))
                if geom:
                    ent = Entity(
                        entity_id=pkid,
                        entity_type=EntityType.PARK,
                        geometry=geom,
                        properties=dict(pk),
                        source_page=source_page,
                        validation_status=ValidationStatus.VERIFIED,
                    )
                    graph.add_entity(ent)

        # 4. Ingest Boundary
        if boundaries:
            for idx, b in enumerate(boundaries):
                bid = b.get("id") or f"boundary_{idx+1}"
                geom = self._to_shapely(b.get("geometry") or b.get("poly"))
                if geom:
                    ent = Entity(
                        entity_id=bid,
                        entity_type=EntityType.BOUNDARY,
                        geometry=geom,
                        properties=dict(b),
                        source_page=source_page,
                        validation_status=ValidationStatus.VERIFIED,
                    )
                    graph.add_entity(ent)

        # 5. Ingest Dimension Lines, Extension Lines, Arrowheads from Linework
        if lines:
            for idx, l_item in enumerate(lines):
                lid = l_item.get("id") or f"line_{idx+1}"
                geom = self._to_shapely(l_item.get("geometry") or l_item.get("coords"))
                l_type_str = str(l_item.get("type") or l_item.get("kind") or "linework").lower()

                if "dim" in l_type_str:
                    e_type = EntityType.DIMENSION_LINE
                elif "ext" in l_type_str:
                    e_type = EntityType.EXTENSION_LINE
                elif "arrow" in l_type_str:
                    e_type = EntityType.ARROWHEAD
                else:
                    e_type = EntityType.UNKNOWN_FEATURE

                if geom:
                    ent = Entity(
                        entity_id=lid,
                        entity_type=e_type,
                        geometry=geom,
                        properties=dict(l_item),
                        source_page=source_page,
                        validation_status=ValidationStatus.CANDIDATE,
                    )
                    graph.add_entity(ent)

        # 6. Ingest Text Elements
        if text_elements:
            for idx, t_item in enumerate(text_elements):
                tid = t_item.get("id") or f"text_{idx+1}"
                t_str = str(t_item.get("text") or "").strip()
                geom = self._to_shapely(t_item.get("geometry") or t_item.get("coordinates") or t_item.get("bbox"))

                # Pre-screen whether text is dimension-like
                parsed = parse_measurement_text(t_str)
                if parsed.is_valid_measurement and not parsed.is_plot_label:
                    e_type = EntityType.DIMENSION_ANNOTATION
                else:
                    e_type = EntityType.TEXT_LABEL

                ent = Entity(
                    entity_id=tid,
                    entity_type=e_type,
                    geometry=geom if geom else Point(0, 0),
                    properties={
                        **t_item,
                        "text": t_str,
                        "raw_text": t_str,
                    },
                    source_page=source_page,
                    validation_status=ValidationStatus.CANDIDATE,
                )
                graph.add_entity(ent)

        # 7. Ingest Explicit Dimension Annotations
        if dimension_annotations:
            for idx, d_item in enumerate(dimension_annotations):
                did = d_item.get("id") or d_item.get("entity_id") or f"dim_ann_{idx+1}"
                raw_text = d_item.get("raw_text") or d_item.get("text") or ""
                geom = self._to_shapely(d_item.get("geometry") or d_item.get("coordinates") or d_item.get("bbox"))

                ent = Entity(
                    entity_id=did,
                    entity_type=EntityType.DIMENSION_ANNOTATION,
                    geometry=geom if geom else Point(0, 0),
                    properties={
                        **d_item,
                        "raw_text": raw_text,
                        "text": raw_text,
                    },
                    source_page=source_page,
                    validation_status=ValidationStatus.CANDIDATE,
                )
                graph.add_entity(ent)

        # EXECUTE PIPELINE
        # Step A: Build geometric topology (edges, shared boundaries, road frontages)
        self.topology_builder.build_topology(graph)

        # Step B: Associate text labels with plots and features
        self.label_associator.associate_labels(graph)

        # Step C: Interpret dimension annotations
        self.dimension_interpreter.interpret_dimensions(graph, scale_ratio=scale_ratio)

        # Step D: Evidence fusion, VLM arbitration, validation checks
        self.evidence_fusion.fuse_and_validate(graph, vlm_proposals=vlm_proposals)

        return graph

    def answer_semantic_questions(self, graph: SemanticDrawingGraph) -> Dict[str, Any]:
        """Provides direct, verifiable answers to the core drawing-understanding questions."""
        answers = {}

        # 1. Which plot does this plot number belong to?
        label_to_plot = {}
        for rel in graph.find_relationships(rel_type=RelationshipType.LABEL_BELONGS_TO_FEATURE):
            label = graph.get_entity(rel.source_entity_id)
            if label and label.properties.get("text"):
                label_to_plot[label.properties["text"]] = {
                    "plot_id": rel.target_entity_id,
                    "validation_status": rel.validation_status.value,
                    "confidence": rel.confidence_signals.aggregate,
                    "evidence": rel.evidence,
                }
        answers["plot_label_associations"] = label_to_plot

        # 2. Which edge or feature does this dimension measure?
        # 3. Is this measurement a plot frontage, plot depth, road width, etc.?
        dim_targets = {}
        for cr in graph.canonical_relationships:
            dim_targets[cr.entity_id] = {
                "raw_text": cr.raw_text,
                "parsed_value": cr.parsed_value,
                "unit": cr.unit,
                "measurement_type": cr.measurement_type,
                "candidate_target_edges": cr.candidate_target_edges,
                "candidate_target_features": cr.candidate_target_features,
                "association_status": cr.association_status,
                "evidence": cr.evidence,
                "qa_issues": cr.qa_issues,
            }
        answers["dimension_associations"] = dim_targets

        # 4. Which plots share a boundary?
        shared_boundaries = []
        for rel in graph.find_relationships(rel_type=RelationshipType.PLOT_ADJACENT_TO_PLOT):
            if rel.properties.get("adjacency_type") == "shared_boundary":
                shared_boundaries.append({
                    "plot_a": rel.source_entity_id,
                    "plot_b": rel.target_entity_id,
                    "shared_length": rel.properties.get("shared_length"),
                    "status": rel.validation_status.value,
                })
        answers["shared_boundaries"] = shared_boundaries

        # 5. Which plots are adjacent to a particular road?
        road_plots = {}
        for rel in graph.find_relationships(rel_type=RelationshipType.PLOT_ADJACENT_TO_ROAD):
            road_id = rel.target_entity_id
            road_plots.setdefault(road_id, []).append({
                "plot_id": rel.source_entity_id,
                "road_name": rel.properties.get("road_name", ""),
                "contact_length": rel.properties.get("contact_length", 0.0),
            })
        answers["road_adjacent_plots"] = road_plots

        # 6. Does a dimension apply to one plot, multiple plots or an entire block?
        multi_plot_dimensions = [
            cr.to_dict() for cr in graph.canonical_relationships
            if len(cr.candidate_target_features) > 1 or cr.measurement_type == MeasurementType.BLOCK_LENGTH.value
        ]
        answers["multi_plot_dimensions"] = multi_plot_dimensions

        # 7. QA issues summary
        answers["qa_issues"] = [issue.to_dict() for issue in graph.qa_issues]

        return answers

    def _to_shapely(self, geom_data: Any) -> Optional[Any]:
        if geom_data is None:
            return None
        if isinstance(geom_data, (Point, LineString, Polygon, MultiPolygon)):
            return geom_data
        if isinstance(geom_data, dict):
            try:
                return shape(geom_data)
            except Exception:
                pass
        if isinstance(geom_data, (list, tuple)):
            if len(geom_data) >= 3 and isinstance(geom_data[0], (list, tuple)):
                try:
                    return Polygon(geom_data)
                except Exception:
                    pass
            elif len(geom_data) >= 2 and isinstance(geom_data[0], (list, tuple)):
                try:
                    return LineString(geom_data)
                except Exception:
                    pass
            elif len(geom_data) == 2 and isinstance(geom_data[0], (int, float)):
                return Point(geom_data[0], geom_data[1])
            elif len(geom_data) == 4 and isinstance(geom_data[0], (int, float)):
                # Bounding box [minx, miny, maxx, maxy]
                from shapely.geometry import box
                return box(geom_data[0], geom_data[1], geom_data[2], geom_data[3])
        return None
