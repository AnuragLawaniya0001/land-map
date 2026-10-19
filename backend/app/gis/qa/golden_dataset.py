"""Golden Dataset and Quantitative Benchmark Evaluation Module.

Provides ground truth fixture schemas, quantitative geometric metrics (IoU, Hausdorff,
boundary deviation), plot identification precision/recall/F1, dimension parsing accuracy,
and target association evaluation across document categories.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from shapely.geometry import MultiPolygon, Polygon, shape

from app.gis.qa.models import QuantitativeBenchmarkMetrics
from app.gis.spatial_understanding.models import SemanticDrawingGraph


@dataclass
class GoldenPlotGroundTruth:
    plot_number: str
    geometry: Any  # Shapely Polygon or GeoJSON dict
    expected_area_sqm: Optional[float] = None
    is_corner_plot: bool = False
    adjacent_road_ids: List[str] = field(default_factory=list)
    adjacent_plot_numbers: List[str] = field(default_factory=list)


@dataclass
class GoldenDimensionGroundTruth:
    raw_text: str
    parsed_value: float
    unit: str
    measurement_type: str
    target_plot_number: Optional[str] = None
    target_road_id: Optional[str] = None
    is_multi_span: bool = False


@dataclass
class GoldenDocumentFixture:
    document_id: str
    category: str  # "clean_vector", "irregular_agricultural", "scanned_raster", "rotated_challenge"
    pdf_filename: str
    page_number: int = 1
    expected_boundary: Optional[Any] = None
    plots: List[GoldenPlotGroundTruth] = field(default_factory=list)
    dimensions: List[GoldenDimensionGroundTruth] = field(default_factory=list)
    known_ambiguities: List[str] = field(default_factory=list)


def calculate_polygon_iou(geom1: Any, geom2: Any) -> float:
    """Computes Intersection over Union (IoU) between two Shapely polygons."""
    if geom1 is None or geom2 is None or geom1.is_empty or geom2.is_empty:
        return 0.0
    try:
        if not geom1.is_valid:
            geom1 = geom1.buffer(0)
        if not geom2.is_valid:
            geom2 = geom2.buffer(0)
        inter = geom1.intersection(geom2).area
        union = geom1.union(geom2).area
        return inter / union if union > 0 else 0.0
    except Exception:
        return 0.0


def calculate_hausdorff_distance(geom1: Any, geom2: Any) -> float:
    """Computes maximum Hausdorff distance between two polygon boundaries in metres/units."""
    if geom1 is None or geom2 is None or geom1.is_empty or geom2.is_empty:
        return float("inf")
    try:
        return float(geom1.boundary.hausdorff_distance(geom2.boundary))
    except Exception:
        return float("inf")


class BenchmarkEvaluator:
    """Evaluates spatial understanding graphs against Golden ground truth fixtures."""

    def evaluate(
        self,
        graph: SemanticDrawingGraph,
        fixture: GoldenDocumentFixture,
    ) -> QuantitativeBenchmarkMetrics:
        """Evaluates reconstructed drawing data against verified ground truth."""
        metrics = QuantitativeBenchmarkMetrics()

        # 1. Evaluate Plot Geometries (IoU & Hausdorff)
        pred_plots = {
            p.properties.get("plot_number") or p.entity_id: p.geometry
            for p in graph.entities.values()
            if p.entity_type.value == "Plot"
        }

        ious = []
        hausdorffs = []

        gt_numbers = {gt.plot_number for gt in fixture.plots}
        pred_numbers = set(pred_plots.keys())

        for gt_plot in fixture.plots:
            gt_no = gt_plot.plot_number
            gt_geom = gt_plot.geometry
            if isinstance(gt_geom, dict):
                gt_geom = shape(gt_geom)

            # Look up matching predicted plot by number or best spatial overlap
            matched_pred_geom = pred_plots.get(gt_no)
            if not matched_pred_geom and pred_plots:
                # Spatial matching
                best_iou = 0.0
                best_geom = None
                for p_geom in pred_plots.values():
                    cur_iou = calculate_polygon_iou(p_geom, gt_geom)
                    if cur_iou > best_iou:
                        best_iou = cur_iou
                        best_geom = p_geom
                if best_iou > 0.4:
                    matched_pred_geom = best_geom

            if matched_pred_geom:
                iou = calculate_polygon_iou(matched_pred_geom, gt_geom)
                ious.append(iou)
                h_dist = calculate_hausdorff_distance(matched_pred_geom, gt_geom)
                if math.isfinite(h_dist):
                    hausdorffs.append(h_dist)

        if ious:
            metrics.mean_iou = float(np.mean(ious))
            metrics.min_iou = float(np.min(ious))
        if hausdorffs:
            metrics.mean_hausdorff_distance_m = float(np.mean(hausdorffs))
            metrics.max_boundary_deviation_m = float(np.max(hausdorffs))

        # 2. Evaluate Plot ID Identification (Precision, Recall, F1)
        if gt_numbers:
            tp = len(gt_numbers.intersection(pred_numbers))
            fp = len(pred_numbers - gt_numbers)
            fn = len(gt_numbers - pred_numbers)

            precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
            recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
            f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

            metrics.plot_id_precision = precision
            metrics.plot_id_recall = recall
            metrics.plot_id_f1 = f1

        # 3. Evaluate Dimension Parsing and Associations
        if fixture.dimensions:
            correct_parsing = 0
            correct_associations = 0
            total_evaluated = len(fixture.dimensions)

            pred_dims = {
                cr.raw_text.strip().lower(): cr
                for cr in graph.canonical_relationships
            }

            for gt_dim in fixture.dimensions:
                raw_key = gt_dim.raw_text.strip().lower()
                pred_cr = pred_dims.get(raw_key)
                if pred_cr and pred_cr.parsed_value is not None:
                    # Check parsed value tolerance
                    if abs(pred_cr.parsed_value - gt_dim.parsed_value) < 0.01:
                        correct_parsing += 1

                    # Check target association
                    if gt_dim.target_plot_number:
                        if gt_dim.target_plot_number in pred_cr.candidate_target_features or \
                           any(gt_dim.target_plot_number in str(f) for f in pred_cr.candidate_target_features):
                            correct_associations += 1

            metrics.dimension_parsing_accuracy = correct_parsing / total_evaluated
            metrics.target_association_precision = correct_associations / max(len(pred_dims), 1)
            metrics.target_association_recall = correct_associations / total_evaluated

        # 4. Unresolved Case Rate
        total_rels = len(graph.canonical_relationships)
        if total_rels > 0:
            unresolved = sum(
                1 for cr in graph.canonical_relationships
                if cr.association_status in ("unresolved", "review_required")
            )
            metrics.unresolved_case_rate = unresolved / total_rels
        else:
            metrics.unresolved_case_rate = 0.0

        return metrics
