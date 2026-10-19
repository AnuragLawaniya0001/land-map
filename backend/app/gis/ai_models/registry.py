"""Central AI Model Registry and Lifecycle Orchestrator.

Manages all six mandatory models:
1. PaddleOCR PP-OCRv5
2. Qwen2.5-VL
3. SegFormer
4. Mask2Former
5. SAM 2
6. Grounding DINO

Handles hardware capability detection, lazy loading, truthful diagnostics,
resource management, and strict-mode validation.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.gis.ai_models.grounding_dino import GroundingDINOAdapter
from app.gis.ai_models.manifest import MODEL_MANIFEST, get_default_models_dir
from app.gis.ai_models.mask2former import Mask2FormerAdapter
from app.gis.ai_models.models import ModelDiagnosticInfo, ModelLifecycleStatus
from app.gis.ai_models.paddle_ocr import PaddleOCRAdapter
from app.gis.ai_models.qwen_vlm import QwenVLMAdapter
from app.gis.ai_models.sam2 import SAM2Adapter
from app.gis.ai_models.segformer import SegFormerAdapter

logger = logging.getLogger("livemap.ai_models.registry")


class AIModelRegistry:
    """Central registry and lifecycle manager for all layout AI models."""

    _instance: Optional[AIModelRegistry] = None

    def __init__(
        self,
        base_models_dir: Optional[Path] = None,
        strict_mode: bool = False,
    ):
        self.base_models_dir = base_models_dir or get_default_models_dir()
        self.strict_mode = strict_mode
        self.device = self._detect_best_device()

        # Initialize adapters
        self.paddle_ocr = PaddleOCRAdapter(
            model_dir=self.base_models_dir / "paddleocr_v5",
            use_gpu=self.device.startswith("cuda"),
        )
        self.qwen_vlm = QwenVLMAdapter(
            model_dir=self.base_models_dir / "qwen2_5_vl_3b",
            device=self.device,
        )
        self.segformer = SegFormerAdapter(
            model_dir=self.base_models_dir / "segformer_b0",
            device=self.device,
        )
        self.mask2former = Mask2FormerAdapter(
            model_dir=self.base_models_dir / "mask2former_tiny",
            device=self.device,
        )
        self.sam2 = SAM2Adapter(
            checkpoint_path=self.base_models_dir / "sam2_hiera_small" / "sam2.1_hiera_small.pt",
            config_path=self.base_models_dir / "sam2_hiera_small" / "sam2.1_hiera_s.yaml",
            device=self.device,
        )
        self.grounding_dino = GroundingDINOAdapter(
            model_dir=self.base_models_dir / "grounding_dino_tiny",
            device=self.device,
        )

    @classmethod
    def get_instance(cls) -> AIModelRegistry:
        if cls._instance is None:
            strict = os.getenv("GIS_STRICT_MODEL_MODE", "false").lower() in ("true", "1")
            cls._instance = cls(strict_mode=strict)
        return cls._instance

    def _detect_best_device(self) -> str:
        """Detects available acceleration hardware (CUDA GPU vs CPU)."""
        try:
            import torch  # type: ignore
            if torch.cuda.is_available():
                device_name = torch.cuda.get_device_name(0)
                logger.info("CUDA GPU detected: %s", device_name)
                return "cuda:0"
        except Exception:
            pass
        return "cpu"

    def run_all_diagnostics(self) -> Dict[str, Any]:
        """Runs comprehensive diagnostics across all six models."""
        adapters = {
            "paddle_ocr_v5": self.paddle_ocr,
            "qwen_vlm": self.qwen_vlm,
            "segformer": self.segformer,
            "mask2former": self.mask2former,
            "sam2": self.sam2,
            "grounding_dino": self.grounding_dino,
        }

        diagnostics_map: Dict[str, Dict[str, Any]] = {}
        all_ready = True
        missing_count = 0

        for key, adapter in adapters.items():
            diag = adapter.get_diagnostics()
            diagnostics_map[key] = diag.to_dict()
            if diag.status != ModelLifecycleStatus.READY:
                all_ready = False
                if diag.status in (ModelLifecycleStatus.WEIGHTS_MISSING, ModelLifecycleStatus.DEPENDENCY_MISSING):
                    missing_count += 1

        return {
            "all_models_ready": all_ready,
            "strict_mode_enabled": self.strict_mode,
            "assigned_compute_device": self.device,
            "base_models_directory": str(self.base_models_dir),
            "models_count": len(adapters),
            "missing_or_unready_count": missing_count,
            "models": diagnostics_map,
        }

    def validate_strict_mode(self) -> None:
        """In strict mode, raises an error if any required model is unready."""
        if not self.strict_mode:
            return
        summary = self.run_all_diagnostics()
        if not summary["all_models_ready"]:
            unready = [k for k, v in summary["models"].items() if v["status"] != "ready"]
            raise RuntimeError(
                f"Strict mode violation: The following required models are not ready: {unready}. "
                "Download the required weights or disable strict mode."
            )
