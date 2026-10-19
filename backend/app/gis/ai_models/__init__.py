"""AI Models Package: Multi-Model Inference, Adapters, and Central Registry."""

from app.gis.ai_models.grounding_dino import GroundingDINOAdapter
from app.gis.ai_models.manifest import MODEL_MANIFEST, get_default_models_dir
from app.gis.ai_models.mask2former import Mask2FormerAdapter
from app.gis.ai_models.models import (
    DetectionBoxProposal,
    ModelDiagnosticInfo,
    ModelLifecycleStatus,
    OCRTextDetection,
    SegmentationMaskProposal,
    VLMInterpretationResult,
)
from app.gis.ai_models.paddle_ocr import PaddleOCRAdapter
from app.gis.ai_models.qwen_vlm import QwenVLMAdapter
from app.gis.ai_models.registry import AIModelRegistry
from app.gis.ai_models.sam2 import SAM2Adapter
from app.gis.ai_models.segformer import SegFormerAdapter

__all__ = [
    "AIModelRegistry",
    "DetectionBoxProposal",
    "GroundingDINOAdapter",
    "MODEL_MANIFEST",
    "Mask2FormerAdapter",
    "ModelDiagnosticInfo",
    "ModelLifecycleStatus",
    "OCRTextDetection",
    "PaddleOCRAdapter",
    "QwenVLMAdapter",
    "SAM2Adapter",
    "SegFormerAdapter",
    "SegmentationMaskProposal",
    "VLMInterpretationResult",
    "get_default_models_dir",
]
