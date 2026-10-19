"""Confidence Calibration and Validation Status Decider.

Calibrates confidence scores against verified baseline signals, separates raw
model confidence from validation status, enforces strict rule gates (high model
confidence cannot override invalid geometry), and computes overall document quality grades.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from app.gis.qa.models import QAFinding, QASeverity, QualityGrade
from app.gis.spatial_understanding.models import (
    ConfidenceSignals,
    Entity,
    Relationship,
    ValidationStatus,
)


class ConfidenceCalibrator:
    """Calibrates confidence signals and enforces evidence-based validation status rules."""

    def __init__(
        self,
        verified_threshold: float = 0.85,
        candidate_threshold: float = 0.65,
        review_threshold: float = 0.40,
    ):
        self.verified_threshold = verified_threshold
        self.candidate_threshold = candidate_threshold
        self.review_threshold = review_threshold

    def calibrate_entity(
        self,
        entity: Entity,
        findings: List[QAFinding],
    ) -> ValidationStatus:
        """Determines final validation status for an entity, gating high confidence with QA findings."""
        entity_findings = [f for f in findings if entity.entity_id in f.entity_ids]

        has_critical = any(f.severity == QASeverity.CRITICAL for f in entity_findings)
        has_error = any(f.severity == QASeverity.ERROR for f in entity_findings)
        has_warning = any(f.severity == QASeverity.WARNING for f in entity_findings)

        # RULE GATE 1: Critical or Error findings strictly prohibit VERIFIED status
        if has_critical:
            return ValidationStatus.CONFLICTED
        if has_error:
            return ValidationStatus.REVIEW_REQUIRED

        # RULE GATE 2: Warnings require review unless confidence is exceptionally high
        if has_warning:
            return ValidationStatus.REVIEW_REQUIRED

        # RULE GATE 3: Evidence-based confidence thresholds
        conf = entity.confidence
        if conf >= self.verified_threshold:
            return ValidationStatus.VERIFIED
        elif conf >= self.candidate_threshold:
            return ValidationStatus.CANDIDATE
        elif conf >= self.review_threshold:
            return ValidationStatus.REVIEW_REQUIRED
        return ValidationStatus.UNRESOLVED

    def calibrate_relationship(
        self,
        relationship: Relationship,
        findings: List[QAFinding],
    ) -> ValidationStatus:
        """Determines final validation status for a relationship."""
        rel_entities = {relationship.source_entity_id, relationship.target_entity_id}
        rel_findings = [f for f in findings if any(eid in rel_entities for eid in f.entity_ids)]

        has_critical = any(f.severity == QASeverity.CRITICAL for f in rel_findings)
        has_error = any(f.severity == QASeverity.ERROR for f in rel_findings)

        if has_critical:
            return ValidationStatus.CONFLICTED
        if has_error:
            return ValidationStatus.REVIEW_REQUIRED

        score = relationship.confidence_signals.aggregate
        if score >= self.verified_threshold and len(relationship.evidence) >= 1:
            return ValidationStatus.VERIFIED
        elif score >= self.candidate_threshold:
            return ValidationStatus.CANDIDATE
        elif score >= self.review_threshold:
            return ValidationStatus.REVIEW_REQUIRED
        return ValidationStatus.UNRESOLVED

    def compute_quality_grade(
        self,
        findings: List[QAFinding],
        total_plots: int,
        verified_plots: int,
    ) -> QualityGrade:
        """Computes the overall machine-readable document quality grade."""
        critical_count = sum(1 for f in findings if f.severity == QASeverity.CRITICAL)
        error_count = sum(1 for f in findings if f.severity == QASeverity.ERROR)
        warning_count = sum(1 for f in findings if f.severity == QASeverity.WARNING)

        if critical_count > 0:
            return QualityGrade.F_REJECTED

        if total_plots > 0:
            verification_ratio = verified_plots / total_plots
            if error_count > 3 or verification_ratio < 0.40:
                return QualityGrade.D_UNRELIABLE
            elif error_count > 0 or verification_ratio < 0.70 or warning_count > 8:
                return QualityGrade.C_REVIEW_NEEDED
            elif warning_count > 0 or verification_ratio < 0.90:
                return QualityGrade.B_ACCEPTABLE
            else:
                return QualityGrade.A_VERIFIED
        else:
            if error_count > 3:
                return QualityGrade.D_UNRELIABLE
            elif error_count > 0 or warning_count > 5:
                return QualityGrade.C_REVIEW_NEEDED
            elif warning_count > 0:
                return QualityGrade.B_ACCEPTABLE
            else:
                return QualityGrade.A_VERIFIED
