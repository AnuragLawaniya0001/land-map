"""Official Model Manifest and Manual Download Specifications.

Machine-readable manifest detailing official model sources, recommended variants,
required configuration and checkpoint files, download URLs, and destination paths.
Weights are NOT committed to source control and must be downloaded manually by the user.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional


def get_default_models_dir() -> Path:
    env_dir = os.getenv("GIS_MODEL_DIR")
    if env_dir:
        return Path(env_dir)
    # Default relative to backend/python/models
    backend_dir = Path(__file__).resolve().parent.parent.parent.parent
    return backend_dir / "models"


MODEL_MANIFEST: Dict[str, Dict[str, Any]] = {
    "paddle_ocr_v5": {
        "model_name": "PaddleOCR PP-OCRv5",
        "role": "Text Detection, Recognition, and Orientation for plot numbers, labels, dimensions",
        "official_repo": "https://github.com/PaddlePaddle/PaddleOCR",
        "recommended_variant": "PP-OCRv5 Mobile/Server Inference",
        "local_subdir": "paddleocr_v5",
        "required_files": [
            "ch_PP-OCRv5_det_infer/inference.pdmodel",
            "ch_PP-OCRv5_det_infer/inference.pdiparams",
            "ch_PP-OCRv5_rec_infer/inference.pdmodel",
            "ch_PP-OCRv5_rec_infer/inference.pdiparams",
            "ch_ppocr_mobile_v2.0_cls_infer/inference.pdmodel",
            "ch_ppocr_mobile_v2.0_cls_infer/inference.pdiparams",
        ],
        "hardware_requirements": "CPU (4+ cores) or CUDA GPU (>=2 GB VRAM)",
        "download_instructions": {
            "det_url": "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_det_infer.tar",
            "rec_url": "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_rec_infer.tar",
            "cls_url": "https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_cls_infer.tar",
            "notes": "Extract tar archives into the designated paddleocr_v5 subdirectory.",
        },
        "python_dependencies": ["paddleocr>=2.7.0", "paddlepaddle>=2.5.0"],
    },
    "qwen_vlm": {
        "model_name": "Qwen2.5-VL",
        "role": "Visual-Language contextual interpretation, layout semantics, and ambiguity explanation",
        "official_repo": "https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct",
        "recommended_variant": "Qwen/Qwen2.5-VL-3B-Instruct (or 7B-Instruct for high-VRAM)",
        "local_subdir": "qwen2_5_vl_3b",
        "required_files": [
            "config.json",
            "generation_config.json",
            "preprocessor_config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "model.safetensors.index.json",
            "model-00001-of-00002.safetensors",
            "model-00002-of-00002.safetensors",  # SHARD 2 — must be downloaded
        ],
        "hardware_requirements": "8 GB VRAM GPU recommended, or 16 GB System RAM on CPU (fp16/int4)",
        "download_instructions": {
            "huggingface_repo": "Qwen/Qwen2.5-VL-3B-Instruct",
            "command": "huggingface-cli download Qwen/Qwen2.5-VL-3B-Instruct --local-dir models/qwen2_5_vl_3b",
            "shard_2_direct": "huggingface-cli download Qwen/Qwen2.5-VL-3B-Instruct model-00002-of-00002.safetensors --local-dir models/qwen2_5_vl_3b",
            "notes": "Shard 1 (3.98 GB) is present. Shard 2 must also be downloaded. Run the shard_2_direct command if full re-download is not desired.",
        },
        "python_dependencies": ["transformers>=4.48.0", "torch>=2.1.0", "accelerate>=0.26.0"],
    },
    "segformer": {
        "model_name": "SegFormer",
        "role": "Semantic segmentation proposals (parcel regions, roads, greens, water)",
        "official_repo": "https://huggingface.co/nvidia/segformer-b0-finetuned-ade-512-512",
        "recommended_variant": "nvidia/segformer-b0-finetuned-ade-512-512 (or b2 variant)",
        "local_subdir": "segformer_b0",
        "required_files": [
            "config.json",
            "preprocessor_config.json",
            "model.safetensors",
        ],
        "hardware_requirements": "CPU or CUDA GPU (>=2 GB VRAM)",
        "download_instructions": {
            "huggingface_repo": "nvidia/segformer-b0-finetuned-ade-512-512",
            "command": "huggingface-cli download nvidia/segformer-b0-finetuned-ade-512-512 --local-dir models/segformer_b0",
            "notes": "Provides baseline semantic class masks for layout plan features.",
        },
        "python_dependencies": ["transformers>=4.36.0", "torch>=2.0.0"],
    },
    "mask2former": {
        "model_name": "Mask2Former",
        "role": "Instance and panoptic segmentation proposals for parcel separation and disagreement QA",
        "official_repo": "https://huggingface.co/facebook/mask2former-swin-tiny-cityscapes-panoptic",
        "recommended_variant": "facebook/mask2former-swin-tiny-cityscapes-panoptic",
        "local_subdir": "mask2former_tiny",
        "required_files": [
            "config.json",
            "preprocessor_config.json",
            "model.safetensors",
        ],
        "hardware_requirements": "CPU or CUDA GPU (>=4 GB VRAM)",
        "download_instructions": {
            "huggingface_repo": "facebook/mask2former-swin-tiny-cityscapes-panoptic",
            "command": "huggingface-cli download facebook/mask2former-swin-tiny-cityscapes-panoptic --local-dir models/mask2former_tiny",
            "notes": "Cityscapes panoptic variant provides robust parcel separation masks.",
        },
        "python_dependencies": ["transformers>=4.36.0", "torch>=2.0.0"],
    },
    "sam2": {
        "model_name": "SAM 2",
        "role": "Promptable segmentation refinement for ambiguous boundaries (points/boxes)",
        "official_repo": "https://github.com/facebookresearch/sam2",
        "recommended_variant": "facebook/sam2.1-hiera-small (or tiny)",
        "local_subdir": "sam2_hiera_small",
        "required_files": [
            "sam2.1_hiera_small.pt",
            "sam2.1_hiera_s.yaml",
        ],
        "hardware_requirements": "CUDA GPU recommended (>=4 GB VRAM) or CPU",
        "download_instructions": {
            "checkpoint_url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
            "config_url": "https://raw.githubusercontent.com/facebookresearch/sam2/main/sam2/configs/sam2.1/sam2.1_hiera_s.yaml",
            "command": "curl -L -o models/sam2_hiera_small/sam2.1_hiera_small.pt https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
            "notes": "Refines proposed regions without erasing source-supported linework.",
        },
        "python_dependencies": ["sam2>=1.0.0", "torch>=2.1.0"],
    },
    "grounding_dino": {
        "model_name": "Grounding DINO",
        "role": "Open-vocabulary text-conditioned detection (plot numbers, road labels, parks)",
        "official_repo": "https://github.com/IDEA-Research/GroundingDINO",
        "recommended_variant": "IDEA-Research/grounding-dino-tiny",
        "local_subdir": "grounding_dino_tiny",
        "required_files": [
            "config.json",
            "preprocessor_config.json",
            "model.safetensors",
        ],
        "hardware_requirements": "CPU or CUDA GPU (>=2 GB VRAM)",
        "download_instructions": {
            "huggingface_repo": "IDEA-Research/grounding-dino-tiny",
            "command": "huggingface-cli download IDEA-Research/grounding-dino-tiny --local-dir models/grounding_dino_tiny",
            "notes": "Detects candidate layout regions conditioned on natural text prompts.",
        },
        "python_dependencies": ["transformers>=4.36.0", "torch>=2.0.0"],
    },
}
