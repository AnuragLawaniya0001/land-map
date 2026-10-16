"""Tests for Real-Document Accuracy Benchmarking Framework."""

import pytest
from shapely.geometry import Polygon, mapping

from app.gis.benchmarking.benchmark_runner import (
    BenchmarkMetricReport,
    RealDocumentBenchmarkRunner,
)


def test_benchmark_runner_metrics():
    runner = RealDocumentBenchmarkRunner()

    p1 = Polygon([(0, 0), (20, 0), (20, 40), (0, 40), (0, 0)])
    p2 = Polygon([(20, 0), (40, 0), (40, 40), (20, 40), (20, 0)])

    gt_plots = [
        {"original_number": "101", "geometry": mapping(p1)},
        {"original_number": "102", "geometry": mapping(p2)},
    ]

    pred_plots = [
        {"number": "101", "geometry": mapping(p1), "semantic_validation_status": "verified"},
        {"number": "102", "geometry": mapping(p2), "semantic_validation_status": "verified"},
    ]

    report = runner.evaluate_colony_dataset(
        predicted_plots=pred_plots,
        ground_truth_plots=gt_plots,
        runtime_sec=0.45,
        dataset_name="Test_Ground_Truth",
    )

    assert isinstance(report, BenchmarkMetricReport)
    assert report.ocr_precision == 1.0
    assert report.ocr_recall == 1.0
    assert report.mean_polygon_iou == 1.0
    assert report.polygon_precision == 1.0
    assert report.polygon_recall == 1.0
    assert report.invalid_geometry_rate == 0.0
    assert report.overlap_rate == 0.0

    rep_dict = report.to_dict()
    assert "ocr_metrics" in rep_dict
    assert "geometry_metrics" in rep_dict
    assert rep_dict["geometry_metrics"]["mean_polygon_iou"] == 1.0
