"""GIS Model Management and Configuration.

Central configuration governing OCR engine capabilities, model versions,
inference concurrency, fallback policies, and offline startup.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import os
from typing import Any, Dict, Optional


@dataclass
class GISModelConfig:
    pipeline_version: str = "2.0.0"
    ocr_enabled: bool = True
    ocr_engine: str = "tesseract"
    ocr_language: str = "eng"
    vlm_enabled: bool = False
    vlm_model_name: Optional[str] = None
    max_concurrent_workers: int = 2
    job_timeout_seconds: int = 300
    max_retries: int = 3
    model_cache_dir: str = field(
        default_factory=lambda: os.getenv("GIS_MODEL_CACHE_DIR", "cache/models")
    )
    offline_mode: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pipeline_version": self.pipeline_version,
            "ocr_enabled": self.ocr_enabled,
            "ocr_engine": self.ocr_engine,
            "ocr_language": self.ocr_language,
            "vlm_enabled": self.vlm_enabled,
            "vlm_model_name": self.vlm_model_name,
            "max_concurrent_workers": self.max_concurrent_workers,
            "job_timeout_seconds": self.job_timeout_seconds,
            "max_retries": self.max_retries,
            "offline_mode": self.offline_mode,
        }

    @classmethod
    def from_env(cls) -> GISModelConfig:
        return cls(
            pipeline_version="2.0.0",
            ocr_enabled=os.getenv("GIS_OCR_ENABLED", "true").lower() in ("true", "1", "yes"),
            ocr_engine=os.getenv("GIS_OCR_ENGINE", "tesseract"),
            ocr_language=os.getenv("GIS_OCR_LANGUAGE", "eng"),
            vlm_enabled=os.getenv("GIS_VLM_ENABLED", "false").lower() in ("true", "1", "yes"),
            vlm_model_name=os.getenv("GIS_VLM_MODEL_NAME"),
            max_concurrent_workers=int(os.getenv("GIS_MAX_WORKERS", "2")),
            job_timeout_seconds=int(os.getenv("GIS_JOB_TIMEOUT", "300")),
            max_retries=int(os.getenv("GIS_MAX_RETRIES", "3")),
            offline_mode=os.getenv("GIS_OFFLINE_MODE", "true").lower() in ("true", "1", "yes"),
        )
