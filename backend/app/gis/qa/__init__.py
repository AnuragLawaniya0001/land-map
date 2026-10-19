"""Phase 6 End-to-End QA, Confidence Calibration, and Recovery Pipeline."""

from app.gis.qa.confidence_calibration import ConfidenceCalibrator
from app.gis.qa.geometry_qa import GeometryQAChecker
from app.gis.qa.golden_dataset import (
    BenchmarkEvaluator,
    GoldenDimensionGroundTruth,
    GoldenDocumentFixture,
    GoldenPlotGroundTruth,
    calculate_hausdorff_distance,
    calculate_polygon_iou,
)
from app.gis.qa.models import (
    QAFinding,
    QASeverity,
    QualityGrade,
    QuantitativeBenchmarkMetrics,
    RecoveryActionType,
    RecoveryRecord,
)
from app.gis.qa.qa_report import PIPELINE_VERSION, QAReportGenerator
from app.gis.qa.recovery_pipeline import RecoveryPipeline
from app.gis.qa.semantic_qa import SemanticQAChecker

__all__ = [
    "GeometryQAChecker",
    "SemanticQAChecker",
    "ConfidenceCalibrator",
    "RecoveryPipeline",
    "BenchmarkEvaluator",
    "QAReportGenerator",
    "QAFinding",
    "QASeverity",
    "QualityGrade",
    "RecoveryActionType",
    "RecoveryRecord",
    "QuantitativeBenchmarkMetrics",
    "GoldenDocumentFixture",
    "GoldenPlotGroundTruth",
    "GoldenDimensionGroundTruth",
    "calculate_polygon_iou",
    "calculate_hausdorff_distance",
    "PIPELINE_VERSION",
]
