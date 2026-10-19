"""Topology Builder: Polygon Decomposition, Edge Generation, and Adjacency Graph.

Constructs explicit topological relationships between polygons, edges, plots, roads,
and boundaries using robust Shapely geometric operations.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple, Set

import numpy as np
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    shape,
)
from shapely.ops import nearest_points, unary_union

from app.gis.spatial_understanding.models import (
    AdjacencyType,
    ConfidenceSignals,
    Entity,
    EntityType,
    QAIssue,
    Relationship,
    RelationshipType,
    SemanticDrawingGraph,
    ValidationStatus,
)


def _edge_angle_deg(p1: Tuple[float, float], p2: Tuple[float, float]) -> float:
    """Returns orientation angle in degrees [0, 180)."""
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    angle = math.degrees(math.atan2(dy, dx)) % 180.0
    return round(angle, 2)


def _is_parallel(angle1: float, angle2: float, tolerance: float = 8.0) -> bool:
    diff = abs(angle1 - angle2) % 180.0
    return diff <= tolerance or diff >= (180.0 - tolerance)


def _is_perpendicular(angle1: float, angle2: float, tolerance: float = 8.0) -> bool:
    diff = abs(angle1 - angle2) % 180.0
    return abs(diff - 90.0) <= tolerance


class TopologyBuilder:
    """Builds topology and adjacency relationships for colony engineering drawings."""

    def __init__(self, tolerance: float = 0.08):
        self.tolerance = tolerance

    def build_topology(
        self,
        graph: SemanticDrawingGraph,
        boundary_entity_id: Optional[str] = None,
    ) -> None:
        """Decomposes polygons into edges, computes adjacencies and boundary containment."""
        self._decompose_polygons_into_edges(graph)
        self._compute_plot_adjacencies(graph)
        self._compute_plot_road_adjacencies(graph)
        self._compute_boundary_containment(graph, boundary_entity_id)

    def _decompose_polygons_into_edges(self, graph: SemanticDrawingGraph) -> None:
        """Decomposes every polygon into distinct Edge entities and creates edge_belongs_to_polygon."""
        edge_counter = 0

        # Features to decompose
        poly_types = {
            EntityType.PLOT,
            EntityType.ROAD,
            EntityType.PARK,
            EntityType.OPEN_SPACE,
            EntityType.BOUNDARY,
        }

        for ent_id, entity in list(graph.entities.items()):
            if entity.entity_type not in poly_types:
                continue

            geom = entity.geometry
            if not isinstance(geom, (Polygon, MultiPolygon)):
                continue

            polys = [geom] if isinstance(geom, Polygon) else list(geom.geoms)

            for p_idx, poly in enumerate(polys):
                coords = list(poly.exterior.coords)
                if len(coords) < 3:
                    continue

                for i in range(len(coords) - 1):
                    p1 = coords[i][:2]
                    p2 = coords[i + 1][:2]

                    # Skip zero-length edge segments
                    length = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
                    if length < 1e-5:
                        continue

                    edge_counter += 1
                    edge_id = f"edge_{ent_id}_{p_idx}_{i}"
                    angle = _edge_angle_deg(p1, p2)
                    midpoint = ((p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0)

                    edge_line = LineString([p1, p2])
                    edge_entity = Entity(
                        entity_id=edge_id,
                        entity_type=EntityType.EDGE,
                        geometry=edge_line,
                        properties={
                            "parent_feature_id": ent_id,
                            "parent_feature_type": entity.entity_type.value,
                            "start_point": list(p1),
                            "end_point": list(p2),
                            "length": round(length, 4),
                            "angle_deg": angle,
                            "midpoint": list(midpoint),
                            "is_shared": False,
                            "shared_with": [],
                            "is_road_frontage": False,
                        },
                        source_page=entity.source_page,
                        validation_status=ValidationStatus.VERIFIED,
                    )
                    graph.add_entity(edge_entity)

                    # Relationship: edge_belongs_to_polygon
                    rel = Relationship(
                        relationship_id=f"rel_edge_poly_{edge_id}_{ent_id}",
                        relationship_type=RelationshipType.EDGE_BELONGS_TO_POLYGON,
                        source_entity_id=edge_id,
                        target_entity_id=ent_id,
                        validation_status=ValidationStatus.VERIFIED,
                        evidence=["geometric_boundary_decomposition"],
                        properties={"edge_index": i, "length": length},
                    )
                    graph.add_relationship(rel)

    def _compute_plot_adjacencies(self, graph: SemanticDrawingGraph) -> None:
        """Finds which plots share boundaries or are in close proximity."""
        plots = [e for e in graph.entities.values() if e.entity_type == EntityType.PLOT]
        n_plots = len(plots)

        for i in range(n_plots):
            plot_a = plots[i]
            geom_a = plot_a.geometry
            if not isinstance(geom_a, (Polygon, MultiPolygon)):
                continue

            for j in range(i + 1, n_plots):
                plot_b = plots[j]
                geom_b = plot_b.geometry
                if not isinstance(geom_b, (Polygon, MultiPolygon)):
                    continue

                # Quick bounding box disjoint check
                if geom_a.bounds[2] < geom_b.bounds[0] - self.tolerance or \
                   geom_b.bounds[2] < geom_a.bounds[0] - self.tolerance or \
                   geom_a.bounds[3] < geom_b.bounds[1] - self.tolerance or \
                   geom_b.bounds[3] < geom_a.bounds[1] - self.tolerance:
                    continue

                # Compute intersection
                try:
                    inter = geom_a.intersection(geom_b)
                except Exception:
                    inter = GeometryCollection()

                shared_len = 0.0
                if not inter.is_empty:
                    if isinstance(inter, (LineString, MultiLineString)):
                        shared_len = inter.length
                    elif isinstance(inter, (Polygon, MultiPolygon)):
                        # If polygons slightly overlap, boundary length is significant
                        shared_len = inter.boundary.length / 2.0

                if shared_len > self.tolerance:
                    # Shared boundary adjacency
                    rel_id = f"adj_{plot_a.entity_id}_{plot_b.entity_id}"
                    signals = ConfidenceSignals(
                        text_recognition=1.0,
                        entity_classification=1.0,
                        label_to_feature=1.0,
                        dimension_to_edge=1.0,
                        geometry_validity=1.0,
                        geographic_alignment=1.0,
                    )
                    rel = Relationship(
                        relationship_id=rel_id,
                        relationship_type=RelationshipType.PLOT_ADJACENT_TO_PLOT,
                        source_entity_id=plot_a.entity_id,
                        target_entity_id=plot_b.entity_id,
                        validation_status=ValidationStatus.VERIFIED,
                        confidence_signals=signals,
                        evidence=["shared_boundary_polygon_intersection"],
                        properties={
                            "adjacency_type": AdjacencyType.SHARED_BOUNDARY.value,
                            "shared_length": round(shared_len, 4),
                        },
                    )
                    graph.add_relationship(rel)

                    # Also mark edges belonging to these plots as shared
                    self._mark_shared_edges(graph, plot_a.entity_id, plot_b.entity_id, inter)

                elif geom_a.distance(geom_b) <= self.tolerance:
                    # Hairline proximity adjacency
                    dist = geom_a.distance(geom_b)
                    rel_id = f"adj_prox_{plot_a.entity_id}_{plot_b.entity_id}"
                    signals = ConfidenceSignals(
                        text_recognition=1.0,
                        entity_classification=1.0,
                        label_to_feature=1.0,
                        dimension_to_edge=1.0,
                        geometry_validity=0.85,
                        geographic_alignment=1.0,
                    )
                    rel = Relationship(
                        relationship_id=rel_id,
                        relationship_type=RelationshipType.PLOT_ADJACENT_TO_PLOT,
                        source_entity_id=plot_a.entity_id,
                        target_entity_id=plot_b.entity_id,
                        validation_status=ValidationStatus.CANDIDATE,
                        confidence_signals=signals,
                        evidence=["hairline_geometric_proximity"],
                        properties={
                            "adjacency_type": AdjacencyType.PROXIMITY.value,
                            "gap_distance": round(dist, 4),
                        },
                    )
                    graph.add_relationship(rel)

    def _mark_shared_edges(
        self,
        graph: SemanticDrawingGraph,
        plot_a_id: str,
        plot_b_id: str,
        intersection_geom: Any,
    ) -> None:
        """Flags edge entities that lie on the shared boundary."""
        edges_a = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.EDGE and e.properties.get("parent_feature_id") == plot_a_id
        ]
        edges_b = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.EDGE and e.properties.get("parent_feature_id") == plot_b_id
        ]

        for ea in edges_a:
            for eb in edges_b:
                # Check if edges are close and collinear/parallel
                if ea.geometry.distance(eb.geometry) <= self.tolerance:
                    ang_a = ea.properties["angle_deg"]
                    ang_b = eb.properties["angle_deg"]
                    if _is_parallel(ang_a, ang_b, tolerance=10.0):
                        ea.properties["is_shared"] = True
                        if plot_b_id not in ea.properties["shared_with"]:
                            ea.properties["shared_with"].append(plot_b_id)
                        eb.properties["is_shared"] = True
                        if plot_a_id not in eb.properties["shared_with"]:
                            eb.properties["shared_with"].append(plot_a_id)

    def _compute_plot_road_adjacencies(self, graph: SemanticDrawingGraph) -> None:
        """Determines which plots are adjacent to roads and flags frontage edges."""
        plots = [e for e in graph.entities.values() if e.entity_type == EntityType.PLOT]
        roads = [e for e in graph.entities.values() if e.entity_type == EntityType.ROAD]

        if not roads:
            return

        for plot in plots:
            p_geom = plot.geometry
            if not isinstance(p_geom, (Polygon, MultiPolygon)):
                continue

            bordering_roads = []
            for road in roads:
                r_geom = road.geometry
                dist = p_geom.distance(r_geom)

                if dist <= (self.tolerance * 2.5):  # Road tolerance
                    try:
                        inter = p_geom.boundary.intersection(r_geom.buffer(self.tolerance * 2.5))
                        shared_len = inter.length if not inter.is_empty else 0.0
                    except Exception:
                        shared_len = 0.0

                    rel_id = f"road_adj_{plot.entity_id}_{road.entity_id}"
                    signals = ConfidenceSignals(
                        text_recognition=1.0,
                        entity_classification=1.0,
                        label_to_feature=1.0,
                        dimension_to_edge=1.0,
                        geometry_validity=1.0,
                        geographic_alignment=1.0,
                    )
                    rel = Relationship(
                        relationship_id=rel_id,
                        relationship_type=RelationshipType.PLOT_ADJACENT_TO_ROAD,
                        source_entity_id=plot.entity_id,
                        target_entity_id=road.entity_id,
                        validation_status=ValidationStatus.VERIFIED,
                        confidence_signals=signals,
                        evidence=["road_boundary_contact"],
                        properties={
                            "road_name": road.properties.get("name", ""),
                            "contact_length": round(shared_len, 4),
                        },
                    )
                    graph.add_relationship(rel)
                    bordering_roads.append(road.entity_id)

                    # Identify which edges of the plot face this road
                    plot_edges = [
                        e for e in graph.entities.values()
                        if e.entity_type == EntityType.EDGE and e.properties.get("parent_feature_id") == plot.entity_id
                    ]
                    for edge in plot_edges:
                        if edge.geometry.distance(r_geom) <= (self.tolerance * 2.5):
                            edge.properties["is_road_frontage"] = True
                            edge.properties["facing_road_id"] = road.entity_id

            if len(bordering_roads) > 1:
                plot.properties["is_corner_plot"] = True
            elif len(bordering_roads) == 1:
                plot.properties["is_corner_plot"] = False

    def _compute_boundary_containment(
        self,
        graph: SemanticDrawingGraph,
        boundary_entity_id: Optional[str] = None,
    ) -> None:
        """Determines whether plots, roads, and parks lie within the colony boundary."""
        boundary = None
        if boundary_entity_id:
            boundary = graph.get_entity(boundary_entity_id)
        if not boundary:
            boundaries = [e for e in graph.entities.values() if e.entity_type == EntityType.BOUNDARY]
            if boundaries:
                boundary = boundaries[0]

        if not boundary or not isinstance(boundary.geometry, (Polygon, MultiPolygon)):
            return

        b_geom = boundary.geometry

        features = [
            e for e in graph.entities.values()
            if e.entity_type in {EntityType.PLOT, EntityType.ROAD, EntityType.PARK, EntityType.OPEN_SPACE}
        ]

        for feat in features:
            f_geom = feat.geometry
            if not isinstance(f_geom, (Polygon, MultiPolygon, LineString)):
                continue

            try:
                if b_geom.covers(f_geom) or b_geom.contains(f_geom):
                    rel = Relationship(
                        relationship_id=f"inside_bdy_{feat.entity_id}",
                        relationship_type=RelationshipType.FEATURE_INSIDE_BOUNDARY,
                        source_entity_id=feat.entity_id,
                        target_entity_id=boundary.entity_id,
                        validation_status=ValidationStatus.VERIFIED,
                        evidence=["geometric_boundary_containment"],
                    )
                    graph.add_relationship(rel)
                else:
                    inter_area = b_geom.intersection(f_geom).area if hasattr(f_geom, "area") else 0
                    total_area = f_geom.area if hasattr(f_geom, "area") else 1.0
                    overlap_ratio = inter_area / total_area if total_area > 0 else 0

                    if overlap_ratio >= 0.90:
                        rel = Relationship(
                            relationship_id=f"inside_bdy_{feat.entity_id}",
                            relationship_type=RelationshipType.FEATURE_INSIDE_BOUNDARY,
                            source_entity_id=feat.entity_id,
                            target_entity_id=boundary.entity_id,
                            validation_status=ValidationStatus.VERIFIED,
                            evidence=["boundary_containment_above_90_percent"],
                            properties={"overlap_ratio": round(overlap_ratio, 3)},
                        )
                        graph.add_relationship(rel)
                    else:
                        # QA issue: feature outside or crossing boundary
                        issue = QAIssue(
                            issue_id=f"qa_outside_bdy_{feat.entity_id}",
                            issue_type="feature_outside_boundary",
                            severity="medium",
                            message=f"Feature {feat.entity_id} extends outside the site boundary (overlap: {overlap_ratio*100:.1f}%)",
                            entity_ids=[feat.entity_id, boundary.entity_id],
                            details={"overlap_ratio": overlap_ratio},
                        )
                        graph.add_qa_issue(issue)
            except Exception:
                pass
