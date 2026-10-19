"""Plot and Feature Label Associator.

Associates text labels with plots and drawing features using multi-criteria evidence:
point containment, bounding box overlap, clearance, sequence continuity, orientation,
and OCR/native PDF quality. Preserves candidate alternatives and review-required states
without forced decisions or sequence-gap renumbering.
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple

from shapely.geometry import Point, Polygon, MultiPolygon, box

from app.gis.spatial_understanding.models import (
    ConfidenceSignals,
    Entity,
    EntityType,
    QAIssue,
    Relationship,
    RelationshipType,
    SemanticDrawingGraph,
    ValidationStatus,
)
from app.gis.spatial_understanding.unit_parser import (
    PLOT_LABEL_RE,
    ROAD_LABEL_RE,
    parse_measurement_text,
)

LEGEND_TITLE_WORDS = re.compile(
    r"\b(legend|title|scale|north|drawing|sheet|architect|engineer|approved|plan|"
    r"zone|sector|block|colony|layout|drg|rev|date|client|project)\b",
    re.I,
)

PARK_WORDS = re.compile(
    r"\b(park|garden|green|lawn|open\s*space|amenity|play|club|temple|pond)\b",
    re.I,
)


def _extract_sequence_number(text: str) -> Optional[Tuple[str, int]]:
    """Extracts alphanumeric prefix and numeric sequence number (e.g. 'P-12' -> ('P', 12))."""
    m = re.search(r"([A-Za-z]*)[-_/\s]*(\d+)", text)
    if m:
        prefix = m.group(1).upper()
        num = int(m.group(2))
        return (prefix, num)
    return None


class LabelAssociator:
    """Associates text labels to plots and colony features."""

    def __init__(self, search_radius: float = 25.0):
        self.search_radius = search_radius

    def associate_labels(self, graph: SemanticDrawingGraph) -> None:
        """Finds all text label entities and associates them to features."""
        text_labels = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.TEXT_LABEL
        ]
        plots = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.PLOT
        ]
        roads = [
            e for e in graph.entities.values()
            if e.entity_type == EntityType.ROAD
        ]

        for label in text_labels:
            raw_text = label.properties.get("text", "").strip()
            if not raw_text:
                continue

            # 1. Filter out Legend / Title Block labels
            if LEGEND_TITLE_WORDS.search(raw_text) and not PLOT_LABEL_RE.match(raw_text):
                label.properties["label_category"] = "legend_or_title"
                continue

            # 2. Filter out Road labels
            if ROAD_LABEL_RE.search(raw_text) or "wide" in raw_text.lower():
                self._associate_road_label(graph, label, roads)
                continue

            # 3. Filter out Dimension measurements
            parsed = parse_measurement_text(raw_text)
            if parsed.is_valid_measurement and not parsed.is_plot_label:
                # This is a dimension, not a plot label
                label.properties["label_category"] = "dimension"
                continue

            # 4. Check for Park / Green labels
            if PARK_WORDS.search(raw_text):
                self._associate_park_label(graph, label)
                continue

            # 5. Evaluate as Plot Label
            self._evaluate_plot_label(graph, label, plots)

    def _associate_road_label(
        self,
        graph: SemanticDrawingGraph,
        label: Entity,
        roads: List[Entity],
    ) -> None:
        """Associates road text labels with the corresponding Road entity."""
        pt = self._label_center(label)
        if not pt or not roads:
            return

        label.properties["label_category"] = "road"
        best_road = None
        min_dist = float("inf")

        for road in roads:
            dist = road.geometry.distance(pt)
            if dist < min_dist:
                min_dist = dist
                best_road = road

        if best_road and min_dist <= self.search_radius:
            rel = Relationship(
                relationship_id=f"rel_road_label_{label.entity_id}_{best_road.entity_id}",
                relationship_type=RelationshipType.LABEL_BELONGS_TO_FEATURE,
                source_entity_id=label.entity_id,
                target_entity_id=best_road.entity_id,
                validation_status=ValidationStatus.VERIFIED if min_dist < 5.0 else ValidationStatus.CANDIDATE,
                evidence=["road_text_proximity", "keyword_match"],
                properties={"distance": round(min_dist, 3)},
            )
            graph.add_relationship(rel)

    def _associate_park_label(self, graph: SemanticDrawingGraph, label: Entity) -> None:
        """Associates park text labels with Park or OpenSpace entities."""
        pt = self._label_center(label)
        if not pt:
            return

        label.properties["label_category"] = "park"
        parks = [
            e for e in graph.entities.values()
            if e.entity_type in {EntityType.PARK, EntityType.OPEN_SPACE}
        ]
        for park in parks:
            if park.geometry.contains(pt) or park.geometry.distance(pt) < 5.0:
                rel = Relationship(
                    relationship_id=f"rel_park_label_{label.entity_id}_{park.entity_id}",
                    relationship_type=RelationshipType.LABEL_BELONGS_TO_FEATURE,
                    source_entity_id=label.entity_id,
                    target_entity_id=park.entity_id,
                    validation_status=ValidationStatus.VERIFIED,
                    evidence=["park_containment"],
                )
                graph.add_relationship(rel)
                break

    def _evaluate_plot_label(
        self,
        graph: SemanticDrawingGraph,
        label: Entity,
        plots: List[Entity],
    ) -> None:
        """Evaluates plot label candidates using multi-criteria scoring."""
        pt = self._label_center(label)
        label_bbox = self._label_box(label)
        raw_text = label.properties.get("text", "")
        seq_tuple = _extract_sequence_number(raw_text)

        source_type = label.properties.get("source", "native_pdf")
        text_conf = 1.0 if source_type == "native_pdf" else label.properties.get("confidence", 0.8)

        candidate_evaluations: List[Dict[str, Any]] = []

        for plot in plots:
            p_geom = plot.geometry
            if not isinstance(p_geom, (Polygon, MultiPolygon)):
                continue

            dist_to_poly = p_geom.distance(pt)
            if dist_to_poly > self.search_radius:
                continue

            # 1. Point in Polygon containment
            is_inside = p_geom.contains(pt) or p_geom.covers(pt)

            # 2. Text Bounding Box overlap
            overlap_ratio = 0.0
            if label_bbox and p_geom.intersects(label_bbox):
                try:
                    inter_area = p_geom.intersection(label_bbox).area
                    overlap_ratio = inter_area / label_bbox.area if label_bbox.area > 0 else 0.0
                except Exception:
                    overlap_ratio = 1.0 if is_inside else 0.0
            elif is_inside:
                overlap_ratio = 1.0

            # 3. Clearance to boundary (distance to exterior boundary)
            clearance = p_geom.boundary.distance(pt) if is_inside else 0.0
            # Normalize clearance by polygon characteristic scale
            poly_dim = math.sqrt(max(p_geom.area, 1.0))
            norm_clearance = min(clearance / (poly_dim * 0.5 + 1e-5), 1.0)

            # 4. Distance to representative point / centroid
            rep_pt = p_geom.representative_point()
            dist_to_rep = rep_pt.distance(pt)
            norm_dist = max(0.0, 1.0 - (dist_to_rep / self.search_radius))

            # 5. Sequence consistency bonus
            seq_bonus = self._check_sequence_consistency(graph, plot.entity_id, seq_tuple)

            # Composite Score calculation
            if is_inside:
                score = 0.50 + (0.25 * overlap_ratio) + (0.10 * norm_clearance) + (0.15 * seq_bonus)
            else:
                score = (0.35 * overlap_ratio) + (0.35 * norm_dist) + (0.20 * seq_bonus)

            score *= text_conf

            evidence_items = []
            if is_inside:
                evidence_items.append("point_in_polygon_containment")
            if overlap_ratio > 0.8:
                evidence_items.append("full_bbox_overlap")
            elif overlap_ratio > 0.2:
                evidence_items.append("partial_bbox_overlap")
            if seq_bonus > 0.5:
                evidence_items.append("neighboring_sequence_continuity")
            if not is_inside:
                evidence_items.append("label_outside_polygon")

            candidate_evaluations.append({
                "plot_id": plot.entity_id,
                "score": round(score, 3),
                "is_inside": is_inside,
                "overlap_ratio": round(overlap_ratio, 3),
                "distance": round(dist_to_poly, 3),
                "clearance": round(clearance, 3),
                "sequence_bonus": round(seq_bonus, 3),
                "evidence": evidence_items,
            })

        if not candidate_evaluations:
            # Unresolved label
            label.validation_status = ValidationStatus.UNRESOLVED
            graph.add_qa_issue(QAIssue(
                issue_id=f"qa_unresolved_label_{label.entity_id}",
                issue_type="unresolved_label",
                severity="low",
                message=f"Text label '{raw_text}' is not near any plot polygon",
                entity_ids=[label.entity_id],
            ))
            return

        # Sort candidates descending by score
        candidate_evaluations.sort(key=lambda c: c["score"], reverse=True)
        top = candidate_evaluations[0]

        # Check for ambiguity
        is_ambiguous = False
        second = candidate_evaluations[1] if len(candidate_evaluations) > 1 else None

        if second:
            score_diff = top["score"] - second["score"]
            bbox_straddles = top["overlap_ratio"] >= 0.20 and second["overlap_ratio"] >= 0.20
            close_score = score_diff < 0.25 and second["score"] >= 0.40
            if bbox_straddles or close_score:
                is_ambiguous = True

        # Validation status decision
        if is_ambiguous:
            status = ValidationStatus.REVIEW_REQUIRED
            graph.add_qa_issue(QAIssue(
                issue_id=f"qa_ambiguous_label_{label.entity_id}",
                issue_type="ambiguous_plot_label",
                severity="medium",
                message=f"Label '{raw_text}' is ambiguous between {top['plot_id']} (score {top['score']}) and {second['plot_id']} (score {second['score']})",
                entity_ids=[label.entity_id, top["plot_id"], second["plot_id"]],
                details={"candidates": candidate_evaluations[:3]},
            ))
        elif not top["is_inside"]:
            # Label is outside its polygon
            status = ValidationStatus.REVIEW_REQUIRED
            graph.add_qa_issue(QAIssue(
                issue_id=f"qa_label_outside_{label.entity_id}",
                issue_type="label_outside_polygon",
                severity="low",
                message=f"Label '{raw_text}' is placed outside polygon {top['plot_id']} (distance {top['distance']})",
                entity_ids=[label.entity_id, top["plot_id"]],
                details={"distance": top["distance"]},
            ))
        elif top["score"] >= 0.70:
            status = ValidationStatus.VERIFIED
        else:
            status = ValidationStatus.CANDIDATE

        # Create relationship
        signals = ConfidenceSignals(
            text_recognition=text_conf,
            entity_classification=0.95,
            label_to_feature=top["score"],
            dimension_to_edge=1.0,
            geometry_validity=1.0,
            geographic_alignment=1.0,
        )

        rel = Relationship(
            relationship_id=f"rel_label_{label.entity_id}_{top['plot_id']}",
            relationship_type=RelationshipType.LABEL_BELONGS_TO_FEATURE,
            source_entity_id=label.entity_id,
            target_entity_id=top["plot_id"],
            validation_status=status,
            confidence_signals=signals,
            evidence=top["evidence"],
            candidate_alternatives=candidate_evaluations,
            properties={"plot_number": raw_text, "score": top["score"]},
        )
        graph.add_relationship(rel)

        # Update plot properties
        target_plot = graph.get_entity(top["plot_id"])
        if target_plot:
            if status == ValidationStatus.VERIFIED:
                target_plot.properties["plot_number"] = raw_text
                target_plot.properties["label_id"] = label.entity_id
            elif "plot_number" not in target_plot.properties:
                target_plot.properties["candidate_plot_number"] = raw_text

    def _check_sequence_consistency(
        self,
        graph: SemanticDrawingGraph,
        plot_id: str,
        seq_tuple: Optional[Tuple[str, int]],
    ) -> float:
        """Checks if neighboring plots have sequential numbers. NEVER renumbers missing plots."""
        if not seq_tuple:
            return 0.5  # Neutral

        target_prefix, target_num = seq_tuple

        # Find adjacent plots
        adj_rels = graph.find_relationships(
            rel_type=RelationshipType.PLOT_ADJACENT_TO_PLOT,
            source_id=plot_id,
        ) + graph.find_relationships(
            rel_type=RelationshipType.PLOT_ADJACENT_TO_PLOT,
            target_id=plot_id,
        )

        neighbor_ids = set()
        for rel in adj_rels:
            nid = rel.target_entity_id if rel.source_entity_id == plot_id else rel.source_entity_id
            neighbor_ids.add(nid)

        if not neighbor_ids:
            return 0.5

        matches = 0
        total_neighbors_with_labels = 0

        for nid in neighbor_ids:
            neighbor = graph.get_entity(nid)
            if not neighbor:
                continue
            num_str = neighbor.properties.get("plot_number") or neighbor.properties.get("candidate_plot_number")
            if not num_str:
                continue
            n_seq = _extract_sequence_number(str(num_str))
            if n_seq:
                total_neighbors_with_labels += 1
                n_prefix, n_num = n_seq
                if n_prefix == target_prefix and abs(n_num - target_num) in (1, 2):
                    matches += 1

        if total_neighbors_with_labels > 0:
            if matches > 0:
                return 1.0  # Strong sequence support
            return 0.2  # Out of sequence with neighbors
        return 0.5

    def _label_center(self, label: Entity) -> Optional[Point]:
        geom = label.geometry
        if isinstance(geom, Point):
            return geom
        coords = label.properties.get("coordinates")
        if coords and len(coords) >= 2:
            return Point(coords[0], coords[1])
        bbox = label.properties.get("bbox")
        if bbox and len(bbox) >= 4:
            return Point((bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0)
        return None

    def _label_box(self, label: Entity) -> Optional[Polygon]:
        bbox = label.properties.get("bbox")
        if bbox and len(bbox) >= 4:
            return box(bbox[0], bbox[1], bbox[2], bbox[3])
        pt = self._label_center(label)
        if pt:
            # Approximate small 1x1 bbox around center
            return box(pt.x - 0.5, pt.y - 0.5, pt.x + 0.5, pt.y + 0.5)
        return None
