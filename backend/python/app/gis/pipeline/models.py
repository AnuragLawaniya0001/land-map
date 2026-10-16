"""GIS Processing Job Lifecycle and Execution Models.

Defines the durable job data structure, lifecycle states, truthful progress values,
phase execution metrics, and retry history.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class JobStatus(str, Enum):
    QUEUED = "queued"
    VALIDATING = "validating"
    PROCESSING = "processing"
    EXTRACTING = "extracting"
    RECONSTRUCTING_GEOMETRY = "reconstructing_geometry"
    SPATIAL_UNDERSTANDING = "spatial_understanding"
    QA_RUNNING = "qa_running"
    PREVIEW_READY = "preview_ready"
    AWAITING_REVIEW = "awaiting_review"
    COMMITTING = "committing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    REJECTED = "rejected"


# Truthful progress mapping for each stage
STAGE_PROGRESS_MAP: Dict[JobStatus, int] = {
    JobStatus.QUEUED: 0,
    JobStatus.VALIDATING: 10,
    JobStatus.PROCESSING: 15,
    JobStatus.EXTRACTING: 30,
    JobStatus.RECONSTRUCTING_GEOMETRY: 50,
    JobStatus.SPATIAL_UNDERSTANDING: 70,
    JobStatus.QA_RUNNING: 85,
    JobStatus.PREVIEW_READY: 90,
    JobStatus.AWAITING_REVIEW: 90,
    JobStatus.COMMITTING: 95,
    JobStatus.COMPLETED: 100,
}


@dataclass
class GISJob:
    job_id: str
    colony_id: str
    owner_id: str
    source_filename: str
    source_sha256: str
    source_mime: str = "application/pdf"
    source_size_bytes: int = 0
    status: JobStatus = JobStatus.QUEUED
    current_stage: str = "queued"
    progress_percent: int = 0
    options: Dict[str, Any] = field(default_factory=dict)
    phase_durations_sec: Dict[str, float] = field(default_factory=dict)
    created_at: str = ""
    started_at: Optional[str] = None
    updated_at: str = ""
    completed_at: Optional[str] = None
    retry_count: int = 0
    max_retries: int = 3
    retry_history: List[Dict[str, Any]] = field(default_factory=list)
    qa_grade: Optional[str] = None
    qa_summary: Optional[Dict[str, Any]] = None
    canonical_dataset_version: Optional[int] = None
    preview_data: Optional[Dict[str, Any]] = None
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    is_cancelled: bool = False

    def update_stage(self, new_status: JobStatus, stage_name: Optional[str] = None, timestamp: Optional[str] = None) -> None:
        self.status = new_status
        self.current_stage = stage_name or new_status.value
        if new_status in STAGE_PROGRESS_MAP:
            self.progress_percent = STAGE_PROGRESS_MAP[new_status]
        if timestamp:
            self.updated_at = timestamp

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "colony_id": self.colony_id,
            "owner_id": self.owner_id,
            "source_filename": self.source_filename,
            "source_sha256": self.source_sha256,
            "source_mime": self.source_mime,
            "source_size_bytes": self.source_size_bytes,
            "status": self.status.value if isinstance(self.status, JobStatus) else str(self.status),
            "current_stage": self.current_stage,
            "progress_percent": self.progress_percent,
            "options": self.options,
            "phase_durations_sec": self.phase_durations_sec,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "retry_history": self.retry_history,
            "qa_grade": self.qa_grade,
            "qa_summary": self.qa_summary,
            "canonical_dataset_version": self.canonical_dataset_version,
            "preview_data": self.preview_data,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "is_cancelled": self.is_cancelled,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> GISJob:
        status_val = data.get("status", JobStatus.QUEUED.value)
        try:
            status = JobStatus(status_val)
        except ValueError:
            status = JobStatus.QUEUED

        return cls(
            job_id=data["job_id"],
            colony_id=data["colony_id"],
            owner_id=data.get("owner_id", ""),
            source_filename=data.get("source_filename", ""),
            source_sha256=data.get("source_sha256", ""),
            source_mime=data.get("source_mime", "application/pdf"),
            source_size_bytes=int(data.get("source_size_bytes", 0)),
            status=status,
            current_stage=data.get("current_stage", "queued"),
            progress_percent=int(data.get("progress_percent", 0)),
            options=data.get("options") or {},
            phase_durations_sec=data.get("phase_durations_sec") or {},
            created_at=data.get("created_at", ""),
            started_at=data.get("started_at"),
            updated_at=data.get("updated_at", ""),
            completed_at=data.get("completed_at"),
            retry_count=int(data.get("retry_count", 0)),
            max_retries=int(data.get("max_retries", 3)),
            retry_history=data.get("retry_history") or [],
            qa_grade=data.get("qa_grade"),
            qa_summary=data.get("qa_summary"),
            canonical_dataset_version=data.get("canonical_dataset_version"),
            preview_data=data.get("preview_data"),
            errors=data.get("errors") or [],
            warnings=data.get("warnings") or [],
            is_cancelled=bool(data.get("is_cancelled", False)),
        )
