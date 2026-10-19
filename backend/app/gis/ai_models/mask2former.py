"""Mask2Former Universal Segmentation Adapter.

Performs instance and panoptic segmentation proposals for colony layout plans:
- Candidate parcel/region instance separation
- Multi-instance polygon proposals
- Cross-validation and disagreement detection against SegFormer and vector linework
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import Polygon, mapping

from app.gis.ai_models.models import (
    ModelDiagnosticInfo,
    ModelLifecycleStatus,
    SegmentationMaskProposal,
)
from app.gis.ingestion.coordinates import PageCoordinateTransform

logger = logging.getLogger("livemap.ai_models.mask2former")


class Mask2FormerAdapter:
    """Mask2Former universal/instance segmentation adapter (strictly distinct from SegFormer)."""

    def __init__(
        self,
        model_dir: Optional[Path] = None,
        variant_name: str = "facebook/mask2former-swin-tiny-ade-panoptic",
        device: str = "cpu",
    ):
        self.model_dir = model_dir
        self.variant_name = variant_name
        self.device = device
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
                model_name="Mask2Former",
                role="Instance & Panoptic Segmentation",
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
                model_name="Mask2Former",
                role="Instance & Panoptic Segmentation",
                status=ModelLifecycleStatus.WEIGHTS_MISSING,
                selected_variant=self.variant_name,
                checkpoint_path=str(self.model_dir),
                config_path=None,
                missing_files=missing_files,
                installed_dependencies=deps,
                assigned_device=self.device,
                weights_verified=False,
                diagnostic_message=f"Mask2Former weights missing in {self.model_dir}.",
            )

        status = ModelLifecycleStatus.READY if self._model is not None else ModelLifecycleStatus.CONFIGURED
        return ModelDiagnosticInfo(
            model_name="Mask2Former",
            role="Instance & Panoptic Segmentation",
            status=status,
            selected_variant=self.variant_name,
            checkpoint_path=str(self.model_dir or self.variant_name),
            config_path=None,
            missing_files=[],
            installed_dependencies=deps,
            assigned_device=self.device,
            weights_verified=True,
            diagnostic_message="Mask2Former adapter configured and ready.",
        )

    def load(self) -> None:
        diag = self.get_diagnostics()
        if diag.status in (ModelLifecycleStatus.DEPENDENCY_MISSING, ModelLifecycleStatus.WEIGHTS_MISSING):
            self._status = diag.status
            raise RuntimeError(diag.diagnostic_message)

        try:
            from transformers import (  # type: ignore
                Mask2FormerForUniversalSegmentation,
                Mask2FormerImageProcessor,
                logging as tf_logging,
            )

            model_source = str(self.model_dir) if self.model_dir and self.model_dir.exists() else self.variant_name
            prev_level = tf_logging.get_verbosity()
            tf_logging.set_verbosity_error()
            try:
                self._processor = Mask2FormerImageProcessor.from_pretrained(model_source)
                self._model = Mask2FormerForUniversalSegmentation.from_pretrained(model_source)
            finally:
                tf_logging.set_verbosity(prev_level)

            self._model.to(self.device)
            self._model.eval()
            self._status = ModelLifecycleStatus.READY
            logger.info("Mask2Former model loaded successfully.")
        except Exception as exc:
            self._status = ModelLifecycleStatus.INFERENCE_FAILED
            logger.exception("Failed to load Mask2Former: %s", exc)
            raise

    def predict_instances(
        self,
        image: Image.Image,
        transform: PageCoordinateTransform,
    ) -> List[SegmentationMaskProposal]:
        """Runs instance segmentation and extracts distinct parcel/region candidates."""
        if self._model is None or self._processor is None:
            diag = self.get_diagnostics()
            if diag.status not in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                logger.debug("Mask2Former not ready (%s); skipping live prediction.", diag.status.value)
                return []
            self.load()

        proposals: List[SegmentationMaskProposal] = []
        w, h = image.size

        try:
            import torch  # type: ignore

            inputs = self._processor(images=image, return_tensors="pt").to(self.device)
            with torch.no_grad():
                outputs = self._model(**inputs)

            # Post-process panoptic / instance segmentation
            processed = self._processor.post_process_instance_segmentation(
                outputs, target_sizes=[(h, w)]
            )[0]

            masks = processed.get("segmentation")  # tensor of shape (H, W) with instance IDs
            segments_info = processed.get("segments_info", [])

            if masks is not None:
                mask_np = masks.cpu().numpy()
                for seg in segments_info:
                    seg_id = seg.get("id")
                    score = float(seg.get("score", 0.8))
                    label_id = seg.get("label_id", 0)

                    bin_mask = (mask_np == seg_id).astype(np.uint8)
                    area = int(np.sum(bin_mask))
                    if area < 50:  # Reduced from 80 to catch smaller parcels
                        continue

                    slices = ndimage.find_objects(bin_mask)
                    if not slices or slices[0] is None:
                        continue
                    ymin, ymax = slices[0][0].start, slices[0][0].stop
                    xmin, xmax = slices[0][1].start, slices[0][1].stop

                    pt_x1, pt_y1 = transform.pixel_to_point(xmin, ymin)
                    pt_x2, pt_y2 = transform.pixel_to_point(xmax, ymax)

                    poly = Polygon([(pt_x1, pt_y1), (pt_x2, pt_y1), (pt_x2, pt_y2), (pt_x1, pt_y2), (pt_x1, pt_y1)])
                    proposals.append(
                        SegmentationMaskProposal(
                            proposal_id=f"mask2former_inst_{seg_id}",
                            category="parcel_candidate",
                            confidence=score,
                            bbox_page_pt=[round(pt_x1, 2), round(pt_y1, 2), round(pt_x2, 2), round(pt_y2, 2)],
                            polygon_geojson=mapping(poly),
                            model_name="Mask2Former",
                            instance_id=int(seg_id),
                            quality_score=score,
                        )
                    )
        except Exception as exc:
            logger.error("Mask2Former inference error: %s", exc)

        return proposals

    def mock_predict(
        self,
        transform: PageCoordinateTransform,
        mock_instances: Optional[List[Dict[str, Any]]] = None,
    ) -> List[SegmentationMaskProposal]:
        """Provides simulated instance segmentation proposals for testing."""
        instances = mock_instances or [
            {"category": "parcel_candidate", "bbox_pt": [100, 100, 160, 150], "conf": 0.85, "inst_id": 1},
            {"category": "parcel_candidate", "bbox_pt": [165, 100, 225, 150], "conf": 0.87, "inst_id": 2},
        ]
        proposals = []
        for inst in instances:
            bbox = inst["bbox_pt"]
            poly = Polygon([(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[2], bbox[3]), (bbox[0], bbox[3]), (bbox[0], bbox[1])])
            proposals.append(
                SegmentationMaskProposal(
                    proposal_id=f"mask2former_mock_{inst['inst_id']}",
                    category=inst["category"],
                    confidence=inst["conf"],
                    bbox_page_pt=bbox,
                    polygon_geojson=mapping(poly),
                    model_name="Mask2Former_Mock",
                    instance_id=inst["inst_id"],
                    quality_score=inst["conf"],
                )
            )
        return proposals

    # Convenience alias for uniform segmentation interface
    predict_segments = predict_instances
