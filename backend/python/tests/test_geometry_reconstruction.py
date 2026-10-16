"""Tests for Geometry Reconstruction Engine and Georeferencing."""

import pytest
from shapely.geometry import Polygon

from app.gis.geometry.reconstruction import GeometryReconstructionEngine
from app.gis.geometry.georeferencing import GeoreferenceAlignmentEngine


def test_endpoint_snapping_and_polygonization():
    engine = GeometryReconstructionEngine(base_snap_tolerance_pt=2.0)

    # 4 segments forming a rectangle with a 1.0 point micro-gap at (100, 201)
    segments = [
        ((100.0, 100.0), (200.0, 100.0)),
        ((200.0, 100.0), (200.0, 200.0)),
        ((200.0, 200.0), (100.0, 201.0)),  # 1.0 gap from (100, 200)
        ((100.0, 200.0), (100.0, 100.0)),
    ]

    labels = [
        {"text": "Plot 1", "center_pt": (150.0, 150.0), "confidence": 0.95}
    ]

    reconstructed = engine.reconstruct_layout_entities(segments, labels)
    assert len(reconstructed["plots"]) == 1
    assert reconstructed["plots"][0]["number"] == "Plot 1"
    assert reconstructed["plots"][0]["area_points"] > 9000.0


def test_road_centerline_generation():
    engine = GeometryReconstructionEngine()

    # Elongated road rectangle (10m wide, 200m long)
    segments = [
        ((0.0, 0.0), (200.0, 0.0)),
        ((200.0, 0.0), (200.0, 10.0)),
        ((200.0, 10.0), (0.0, 10.0)),
        ((0.0, 10.0), (0.0, 0.0)),
    ]
    labels = [
        {"text": "Main Street 30ft", "center_pt": (100.0, 5.0), "confidence": 0.9}
    ]

    reconstructed = engine.reconstruct_layout_entities(segments, labels)
    assert len(reconstructed["roads"]) == 1
    assert len(reconstructed["road_centerlines"]) == 1
    cl = reconstructed["road_centerlines"][0]
    assert cl["road_id"] == reconstructed["roads"][0]["id"]
    assert cl["geometry"]["type"] == "LineString"


def test_kml_georeferencing_fit():
    engine = GeoreferenceAlignmentEngine()

    # 4 control points in local frame
    src_points = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
    # Corresponding geographic coordinates (Vadodara)
    dst_points = [
        (73.105, 22.222),
        (73.106, 22.222),
        (73.106, 22.223),
        (73.105, 22.223),
    ]

    res = engine.fit_control_points(src_points, dst_points)
    assert res["success"] is True
    assert res["control_points_count"] == 4
    assert res["rms_error_meters"] >= 0.0
    assert "transform_matrix" in res
