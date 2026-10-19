"""PaddleOCR PP-OCRv5 Adapter.

Provides text detection, recognition, and orientation classification for colony layout plans:
- Plot numbers and parcel IDs
- Road labels and street names
- Dimensions and measurement annotations
- Colony/sector/block names
- Park, green space, and amenity labels
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from app.gis.ai_models.models import ModelDiagnosticInfo, ModelLifecycleStatus, OCRTextDetection
from app.gis.ingestion.coordinates import PageCoordinateTransform

logger = logging.getLogger("livemap.ai_models.paddle_ocr")


class PaddleOCRAdapter:
    """PaddleOCR PP-OCRv5 inference and lifecycle adapter."""

    def __init__(
        self,
        model_dir: Optional[Path] = None,
        use_gpu: bool = False,
        lang: str = "en",
    ):
        self.model_dir = model_dir
        self.use_gpu = use_gpu
        self.lang = lang
        self._engine = None
        self._status = ModelLifecycleStatus.CONFIGURED

    def get_diagnostics(self) -> ModelDiagnosticInfo:
        """Inspects environment and weights, reporting truthful lifecycle status."""
        deps = {}
        try:
            import paddleocr  # type: ignore
            deps["paddleocr"] = True
        except ImportError:
            deps["paddleocr"] = False

        try:
            import paddle  # type: ignore
            deps["paddle"] = True
        except ImportError:
            deps["paddle"] = False

        missing_deps = [pkg for pkg, present in deps.items() if not present]
        if missing_deps:
            return ModelDiagnosticInfo(
                model_name="PaddleOCR_PP-OCRv5",
                role="Text Detection & Recognition",
                status=ModelLifecycleStatus.DEPENDENCY_MISSING,
                selected_variant="PP-OCRv5 (en/ch)",
                checkpoint_path=str(self.model_dir or "default"),
                config_path=None,
                missing_files=[],
                installed_dependencies=deps,
                assigned_device="cpu",
                weights_verified=False,
                diagnostic_message=f"Missing required packages: {missing_deps}. Install via `pip install paddleocr paddlepaddle`.",
            )

        # Check local checkpoint files if configured
        missing_files = []
        if self.model_dir and self.model_dir.exists():
            det_model = self.model_dir / "ch_PP-OCRv5_det_infer" / "inference.pdmodel"
            rec_model = self.model_dir / "ch_PP-OCRv5_rec_infer" / "inference.pdmodel"
            if not det_model.exists():
                missing_files.append(str(det_model))
            if not rec_model.exists():
                missing_files.append(str(rec_model))

        if missing_files:
            return ModelDiagnosticInfo(
                model_name="PaddleOCR_PP-OCRv5",
                role="Text Detection & Recognition",
                status=ModelLifecycleStatus.WEIGHTS_MISSING,
                selected_variant="PP-OCRv5",
                checkpoint_path=str(self.model_dir),
                config_path=None,
                missing_files=missing_files,
                installed_dependencies=deps,
                assigned_device="cpu",
                weights_verified=False,
                diagnostic_message=f"PaddleOCR weights missing in {self.model_dir}. Download official tarballs to activate real inference.",
            )

        status = ModelLifecycleStatus.READY if self._engine is not None else ModelLifecycleStatus.CONFIGURED
        return ModelDiagnosticInfo(
            model_name="PaddleOCR_PP-OCRv5",
            role="Text Detection & Recognition",
            status=status,
            selected_variant="PP-OCRv5",
            checkpoint_path=str(self.model_dir or "bundled_or_auto_download"),
            config_path=None,
            missing_files=[],
            installed_dependencies=deps,
            assigned_device="gpu" if self.use_gpu else "cpu",
            weights_verified=True,
            diagnostic_message="PaddleOCR PP-OCRv5 configured and ready for initialization.",
        )

    def load(self) -> None:
        """Initializes PaddleOCR instance with local models or default models."""
        diag = self.get_diagnostics()
        if diag.status == ModelLifecycleStatus.DEPENDENCY_MISSING:
            self._status = ModelLifecycleStatus.DEPENDENCY_MISSING
            raise RuntimeError(diag.diagnostic_message)
        if diag.status == ModelLifecycleStatus.WEIGHTS_MISSING:
            self._status = ModelLifecycleStatus.WEIGHTS_MISSING
            raise RuntimeError(diag.diagnostic_message)

        try:
            import os
            os.environ["FLAGS_use_onednn"] = "0"
            from paddleocr import PaddleOCR  # type: ignore
            kwargs: Dict[str, Any] = {
                "use_doc_orientation_classify": False,
                "use_doc_unwarping": False,
                "use_textline_orientation": False,
                "enable_mkldnn": False,
            }
            if self.lang:
                kwargs["lang"] = self.lang

            self._engine = PaddleOCR(**kwargs)
            self._status = ModelLifecycleStatus.READY
            logger.info("PaddleOCR initialized successfully with detector and recognizer.")
        except Exception as exc:
            self._status = ModelLifecycleStatus.INFERENCE_FAILED
            logger.exception("Failed to initialize PaddleOCR: %s", exc)
            raise

    def detect_and_recognize(
        self,
        image: Image.Image,
        transform: PageCoordinateTransform,
        targeted_crops: Optional[List[Tuple[Image.Image, List[int]]]] = None,
    ) -> List[OCRTextDetection]:
        """Runs text detection and recognition safely via an isolated subprocess.

        Protects the main web server process from native C++ Access Violations (0xc0000005 in phi.dll).
        """
        import json
        import os
        import subprocess
        import sys
        import tempfile

        results: List[OCRTextDetection] = []
        diag = self.get_diagnostics()
        if diag.status not in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
            logger.debug("PaddleOCR not ready (%s); skipping live inference.", diag.status.value)
            return results

        in_path = None
        out_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f_in:
                in_path = f_in.name
            with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f_out:
                out_path = f_out.name

            # Save input image for isolated worker
            image.convert("RGB").save(in_path)

            runner_script = os.path.join(os.path.dirname(__file__), "ocr_runner.py")
            backend_python_dir = str(Path(__file__).resolve().parents[3])

            runner_cmd = [
                sys.executable,
                runner_script,
                in_path,
                out_path,
                self.lang or "en",
            ]

            env = {
                **os.environ,
                "PYTHONPATH": backend_python_dir,
                "FLAGS_use_onednn": "0",
                "FLAGS_use_mkldnn": "0",
                "KMP_DUPLICATE_LIB_OK": "TRUE",
                "PADDLE_DISABLE_DNNL": "1",
            }

            proc = subprocess.run(
                runner_cmd,
                capture_output=True,
                text=True,
                timeout=90,
                cwd=backend_python_dir,
                env=env,
            )

            if proc.returncode == 0 and os.path.exists(out_path):
                with open(out_path, "r", encoding="utf-8") as f:
                    raw_detections = json.load(f)

                for item in raw_detections:
                    text = item.get("text", "").strip()
                    if not text:
                        continue
                    conf = float(item.get("confidence", 0.9))
                    bbox = item.get("bbox_pixel", [0, 0, 0, 0])
                    box_pts = item.get("box_points") or [
                        [bbox[0], bbox[1]],
                        [bbox[2], bbox[1]],
                        [bbox[2], bbox[3]],
                        [bbox[0], bbox[3]],
                    ]

                    quad_page_pts = [
                        list(transform.pixel_to_point(pt[0], pt[1])) for pt in box_pts
                    ]
                    pt_x1, pt_y1 = transform.pixel_to_point(bbox[0], bbox[1])
                    pt_x2, pt_y2 = transform.pixel_to_point(bbox[2], bbox[3])

                    dx = float(box_pts[1][0] - box_pts[0][0])
                    dy = float(box_pts[1][1] - box_pts[0][1])
                    angle = round(float(np.degrees(np.arctan2(dy, dx))), 1) if (dx != 0 or dy != 0) else 0.0

                    results.append(
                        OCRTextDetection(
                            text=text,
                            confidence=conf,
                            bbox_pixel=bbox,
                            bbox_page_pt=[round(pt_x1, 2), round(pt_y1, 2), round(pt_x2, 2), round(pt_y2, 2)],
                            polygon_points=quad_page_pts,
                            orientation_deg=angle,
                            model_name="PaddleOCR_PP-OCRv6",
                        )
                    )
                logger.info(f"[AI] PaddleOCR isolated worker extracted {len(results)} text detections.")
            else:
                err_msg = proc.stderr[:160].strip() if proc.stderr else "none"
                logger.warning(
                    f"[AI] PaddleOCR isolated worker notice (exit code {proc.returncode}, stderr: {err_msg}); gracefully falling back to vector linework."
                )
        except subprocess.TimeoutExpired:
            logger.warning("[AI] PaddleOCR isolated worker timed out (45s); proceeding with vector linework.")
        except Exception as exc:
            logger.warning(f"[AI] PaddleOCR runner notice: {exc}; proceeding with vector linework.")
        finally:
            if in_path and os.path.exists(in_path):
                try:
                    os.remove(in_path)
                except Exception:
                    pass
            if out_path and os.path.exists(out_path):
                try:
                    os.remove(out_path)
                except Exception:
                    pass

        return results

    def mock_predict(
        self,
        mock_labels: List[Tuple[str, List[float], float]],
        transform: PageCoordinateTransform,
    ) -> List[OCRTextDetection]:
        """Provides simulated deterministic OCR detections for testing without model weights."""
        results = []
        for text, bbox_pt, conf in mock_labels:
            bbox_px = transform.bbox_point_to_pixel(bbox_pt)
            quad = [
                [bbox_pt[0], bbox_pt[1]],
                [bbox_pt[2], bbox_pt[1]],
                [bbox_pt[2], bbox_pt[3]],
                [bbox_pt[0], bbox_pt[3]],
            ]
            results.append(
                OCRTextDetection(
                    text=text,
                    confidence=conf,
                    bbox_pixel=bbox_px,
                    bbox_page_pt=bbox_pt,
                    polygon_points=quad,
                    orientation_deg=0.0,
                    model_name="PaddleOCR_PP-OCRv5_Mock",
                )
            )
        return results
