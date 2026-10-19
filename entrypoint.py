#!/usr/bin/env python3
"""Unified Container Entrypoint for LiveMap.

Handles:
1. Directory initialization for storage and models.
2. Immediate start of Supervisord so Frontend (Port 4800) and Backend (Port 4801)
   are live in under 2 seconds without showing 502 Bad Gateway.
3. Supervisord concurrently manages model downloading in the background.
"""

import os
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

    print(">>> Initialized storage and models directories.", flush=True)
    print(">>> Starting Supervisord (Frontend on 4800, Backend on 4801, Model Downloader in background)...", flush=True)
    sys.stdout.flush()
    sys.stderr.flush()

    # Hand over process control to supervisord as PID 1 immediately
    os.execv("/usr/bin/supervisord", ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"])


if __name__ == "__main__":
    main()
