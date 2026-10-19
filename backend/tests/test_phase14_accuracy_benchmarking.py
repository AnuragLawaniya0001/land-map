"""Phase 14 Tests: Accuracy Benchmarking and Evaluation Engine.

Tests:
1. Polygon IoU calculation (identical, disjoint, partial overlaps).
2. Plot identification evaluation (Precision, Recall, F1).
3. Geometry health evaluation (validity rate, overlap rates).
4. Manifest execution on real repository engineering drawings.
"""

from pathlib import Path
from shapely.geometry import Polygon

from app.gis.qa.benchmark_evaluator import (
    compute_polygon_iou,
    evaluate_plot_identification,
    evaluate_geometry_health,
    run_benchmark_on_manifest,
)


def test_compute_polygon_iou():
    p1 = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    p2 = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])

    # Identical
    assert compute_polygon_iou(p1, p2) == 1.0

    # Disjoint
    p3 = Polygon([(20, 20), (30, 20), (30, 30), (20, 30)])
    assert compute_polygon_iou(p1, p3) == 0.0

    # Half overlap: [0..10] x [0..10] area 100, [5..15] x [0..10] area 100.
    # Intersection is [5..10] x [0..10] area 50. Union is 150. IoU = 50/150 = 0.3333...
    p4 = Polygon([(5, 0), (15, 0), (15, 10), (5, 10)])
    iou = compute_polygon_iou(p1, p4)
    assert round(iou, 3) == 0.333


def test_evaluate_plot_identification():
    predicted = ["101", "102", "103", "104"]
    ground_truth = ["101", "102", "103", "105"]

    # TP = 3 (101, 102, 103), FP = 1 (104), FN = 1 (105)
    # Precision = 3/4 = 0.75, Recall = 3/4 = 0.75, F1 = 0.75
    metrics = evaluate_plot_identification(predicted, ground_truth)
    assert metrics["precision"] == 0.75
    assert metrics["recall"] == 0.75
    assert metrics["f1"] == 0.75
    assert metrics["true_positives"] == 3
    assert metrics["false_positives"] == 1
    assert metrics["false_negatives"] == 1


def test_evaluate_geometry_health():
    # 2 valid non-overlapping rectangles + 1 invalid self-intersecting bowtie
    box1 = {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]}
    box2 = {"type": "Polygon", "coordinates": [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]]}
    bowtie = {"type": "Polygon", "coordinates": [[[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]]}

    health = evaluate_geometry_health([box1, box2, bowtie])
    assert health["total"] == 3
    assert health["valid_count"] == 2
    assert health["invalid_count"] == 1
    assert round(health["valid_rate"], 2) == 0.67
    assert health["overlap_pairs"] == 0


def test_run_benchmark_on_real_manifest():
    manifest_path = Path("app/gis/qa/benchmark_manifest.json")
    if not manifest_path.exists():
        manifest_path = Path("backend/app/gis/qa/benchmark_manifest.json")

    summary = run_benchmark_on_manifest(
        str(manifest_path),
        workspace_root=str(Path.cwd().parent if Path.cwd().name == "backend" else Path.cwd()),
    )

    assert summary["total_documents"] >= 3
    assert summary["passed_documents"] >= 2
    assert summary["overall_regression_gate"] in ("PASSED", "PARTIAL")

    # Verify real PDFs were parsed and inspected
    for doc in summary["documents"]:
        if doc["file_exists"]:
            m = doc["metrics"]
            assert m["page_count"] >= 1
            assert m["drawing_paths_count"] > 0
            assert m["geometry_valid_rate"] == 1.0
