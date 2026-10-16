"""Grounding DINO Open-Vocabulary Detection Adapter.

Conditioned on natural language prompts to propose candidate regions across colony plans:
- "plot number", "road label", "park", "community facility",
- "building footprint", "water body", "layout region"
Proposals guide targeted crops for high-precision OCR and prompts for SAM 2 refinement.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from app.gis.ai_models.models import (
    DetectionBoxProposal,
    ModelDiagnosticInfo,
    ModelLifecycleStatus,
)
from app.gis.ingestion.coordinates import PageCoordinateTransform

logger = logging.getLogger("livemap.ai_models.grounding_dino")

DEFAULT_PROMPTS = [
    "rectangular parcel",
    "plot boundary",
    "road corridor",
    "plot number text",
    "open space",
    "green area",
]

# CPU timeout for Grounding DINO to avoid GIL lockup stalling the server
_DINO_CPU_TIMEOUT_SEC = 20


class GroundingDINOAdapter:
    """Grounding DINO open-vocabulary detection adapter."""

    def __init__(
        self,
        model_dir: Optional[Path] = None,
        variant_name: str = "IDEA-Research/grounding-dino-tiny",
        device: str = "cpu",
        box_threshold: float = 0.20,   # Lowered for technical cadastral drawings
        text_threshold: float = 0.20,
        cpu_timeout_sec: int = _DINO_CPU_TIMEOUT_SEC,
    ):
        self.model_dir = model_dir
        self.variant_name = variant_name
        self.device = device
        self.box_threshold = box_threshold
        self.text_threshold = text_threshold
        self.cpu_timeout_sec = cpu_timeout_sec
        self._model = None
        self._processor = None
        self._status = ModelLifecycleStatus.CONFIGURED

    def get_diagnostics(self) -> ModelDiagnosticInfo:
        deps = {}
        try:
            import transformers  # type: ignore
            deps["transformers"] = True
        except ImportError:
            deps["transformers"] = False

        try:
            import torch  # type: ignore
            deps["torch"] = True
        except ImportError:
            deps["torch"] = False

        missing_deps = [pkg for pkg, present in deps.items() if not present]
        if missing_deps:
            return ModelDiagnosticInfo(
                model_name="GroundingDINO",
                role="Open-Vocabulary Object Detection",
                status=ModelLifecycleStatus.DEPENDENCY_MISSING,
                selected_variant=self.variant_name,
                checkpoint_path=str(self.model_dir or "huggingface_hub"),
                config_path=None,
                missing_files=[],
                installed_dependencies=deps,
                assigned_device=self.device,
                weights_verified=False,
                diagnostic_message=f"Missing dependencies: {missing_deps}. Install via `pip install transformers torch`.",
            )

        missing_files = []
        if self.model_dir:
            if not self.model_dir.exists():
                missing_files.append(str(self.model_dir))
            else:
                cfg = self.model_dir / "config.json"
                if not cfg.exists():
                    missing_files.append(str(cfg))

        if missing_files:
            return ModelDiagnosticInfo(
                model_name="GroundingDINO",
                role="Open-Vocabulary Object Detection",
                status=ModelLifecycleStatus.WEIGHTS_MISSING,
                selected_variant=self.variant_name,
                checkpoint_path=str(self.model_dir),
                config_path=None,
                missing_files=missing_files,
                installed_dependencies=deps,
                assigned_device=self.device,
                weights_verified=False,
                diagnostic_message=f"Grounding DINO weights missing in {self.model_dir}.",
            )

        status = ModelLifecycleStatus.READY if self._model is not None else ModelLifecycleStatus.CONFIGURED
        return ModelDiagnosticInfo(
            model_name="GroundingDINO",
            role="Open-Vocabulary Object Detection",
            status=status,
            selected_variant=self.variant_name,
            checkpoint_path=str(self.model_dir or self.variant_name),
            config_path=None,
            missing_files=[],
            installed_dependencies=deps,
            assigned_device=self.device,
            weights_verified=True,
            diagnostic_message="Grounding DINO adapter configured and ready.",
        )

    def load(self) -> None:
        diag = self.get_diagnostics()
        if diag.status in (ModelLifecycleStatus.DEPENDENCY_MISSING, ModelLifecycleStatus.WEIGHTS_MISSING):
            self._status = diag.status
            raise RuntimeError(diag.diagnostic_message)

        try:
            from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor  # type: ignore

            model_source = str(self.model_dir) if self.model_dir and self.model_dir.exists() else self.variant_name
            self._processor = AutoProcessor.from_pretrained(model_source)
            self._model = AutoModelForZeroShotObjectDetection.from_pretrained(model_source)
            self._model.to(self.device)
            self._model.eval()
            self._status = ModelLifecycleStatus.READY
            logger.info("Grounding DINO model loaded successfully.")
        except Exception as exc:
            self._status = ModelLifecycleStatus.INFERENCE_FAILED
            logger.exception("Failed to load Grounding DINO: %s", exc)
            raise

    def detect_regions(
        self,
        image: Image.Image,
        transform: PageCoordinateTransform,
        prompt_phrases: Optional[List[str]] = None,
    ) -> List[DetectionBoxProposal]:
        """Detects candidate bounding boxes conditioned on cadastral prompt phrases."""
        if self._model is None or self._processor is None:
            diag = self.get_diagnostics()
            if diag.status not in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                logger.debug("Grounding DINO not ready (%s); skipping live detection.", diag.status.value)
                return []
            self.load()

        proposals: List[DetectionBoxProposal] = []
        prompts = prompt_phrases or DEFAULT_PROMPTS
        text_query = ". ".join(prompts) + "."
        w, h = image.size

        import signal
        import threading

        def _run_inference(result_holder: list) -> None:
            """Runs DINO inference in a thread; stores result or exception."""
            try:
                import torch  # type: ignore
                inputs = self._processor(images=image, text=text_query, return_tensors="pt").to(self.device)
                with torch.no_grad():
                    outputs = self._model(**inputs)

                results = self._processor.post_process_grounded_object_detection(
                    outputs,
                    inputs.input_ids,
                    threshold=self.box_threshold,
                    text_threshold=self.text_threshold,
                    target_sizes=[(h, w)],
                )[0]
                result_holder.append(results)
            except Exception as exc:
                result_holder.append(exc)

        result_holder: list = []
        thread = threading.Thread(target=_run_inference, args=(result_holder,), daemon=True)
        thread.start()
        thread.join(timeout=self.cpu_timeout_sec)

        if not result_holder:
            logger.warning(
                "Grounding DINO inference timed out after %ds on CPU. Skipping to preserve server responsiveness.",
                self.cpu_timeout_sec,
            )
            return []

        raw = result_holder[0]
        if isinstance(raw, Exception):
            logger.error("Grounding DINO inference error: %s", raw)
            return []

        try:
            boxes = raw.get("boxes", [])
            scores = raw.get("scores", [])
            labels = raw.get("text_labels") if "text_labels" in raw else raw.get("labels", [])

            for box, score, label in zip(boxes, scores, labels):
                b = box.cpu().numpy()
                x1_px, y1_px, x2_px, y2_px = float(b[0]), float(b[1]), float(b[2]), float(b[3])
                score_val = float(score.cpu().item())
                label_str = str(label)

                pt_x1, pt_y1 = transform.pixel_to_point(x1_px, y1_px)
                pt_x2, pt_y2 = transform.pixel_to_point(x2_px, y2_px)

                # Classify category from matched phrase
                cat = "layout_region"
                for p in prompts:
                    if p.split()[0] in label_str.lower():
                        cat = p.replace(" ", "_")
                        break

                proposals.append(
                    DetectionBoxProposal(
                        category=cat,
                        label=label_str,
                        confidence=score_val,
                        bbox_pixel=[int(x1_px), int(y1_px), int(x2_px), int(y2_px)],
                        bbox_page_pt=[round(pt_x1, 2), round(pt_y1, 2), round(pt_x2, 2), round(pt_y2, 2)],
                        model_name="GroundingDINO",
                    )
                )
        except Exception as exc:
            logger.error("Grounding DINO post-processing error: %s", exc)

        logger.info("Grounding DINO detected %d candidate regions from %d prompts.", len(proposals), len(prompts))
        return proposals

    def mock_predict(
        self,
        transform: PageCoordinateTransform,
        mock_boxes: Optional[List[Dict[str, Any]]] = None,
    ) -> List[DetectionBoxProposal]:
        """Provides simulated detections for testing without model weights."""
        boxes = mock_boxes or [
            {"cat": "plot_number", "label": "plot number", "bbox_pt": [115, 140, 165, 160], "conf": 0.88},
            {"cat": "road_label", "label": "road label", "bbox_pt": [200, 205, 300, 225], "conf": 0.91},
        ]
        proposals = []
        for b in boxes:
            bbox_px = transform.bbox_point_to_pixel(b["bbox_pt"])
            proposals.append(
                DetectionBoxProposal(
                    category=b["cat"],
                    label=b["label"],
                    confidence=b["conf"],
                    bbox_pixel=bbox_px,
                    bbox_page_pt=b["bbox_pt"],
                    model_name="GroundingDINO_Mock",
                )
            )
        return proposals
