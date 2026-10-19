"""GIS Pipeline and Job Execution API Routes.

Exposes REST endpoints for asynchronous processing jobs, progress monitoring,
cancellation, retries, preview retrieval, approval commits, and health checks.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, Dict, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, UploadFile
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.gis.canonical.persistence import commit_canonical_dataset
from app.gis.pipeline.file_validator import validate_uploaded_file, compute_sha256
from app.gis.pipeline.job_service import GISJobService
from app.gis.pipeline.models import JobStatus
from app.gis.ai_models.registry import AIModelRegistry

logger = logging.getLogger("livemap.pipeline.routes")


def build_pipeline_job_router(
    db: Any,
    require_admin_dep: Any,
    owned_colony_fn: Callable[[str, Any], Any],
    now_iso_fn: Callable[[], str],
    job_service: Optional[GISJobService] = None,
) -> APIRouter:
    router = APIRouter()
    service = job_service or GISJobService(db)

    def _get(val: Any, key: str, default: Any = None) -> Any:
        if isinstance(val, dict):
            return val.get(key, default)
        return getattr(val, key, default)

    # -------------------------------------------------------------------------
    # HEALTH CHECK
    # -------------------------------------------------------------------------
    @router.get("/admin/gis/health")
    async def get_gis_health():
        db_ok = True
        try:
            if hasattr(db, "command"):
                await db.command("ping")
        except Exception:
            db_ok = False

        return {
            "status": "healthy" if db_ok else "degraded",
            "database_connected": db_ok,
            "pipeline_version": service.config.pipeline_version,
            "max_workers": service.config.max_concurrent_workers,
            "active_tasks": len(service._running_tasks),
            "ocr_enabled": service.config.ocr_enabled,
            "offline_mode": service.config.offline_mode,
        }

    @router.get("/admin/gis/models/diagnostics")
    async def get_gis_model_diagnostics():
        registry = AIModelRegistry.get_instance()
        return registry.run_all_diagnostics()


    # -------------------------------------------------------------------------
    # 1. CREATE PROCESSING JOB
    # -------------------------------------------------------------------------
    @router.post("/admin/colonies/{colonyId}/gis-jobs")
    async def create_processing_job(
        colonyId: str,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await owned_colony_fn(colonyId, user)

        async with request.form() as form:
            pdf_upload = form.get("layout_pdf") or form.get("file")
            companion_upload = form.get("cad_file") or form.get("companion")

            if not pdf_upload or not isinstance(pdf_upload, (UploadFile, StarletteUploadFile)):
                raise HTTPException(400, "Upload at least one primary PDF layout file ('layout_pdf' or 'file')")

            file_bytes = await pdf_upload.read()
            filename = pdf_upload.filename or "drawing.pdf"

            companion_bytes = None
            companion_name = None
            if companion_upload and isinstance(companion_upload, (UploadFile, StarletteUploadFile)):
                companion_bytes = await companion_upload.read()
                companion_name = companion_upload.filename

        # Security validation
        val_res = validate_uploaded_file(file_bytes, filename)
        if not val_res.is_valid:
            raise HTTPException(400, f"File validation failed: {val_res.error_message}")

        if companion_bytes and companion_name:
            comp_res = validate_uploaded_file(companion_bytes, companion_name)
            if not comp_res.is_valid:
                raise HTTPException(400, f"Companion file validation failed: {comp_res.error_message}")

        user_id = str(_get(user, "id") or _get(user, "_id") or "admin")
        sha256 = val_res.sha256

        # Create persistent job in MongoDB
        job = await service.create_job(
            colony_id=colonyId,
            owner_id=user_id,
            source_filename=val_res.sanitized_filename,
            source_sha256=sha256,
            source_size_bytes=val_res.size_bytes,
            source_mime=f"application/{val_res.detected_format}",
            options={"companion_filename": companion_name},
        )

        # Spawn asynchronous non-blocking worker
        service.spawn_job_worker(
            job=job,
            file_bytes=file_bytes,
            companion_bytes=companion_bytes,
            companion_filename=companion_name,
            colony=colony,
            auto_commit=False,
        )

        return {
            "success": True,
            "job_id": job.job_id,
            "colony_id": colonyId,
            "status": job.status.value,
            "current_stage": job.current_stage,
            "progress_percent": job.progress_percent,
            "source_sha256": sha256,
            "created_at": job.created_at,
        }

    # -------------------------------------------------------------------------
    # 2. GET JOB STATUS
    # -------------------------------------------------------------------------
    @router.get("/admin/colonies/{colonyId}/gis-jobs/{jobId}")
    async def get_job_status(
        colonyId: str,
        jobId: str,
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        job = await service.get_job(jobId)
        if not job or job.colony_id != colonyId:
            raise HTTPException(404, f"Job '{jobId}' not found for colony")

        return {
            "job_id": job.job_id,
            "colony_id": job.colony_id,
            "status": job.status.value,
            "current_stage": job.current_stage,
            "progress_percent": job.progress_percent,
            "started_at": job.started_at,
            "updated_at": job.updated_at,
            "completed_at": job.completed_at,
            "phase_durations_sec": job.phase_durations_sec,
            "retry_count": job.retry_count,
            "qa_grade": job.qa_grade,
            "qa_summary": job.qa_summary,
            "errors": job.errors,
            "warnings": job.warnings,
            "is_cancelled": job.is_cancelled,
        }

    # -------------------------------------------------------------------------
    # 3. GET PROCESSING RESULT / PREVIEW
    # -------------------------------------------------------------------------
    @router.get("/admin/colonies/{colonyId}/gis-jobs/{jobId}/result")
    async def get_job_result(
        colonyId: str,
        jobId: str,
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        job = await service.get_job(jobId)
        if not job or job.colony_id != colonyId:
            raise HTTPException(404, f"Job '{jobId}' not found for colony")

        if not job.preview_data:
            raise HTTPException(400, f"Job result is not yet available (current status: {job.status.value})")

        return {
            "job_id": job.job_id,
            "colony_id": job.colony_id,
            "status": job.status.value,
            "quality_grade": job.qa_grade,
            "preview_data": job.preview_data,
            "canonical_dataset_version": job.canonical_dataset_version,
            "qa_summary": job.qa_summary,
            "warnings": job.warnings,
            "errors": job.errors,
        }

    # -------------------------------------------------------------------------
    # 4. CANCEL JOB
    # -------------------------------------------------------------------------
    @router.post("/admin/colonies/{colonyId}/gis-jobs/{jobId}/cancel")
    async def cancel_processing_job(
        colonyId: str,
        jobId: str,
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        cancelled = await service.cancel_job(jobId)
        if not cancelled:
            raise HTTPException(400, f"Job '{jobId}' cannot be cancelled (may be already finished or not found)")

        return {"success": True, "job_id": jobId, "status": "cancelled"}

    # -------------------------------------------------------------------------
    # 5. RETRY FAILED JOB
    # -------------------------------------------------------------------------
    @router.post("/admin/colonies/{colonyId}/gis-jobs/{jobId}/retry")
    async def retry_processing_job(
        colonyId: str,
        jobId: str,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await owned_colony_fn(colonyId, user)
        job = await service.get_job(jobId)
        if not job or job.colony_id != colonyId:
            raise HTTPException(404, f"Job '{jobId}' not found")

        # Read optional re-uploaded file or use request data
        file_bytes = b""
        async with request.form() as form:
            pdf_upload = form.get("layout_pdf") or form.get("file")
            if pdf_upload and isinstance(pdf_upload, (UploadFile, StarletteUploadFile)):
                file_bytes = await pdf_upload.read()

        success, err = await service.retry_job(jobId, file_bytes=file_bytes, colony=colony)
        if not success:
            raise HTTPException(400, f"Cannot retry job: {err}")

        return {"success": True, "job_id": jobId, "status": "queued", "retry_count": job.retry_count}

    # -------------------------------------------------------------------------
    # 6. APPROVE & COMMIT JOB RESULT
    # -------------------------------------------------------------------------
    @router.post("/admin/colonies/{colonyId}/gis-jobs/{jobId}/commit")
    async def commit_job_result(
        colonyId: str,
        jobId: str,
        force_approval: bool = Query(False, description="Override review required state"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        job = await service.get_job(jobId)
        if not job or job.colony_id != colonyId:
            raise HTTPException(404, f"Job '{jobId}' not found")

        if not job.preview_data:
            raise HTTPException(400, "Job has no preview data ready to commit")

        if job.status == JobStatus.COMPLETED:
            raise HTTPException(400, "Job result has already been committed")

        now = now_iso_fn()
        user_id = str(_get(user, "id") or _get(user, "_id") or "admin")

        commit_res = await commit_canonical_dataset(
            db=db,
            colony_id=colonyId,
            preview_data=job.preview_data,
            source_filename=job.source_filename,
            created_by=user_id,
            now_iso=now,
            force_approval=force_approval,
        )

        job.status = JobStatus.COMPLETED
        job.current_stage = "completed"
        job.progress_percent = 100
        job.canonical_dataset_version = commit_res["dataset_version"]
        job.completed_at = now
        await service.update_job(job)

        return {
            "success": True,
            "job_id": jobId,
            "status": "completed",
            "canonical_dataset_version": commit_res["dataset_version"],
            "dataset": commit_res.get("dataset"),
        }

    # -------------------------------------------------------------------------
    # 7. JOB HISTORY
    # -------------------------------------------------------------------------
    @router.get("/admin/colonies/{colonyId}/gis-jobs")
    async def list_colony_jobs(
        colonyId: str,
        limit: int = Query(50, ge=1, le=100),
        skip: int = Query(0, ge=0),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        jobs = await service.list_jobs(colonyId, limit=limit, skip=skip)
        return {
            "colony_id": colonyId,
            "total": len(jobs),
            "jobs": [j.to_dict() for j in jobs],
        }

    return router
