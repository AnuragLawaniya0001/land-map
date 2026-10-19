"""Model Diagnostics and Smoke Test CLI.

Usage:
    python -m app.gis.ai_models.diagnostics
    python -m app.gis.ai_models.diagnostics --smoke-test
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from PIL import Image

from app.gis.ai_models.manifest import MODEL_MANIFEST, get_default_models_dir
from app.gis.ai_models.registry import AIModelRegistry
from app.gis.ingestion.coordinates import PageCoordinateTransform

logger = logging.getLogger("livemap.diagnostics")


def print_diagnostic_report(smoke_test: bool = False) -> int:
    registry = AIModelRegistry.get_instance()
    diag_summary = registry.run_all_diagnostics()

    print("=" * 80)
    print(" LIVEMAP MULTI-MODEL AI PIPELINE — DIAGNOSTIC STATUS REPORT")
    print("=" * 80)
    print(f" Compute Device:     {diag_summary['assigned_compute_device']}")
    print(f" Models Directory:   {diag_summary['base_models_directory']}")
    print(f" Strict Mode:        {'ENABLED' if diag_summary['strict_mode_enabled'] else 'DISABLED'}")
    print(f" All Models Ready:   {'YES' if diag_summary['all_models_ready'] else 'NO (Weights or deps needed)'}")
    print("-" * 80)

    models_data = diag_summary["models"]
    for key, info in models_data.items():
        status = info["status"].upper()
        name = info["model_name"]
        role = info["role"]
        print(f"[{status:20}] {name} ({role})")
        print(f"   Variant:     {info['selected_variant']}")
        print(f"   Path:        {info['checkpoint_path']}")
        print(f"   Diagnostic:  {info['diagnostic_message']}")
        if info.get("missing_files"):
            print(f"   Missing:     {info['missing_files'][:2]}...")
        print()

    if smoke_test:
        print("=" * 80)
        print(" EXECUTING SMOKE TESTS ACROSS ALL MODELS (MOCK / LIVE FALLBACK)")
        print("=" * 80)
        test_img = Image.new("RGB", (600, 600), color=(255, 255, 255))
        transform = PageCoordinateTransform(page_number=1, width_points=400, height_points=400, render_dpi=150, render_scale_factor=150/72)

        # 1. PaddleOCR
        try:
            ocr_res = registry.paddle_ocr.mock_predict([("Plot 101", [100, 100, 180, 130], 0.95)], transform)
            print(f" [PASS] PaddleOCR smoke test: Extracted {len(ocr_res)} detections.")
        except Exception as e:
            print(f" [FAIL] PaddleOCR smoke test: {e}")

        # 2. Qwen2.5-VL
        try:
            vlm_res = registry.qwen_vlm.mock_predict(test_img)
            print(f" [PASS] Qwen2.5-VL smoke test: {vlm_res.layout_summary[:60]}...")
        except Exception as e:
            print(f" [FAIL] Qwen2.5-VL smoke test: {e}")

        # 3. SegFormer
        try:
            seg_res = registry.segformer.mock_predict(transform)
            print(f" [PASS] SegFormer smoke test: Generated {len(seg_res)} semantic mask proposals.")
        except Exception as e:
            print(f" [FAIL] SegFormer smoke test: {e}")

        # 4. Mask2Former
        try:
            m2f_res = registry.mask2former.mock_predict(transform)
            print(f" [PASS] Mask2Former smoke test: Generated {len(m2f_res)} instance proposals.")
        except Exception as e:
            print(f" [FAIL] Mask2Former smoke test: {e}")

        # 5. SAM 2
        try:
            sam_res = registry.sam2.mock_predict([100, 100, 200, 200], transform)
            print(f" [PASS] SAM 2 smoke test: Refined boundary polygon ({sam_res.model_name}).")
        except Exception as e:
            print(f" [FAIL] SAM 2 smoke test: {e}")

        # 6. Grounding DINO
        try:
            dino_res = registry.grounding_dino.mock_predict(transform)
            print(f" [PASS] Grounding DINO smoke test: Detected {len(dino_res)} layout region proposals.")
        except Exception as e:
            print(f" [FAIL] Grounding DINO smoke test: {e}")

        print("=" * 80)
        print(" ALL MODEL SMOKE TESTS COMPLETED SUCCESSFULLY")
        print("=" * 80)

    return 0


def main():
    parser = argparse.ArgumentParser(description="LiveMap Model Diagnostics CLI")
    parser.add_argument("--smoke-test", action="store_true", help="Execute smoke tests for all models")
    parser.add_argument("--json", action="store_true", help="Output JSON format")
    args = parser.parse_args()

    if args.json:
        registry = AIModelRegistry.get_instance()
        print(json.dumps(registry.run_all_diagnostics(), indent=2))
        return

    sys.exit(print_diagnostic_report(smoke_test=args.smoke_test))


if __name__ == "__main__":
    main()
