"""Isolated out-of-process runner for PaddleOCR.

Prevents native C++ crashes (0xc0000005 in phi.dll) from terminating the main web server process.
"""

import json
import os
import sys

# Critical flags for PaddlePaddle stability on Windows
os.environ["FLAGS_use_onednn"] = "0"
os.environ["FLAGS_use_mkldnn"] = "0"
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["PADDLE_DISABLE_DNNL"] = "1"

try:
    import torch  # Pre-load PyTorch DLLs cleanly to prevent DLL conflict with phi.dll
except Exception:
    pass

import numpy as np
from PIL import Image


def run_ocr(image_path: str, lang: str = "en") -> list:
    if not os.path.exists(image_path):
        return []

    from paddleocr import PaddleOCR  # type: ignore

    img = Image.open(image_path).convert("RGB")
    np_img = np.array(img)

    kwargs = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "enable_mkldnn": False,
        "lang": lang,
    }

    engine = PaddleOCR(**kwargs)

    if hasattr(engine, "predict"):
        raw_outputs = list(engine.predict(np_img))
    elif hasattr(engine, "ocr"):
        raw_outputs = engine.ocr(np_img)
    else:
        raw_outputs = []

    detections = []
    for page_output in raw_outputs:
        if not page_output:
            continue
        # PaddleOCR 3.x Dict format
        if isinstance(page_output, dict):
            texts = page_output.get("rec_texts") or []
            scores = page_output.get("rec_scores") or []
            polys = page_output.get("rec_polys") or page_output.get("dt_polys") or []
            boxes = page_output.get("rec_boxes")

            for i, text in enumerate(texts):
                conf = float(scores[i]) if i < len(scores) else 0.95
                if i < len(polys) and polys[i] is not None and len(polys[i]) >= 4:
                    box_pts = [[float(p[0]), float(p[1])] for p in polys[i]]
                    xs = [pt[0] for pt in box_pts]
                    ys = [pt[1] for pt in box_pts]
                    x1, x2 = float(min(xs)), float(max(xs))
                    y1, y2 = float(min(ys)), float(max(ys))
                elif boxes is not None and i < len(boxes):
                    b = boxes[i]
                    x1, y1, x2, y2 = float(b[0]), float(b[1]), float(b[2]), float(b[3])
                    box_pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
                else:
                    continue

                detections.append({
                    "text": str(text).strip(),
                    "confidence": conf,
                    "bbox_pixel": [int(x1), int(y1), int(x2), int(y2)],
                    "box_points": box_pts,
                })
        elif isinstance(page_output, list):
            for line in page_output:
                if not line or len(line) < 2:
                    continue
                box_pts = [[float(p[0]), float(p[1])] for p in line[0]]
                text, conf = line[1]
                xs = [pt[0] for pt in box_pts]
                ys = [pt[1] for pt in box_pts]
                detections.append({
                    "text": str(text).strip(),
                    "confidence": float(conf) if conf is not None else 0.9,
                    "bbox_pixel": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
                    "box_points": box_pts,
                })

    return detections


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2]
    ocr_lang = sys.argv[3] if len(sys.argv) > 3 else "en"

    try:
        results = run_ocr(in_path, ocr_lang)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(results, f)
        sys.exit(0)
    except Exception as exc:
        sys.stderr.write(f"OCR Runner error: {exc}\n")
        sys.exit(2)
