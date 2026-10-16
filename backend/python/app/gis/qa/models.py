"""Phase 6 QA Data Structures, Finding Severities, and Report Models."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple, Union


class QASeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class RecoveryActionType(str, Enum):
    GEOMETRIC_REPAIR_BUFFER0 = "geometric_repair_buffer0"
    GEOMETRIC_REPAIR_MAKE_VALID = "geometric_repair_make_valid"
    SNAP_MICRO_GAPS = "snap_micro_gaps"
    HIGH_RES_RERENDER = "high_res_rerender"
    OCR_PREPROCESSING_CONTRAST = "ocr_preprocessing_contrast"
    OCR_PREPROCESSING_BINARIZE = "ocr_preprocessing_binarize"
    DIMENSION_REINSPECTION_RELAXED = "dimension_reinspection_relaxed"
    FLAG_REVIEW_REQUIRED = "flag_review_required"
    PRESERVE_CONFLICT_CANDIDATES = "preserve_conflict_candidates"
    MERGE_DUPLICATES = "merge_duplicates"
    NO_ACTION_POSSIBLE = "no_action_possible"


class QualityGrade(str, Enum):
    A_VERIFIED = "A_VERIFIED"         # No errors, all core geometry and labels verified
    B_ACCEPTABLE = "B_ACCEPTABLE"     # Minor warnings, geometry valid, few review items
    C_REVIEW_NEEDED = "C_REVIEW_NEEDED" # Noticeable ambiguities or scale discrepancies
    D_UNRELIABLE = "D_UNRELIABLE"     # Geometry invalid or severe contradictions
    F_REJECTED = "F_REJECTED"         # Critical geometric corruption or total extraction failure


@dataclass
class QAFinding:
    finding_id: str
    check_name: str
    severity: QASeverity
    message: str
    entity_ids: List[str] = field(default_factory=list)
    evidence: List[str] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)
    recommended_action: RecoveryActionType = RecoveryActionType.FLAG_REVIEW_REQUIRED
    recovered: bool = False
    recovery_details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "finding_id": self.finding_id,
            "check_name": self.check_name,
            "severity": self.severity.value,
            "message": self.message,
            "entity_ids": list(self.entity_ids),
            "evidence": list(self.evidence),
            "details": self.details,
            "recommended_action": self.recommended_action.value,
            "recovered": self.recovered,
            "recovery_details": self.recovery_details,
        }


@dataclass
class RecoveryRecord:
    action_type: RecoveryActionType
    target_entity_ids: List[str]
    success: bool
    description: str
    original_state: Dict[str, Any] = field(default_factory=dict)
    repaired_state: Dict[str, Any] = field(default_factory=dict)
    reason_for_selection: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action_type": self.action_type.value,
            "target_entity_ids": list(self.target_entity_ids),
            "success": self.success,
            "description": self.description,
            "original_state": self.original_state,
            "repaired_state": self.repaired_state,
            "reason_for_selection": self.reason_for_selection,
        }


@dataclass
class QuantitativeBenchmarkMetrics:
    mean_iou: Optional[float] = None
    min_iou: Optional[float] = None
    mean_hausdorff_distance_m: Optional[float] = None
    max_boundary_deviation_m: Optional[float] = None
    plot_id_precision: Optional[float] = None
    plot_id_recall: Optional[float] = None
    plot_id_f1: Optional[float] = None
    dimension_parsing_accuracy: Optional[float] = None
    target_association_precision: Optional[float] = None
    target_association_recall: Optional[float] = None
    unresolved_case_rate: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            k: (round(v, 4) if isinstance(v, float) else v)
            for k, v in self.__dict__.items()
            if v is not None
        }
