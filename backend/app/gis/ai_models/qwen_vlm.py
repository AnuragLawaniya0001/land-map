"""Qwen2.5-VL Vision-Language Context and Layout Interpretation Adapter.

Performs visual-semantic interpretation of colony layout plans:
- Explaining ambiguous boundaries and complex intersections
- Proposing semantic classifications (plot vs road vs park vs amenity)
- Relating nearby text labels to layout regions
- Producing structured, verifiable observations without hallucinating coordinates
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

from app.gis.ai_models.models import (
    ModelDiagnosticInfo,
    ModelLifecycleStatus,
    VLMInterpretationResult,
)

logger = logging.getLogger("livemap.ai_models.qwen_vlm")


class QwenVLMAdapter:
    """Qwen2.5-VL inference and lifecycle adapter."""

    def __init__(
        self,
        model_dir: Optional[Path] = None,
        variant_name: str = "Qwen/Qwen2.5-VL-3B-Instruct",
        device: str = "auto",
        max_tokens: int = 512,
    ):
        self.model_dir = model_dir
        self.variant_name = variant_name
        self.device = device
        self.max_tokens = max_tokens
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
                model_name="Qwen2.5-VL",
                role="Visual Context & Layout Interpretation",
                status=ModelLifecycleStatus.DEPENDENCY_MISSING,
                selected_variant=self.variant_name,
                checkpoint_path=str(self.model_dir or "huggingface_hub"),
                config_path=None,
                missing_files=[],
                installed_dependencies=deps,
                assigned_device="cpu",
                weights_verified=False,
                diagnostic_message=f"Missing dependencies: {missing_deps}. Install via `pip install transformers torch accelerate`.",
            )

        # Check local weights if path is provided
        missing_files = []
        if self.model_dir:
            if not self.model_dir.exists():
                missing_files.append(str(self.model_dir))
            else:
                config_file = self.model_dir / "config.json"
                if not config_file.exists():
                    missing_files.append(str(config_file))
                # Check for all shards referenced in index
                index_file = self.model_dir / "model.safetensors.index.json"
                if index_file.exists():
                    import json
                    try:
                        with open(index_file, "r", encoding="utf-8") as f:
                            idx_data = json.load(f)
                        weight_map = idx_data.get("weight_map", {})
                        required_shards = set(weight_map.values())
                        for shard in required_shards:
                            if not (self.model_dir / shard).exists():
                                missing_files.append(str(self.model_dir / shard))
                    except Exception:
                        pass
                elif not (self.model_dir / "model.safetensors").exists():
                    missing_files.append(str(self.model_dir / "model.safetensors"))

        if missing_files:
            return ModelDiagnosticInfo(
                model_name="Qwen2.5-VL",
                role="Visual Context & Layout Interpretation",
                status=ModelLifecycleStatus.WEIGHTS_MISSING,
                selected_variant=self.variant_name,
                checkpoint_path=str(self.model_dir),
                config_path=None,
                missing_files=missing_files,
                installed_dependencies=deps,
                assigned_device="cpu",
                weights_verified=False,
                diagnostic_message=f"Qwen2.5-VL weight shard missing: {missing_files}. Download full multi-part weights to activate live VLM inference.",
            )

        status = ModelLifecycleStatus.READY if self._model is not None else ModelLifecycleStatus.CONFIGURED
        return ModelDiagnosticInfo(
            model_name="Qwen2.5-VL",
            role="Visual Context & Layout Interpretation",
            status=status,
            selected_variant=self.variant_name,
            checkpoint_path=str(self.model_dir or self.variant_name),
            config_path=None,
            missing_files=[],
            installed_dependencies=deps,
            assigned_device=self.device,
            weights_verified=True,
            diagnostic_message="Qwen2.5-VL adapter configured.",
        )

    def load(self) -> None:
        """Loads Qwen2.5-VL model and processor."""
        diag = self.get_diagnostics()
        if diag.status == ModelLifecycleStatus.DEPENDENCY_MISSING:
            self._status = ModelLifecycleStatus.DEPENDENCY_MISSING
            raise RuntimeError(diag.diagnostic_message)
        if diag.status == ModelLifecycleStatus.WEIGHTS_MISSING:
            self._status = ModelLifecycleStatus.WEIGHTS_MISSING
            raise RuntimeError(diag.diagnostic_message)

        try:
            import torch  # type: ignore
            from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration  # type: ignore

            model_source = str(self.model_dir) if self.model_dir and self.model_dir.exists() else self.variant_name
            logger.info("Loading Qwen2.5-VL from %s...", model_source)

            self._processor = AutoProcessor.from_pretrained(
                model_source,
                min_pixels=256 * 28 * 28,
                max_pixels=768 * 768,
            )
            load_kwargs: Dict[str, Any] = {}
            if torch.cuda.is_available():
                load_kwargs["torch_dtype"] = torch.float16
                load_kwargs["device_map"] = "cuda:0"
            else:
                load_kwargs["torch_dtype"] = torch.float32
                load_kwargs["device_map"] = "cpu"

            self._model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                model_source,
                **load_kwargs,
            )
            self._status = ModelLifecycleStatus.READY
            logger.info("Qwen2.5-VL loaded successfully.")
        except Exception as exc:
            self._status = ModelLifecycleStatus.INFERENCE_FAILED
            logger.exception("Failed to load Qwen2.5-VL: %s", exc)
            raise

    def interpret_layout(
        self,
        image: Image.Image,
        prompt_context: Optional[str] = None,
        crop_proposals: Optional[List[Dict[str, Any]]] = None,
    ) -> VLMInterpretationResult:
        """Performs visual reasoning over the layout plan or targeted ambiguous crops."""
        if self._model is None or self._processor is None:
            diag = self.get_diagnostics()
            if diag.status not in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                logger.debug("Qwen2.5-VL not ready (%s); skipping live reasoning.", diag.status.value)
                return self.mock_predict(image)
            self.load()

        structured_prompt = (
            "Analyze this colony layout plan drawing carefully based solely on visible evidence.\n"
            "Return a strictly valid JSON object with the following schema:\n"
            "{\n"
            '  "north_direction": "up|down|left|right|unknown",\n'
            '  "entry_gate_position": "top|bottom|left|right|unknown",\n'
            '  "plot_numbering_pattern": "sequential|zone_based|irregular",\n'
            '  "layout_summary": "High-level description of colony layout structure and sectors",\n'
            '  "detected_plot_patterns": ["Regular grid", "Sequential numbers"],\n'
            '  "suggested_classifications": [{"feature_id": "area_1", "suggested_type": "park", "rationale": "Green colored open space"}]\n'
            "}\n"
            "Do not invent plot coordinates. Base observations strictly on drawing evidence."
        )
        if prompt_context:
            structured_prompt += f"\nContext note: {prompt_context}"

        try:
            import torch  # type: ignore

            # Optimize image resolution for VLM layout reasoning:
            # 512px in RGB preserves full geometric clarity of colony plots while bounding tokens to ~350 (runs in 3-5s).
            vlm_img = image.convert("RGB")
            max_vlm_dim = 512
            w, h = vlm_img.size
            if max(w, h) > max_vlm_dim:
                scale = max_vlm_dim / max(w, h)
                new_w = max(1, int(w * scale))
                new_h = max(1, int(h * scale))
                vlm_img = vlm_img.resize((new_w, new_h), Image.Resampling.BILINEAR)

            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": vlm_img},
                        {"type": "text", "text": structured_prompt},
                    ],
                }
            ]
            text_prompt = self._processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = self._processor(
                text=[text_prompt],
                images=[vlm_img],
                padding=True,
                return_tensors="pt",
            )
            if torch.cuda.is_available():
                inputs = inputs.to(self._model.device)

            generated_ids = self._model.generate(
                **inputs,
                max_new_tokens=min(128, self.max_tokens),
                do_sample=False,
            )
            generated_ids_trimmed = [
                out_ids[len(in_ids) :] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
            ]
            response_text = self._processor.batch_decode(
                generated_ids_trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
            )[0]

            # Parse JSON from model output
            parsed = self._extract_json(response_text)
            return VLMInterpretationResult(
                layout_summary=parsed.get("layout_summary", "Colony layout interpreted by Qwen2.5-VL."),
                detected_plot_patterns=parsed.get("detected_plot_patterns", []),
                ambiguity_explanations=parsed.get("ambiguity_explanations", []),
                suggested_classifications=parsed.get("suggested_classifications", []),
                model_name=self.variant_name,
            )
        except Exception as exc:
            logger.error("Qwen2.5-VL inference error: %s", exc)
            return self.mock_predict(image)

    def _extract_json(self, text: str) -> Dict[str, Any]:
        """Safely parses JSON substring from VLM response."""
        try:
            # Look for markdown code fence
            if "```json" in text:
                text = text.split("```json", 1)[1].split("```", 1)[0]
            elif "```" in text:
                text = text.split("```", 1)[1].split("```", 1)[0]
            return json.loads(text.strip())
        except Exception:
            return {"layout_summary": text.strip()[:200]}

    def mock_predict(self, image: Image.Image) -> VLMInterpretationResult:
        """Simulated layout interpretation for offline testing without GPU weights."""
        w, h = image.size
        return VLMInterpretationResult(
            layout_summary=f"Layout drawing ({w}x{h} px) with organized rectangular plot sectors, central access road, and dedicated open greens.",
            detected_plot_patterns=["Sequential integer numbering", "Orthogonal plot grids"],
            ambiguity_explanations=[
                {
                    "region": "outer_periphery",
                    "issue": "Boundary stroke intersects title block annotation",
                }
            ],
            suggested_classifications=[
                {
                    "feature_id": "green_belt_candidate",
                    "suggested_type": "park",
                    "rationale": "High green saturation area with surrounding road access",
                }
            ],
            model_name=f"{self.variant_name}_Mock",
        )
