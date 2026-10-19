#!/bin/bash
set -e

echo "=== LiveMap Container Starting ==="

# Ensure persistent directories exist
mkdir -p /app/backend/storage /app/backend/models

# Check if AI models are missing. If cloned freshly from GitHub, automatically download all models!
if [ ! -d "/app/backend/models/paddleocr_v5" ] || \
   [ ! -d "/app/backend/models/segformer_b0" ] || \
   [ ! -d "/app/backend/models/sam2_hiera_small" ] || \
   [ ! -d "/app/backend/models/qwen2_5_vl_3b" ]; then
    echo "=========================================================================="
    echo " [LiveMap] Fresh installation detected: AI Models missing in models directory."
    echo " [LiveMap] Automatically downloading and configuring all 6 AI pipeline models:"
    echo "           1. PaddleOCR PP-OCRv5 (Text Detection & Recognition)"
    echo "           2. SAM 2.1 Hiera Small (Zero-shot Plot Segmentation)"
    echo "           3. SegFormer B0 (Boundary & Road Segmentation)"
    echo "           4. Mask2Former Tiny (Parcel & Layout Segmentation)"
    echo "           5. Grounding DINO Tiny (Feature & Marker Detection)"
    echo "           6. Qwen2.5-VL 3B (Spatial Understanding & VLM Reasoning)"
    echo "=========================================================================="
    python -m app.gis.ai_models.download_models || echo "Warning: One or more models encountered download warnings, continuing startup..."
    echo "=========================================================================="
    echo " [LiveMap] AI Models download & setup completed successfully!"
    echo "=========================================================================="
else
    echo ">>> All AI pipeline models verified in /app/backend/models."
fi

echo "Starting Supervisord (Backend on port 4801, Frontend on port 4800)..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf