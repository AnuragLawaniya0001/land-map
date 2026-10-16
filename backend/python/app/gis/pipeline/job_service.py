"""GIS Job Service and Persistent Task Management.

Provides MongoDB-backed job lifecycle persistence, bounded worker concurrency,
graceful cancellation checkpoints, restart recovery, and retry controls.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from app.gis.canonical.persistence import _execute_find_list
from app.gis.pipeline.models import GISJob, JobStatus
from app.gis.pipeline.model_config import GISModelConfig
from app.gis.pipeline.orchestrator import GISPipelineOrchestrator

logger = logging.getLogger("livemap.pipeline.job_service")


class GISJobService:
    def __init__(self, db: Any, config: Optional[GISModelConfig] = None):
        self.db = db
        self.config = config or GISModelConfig.from_env()
        self.orchestrator = GISPipelineOrchestrator(self.config)
        self.semaphore = asyncio.Semaphore(self.config.max_concurrent_workers)
        self._running_tasks: Dict[str, asyncio.Task] = {}
        self._cancellation_requested: set[str] = set()

    async def ensure_indexes(self) -> None:
        try:
            if hasattr(self.db["gis_jobs"], "create_index"):
                await self.db["gis_jobs"].create_index([("job_id", 1)], unique=True)
                await self.db["gis_jobs"].create_index([("colony_id", 1), ("created_at", -1)])
                await self.db["gis_jobs"].create_index([("colony_id", 1), ("status", 1)])
                await self.db["gis_jobs"].create_index([("source_sha256", 1)])
        except Exception as exc:
            logger.warning("Job indexes notice: %s", exc)

    async def create_job(
        self,
        colony_id: str,
        owner_id: str,
        source_filename: str,
        source_sha256: str,
        source_size_bytes: int,
        source_mime: str = "application/pdf",
        options: Optional[Dict[str, Any]] = None,
    ) -> GISJob:
        await self.ensure_indexes()
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        job_id = f"job-{uuid.uuid4().hex[:12]}"
        job = GISJob(
            job_id=job_id,
            colony_id=colony_id,
            owner_id=owner_id,
            source_filename=source_filename,
            source_sha256=source_sha256,
            source_mime=source_mime,
            source_size_bytes=source_size_bytes,
            status=JobStatus.QUEUED,
            current_stage="queued",
            progress_percent=0,
            options=options or {},
            created_at=now,
            updated_at=now,
            max_retries=self.config.max_retries,
        )
        await self.db["gis_jobs"].insert_one(job.to_dict())
        return job

    async def get_job(self, job_id: str) -> Optional[GISJob]:
        data = await self.db["gis_jobs"].find_one({"job_id": job_id})
        return GISJob.from_dict(data) if data else None

    async def update_job(self, job: GISJob) -> None:
        job.updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        await self.db["gis_jobs"].update_one(
            {"job_id": job.job_id},
            {"$set": job.to_dict()},
        )

    def is_job_cancelled(self, job_id: str) -> bool:
        return job_id in self._cancellation_requested

    async def cancel_job(self, job_id: str) -> bool:
        job = await self.get_job(job_id)
        if not job:
            return False

        if job.status == JobStatus.CANCELLED:
            return True

        if job.status in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.REJECTED):
            return False

        self._cancellation_requested.add(job_id)
        job.is_cancelled = True
        job.update_stage(JobStatus.CANCELLED, "Cancelled by user")
        job.completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        await self.update_job(job)

        if job_id in self._running_tasks:
            self._running_tasks[job_id].cancel()
            self._running_tasks.pop(job_id, None)

        return True

    async def retry_job(self, job_id: str, file_bytes: bytes, colony: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        job = await self.get_job(job_id)
        if not job:
            return False, "Job not found"

        if job.status not in (JobStatus.FAILED, JobStatus.CANCELLED):
            return False, f"Job cannot be retried from state '{job.status.value}'"

        if job.retry_count >= job.max_retries:
            return False, f"Job reached maximum retry limit ({job.max_retries})"

        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        job.retry_history.append({
            "retry_number": job.retry_count + 1,
            "timestamp": now,
            "previous_errors": list(job.errors),
        })
        job.retry_count += 1
        job.errors = []
        job.is_cancelled = False
        self._cancellation_requested.discard(job_id)
        job.update_stage(JobStatus.QUEUED, "Queued for retry")
        job.progress_percent = 0
        job.started_at = None
        job.completed_at = None
        await self.update_job(job)

        self.spawn_job_worker(job, file_bytes, colony=colony)
        return True, None

    async def recover_stale_jobs(self) -> int:
        """Recovers or marks failed any orphaned jobs that were in-flight during API crash."""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        non_terminal_statuses = [
            JobStatus.PROCESSING.value,
            JobStatus.EXTRACTING.value,
            JobStatus.RECONSTRUCTING_GEOMETRY.value,
            JobStatus.SPATIAL_UNDERSTANDING.value,
            JobStatus.QA_RUNNING.value,
        ]
        stale_jobs = await _execute_find_list(
            self.db["gis_jobs"],
            {"status": {"$in": non_terminal_statuses}}
        )
        recovered_count = 0
        for doc in stale_jobs:
            job = GISJob.from_dict(doc)
            job.update_stage(JobStatus.FAILED, "Interrupted by server restart")
            job.errors.append("Processing interrupted by system restart. Eligible for retry.")
            job.completed_at = now
            await self.update_job(job)
            recovered_count += 1
        return recovered_count

    async def list_jobs(self, colony_id: str, limit: int = 50, skip: int = 0) -> List[GISJob]:
        all_jobs = await _execute_find_list(
            self.db["gis_jobs"],
            {"colony_id": colony_id}
        )
        sorted_jobs = sorted(all_jobs, key=lambda j: j.get("created_at", ""), reverse=True)
        paginated = sorted_jobs[skip : skip + limit]
        return [GISJob.from_dict(j) for j in paginated]

    def spawn_job_worker(
        self,
        job: GISJob,
        file_bytes: bytes,
        companion_bytes: Optional[bytes] = None,
        companion_filename: Optional[str] = None,
        colony: Optional[Dict[str, Any]] = None,
        auto_commit: bool = False,
    ) -> asyncio.Task:
        """Spawns non-blocking worker task managed by bounded semaphore."""
        async def _worker():
            async with self.semaphore:
                try:
                    await self.orchestrator.execute_job(
                        job=job,
                        file_bytes=file_bytes,
                        companion_bytes=companion_bytes,
                        companion_filename=companion_filename,
                        db=self.db,
                        colony=colony,
                        check_cancelled_fn=lambda: self.is_job_cancelled(job.job_id),
                        progress_callback=lambda s, msg, pct: self.update_job(job),
                        auto_commit=auto_commit,
                    )
                except asyncio.CancelledError:
                    job.update_stage(JobStatus.CANCELLED, "Worker task cancelled")
                except Exception as exc:
                    logger.exception("Worker error on job %s: %s", job.job_id, exc)
                finally:
                    await self.update_job(job)
                    self._running_tasks.pop(job.job_id, None)
                    self._cancellation_requested.discard(job.job_id)

        task = asyncio.create_task(_worker())
        self._running_tasks[job.job_id] = task
        return task
