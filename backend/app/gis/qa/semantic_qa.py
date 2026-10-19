"""Semantic and Measurement Quality Assurance Module.

Validates dimension annotations, OCR text interpretations, unit certainty,
geometry-measurement scale consistency, multi-span block dimensions, and multi-source
evidence contradictions.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from app.gis.qa.models import QAFinding, QASeverity, RecoveryActionType
from app.gis.spatial_understanding.models import (
    CanonicalRelationship,
    EntityType,
    MeasurementType,
    SemanticDrawingGraph,
    ValidationStatus,
)


class SemanticQAChecker:
    """Quality assurance checker for semantic interpretations and dimension associations."""

    def __init__(
        self,
        scale_tolerance_ratio: float = 0.12,  # 12% tolerance between measurement text & geometry
        min_alignment_score: float = 0.65,
    ):
        self.scale_tolerance_ratio = scale_tolerance_ratio
        self.min_alignment_score = min_alignment_score

    def run_all_checks(
        self,
        graph: SemanticDrawingGraph,
        scale_ratio: Optional[float] = None,
    ) -> List[QAFinding]:
        """Runs all semantic and measurement QA checks on canonical relationships in the graph."""
        findings: List[QAFinding] = []

        for cr in graph.canonical_relationships:
            findings.extend(self.check_raw_vs_parsed(cr))
            findings.extend(self.check_unit_certainty(cr))
            findings.extend(self.check_measurement_category(cr))
            findings.extend(self.check_endpoint_and_alignment_evidence(cr, graph))
            findings.extend(self.check_geometry_measurement_consistency(cr, graph, scale_ratio))
            findings.extend(self.check_multi_feature_assignment(cr, graph))
            findings.extend(self.check_proximity_only_violations(cr))

        findings.extend(self.check_unresolved_and_conflicted_annotations(graph))
        return findings

    def check_raw_vs_parsed(self, cr: CanonicalRelationship) -> List[QAFinding]:
        """Validates that raw text is preserved and parsed numeric value is unambiguous."""
        findings = []
        if not cr.raw_text or not cr.raw_text.strip():
            findings.append(QAFinding(
                finding_id=f"sem_empty_text_{cr.entity_id}",
                check_name="raw_vs_parsed",
                severity=QASeverity.ERROR,
                message=f"Dimension annotation '{cr.entity_id}' has empty raw text",
                entity_ids=[cr.entity_id],
                evidence=["empty_raw_text"],
                recommended_action=RecoveryActionType.NO_ACTION_POSSIBLE,
            ))
        elif cr.parsed_value is None and cr.measurement_type != MeasurementType.UNKNOWN_MEASUREMENT.value:
            findings.append(QAFinding(
                finding_id=f"sem_unparsed_numeric_{cr.entity_id}",
                check_name="raw_vs_parsed",
                severity=QASeverity.WARNING,
                message=f"Dimension annotation '{cr.entity_id}' text '{cr.raw_text}' could not be parsed into a numeric value",
                entity_ids=[cr.entity_id],
                evidence=["numeric_parsing_failed"],
                details={"raw_text": cr.raw_text},
                recommended_action=RecoveryActionType.DIMENSION_REINSPECTION_RELAXED,
            ))
        return findings

    def check_unit_certainty(self, cr: CanonicalRelationship) -> List[QAFinding]:
        """Flags dimensions where the unit of measurement is ambiguous or uncertain."""
        findings = []
        if cr.parsed_value is not None and cr.unit is None:
            findings.append(QAFinding(
                finding_id=f"sem_unit_uncertain_{cr.entity_id}",
                check_name="unit_certainty",
                severity=QASeverity.WARNING,
                message=f"Dimension '{cr.raw_text}' has numeric value {cr.parsed_value} but unspecified unit (ambiguous bare notation)",
                entity_ids=[cr.entity_id],
                evidence=["bare_number_no_explicit_unit"],
                details={"raw_text": cr.raw_text, "parsed_value": cr.parsed_value},
                recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
            ))
        return findings

    def check_measurement_category(self, cr: CanonicalRelationship) -> List[QAFinding]:
        """Validates that measurement category is properly classified with evidence."""
        findings = []
        if cr.measurement_type == MeasurementType.UNKNOWN_MEASUREMENT.value:
            findings.append(QAFinding(
                finding_id=f"sem_unknown_category_{cr.entity_id}",
                check_name="measurement_category",
                severity=QASeverity.WARNING,
                message=f"Dimension '{cr.raw_text}' has unknown measurement category (insufficient evidence to classify frontage/depth/road width)",
                entity_ids=[cr.entity_id],
                evidence=["insufficient_classification_evidence"],
                details={"raw_text": cr.raw_text},
                recommended_action=RecoveryActionType.DIMENSION_REINSPECTION_RELAXED,
            ))
        return findings

    def check_endpoint_and_alignment_evidence(
        self,
        cr: CanonicalRelationship,
        graph: SemanticDrawingGraph,
    ) -> List[QAFinding]:
        """Validates geometric alignment, dimension line presence, and extension line evidence."""
        findings = []
        ev = set(cr.evidence)

        # Flag missing arrowheads without dropping valid annotation
        if "missing_arrowheads" in ev and cr.association_status == ValidationStatus.VERIFIED.value:
            findings.append(QAFinding(
                finding_id=f"sem_missing_arrow_{cr.entity_id}",
                check_name="dimension_mark_evidence",
                severity=QASeverity.INFO,
                message=f"Dimension '{cr.raw_text}' lacks explicit arrowheads/ticks at endpoints",
                entity_ids=[cr.entity_id],
                evidence=["missing_arrowheads"],
                recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
            ))

        # Flag missing extension lines
        if "missing_extension_lines" in ev and cr.association_status == ValidationStatus.VERIFIED.value:
            findings.append(QAFinding(
                finding_id=f"sem_missing_ext_{cr.entity_id}",
                check_name="dimension_mark_evidence",
                severity=QASeverity.INFO,
                message=f"Dimension '{cr.raw_text}' lacks explicit extension lines",
                entity_ids=[cr.entity_id],
                evidence=["missing_extension_lines"],
                recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
            ))
        return findings

    def check_geometry_measurement_consistency(
        self,
        cr: CanonicalRelationship,
        graph: SemanticDrawingGraph,
        scale_ratio: Optional[float] = None,
    ) -> List[QAFinding]:
        """Checks consistency between declared measurement value and candidate target geometry."""
        findings = []
        if not scale_ratio or cr.parsed_value is None or not cr.candidate_target_edges:
            return findings

        for edge_id in cr.candidate_target_edges:
            edge = graph.get_entity(edge_id)
            if not edge:
                continue

            geom_len = edge.properties.get("length", 0.0)
            expected_geom_len = cr.parsed_value * scale_ratio

            if expected_geom_len > 0:
                diff_ratio = abs(geom_len - expected_geom_len) / expected_geom_len
                if diff_ratio > self.scale_tolerance_ratio:
                    findings.append(QAFinding(
                        finding_id=f"sem_scale_mismatch_{cr.entity_id}_{edge_id}",
                        check_name="scale_geometry_consistency",
                        severity=QASeverity.WARNING if diff_ratio < 0.25 else QASeverity.ERROR,
                        message=f"Declared dimension '{cr.raw_text}' ({cr.parsed_value}) differs from drawing edge {edge_id} length ({geom_len:.2f}) by {diff_ratio*100:.1f}%",
                        entity_ids=[cr.entity_id, edge_id],
                        evidence=["geometric_scale_discrepancy_exceeds_tolerance"],
                        details={
                            "declared_value": cr.parsed_value,
                            "measured_geometry_length": round(geom_len, 3),
                            "scale_ratio": scale_ratio,
                            "discrepancy_ratio": round(diff_ratio, 4),
                        },
                        recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                    ))
        return findings

    def check_multi_feature_assignment(
        self,
        cr: CanonicalRelationship,
        graph: SemanticDrawingGraph,
    ) -> List[QAFinding]:
        """Validates that block-level or multi-plot dimensions reference multiple features correctly."""
        findings = []
        if cr.measurement_type == MeasurementType.BLOCK_LENGTH.value:
            if len(cr.candidate_target_features) < 2:
                findings.append(QAFinding(
                    finding_id=f"sem_invalid_block_span_{cr.entity_id}",
                    check_name="multi_feature_span",
                    severity=QASeverity.WARNING,
                    message=f"Dimension '{cr.raw_text}' is categorized as block_length but references only {len(cr.candidate_target_features)} plot(s)",
                    entity_ids=[cr.entity_id],
                    evidence=["block_length_with_fewer_than_2_plots"],
                    details={"candidate_features": cr.candidate_target_features},
                    recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                ))
        return findings

    def check_proximity_only_violations(self, cr: CanonicalRelationship) -> List[QAFinding]:
        """Asserts that dimensions are not verified solely by nearest centroid or proximity without alignment."""
        findings = []
        ev = set(cr.evidence)
        if cr.association_status == ValidationStatus.VERIFIED.value:
            has_alignment = "dimension_line_alignment" in ev or "road_width_keyword_match" in ev or "multi_plot_span" in ev or "area_unit_parsed" in ev
            if not has_alignment:
                findings.append(QAFinding(
                    finding_id=f"sem_proximity_only_{cr.entity_id}",
                    check_name="anti_proximity_only_rule",
                    severity=QASeverity.ERROR,
                    message=f"Dimension '{cr.raw_text}' was marked verified without alignment evidence (proximity-only violation)",
                    entity_ids=[cr.entity_id],
                    evidence=["missing_alignment_evidence"],
                    recommended_action=RecoveryActionType.FLAG_REVIEW_REQUIRED,
                ))
        return findings

    def check_unresolved_and_conflicted_annotations(
        self,
        graph: SemanticDrawingGraph,
    ) -> List[QAFinding]:
        """Summarizes unresolved, conflicted, and review-required canonical annotations."""
        findings = []
        for cr in graph.canonical_relationships:
            if cr.association_status == ValidationStatus.CONFLICTED.value:
                findings.append(QAFinding(
                    finding_id=f"sem_conflicted_status_{cr.entity_id}",
                    check_name="conflict_register",
                    severity=QASeverity.ERROR,
                    message=f"Dimension annotation '{cr.raw_text}' ({cr.entity_id}) has unresolved conflicting interpretations",
                    entity_ids=[cr.entity_id],
                    evidence=["association_status_conflicted"],
                    details={"candidates": cr.candidate_alternatives},
                    recommended_action=RecoveryActionType.PRESERVE_CONFLICT_CANDIDATES,
                ))
            elif cr.association_status == ValidationStatus.UNRESOLVED.value:
                findings.append(QAFinding(
                    finding_id=f"sem_unresolved_status_{cr.entity_id}",
                    check_name="unresolved_register",
                    severity=QASeverity.INFO,
                    message=f"Dimension annotation '{cr.raw_text}' ({cr.entity_id}) is unresolved",
                    entity_ids=[cr.entity_id],
                    evidence=["association_status_unresolved"],
                    recommended_action=RecoveryActionType.DIMENSION_REINSPECTION_RELAXED,
                ))
        return findings
