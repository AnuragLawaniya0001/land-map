"""Comprehensive Machine-Readable QA Report Generator.

Orchestrates geometry QA, semantic QA, confidence calibration, recovery retry pipeline,
and benchmark evaluation into a single structured report.
"""

from __future__ import annotations

import datetime
from typing import Any, Dict, List, Optional, Tuple

from app.gis.qa.confidence_calibration import ConfidenceCalibrator
from app.gis.qa.geometry_qa import GeometryQAChecker
from app.gis.qa.golden_dataset import BenchmarkEvaluator, GoldenDocumentFixture
from app.gis.qa.models import QAFinding, QASeverity, QualityGrade, RecoveryRecord
from app.gis.qa.recovery_pipeline import RecoveryPipeline
from app.gis.qa.semantic_qa import SemanticQAChecker
from app.gis.spatial_understanding.models import (
    EntityType,
    SemanticDrawingGraph,
    ValidationStatus,
)

PIPELINE_VERSION = "Phase6-2026.10-QACalibrated"


class QAReportGenerator:
    """Master orchestrator for colony layout QA, confidence calibration, and recovery."""

    def __init__(
        self,
        geometry_checker: Optional[GeometryQAChecker] = None,
        semantic_checker: Optional[SemanticQAChecker] = None,
        calibrator: Optional[ConfidenceCalibrator] = None,
        recovery_pipeline: Optional[RecoveryPipeline] = None,
        benchmark_evaluator: Optional[BenchmarkEvaluator] = None,
    ):
        self.geometry_checker = geometry_checker or GeometryQAChecker()
        self.semantic_checker = semantic_checker or SemanticQAChecker()
        self.calibrator = calibrator or ConfidenceCalibrator()
        self.recovery_pipeline = recovery_pipeline or RecoveryPipeline()
        self.benchmark_evaluator = benchmark_evaluator or BenchmarkEvaluator()

    def generate_qa_report(
        self,
        graph: SemanticDrawingGraph,
        document_id: str,
        filename: str,
        page_number: int = 1,
        pdf_bytes: Optional[bytes] = None,
        golden_fixture: Optional[GoldenDocumentFixture] = None,
        scale_ratio: Optional[float] = None,
        enable_recovery: bool = True,
    ) -> Dict[str, Any]:
        """Executes full Phase 6 QA pipeline and returns standardized machine-readable report."""
        plots = [e for e in graph.entities.values() if e.entity_type == EntityType.PLOT]
        roads = [e for e in graph.entities.values() if e.entity_type == EntityType.ROAD]
        boundaries = [e for e in graph.entities.values() if e.entity_type == EntityType.BOUNDARY]
        edges = [e for e in graph.entities.values() if e.entity_type == EntityType.EDGE]

        # 1. Geometry QA Checks
        geom_findings = self.geometry_checker.run_all_checks(
            plots=plots,
            roads=roads,
            boundaries=boundaries,
            edges=edges,
            scale_ratio=scale_ratio,
        )

        # 2. Semantic & Measurement QA Checks
        sem_findings = self.semantic_checker.run_all_checks(
            graph=graph,
            scale_ratio=scale_ratio,
        )

        all_findings = geom_findings + sem_findings

        # 3. Recovery & Retry Pipeline (if enabled)
        recovery_records: List[RecoveryRecord] = []
        if enable_recovery and all_findings:
            recovery_records = self.recovery_pipeline.run_recovery(
                findings=all_findings,
                graph=graph,
                pdf_bytes=pdf_bytes,
            )

        # 4. Calibrate Entities & Relationships with Rule Gates
        verified_plots_count = 0
        for plot in plots:
            calibrated_status = self.calibrator.calibrate_entity(plot, all_findings)
            plot.validation_status = calibrated_status
            if calibrated_status == ValidationStatus.VERIFIED:
                verified_plots_count += 1

        for rel in graph.relationships.values():
            rel.validation_status = self.calibrator.calibrate_relationship(rel, all_findings)

        # 5. Determine Overall Quality Grade
        quality_grade = self.calibrator.compute_quality_grade(
            findings=all_findings,
            total_plots=len(plots),
            verified_plots=verified_plots_count,
        )

        # 6. Benchmark Evaluation against Golden Dataset (if fixture provided)
        benchmark_metrics = None
        if golden_fixture:
            benchmark_metrics = self.benchmark_evaluator.evaluate(graph, golden_fixture).to_dict()

        # 7. Compile Machine-Readable Report
        critical_count = sum(1 for f in all_findings if f.severity == QASeverity.CRITICAL)
        error_count = sum(1 for f in all_findings if f.severity == QASeverity.ERROR)
        warning_count = sum(1 for f in all_findings if f.severity == QASeverity.WARNING)
        info_count = sum(1 for f in all_findings if f.severity == QASeverity.INFO)

        total_dimensions = len(graph.canonical_relationships)
        verified_dimensions = sum(
            1 for cr in graph.canonical_relationships
            if cr.association_status == ValidationStatus.VERIFIED.value
        )

        report = {
            "document_info": {
                "document_id": document_id,
                "filename": filename,
                "page_number": page_number,
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "pipeline_version": PIPELINE_VERSION,
            },
            "quality_grade": quality_grade.value,
            "validation_passed": (quality_grade in (QualityGrade.A_VERIFIED, QualityGrade.B_ACCEPTABLE)),
            "summary": {
                "total_plots": len(plots),
                "verified_plots": verified_plots_count,
                "candidate_plots": sum(1 for p in plots if p.validation_status == ValidationStatus.CANDIDATE),
                "review_required_plots": sum(1 for p in plots if p.validation_status == ValidationStatus.REVIEW_REQUIRED),
                "total_dimensions": total_dimensions,
                "verified_dimensions": verified_dimensions,
                "unresolved_dimensions": total_dimensions - verified_dimensions,
                "total_findings": len(all_findings),
                "findings_by_severity": {
                    "critical": critical_count,
                    "error": error_count,
                    "warning": warning_count,
                    "info": info_count,
                },
                "recovery_actions_attempted": len(recovery_records),
                "recovery_actions_succeeded": sum(1 for r in recovery_records if r.success),
            },
            "findings": [f.to_dict() for f in all_findings],
            "recovery_log": [r.to_dict() for r in recovery_records],
            "benchmark_metrics": benchmark_metrics,
            "canonical_relationships": [cr.to_dict() for cr in graph.canonical_relationships],
        }

        return report
