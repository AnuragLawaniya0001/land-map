import json
import os
import sys
import numpy as np
from PIL import Image
from pathlib import Path

sys.path.insert(0, os.path.abspath("."))

from app.gis.ai_models.registry import AIModelRegistry
from app.gis.ingestion.coordinates import PageCoordinateTransform

def test_models():
    registry = AIModelRegistry.get_instance()
    print("Detected compute device:", registry.device)
    
    dummy_img = Image.new("RGB", (512, 512), color="white")
    transform = PageCoordinateTransform(
        page_number=1,
        width_points=512.0,
        height_points=512.0,
        render_scale_factor=1.0,
    )
    
    print("\n=== REAL SMOKE TEST INFERENCE ON ALL 6 ADAPTERS ===")
    
    # 1. PaddleOCR
    print("\n1. Testing PaddleOCR PP-OCRv5...")
    try:
        paddle_res = registry.paddle_ocr.detect_and_recognize(dummy_img, transform)
        print(f"   [SUCCESS] PaddleOCR returned {len(paddle_res)} detections")
    except Exception as e:
        print(f"   [FAILED] PaddleOCR: {e}")

    # 2. SegFormer
    print("\n2. Testing SegFormer-B0...")
    try:
        seg_res = registry.segformer.predict_segments(dummy_img, transform)
        print(f"   [SUCCESS] SegFormer returned {len(seg_res)} segment proposals")
    except Exception as e:
        print(f"   [FAILED] SegFormer: {e}")

    # 3. Mask2Former
    print("\n3. Testing Mask2Former Swin-Tiny...")
    try:
        m2f_res = registry.mask2former.predict_segments(dummy_img, transform)
        print(f"   [SUCCESS] Mask2Former returned {len(m2f_res)} segment proposals")
    except Exception as e:
        print(f"   [FAILED] Mask2Former: {e}")

    # 4. Grounding DINO
    print("\n4. Testing Grounding DINO Tiny...")
    try:
        gd_res = registry.grounding_dino.detect_regions(dummy_img, transform, ["plot", "road", "gate"])
        print(f"   [SUCCESS] Grounding DINO returned {len(gd_res)} proposals")
    except Exception as e:
        print(f"   [FAILED] Grounding DINO: {e}")

    # 5. SAM 2
    print("\n5. Testing SAM 2.1 Hiera Small...")
    try:
        sam_res = registry.sam2.refine_candidate_boundary(dummy_img, [50, 50, 200, 200], transform)
        print(f"   [SUCCESS] SAM 2 returned: {type(sam_res)}")
    except Exception as e:
        print(f"   [FAILED] SAM 2: {e}")

    # 6. Qwen2.5-VL
    print("\n6. Testing Qwen2.5-VL-3B-Instruct...")
    try:
        diag_qwen = registry.qwen_vlm.get_diagnostics()
        print(f"   Status: {diag_qwen.status}, message: {diag_qwen.diagnostic_message}")
        if diag_qwen.status.value == "configured":
            print("   Model configured with local weights, testing interpret_layout...")
            qwen_res = registry.qwen_vlm.interpret_layout(dummy_img)
            print(f"   [SUCCESS] Qwen2.5-VL returned: summary='{qwen_res.layout_summary[:60]}...'")
    except Exception as e:
        print(f"   [FAILED] Qwen2.5-VL: {e}")

if __name__ == "__main__":
    test_models()
