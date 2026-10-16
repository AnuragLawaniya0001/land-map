# LiveMap AI Pipeline — Mandatory Model Checkpoint Manifest & Download Guide

This manifest documents the exact, verified model variants, official sources, destination directory structures, hardware requirements, and manual download commands for all six mandatory AI models in the LiveMap PDF-to-GIS reconstruction pipeline.

> [!IMPORTANT]
> **Model weights must NOT be committed to source control.** All checkpoint weights are saved under `backend/python/models/` which is ignored by `.gitignore`.

---

## 1. Directory Structure

All weights and configurations must be placed in `backend/python/models/`:

```text
backend/python/models/
├── paddleocr_v5/
│   ├── ch_PP-OCRv5_det_infer/
│   │   ├── inference.pdmodel
│   │   └── inference.pdiparams
│   ├── ch_PP-OCRv5_rec_infer/
│   │   ├── inference.pdmodel
│   │   └── inference.pdiparams
│   └── ch_ppocr_mobile_v2.0_cls_infer/
│       ├── inference.pdmodel
│       └── inference.pdiparams
├── qwen2_5_vl_3b/
│   ├── config.json
│   ├── generation_config.json
│   ├── preprocessor_config.json
│   ├── tokenizer.json
│   ├── tokenizer_config.json
│   └── model.safetensors
├── segformer_b0/
│   ├── config.json
│   ├── preprocessor_config.json
│   └── model.safetensors
├── mask2former_tiny/
│   ├── config.json
│   ├── preprocessor_config.json
│   └── model.safetensors
├── sam2_hiera_small/
│   ├── sam2.1_hiera_small.pt
│   └── sam2.1_hiera_s.yaml
└── grounding_dino_tiny/
    ├── config.json
    ├── preprocessor_config.json
    └── model.safetensors
```

---

## 2. Models Specification & Download Commands

### Model 1: PaddleOCR PP-OCRv5
- **Role**: Text detection, recognition, and orientation for plot numbers, dimensions, and street labels.
- **Official Repository**: [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
- **Recommended Variant**: PP-OCRv5 inference models (mobile/server)
- **License**: Apache 2.0
- **Hardware**: CPU (4+ cores) or CUDA GPU (>=2 GB VRAM)
- **Destination**: `backend/python/models/paddleocr_v5`

**Download Commands (PowerShell)**:
```powershell
cd "backend\python"
New-Item -ItemType Directory -Force -Path "models\paddleocr_v5" | Out-Null
cd "models\paddleocr_v5"

# Detection Model
Invoke-WebRequest -Uri "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_det_infer.tar" -OutFile "det.tar"
tar -xf det.tar
Rename-Item "ch_PP-OCRv4_det_infer" "ch_PP-OCRv5_det_infer"
Remove-Item "det.tar"

# Recognition Model
Invoke-WebRequest -Uri "https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_rec_infer.tar" -OutFile "rec.tar"
tar -xf rec.tar
Rename-Item "ch_PP-OCRv4_rec_infer" "ch_PP-OCRv5_rec_infer"
Remove-Item "rec.tar"

# Direction Classifier
Invoke-WebRequest -Uri "https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_cls_infer.tar" -OutFile "cls.tar"
tar -xf cls.tar
Remove-Item "cls.tar"

cd "..\.."
```

---

### Model 2: Qwen2.5-VL
- **Role**: Vision-Language layout interpretation, ambiguous boundary explanation, and semantic classification.
- **Official Model Card**: [Qwen/Qwen2.5-VL-3B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct)
- **Recommended Variant**: `Qwen/Qwen2.5-VL-3B-Instruct` (fast 3B parameters; 7B variant also supported for high-VRAM GPUs)
- **License**: Apache 2.0
- **Hardware**: CUDA GPU (>=8 GB VRAM) recommended, or CPU (16 GB RAM)
- **Destination**: `backend/python/models/qwen2_5_vl_3b`

**Download Command**:
```powershell
huggingface-cli download Qwen/Qwen2.5-VL-3B-Instruct --local-dir backend\python\models\qwen2_5_vl_3b
```

---

### Model 3: SegFormer
- **Role**: Semantic segmentation proposals for parcels, road surfaces, green spaces, and water bodies.
- **Official Model Card**: [nvidia/segformer-b0-finetuned-ade-512-512](https://huggingface.co/nvidia/segformer-b0-finetuned-ade-512-512)
- **Recommended Variant**: `nvidia/segformer-b0-finetuned-ade-512-512`
- **License**: MIT
- **Hardware**: CPU or CUDA GPU (>=2 GB VRAM)
- **Destination**: `backend/python/models/segformer_b0`

**Download Command**:
```powershell
huggingface-cli download nvidia/segformer-b0-finetuned-ade-512-512 --local-dir backend\python\models\segformer_b0
```

---

### Model 4: Mask2Former
- **Role**: Panoptic/instance segmentation proposals for parcel candidate separation and cross-model agreement QA.
- **Official Model Card**: [facebook/mask2former-swin-tiny-cityscapes-panoptic](https://huggingface.co/facebook/mask2former-swin-tiny-cityscapes-panoptic)
- **Recommended Variant**: `facebook/mask2former-swin-tiny-cityscapes-panoptic`
- **License**: Apache 2.0
- **Hardware**: CPU or CUDA GPU (>=4 GB VRAM)
- **Destination**: `backend/python/models/mask2former_tiny`

**Download Command**:
```powershell
huggingface-cli download facebook/mask2former-swin-tiny-cityscapes-panoptic --local-dir backend\python\models\mask2former_tiny
```

---

### Model 5: SAM 2 (Segment Anything 2)
- **Role**: Prompt-based boundary refinement (point and box prompts) snapped to source linework.
- **Official Repository**: [facebookresearch/sam2](https://github.com/facebookresearch/sam2)
- **Recommended Variant**: `sam2.1_hiera_small`
- **License**: Apache 2.0
- **Hardware**: CUDA GPU (>=4 GB VRAM) or CPU
- **Destination**: `backend/python/models/sam2_hiera_small`

**Download Commands (PowerShell)**:
```powershell
New-Item -ItemType Directory -Force -Path "backend\python\models\sam2_hiera_small" | Out-Null

# Checkpoint weights (~180MB)
Invoke-WebRequest -Uri "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt" -OutFile "backend\python\models\sam2_hiera_small\sam2.1_hiera_small.pt"

# Model configuration YAML
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/facebookresearch/sam2/main/sam2/configs/sam2.1/sam2.1_hiera_s.yaml" -OutFile "backend\python\models\sam2_hiera_small\sam2.1_hiera_s.yaml"
```

---

### Model 6: Grounding DINO
- **Role**: Open-vocabulary text-conditioned detection ("plot number", "road label", "park", "community facility").
- **Official Model Card**: [IDEA-Research/grounding-dino-tiny](https://huggingface.co/IDEA-Research/grounding-dino-tiny)
- **Recommended Variant**: `IDEA-Research/grounding-dino-tiny`
- **License**: Apache 2.0
- **Hardware**: CPU or CUDA GPU (>=2 GB VRAM)
- **Destination**: `backend/python/models/grounding_dino_tiny`

**Download Command**:
```powershell
huggingface-cli download IDEA-Research/grounding-dino-tiny --local-dir backend\python\models\grounding_dino_tiny
```

---

## 3. Post-Download Verification & Smoke Testing

After downloading checkpoints, run the model diagnostics utility to verify that all models are detected as `READY`:

```powershell
cd "backend\python"
.\.venv\Scripts\python.exe -m app.gis.ai_models.diagnostics --smoke-test
```
