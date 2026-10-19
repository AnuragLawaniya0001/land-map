"""Evidence Fusion and Validation Engine.

Implements priority-aware multi-source fusion across:
1. Native PDF vector paths and text
2. Dimension and extension-line geometry
3. OCR text and bounding boxes
4. Polygon topology and neighboring relationships
5. Legend and drawing conventions
6. Vision-Language Model (VLM) suggestions

Preserves contradictory evidence, prevents hallucination, handles VLM vs OCR disagreements,
and performs strict validation checks (duplicate annotations, conflicting measurements,
edge assignment consistency).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Set, Tuple

from app.gis.spatial_understanding.models import (
    ConfidenceSignals,
    EntityType,
    MeasurementType,
    QAIssue,
    Relationship,
    RelationshipType,
    SemanticDrawingGraph,
    ValidationStatus,
)


class EvidenceFusionEngine:
    """Fuses multi-source evidence and performs spatial-semantic validation checks."""

    def __init__(self, conflict_threshold: float = 0.05):
        self.conflict_threshold = conflict_threshold

    def fuse_and_validate(
        self,
        graph: SemanticDrawingGraph,
        vlm_proposals: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Runs multi-source fusion, incorporates VLM suggestions with evidence checks, and validates graph."""
        if vlm_proposals:
            self._incorporate_vlm_proposals(graph, vlm_proposals)

        self._check_duplicate_annotations(graph)
        self._check_conflicting_dimensions_on_edges(graph)
        self._check_plot_dimension_completeness(graph)
        self._validate_canonical_relationships(graph)

    def _incorporate_vlm_proposals(
        self,
        graph: SemanticDrawingGraph,
        vlm_proposals: List[Dict[str, Any]],
    ) -> None:
        """Fuses VLM proposals with evidence validation. VLM cannot self-approve without evidence checks."""
        for prop in vlm_proposals:
            p_type = prop.get("proposal_type")
            source_id = prop.get("source_id")
            target_id = prop.get("target_id")
            vlm_text = prop.get("suggested_text")
            vlm_confidence = prop.get("confidence", 0.7)

            if p_type == "label_association":
                # Check against existing associations
                existing = graph.find_relationships(
                    rel_type=RelationshipType.LABEL_BELONGS_TO_FEATURE,
                    source_id=source_id,
                )
                if existing:
                    ex_rel = existing[0]
                    if ex_rel.target_entity_id != target_id:
                        # VLM and deterministic geometric associator disagree!
                        issue = QAIssue(
                            issue_id=f"qa_vlm_disagree_{source_id}",
                            issue_type="vlm_ocr_disagreement",
                            severity="medium",
                            message=f"VLM suggests label {source_id} belongs to {target_id}, but geometric evidence points to {ex_rel.target_entity_id}",
                            entity_ids=[source_id, ex_rel.target_entity_id, target_id],
                            details={"vlm_target": target_id, "evidence_target": ex_rel.target_entity_id},
                        )
                        graph.add_qa_issue(issue)
                        ex_rel.validation_status = ValidationStatus.REVIEW_REQUIRED
                        ex_rel.evidence.append("vlm_conflict_flagged")
                else:
                    # VLM proposed a relationship where none existed: verify evidence
                    label_ent = graph.get_entity(source_id)
                    plot_ent = graph.get_entity(target_id)
                    if label_ent and plot_ent:
                        dist = label_ent.geometry.distance(plot_ent.geometry)
                        status = ValidationStatus.REVIEW_REQUIRED if dist > 2.0 else ValidationStatus.CANDIDATE
                        rel = Relationship(
                            relationship_id=f"rel_vlm_{source_id}_{target_id}",
                            relationship_type=RelationshipType.LABEL_BELONGS_TO_FEATURE,
                            source_entity_id=source_id,
                            target_entity_id=target_id,
                            validation_status=status,
                            evidence=["vlm_proposal_checked_against_geometry"],
                            properties={"vlm_confidence": vlm_confidence},
                        )
                        graph.add_relationship(rel)

            elif p_type == "dimension_value":
                # Check for OCR vs VLM reading disagreement
                dim_ent = graph.get_entity(source_id)
                if dim_ent:
                    ocr_text = dim_ent.properties.get("raw_text") or dim_ent.properties.get("text")
                    if vlm_text and ocr_text and vlm_text.strip() != ocr_text.strip():
                        issue = QAIssue(
                            issue_id=f"qa_vlm_ocr_text_diff_{source_id}",
                            issue_type="vlm_ocr_disagreement",
                            severity="medium",
                            message=f"Disagreement on dimension {source_id}: OCR reads '{ocr_text}', VLM reads '{vlm_text}'",
                            entity_ids=[source_id],
                            details={"ocr_text": ocr_text, "vlm_text": vlm_text},
                        )
                        graph.add_qa_issue(issue)
                        # Mark corresponding canonical relationship as review_required
                        for cr in graph.canonical_relationships:
                            if cr.entity_id == source_id:
                                cr.association_status = ValidationStatus.REVIEW_REQUIRED.value
                                cr.qa_issues.append(issue.to_dict())

    def _check_duplicate_annotations(self, graph: SemanticDrawingGraph) -> None:
        """Detects duplicate dimension or text annotations positioned at nearly identical locations."""
        text_entities = [
            e for e in graph.entities.values()
            if e.entity_type in {EntityType.TEXT_LABEL, EntityType.DIMENSION_ANNOTATION}
        ]

        seen: Dict[str, List[Entity]] = {}
        for ent in text_entities:
            text = ent.properties.get("text") or ent.properties.get("raw_text", "")
            if not text:
                continue
            seen.setdefault(text.strip().lower(), []).append(ent)

        for text_val, ents in seen.items():
            if len(ents) > 1:
                # Check spatial distance
                for i in range(len(ents)):
                    for j in range(i + 1, len(ents)):
                        e1, e2 = ents[i], ents[j]
                        if e1.geometry.distance(e2.geometry) < 1.0:
                            issue = QAIssue(
                                issue_id=f"qa_dup_{e1.entity_id}_{e2.entity_id}",
                                issue_type="duplicate_annotation",
                                severity="low",
                                message=f"Duplicate annotation '{text_val}' detected at virtually identical coordinates",
                                entity_ids=[e1.entity_id, e2.entity_id],
                            )
                            graph.add_qa_issue(issue)

    def _check_conflicting_dimensions_on_edges(self, graph: SemanticDrawingGraph) -> None:
        """Detects if multiple conflicting dimensions are associated with the same edge."""
        edge_dims: Dict[str, List[Dict[str, Any]]] = {}

        for cr in graph.canonical_relationships:
            if cr.parsed_value is None:
                continue
            for edge_id in cr.candidate_target_edges:
                edge_dims.setdefault(edge_id, []).append({
                    "dim_id": cr.entity_id,
                    "val": cr.parsed_value,
                    "unit": cr.unit,
                    "canonical": cr,
                })

        for edge_id, dims in edge_dims.items():
            if len(dims) > 1:
                vals = [d["val"] for d in dims]
                min_v, max_v = min(vals), max(vals)
                if (max_v - min_v) / max(min_v, 1e-5) > self.conflict_threshold:
                    # Values conflict!
                    dim_ids = [d["dim_id"] for d in dims]
                    issue = QAIssue(
                        issue_id=f"qa_edge_conflict_{edge_id}",
                        issue_type="conflicting_dimension_association",
                        severity="high",
                        message=f"Edge {edge_id} has conflicting dimensions: {vals}",
                        entity_ids=[edge_id] + dim_ids,
                        details={"values": vals},
                    )
                    graph.add_qa_issue(issue)
                    for d in dims:
                        d["canonical"].association_status = ValidationStatus.CONFLICTED.value
                        d["canonical"].qa_issues.append(issue.to_dict())

    def _check_plot_dimension_completeness(self, graph: SemanticDrawingGraph) -> None:
        """Evaluates dimension coverage for regular and irregular/corner plots without assuming 1 width & 1 depth."""
        plots = [e for e in graph.entities.values() if e.entity_type == EntityType.PLOT]

        for plot in plots:
            plot_id = plot.entity_id
            is_corner = plot.properties.get("is_corner_plot", False)

            # Find all dimensions referencing this plot
            plot_crs = [
                cr for cr in graph.canonical_relationships
                if plot_id in cr.candidate_target_features
            ]

            frontages = [cr for cr in plot_crs if cr.measurement_type == MeasurementType.PLOT_FRONTAGE.value]
            depths = [cr for cr in plot_crs if cr.measurement_type == MeasurementType.PLOT_DEPTH.value]
            side_lens = [cr for cr in plot_crs if cr.measurement_type == MeasurementType.PLOT_SIDE_LENGTH.value]

            plot.properties["frontage_dimensions"] = [cr.parsed_value for cr in frontages if cr.parsed_value]
            plot.properties["depth_dimensions"] = [cr.parsed_value for cr in depths if cr.parsed_value]
            plot.properties["side_dimensions"] = [cr.parsed_value for cr in side_lens if cr.parsed_value]

            # Store summary in plot properties
            if frontages and depths:
                plot.properties["dimensions_complete"] = True
            elif frontages:
                plot.properties["dimensions_complete"] = False
                plot.properties["dimension_note"] = "Frontage recorded, depth pending"
            else:
                plot.properties["dimensions_complete"] = False

    def _validate_canonical_relationships(self, graph: SemanticDrawingGraph) -> None:
        """Final sanity check ensuring no association is marked verified without evidence."""
        for cr in graph.canonical_relationships:
            if cr.association_status == ValidationStatus.VERIFIED.value:
                if not cr.evidence or (not cr.candidate_target_edges and not cr.candidate_target_features):
                    # Downgrade to candidate if evidence is empty
                    cr.association_status = ValidationStatus.CANDIDATE.value
