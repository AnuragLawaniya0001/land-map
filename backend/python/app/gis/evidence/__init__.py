"""Evidence Schema and Multi-Model Fusion Package."""

from app.gis.evidence.fusion import MultiModelEvidenceFusionEngine
from app.gis.evidence.schema import (
    CoordinateSpaceEnum,
    EvidenceItem,
    EvidenceSourceType,
    FusedCandidateRegion,
    StageExecutionStatus,
    UnifiedEvidenceCollection,
)

__all__ = [
    "CoordinateSpaceEnum",
    "EvidenceItem",
    "EvidenceSourceType",
    "FusedCandidateRegion",
    "MultiModelEvidenceFusionEngine",
    "StageExecutionStatus",
    "UnifiedEvidenceCollection",
]
