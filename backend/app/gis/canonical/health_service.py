"""Production Health Check and Observability Service.

Implements Phase 15: Deep health checking of actual dependencies:
- MongoDB ping latency and connectivity
- Disk space availability
- GIS processing pipeline libraries (Shapely, PyMuPDF, ezdxf, pyproj)
- Structured diagnostic response.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from typing import Any, Dict

logger = logging.getLogger(__name__)


async def check_system_health(db: Any) -> Dict[str, Any]:
    """Inspects real system dependencies and returns operational status."""
    start_time = time.time()
    checks = {}
    is_healthy = True

    # 1. MongoDB Health & Ping Latency
    db_start = time.time()
    try:
        if hasattr(db, "command"):
            await db.command("ping")
        elif hasattr(db, "client") and hasattr(db.client, "admin"):
            await db.client.admin.command("ping")
        db_latency_ms = round((time.time() - db_start) * 1000, 2)
        checks["database"] = {
            "status": "UP",
            "latency_ms": db_latency_ms,
            "engine": "MongoDB",
        }
    except Exception as exc:
        is_healthy = False
        checks["database"] = {
            "status": "DOWN",
            "error": str(exc),
            "engine": "MongoDB",
        }

    # 2. Disk Space Availability
    try:
        usage = shutil.disk_usage(".")
        free_gb = round(usage.free / (1024 ** 3), 2)
        total_gb = round(usage.total / (1024 ** 3), 2)
        disk_ok = free_gb > 0.1  # Alert if less than 100MB free
        if not disk_ok:
            is_healthy = False
        checks["storage"] = {
            "status": "UP" if disk_ok else "DEGRADED",
            "free_gb": free_gb,
            "total_gb": total_gb,
            "percent_free": round((usage.free / usage.total) * 100, 1),
        }
    except Exception as exc:
        checks["storage"] = {"status": "UNKNOWN", "error": str(exc)}

    # 3. GIS Pipeline Engine Readiness
    gis_modules = {}
    for mod_name in ("shapely", "pymupdf", "ezdxf", "pyproj"):
        try:
            mod = __import__(mod_name)
            gis_modules[mod_name] = getattr(mod, "__version__", "loaded")
        except ImportError:
            is_healthy = False
            gis_modules[mod_name] = "MISSING"

    checks["gis_pipeline"] = {
        "status": "READY" if all(v != "MISSING" for v in gis_modules.values()) else "DEGRADED",
        "modules": gis_modules,
    }

    total_latency_ms = round((time.time() - start_time) * 1000, 2)

    return {
        "status": "HEALTHY" if is_healthy else "UNHEALTHY",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "latency_ms": total_latency_ms,
        "environment": os.getenv("ENVIRONMENT", "production"),
        "checks": checks,
    }
