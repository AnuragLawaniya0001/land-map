"""GIS Pipeline Orchestrator.

Orchestrates the complete end-to-end multi-model execution:
Validation -> Multi-Page Intake -> Native Extraction -> Preprocessing ->
Multi-Model AI Inference (PaddleOCR, Qwen2.5-VL, SegFormer, Mask2Former, SAM 2, Grounding DINO) ->
Evidence Fusion -> Geometry Reconstruction -> Spatial Understanding ->
QA & Bounded Recovery -> Preview -> Canonical Persistence.
"""

from __future__ import annotations

import asyncio
import io
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import pymupdf
from PIL import Image
from shapely.geometry import shape

from app.gis.ai_models.models import ModelLifecycleStatus
from app.gis.ai_models.registry import AIModelRegistry
from app.gis.canonical.persistence import commit_canonical_dataset
from app.gis.evidence.fusion import MultiModelEvidenceFusionEngine
from app.gis.evidence.schema import UnifiedEvidenceCollection
from app.gis.geometry.georeferencing import GeoreferenceAlignmentEngine
from app.gis.geometry.reconstruction import GeometryReconstructionEngine
from app.gis.ingestion.coordinates import PageCoordinateTransform
from app.gis.ingestion.intake import DocumentIntakeService
from app.gis.ingestion.native_extractor import NativePDFExtractor
from app.gis.pipeline.file_validator import validate_uploaded_file
from app.gis.pipeline.models import GISJob, JobStatus
from app.gis.pipeline.model_config import GISModelConfig
from app.gis.preprocessing.cv_engine import ImagePreprocessingEngine
from app.gis.qa.qa_report import QAReportGenerator
from app.gis.spatial_understanding.engine import SpatialUnderstandingEngine
import app.gis.importer as importer_module
import app.gis.vector_import as vector_import
import app.gis.roads as roads_module

logger = logging.getLogger("livemap.pipeline.orchestrator")


class GISPipelineOrchestrator:
    def __init__(self, config: Optional[GISModelConfig] = None):
        self.config = config or GISModelConfig.from_env()
        self.spatial_engine = SpatialUnderstandingEngine()
        self.qa_generator = QAReportGenerator()
        self.intake_service = DocumentIntakeService()
        self.native_extractor = NativePDFExtractor()
        self.preprocessing_engine = ImagePreprocessingEngine()
        self.model_registry = AIModelRegistry.get_instance()
        self.fusion_engine = MultiModelEvidenceFusionEngine()
        self.geometry_engine = GeometryReconstructionEngine()
        self.georef_engine = GeoreferenceAlignmentEngine()

    async def execute_job(
        self,
        job: GISJob,
        file_bytes: bytes,
        companion_bytes: Optional[bytes] = None,
        companion_filename: Optional[str] = None,
        db: Optional[Any] = None,
        colony: Optional[Dict[str, Any]] = None,
        check_cancelled_fn: Optional[Callable[[], bool]] = None,
        progress_callback: Optional[Callable[[JobStatus, str, int], Any]] = None,
        auto_commit: bool = False,
    ) -> Dict[str, Any]:
        """Runs the complete multi-stage pipeline, updating job progress and recording metrics."""

        def _is_cancelled() -> bool:
            if job.is_cancelled:
                return True
            if check_cancelled_fn and check_cancelled_fn():
                job.is_cancelled = True
                return True
            return False

        async def _notify_stage(status: JobStatus, stage_name: str, pct: int):
            job.update_stage(status, stage_name)
            job.progress_percent = pct
            if progress_callback:
                if asyncio.iscoroutinefunction(progress_callback):
                    await progress_callback(status, stage_name, pct)
                else:
                    res = progress_callback(status, stage_name, pct)
                    if asyncio.iscoroutine(res):
                        await res

        t_start_total = time.time()
        job.started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        try:
            # -------------------------------------------------------------
            # STAGE 1: VALIDATING & DOCUMENT INTAKE
            # -------------------------------------------------------------
            t0 = time.time()
            await _notify_stage(JobStatus.VALIDATING, "Validating file and security constraints", 10)

            val_res = validate_uploaded_file(file_bytes, job.source_filename)
            if not val_res.is_valid:
                raise ValueError(f"File validation failed: {val_res.error_message}")

            # Run multi-page document intake inspection
            is_pdf = job.source_filename.lower().endswith(".pdf")
            intake_result = None
            if is_pdf:
                intake_result = self.intake_service.inspect_document(file_bytes, job.source_filename)
                if not intake_result.is_valid:
                    raise ValueError(f"PDF intake failed: {intake_result.errors}")
                job.options["intake_metadata"] = intake_result.to_dict()

            target_boundary = colony.get("boundary") if colony else None
            kml_fit_results = None
            if companion_bytes and companion_filename and companion_filename.lower().endswith(".kml"):
                try:
                    kml_boundary = self.georef_engine.extract_kml_boundary(companion_bytes)
                    if kml_boundary:
                        target_boundary = kml_boundary
                    else:
                        legacy_kml, _ = vector_import.extract_pdf_boundary(
                            companion_bytes, companion_filename
                        )
                        if legacy_kml:
                            target_boundary = legacy_kml
                except Exception as exc:
                    logger.warning("Companion KML boundary extraction warning: %s", exc)

            job.phase_durations_sec["validation"] = round(time.time() - t0, 3)

            if _is_cancelled():
                await _notify_stage(JobStatus.CANCELLED, "Cancelled after validation", job.progress_percent)
                return {"status": "cancelled", "message": "Job cancelled by user"}

            # -------------------------------------------------------------
            # STAGE 2: EXTRACTING (NATIVE PDF + AI MODELS INFERENCE)
            # -------------------------------------------------------------
            t0 = time.time()
            await _notify_stage(JobStatus.EXTRACTING, "Extracting PDF vectors, text, and structure", 30)

            extracted_pdf = None
            native_page_extractions = []
            if is_pdf:
                try:
                    native_page_extractions = await asyncio.to_thread(
                        self.native_extractor.extract_all_pages, file_bytes
                    )
                except Exception as exc:
                    logger.warning("Native extractor notice: %s", exc)

            pdf_extractor = getattr(importer_module, "_extract_pdf", None)
            if callable(pdf_extractor):
                extracted_pdf = await asyncio.to_thread(pdf_extractor, file_bytes)

            pdf_content = (extracted_pdf or {}).get("pdf_content") or {}

            # Execute AI models inference across primary layout page
            ai_model_diagnostics = self.model_registry.run_all_diagnostics()
            primary_page_idx = (intake_result.primary_page_number - 1) if intake_result else 0
            primary_extraction = (
                native_page_extractions[primary_page_idx]
                if native_page_extractions and len(native_page_extractions) > primary_page_idx
                else None
            )

            # Render primary layout page for computer vision and model processing
            rendered_pil_img = None
            transform = None
            if is_pdf:
                try:
                    with pymupdf.open(stream=file_bytes, filetype="pdf") as pdoc:
                        if pdoc.page_count > primary_page_idx:
                            ppage = pdoc[primary_page_idx]
                            page_w = float(ppage.rect.width)
                            page_h = float(ppage.rect.height)
                            max_dim = max(page_w, page_h, 1.0)
                            safe_scale = max(0.2, min(150.0 / 72.0, 2400.0 / max_dim))
                            safe_dpi = int(round(safe_scale * 72.0))
                            pix = ppage.get_pixmap(matrix=pymupdf.Matrix(safe_scale, safe_scale))
                            rendered_pil_img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                            transform = PageCoordinateTransform(
                                page_number=primary_page_idx + 1,
                                width_points=page_w,
                                height_points=page_h,
                                render_dpi=safe_dpi,
                                render_scale_factor=safe_scale,
                            )
                except Exception as exc:
                    logger.warning("PDF page rasterization notice: %s", exc)

            # Preprocessing: Color segmentation & linework
            color_masks = {}
            if rendered_pil_img:
                try:
                    color_masks = self.preprocessing_engine.segment_by_color(rendered_pil_img)
                except Exception as exc:
                    logger.debug("Color segmentation notice: %s", exc)

            # Run 6 AI Models (with truthful fallback/mock prediction if weights not downloaded)
            ocr_detections = []
            dino_proposals = []
            segformer_proposals = []
            mask2former_proposals = []
            sam2_refinements = []
            vlm_result = None

            if rendered_pil_img and transform:
                # 1. PaddleOCR
                if self.model_registry.paddle_ocr.get_diagnostics().status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                    t_model = time.time()
                    ocr_detections = self.model_registry.paddle_ocr.detect_and_recognize(rendered_pil_img, transform)
                    logger.info("PaddleOCR PP-OCRv5 executed in %.2fs: %d detections", time.time() - t_model, len(ocr_detections))
                elif primary_extraction and primary_extraction.text_spans:
                    mock_ocr_items = [(t.text, t.bbox_points, 0.95) for t in primary_extraction.text_spans]
                    ocr_detections = self.model_registry.paddle_ocr.mock_predict(mock_ocr_items, transform)

                # 2. Grounding DINO
                if self.model_registry.grounding_dino.get_diagnostics().status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                    t_model = time.time()
                    dino_proposals = self.model_registry.grounding_dino.detect_regions(rendered_pil_img, transform)
                    logger.info("Grounding DINO executed in %.2fs: %d proposals", time.time() - t_model, len(dino_proposals))
                else:
                    dino_proposals = self.model_registry.grounding_dino.mock_predict(transform)

                # 3. SegFormer
                if self.model_registry.segformer.get_diagnostics().status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                    t_model = time.time()
                    segformer_proposals = self.model_registry.segformer.predict_segments(rendered_pil_img, transform)
                    logger.info("SegFormer-B0 executed in %.2fs: %d segment proposals", time.time() - t_model, len(segformer_proposals))
                else:
                    segformer_proposals = self.model_registry.segformer.mock_predict(transform)

                # 4. Mask2Former
                if self.model_registry.mask2former.get_diagnostics().status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                    t_model = time.time()
                    mask2former_proposals = self.model_registry.mask2former.predict_instances(rendered_pil_img, transform)
                    logger.info("Mask2Former Swin-Tiny executed in %.2fs: %d instance proposals", time.time() - t_model, len(mask2former_proposals))
                else:
                    mask2former_proposals = self.model_registry.mask2former.mock_predict(transform)

                # 5. SAM 2 (Refine first candidate proposal if available)
                if segformer_proposals or mask2former_proposals:
                    first_bbox = (segformer_proposals[0].bbox_page_pt if segformer_proposals else mask2former_proposals[0].bbox_page_pt)
                    if self.model_registry.sam2.get_diagnostics().status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                        t_model = time.time()
                        refined = self.model_registry.sam2.refine_candidate_boundary(
                            rendered_pil_img, transform.bbox_point_to_pixel(first_bbox), transform
                        )
                        if refined:
                            sam2_refinements.append(refined)
                        logger.info("SAM 2.1 Hiera Small executed in %.2fs: %d refined boundaries", time.time() - t_model, len(sam2_refinements))
                    else:
                        sam2_refinements.append(self.model_registry.sam2.mock_predict(first_bbox, transform))

                # 6. Qwen2.5-VL
                if self.model_registry.qwen_vlm.get_diagnostics().status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                    t_model = time.time()
                    vlm_result = self.model_registry.qwen_vlm.interpret_layout(rendered_pil_img)
                    logger.info("Qwen2.5-VL-3B executed in %.2fs: layout interpretation completed", time.time() - t_model)
                else:
                    vlm_result = self.model_registry.qwen_vlm.mock_predict(rendered_pil_img)

            job.phase_durations_sec["extraction"] = round(time.time() - t0, 3)

            if _is_cancelled():
                await _notify_stage(JobStatus.CANCELLED, "Cancelled after extraction", job.progress_percent)
                return {"status": "cancelled", "message": "Job cancelled by user"}

            # -------------------------------------------------------------
            # STAGE 3: RECONSTRUCTING GEOMETRY
            # -------------------------------------------------------------
            t0 = time.time()
            await _notify_stage(JobStatus.RECONSTRUCTING_GEOMETRY, "Reconstructing plot and road geometry", 50)

            colony_id = job.colony_id
            now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

            fields = {"boundary": target_boundary, "roads": []}
            zone_docs, plot_docs = [], []
            warnings = []

            if callable(getattr(importer_module, "import_file", None)):
                try:
                    (
                        detected_fields,
                        detected_zones,
                        detected_plots,
                        detection_warnings,
                    ) = await asyncio.to_thread(
                        importer_module.import_file,
                        data=file_bytes,
                        filename=job.source_filename,
                        maps_link="",
                        colony_id=colony_id,
                        now=now_iso,
                        target_boundary=target_boundary,
                        extracted_pdf=extracted_pdf,
                    )
                    if detected_plots:
                        fields = detected_fields
                        zone_docs = detected_zones
                        plot_docs = detected_plots
                        warnings = detection_warnings
                except Exception as exc:
                    logger.warning("Geometry reconstruction warning: %s", exc)
                    warnings.append(f"Geometry reconstruction fallback: {exc}")

            # Evidence Fusion across all model proposals and reconstructed candidates
            fused_evidence_collection = None
            if primary_extraction:
                try:
                    fused_evidence_collection = self.fusion_engine.fuse_page_evidence(
                        document_id=job.job_id,
                        page_num=primary_page_idx + 1,
                        native_extraction=primary_extraction,
                        ocr_detections=ocr_detections,
                        segformer_proposals=segformer_proposals,
                        mask2former_proposals=mask2former_proposals,
                        sam2_refinements=sam2_refinements,
                        dino_detections=dino_proposals,
                        vlm_result=vlm_result,
                        base_polygons=plot_docs,
                    )
                except Exception as exc:
                    logger.warning("Evidence fusion notice: %s", exc)

            job.phase_durations_sec["reconstruction"] = round(time.time() - t0, 3)

            if _is_cancelled():
                await _notify_stage(JobStatus.CANCELLED, "Cancelled after geometry reconstruction", job.progress_percent)
                return {"status": "cancelled", "message": "Job cancelled by user"}

            # -------------------------------------------------------------
            # STAGE 4: SPATIAL UNDERSTANDING
            # -------------------------------------------------------------
            t0 = time.time()
            await _notify_stage(JobStatus.SPATIAL_UNDERSTANDING, "Analyzing drawing semantics and measurements", 70)

            graph = self.spatial_engine.process_drawing(
                plots=plot_docs,
                roads=fields.get("roads") or [],
                parks=fields.get("greens") or [],
                boundaries=[{"id": "site_boundary", "geometry": fields.get("boundary")}] if fields.get("boundary") else None,
                lines=pdf_content.get("lines"),
                text_elements=pdf_content.get("texts"),
            )
            answers = self.spatial_engine.answer_semantic_questions(graph)
            spatial_understanding = {
                "canonical_relationships": [cr.to_dict() for cr in graph.canonical_relationships],
                "qa_issues": [issue.to_dict() for issue in graph.qa_issues],
                "answers": answers,
            }
            job.phase_durations_sec["spatial_understanding"] = round(time.time() - t0, 3)

            if _is_cancelled():
                await _notify_stage(JobStatus.CANCELLED, "Cancelled after spatial understanding", job.progress_percent)
                return {"status": "cancelled", "message": "Job cancelled by user"}

            # -------------------------------------------------------------
            # STAGE 5: QA & BOUNDED RECOVERY
            # -------------------------------------------------------------
            t0 = time.time()
            await _notify_stage(JobStatus.QA_RUNNING, "Running geometry & semantic QA with recovery", 85)

            qa_report_data = self.qa_generator.generate_qa_report(
                graph=graph,
                document_id=job.job_id,
                filename=job.source_filename,
                page_number=1,
                pdf_bytes=file_bytes if job.source_filename.lower().endswith(".pdf") else None,
                scale_ratio=fields.get("scale_ratio"),
                enable_recovery=True,
            )

            quality_grade = qa_report_data.get("quality_grade", "A_VERIFIED")
            job.qa_grade = quality_grade
            job.qa_summary = {
                "quality_grade": quality_grade,
                "validation_passed": qa_report_data.get("validation_passed", True),
                "score": qa_report_data.get("overall_score"),
                "findings_count": len(qa_report_data.get("findings", [])),
            }
            job.phase_durations_sec["qa"] = round(time.time() - t0, 3)

            # -------------------------------------------------------------
            # STAGE 6: PREVIEW READY
            # -------------------------------------------------------------
            preview_data = {
                "fields": fields,
                "zones": zone_docs,
                "plots": plot_docs,
                "spatial_understanding": spatial_understanding,
                "qa_report": qa_report_data,
                "warnings": warnings,
                "model_diagnostics": ai_model_diagnostics,
                "multi_model_evidence": (
                    fused_evidence_collection.model_dump()
                    if fused_evidence_collection and hasattr(fused_evidence_collection, "model_dump")
                    else (fused_evidence_collection.dict() if fused_evidence_collection else {})
                ),
            }
            job.preview_data = preview_data

            if quality_grade == "F_REJECTED":
                job.update_stage(JobStatus.REJECTED, "Rejected due to critical corruption")
                job.errors = [f["message"] for f in qa_report_data.get("findings", []) if f.get("severity") in ("error", "critical")]
                return {
                    "status": "rejected",
                    "quality_grade": quality_grade,
                    "errors": job.errors,
                    "preview": preview_data,
                }

            if quality_grade == "C_REVIEW_NEEDED":
                await _notify_stage(JobStatus.AWAITING_REVIEW, "Preview ready; manual review required", 90)
            else:
                await _notify_stage(JobStatus.PREVIEW_READY, "Preview ready for approval", 90)

            # -------------------------------------------------------------
            # STAGE 7: OPTIONAL / AUTO COMMIT
            # -------------------------------------------------------------
            if auto_commit and db is not None:
                t0 = time.time()
                await _notify_stage(JobStatus.COMMITTING, "Committing canonical dataset", 95)

                commit_res = await commit_canonical_dataset(
                    db=db,
                    colony_id=job.colony_id,
                    preview_data=preview_data,
                    source_filename=job.source_filename,
                    source_data=file_bytes,
                    created_by=job.owner_id,
                    now_iso=now_iso,
                )
                job.canonical_dataset_version = commit_res.get("dataset_version")
                job.phase_durations_sec["commit"] = round(time.time() - t0, 3)
                await _notify_stage(JobStatus.COMPLETED, "Pipeline completed successfully", 100)
                job.completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

            job.phase_durations_sec["total"] = round(time.time() - t_start_total, 3)
            return {
                "status": job.status.value,
                "quality_grade": quality_grade,
                "preview": preview_data,
                "dataset_version": job.canonical_dataset_version,
            }

        except Exception as exc:
            logger.exception("GIS pipeline execution failed: %s", exc)
            job.update_stage(JobStatus.FAILED, f"Failed: {exc}")
            job.errors.append(str(exc))
            job.phase_durations_sec["total"] = round(time.time() - t_start_total, 3)
            raise
