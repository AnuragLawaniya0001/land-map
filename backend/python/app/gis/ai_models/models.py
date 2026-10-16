"""AI Models Core Types, Enums, and Schemas.

Defines the explicit lifecycle states, evidence outputs, and inference schemas
for all six mandatory AI model adapters:
1. PaddleOCR PP-OCRv5
2. Qwen2.5-VL
3. SegFormer
4. Mask2Former
5. SAM 2
6. Grounding DINO
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple


class ModelLifecycleStatus(str, Enum):
    CONFIGURED = "configured"
    WEIGHTS_MISSING = "weights_missing"
    DEPENDENCY_MISSING = "dependency_missing"
    LOADING = "loading"
    READY = "ready"
    INFERENCE_FAILED = "inference_failed"
    DISABLED_BY_CONFIGURATION = "disabled_by_configuration"


@dataclass
class ModelDiagnosticInfo:
    model_name: str
    role: str
    status: ModelLifecycleStatus
    selected_variant: str
    checkpoint_path: str
    config_path: Optional[str]
    missing_files: List[str]
    installed_dependencies: Dict[str, bool]
    assigned_device: str  # "cuda:0", "cpu", etc.
    weights_verified: bool
    diagnostic_message: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model_name": self.model_name,
            "role": self.role,
            "status": self.status.value,
            "selected_variant": self.selected_variant,
            "checkpoint_path": self.checkpoint_path,
            "config_path": self.config_path,
            "missing_files": self.missing_files,
            "installed_dependencies": self.installed_dependencies,
            "assigned_device": self.assigned_device,
            "weights_verified": self.weights_verified,
            "diagnostic_message": self.diagnostic_message,
        }


# -----------------------------------------------------------------------------
# Typed Inference Outputs
# -----------------------------------------------------------------------------

@dataclass
class OCRTextDetection:
    text: str
    confidence: float
    bbox_pixel: List[int]  # [x1, y1, x2, y2]
    bbox_page_pt: List[float]  # [x1, y1, x2, y2] in PDF points
    polygon_points: List[List[float]]  # Quad polygon in page points
    orientation_deg: float
    model_name: str = "PaddleOCR_PP-OCRv5"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "confidence": round(self.confidence, 4),
            "bbox_pixel": self.bbox_pixel,
            "bbox_page_pt": [round(v, 2) for v in self.bbox_page_pt],
            "polygon_points": [[round(x, 2), round(y, 2)] for x, y in self.polygon_points],
            "orientation_deg": self.orientation_deg,
            "model_name": self.model_name,
        }


@dataclass
class DetectionBoxProposal:
    category: str
    label: str
    confidence: float
    bbox_pixel: List[int]
    bbox_page_pt: List[float]
    model_name: str = "GroundingDINO"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "label": self.label,
            "confidence": round(self.confidence, 4),
            "bbox_pixel": self.bbox_pixel,
            "bbox_page_pt": [round(v, 2) for v in self.bbox_page_pt],
            "model_name": self.model_name,
        }


@dataclass
class SegmentationMaskProposal:
    proposal_id: str
    category: str  # "plot", "road", "park", "water", "amenity"
    confidence: float
    bbox_page_pt: List[float]
    polygon_geojson: Dict[str, Any]
    model_name: str  # "SegFormer" or "Mask2Former" or "SAM2"
    instance_id: Optional[int] = None
    quality_score: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "proposal_id": self.proposal_id,
            "category": self.category,
            "confidence": round(self.confidence, 4),
            "bbox_page_pt": [round(v, 2) for v in self.bbox_page_pt],
            "polygon_geojson": self.polygon_geojson,
            "model_name": self.model_name,
            "instance_id": self.instance_id,
            "quality_score": round(self.quality_score, 4) if self.quality_score is not None else None,
        }


@dataclass
class VLMInterpretationResult:
    layout_summary: str
    detected_plot_patterns: List[str]
    ambiguity_explanations: List[Dict[str, Any]]
    suggested_classifications: List[Dict[str, Any]]  # [{"region_bbox": [...], "suggested_type": "park", "rationale": "..."}]
    model_name: str = "Qwen2.5-VL"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "layout_summary": self.layout_summary,
            "detected_plot_patterns": self.detected_plot_patterns,
            "ambiguity_explanations": self.ambiguity_explanations,
            "suggested_classifications": self.suggested_classifications,
            "model_name": self.model_name,
        }
