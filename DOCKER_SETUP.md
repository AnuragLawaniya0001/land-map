# LiveMap Single-Container Production Docker Setup

This document provides complete instructions for running the unified LiveMap application in a **Single Docker Container** with:
- **Frontend (Nginx + React UI):** Port `4800`
- **Backend (Python FastAPI + GIS Engine + AI Models):** Port `4801`
- **Process Manager:** `supervisord` managing both services concurrently in one container

---

## Architecture Overview

```
[ Browser / Client ]
         │
         ├── Port 4800 ──► Nginx (Serves React UI & Proxies /api/ to 127.0.0.1:4801)
         └── Port 4801 ──► Python FastAPI (Direct REST API & GIS Pipeline)
```

Both services run inside the same `livemap-app` container.

---

## Quick Start (Single Command)

### Step 1: Start Container
```bash
docker compose up --build -d
```

### Step 2: Access the Application
- **Frontend (Web Application):** http://localhost:4800
- **Backend API (Direct Access / Docs):** http://localhost:4801/docs
- **Health Check:** http://localhost:4800/health (or http://localhost:4801/health)

### Step 3: Stop Container
```bash
docker compose down
```

---

## Ports Configuration

| Service | Port | Description |
|---|---|---|
| **Frontend UI** | **`4800`** | Nginx web server serving compiled React production build and reverse-proxying `/api/` |
| **Backend API** | **`4801`** | Python FastAPI server running with Uvicorn multi-worker engine |

---

## GitHub Clone & Automated Model Download

When you or someone else clones this project from GitHub:
1. Model files are ignored in `.gitignore` (not committed to git).
2. On running `docker compose up --build -d`:
   - The container starts and automatically checks `/app/backend/models`.
   - If model checkpoints are missing, **it automatically downloads all 6 AI models** (PaddleOCR, SAM 2, SegFormer, Mask2Former, Grounding DINO, Qwen2.5-VL) directly from official repositories (HuggingFace, Meta, Baidu).
   - Because `./backend/models` is mapped as a volume, downloaded models are cached locally on host so they never need to be downloaded again on container restarts!

---

## Useful Docker Commands

```bash
# View real-time logs of both frontend & backend:
docker compose logs -f

# Check container status:
docker compose ps

# Rebuild and restart after changes:
docker compose up --build -d

# Restart container:
docker compose restart
```
