"""Automated Checkpoint Downloader for LiveMap AI Pipeline.

Downloads and configures weights for:
1. PaddleOCR PP-OCRv5 (det, rec, cls)
2. SegFormer (nvidia/segformer-b0-finetuned-ade-512-512)
3. Mask2Former (facebook/mask2former-swin-tiny-cityscapes-panoptic)
4. Grounding DINO (IDEA-Research/grounding-dino-tiny)
5. SAM 2 (sam2.1_hiera_small)
6. Qwen2.5-VL (Qwen/Qwen2.5-VL-3B-Instruct)
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path
from typing import Optional

from huggingface_hub import snapshot_download

from app.gis.ai_models.manifest import get_default_models_dir


def download_file(url: str, dest_path: Path) -> None:
    """Downloads a file with progress reporting."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url} -> {dest_path.name}...")

    def _reporthook(block_num, block_size, total_size):
        if total_size > 0:
            downloaded = block_num * block_size
            pct = min(100.0, downloaded * 100.0 / total_size)
            mb = downloaded / (1024 * 1024)
            total_mb = total_size / (1024 * 1024)
            sys.stdout.write(f"\r  [{pct:5.1f}%] {mb:.1f} / {total_mb:.1f} MB")
            sys.stdout.flush()

    urllib.request.urlretrieve(url, str(dest_path), reporthook=_reporthook)
    sys.stdout.write("\n")


def download_paddleocr(models_dir: Path) -> None:
    print("\n--- [1/6] Downloading PaddleOCR PP-OCRv5 Checkpoints ---")
    dest_dir = models_dir / "paddleocr_v5"
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Clean up any accidental nested models folders
    nested_models = dest_dir / "models"
    if nested_models.exists():
        shutil.rmtree(nested_models, ignore_errors=True)

    items = [
        (
            "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_det_infer.tar",
            "ch_PP-OCRv5_det_infer",
            "det.tar",
        ),
        (
            "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_rec_infer.tar",
            "ch_PP-OCRv5_rec_infer",
            "rec.tar",
        ),
        (
            "https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_cls_infer.tar",
            "ch_ppocr_mobile_v2.0_cls_infer",
            "cls.tar",
        ),
    ]

    for url, target_dir_name, tar_name in items:
        target_dir = dest_dir / target_dir_name
        if target_dir.exists() and any(target_dir.iterdir()):
            print(f"  Already downloaded: {target_dir_name}")
            continue

        tar_path = dest_dir / tar_name
        download_file(url, tar_path)

        print(f"  Extracting {tar_name}...")
        with tarfile.open(tar_path, "r") as tar:
            tar.extractall(path=dest_dir)

        # Detect extracted folder name
        extracted_name = tar_name.replace(".tar", "")
        extracted_folder = None
        for p in dest_dir.iterdir():
            if p.is_dir() and "infer" in p.name and p.name != target_dir_name:
                extracted_folder = p
                break

        if extracted_folder and extracted_folder.exists():
            if target_dir.exists():
                shutil.rmtree(target_dir)
            extracted_folder.rename(target_dir)

        if tar_path.exists():
            tar_path.unlink()

        print(f"  Extracted into {target_dir_name} successfully.")


def download_sam2(models_dir: Path) -> None:
    print("\n--- [2/6] Downloading SAM 2 (sam2.1_hiera_small) ---")
    dest_dir = models_dir / "sam2_hiera_small"
    dest_dir.mkdir(parents=True, exist_ok=True)

    pt_path = dest_dir / "sam2.1_hiera_small.pt"
    yaml_path = dest_dir / "sam2.1_hiera_s.yaml"

    if not pt_path.exists():
        download_file(
            "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
            pt_path,
        )
    else:
        print(f"  Already downloaded: {pt_path.name}")

    if not yaml_path.exists():
        download_file(
            "https://raw.githubusercontent.com/facebookresearch/sam2/main/sam2/configs/sam2.1/sam2.1_hiera_s.yaml",
            yaml_path,
        )
    else:
        print(f"  Already downloaded: {yaml_path.name}")


def download_segformer(models_dir: Path) -> None:
    print("\n--- [3/6] Downloading SegFormer (nvidia/segformer-b0-finetuned-ade-512-512) ---")
    dest_dir = models_dir / "segformer_b0"
    if (dest_dir / "model.safetensors").exists() or (dest_dir / "pytorch_model.bin").exists():
        print("  Already downloaded: SegFormer")
        return

    dest_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id="nvidia/segformer-b0-finetuned-ade-512-512",
        local_dir=str(dest_dir),
    )
    print("  SegFormer downloaded successfully.")


def download_mask2former(models_dir: Path) -> None:
    print("\n--- [4/6] Downloading Mask2Former (facebook/mask2former-swin-tiny-cityscapes-panoptic) ---")
    dest_dir = models_dir / "mask2former_tiny"
    if (dest_dir / "model.safetensors").exists() or (dest_dir / "pytorch_model.bin").exists():
        print("  Already downloaded: Mask2Former")
        return

    dest_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id="facebook/mask2former-swin-tiny-cityscapes-panoptic",
        local_dir=str(dest_dir),
    )
    print("  Mask2Former downloaded successfully.")


def download_grounding_dino(models_dir: Path) -> None:
    print("\n--- [5/6] Downloading Grounding DINO (IDEA-Research/grounding-dino-tiny) ---")
    dest_dir = models_dir / "grounding_dino_tiny"
    if (dest_dir / "model.safetensors").exists() or (dest_dir / "pytorch_model.bin").exists():
        print("  Already downloaded: Grounding DINO")
        return

    dest_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id="IDEA-Research/grounding-dino-tiny",
        local_dir=str(dest_dir),
    )
    print("  Grounding DINO downloaded successfully.")


def download_qwen_vlm(models_dir: Path) -> None:
    print("\n--- [6/6] Downloading Qwen2.5-VL (Qwen/Qwen2.5-VL-3B-Instruct) ---")
    dest_dir = models_dir / "qwen2_5_vl_3b"
    if (dest_dir / "model.safetensors").exists() or (dest_dir / "model-00001-of-00002.safetensors").exists():
        print("  Already downloaded: Qwen2.5-VL")
        return

    dest_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id="Qwen/Qwen2.5-VL-3B-Instruct",
        local_dir=str(dest_dir),
    )
    print("  Qwen2.5-VL downloaded successfully.")


def main():
    parser = argparse.ArgumentParser(description="Download model weights for LiveMap AI Pipeline")
    parser.add_argument(
        "--model",
        choices=["all", "paddleocr", "sam2", "segformer", "mask2former", "grounding_dino", "qwen_vlm"],
        default="all",
        help="Specify which model to download, or 'all'",
    )
    args = parser.parse_args()

    models_dir = get_default_models_dir()
    models_dir.mkdir(parents=True, exist_ok=True)
    print(f"Models Target Directory: {models_dir}")

    target = args.model
    if target in ("all", "paddleocr"):
        download_paddleocr(models_dir)
    if target in ("all", "sam2"):
        download_sam2(models_dir)
    if target in ("all", "segformer"):
        download_segformer(models_dir)
    if target in ("all", "mask2former"):
        download_mask2former(models_dir)
    if target in ("all", "grounding_dino"):
        download_grounding_dino(models_dir)
    if target in ("all", "qwen_vlm"):
        download_qwen_vlm(models_dir)

    print("\n=======================================================")
    print(" Checkpoints download process finished!")
    print("=======================================================")


if __name__ == "__main__":
    main()
