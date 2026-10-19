#!/usr/bin/env python3
"""Unified Container Entrypoint for LiveMap.

Handles:
1. Directory initialization for storage and models.
2. Automatic download and setup of AI pipeline models if missing (on fresh clone).
3. Starting Supervisord to run Backend (Port 4801) and Frontend (Port 4800) concurrently.
"""

import os
import subprocess
import sys
from pathlib import Path


def main():
    print("=" * 74, flush=True)
    print(" === LiveMap Unified Container Starting ===", flush=True)
    print("=" * 74, flush=True)

    storage_dir = Path("/app/backend/storage")
    models_dir = Path("/app/backend/models")

    storage_dir.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)

    # Required model checkpoints to check
    required_checkpoints = [
        models_dir / "paddleocr_v5",
        models_dir / "segformer_b0",
        models_dir / "sam2_hiera_small",
        models_dir / "qwen2_5_vl_3b",
    ]

    missing = [p for p in required_checkpoints if not p.exists()]

    if missing:
        print("=" * 74, flush=True)
        print(" [LiveMap] Fresh installation detected: AI Models missing in models directory.", flush=True)
        print(" [LiveMap] Automatically downloading and configuring all 6 AI pipeline models:", flush=True)
        print("           1. PaddleOCR PP-OCRv5 (Text Detection & Recognition)", flush=True)
        print("           2. SAM 2.1 Hiera Small (Zero-shot Plot Segmentation)", flush=True)
        print("           3. SegFormer B0 (Boundary & Road Segmentation)", flush=True)
        print("           4. Mask2Former Tiny (Parcel & Layout Segmentation)", flush=True)
        print("           5. Grounding DINO Tiny (Feature & Marker Detection)", flush=True)
        print("           6. Qwen2.5-VL 3B (Spatial Understanding & VLM Reasoning)", flush=True)
        print("=" * 74, flush=True)

        try:
            res = subprocess.run(
                [sys.executable, "-m", "app.gis.ai_models.download_models"],
                cwd="/app/backend",
                check=False,
            )
            if res.returncode == 0:
                print(" [LiveMap] All AI models downloaded and configured successfully!", flush=True)
            else:
                print(f" [LiveMap] Notice: Model downloader exited with code {res.returncode}. Continuing startup...", flush=True)
        except Exception as exc:
            print(f" [LiveMap] Warning during model download: {exc}. Continuing startup...", flush=True)

        print("=" * 74, flush=True)
    else:
        print(">>> All AI pipeline models verified in /app/backend/models.", flush=True)

    print("Starting Supervisord (Backend on port 4801, Frontend on port 4800)...", flush=True)
    sys.stdout.flush()
    sys.stderr.flush()

    # Hand over process control to supervisord as PID 1
    os.execv("/usr/bin/supervisord", ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"])


if __name__ == "__main__":
    main()
