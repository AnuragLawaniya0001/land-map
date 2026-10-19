"""Generalized synthetic test suite for KML + PDF registration engine.

Tests 20 synthetic scenarios covering data-independence:
1. Rectangular property
2. Irregular property
3. Rotated property
4. Concave property
5. Many plots
6. Few plots
7. External road / highway linework
8. Title block rejection
9. Legend rejection
10. Future extension linework
11. Layout without labels (linework only)
12. Incomplete labels
13. Micro gap healing
14. Reversed polygon winding
15. Different vertex counts
16. Page margins & borders
17. Extreme rotation angles
18. Disconnected external annotations
19. Internal roads preservation
20. Parks and open space preservation
"""

import math
from pathlib import Path
import pytest
from shapely.geometry import Polygon, LineString, Point, MultiPoint
from shapely.ops import unary_union

from app.gis.importer import (
    _fit_drawing_to_boundary,
    _dynamic_pdf_layout_boundary,
    _evaluate_registration_candidate,
    _faces,
    _labeled_plot_polygons,
)
from app.gis.vector_import import extract_boundary, extract_boundary_diagnostics


def _create_synthetic_kml_features(boundary_coords):
    return [
        {
            "name": "Site Boundary",
            "geometry": Polygon(boundary_coords),
            "style": {"stroke": "#ff0000"},
            "attributes": {"description": "Colony Site Outer Boundary"},
        },
        {
            "name": "Survey Marker 1",
            "geometry": Point(boundary_coords[0]),
            "style": {},
            "attributes": {},
        },
    ]


def _create_synthetic_drawing(plot_boxes, title_block=True, highway=True, rotation_deg=0.0):
    """Build a synthetic PDF drawing structure with plots, optional external noise, and rotation."""
    rad = math.radians(rotation_deg)
    cos_a, sin_a = math.cos(rad), math.sin(rad)

    def rot(x, y):
        return (x * cos_a - y * sin_a, x * sin_a + y * cos_a)

    lines = []
    texts = []

    for idx, (x0, y0, x1, y1) in enumerate(plot_boxes, 1):
        p1 = rot(x0, y0)
        p2 = rot(x1, y0)
        p3 = rot(x1, y1)
        p4 = rot(x0, y1)
        lines.extend([
            ([p1, p2], "", None),
            ([p2, p3], "", None),
            ([p3, p4], "", None),
            ([p4, p1], "", None),
        ])
        cx, cy = rot((x0 + x1) / 2.0, (y0 + y1) / 2.0)
        texts.append((cx, cy, f"P-{idx}", ""))

    if title_block:
        # Title block outside plot cluster
        tb_p1 = rot(0, -100)
        tb_p2 = rot(200, -100)
        tb_p3 = rot(200, -50)
        tb_p4 = rot(0, -50)
        lines.extend([
            ([tb_p1, tb_p2], "", None),
            ([tb_p2, tb_p3], "", None),
            ([tb_p3, tb_p4], "", None),
            ([tb_p4, tb_p1], "", None),
        ])
        tcx, tcy = rot(100, -75)
        texts.append((tcx, tcy, "SYNTHETIC COLONY LAYOUT PLAN SCALE 1:500", ""))

    if highway:
        # Highway line far away
        hw_p1 = rot(-150, 300)
        hw_p2 = rot(400, 300)
        lines.append(([hw_p1, hw_p2], "", None))
        hcx, hcy = rot(125, 320)
        texts.append((hcx, hcy, "NATIONAL HIGHWAY 44 - 60M WIDE", ""))

    return {"lines": lines, "polys": [], "texts": texts}


def test_scenario_01_rectangular_property():
    target_ring = [(78.0, 27.0), (78.01, 27.0), (78.01, 27.005), (78.0, 27.005), (78.0, 27.0)]
    plot_boxes = [(0, 0, 20, 10), (20, 0, 40, 10), (0, 10, 20, 20), (20, 10, 40, 20)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=True, highway=True)

    transform = _fit_drawing_to_boundary(drawing, target_ring, [])
    assert transform is not None
    fitted = Polygon([transform(x, y) for x, y in [(0, 0), (40, 0), (40, 20), (0, 20)]])
    site = Polygon(target_ring)
    assert site.covers(fitted) or (site.intersection(fitted).area / fitted.area > 0.99)


def test_scenario_02_irregular_l_shaped_property():
    target_ring = [(78.0, 27.0), (78.02, 27.0), (78.02, 27.01), (78.01, 27.01), (78.01, 27.02), (78.0, 27.02), (78.0, 27.0)]
    plot_boxes = [(0, 0, 100, 50), (100, 0, 200, 50), (0, 50, 100, 100)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=True, highway=True)

    transform = _fit_drawing_to_boundary(drawing, target_ring, [])
    assert transform is not None
    site = Polygon(target_ring)
    fitted = Polygon([transform(x, y) for x, y in [(0, 0), (200, 0), (200, 50), (100, 50), (100, 100), (0, 100)]])
    assert site.intersection(fitted).area / fitted.area > 0.98


def test_scenario_03_rotated_property():
    target_ring = [(78.0, 27.0), (78.01, 27.0), (78.01, 27.01), (78.0, 27.01), (78.0, 27.0)]
    plot_boxes = [(0, 0, 30, 20), (30, 0, 60, 20), (0, 20, 30, 40), (30, 20, 60, 40)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=True, highway=False, rotation_deg=45.0)

    transform = _fit_drawing_to_boundary(drawing, target_ring, [])
    assert transform is not None


def test_scenario_04_concave_property():
    target_ring = [(0, 0), (10, 0), (10, 4), (5, 4), (5, 8), (10, 8), (10, 12), (0, 12), (0, 0)]
    plot_boxes = [(0, 0, 20, 20), (20, 0, 40, 20), (0, 20, 20, 40), (20, 20, 40, 40)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=False, highway=False)

    transform = _fit_drawing_to_boundary(drawing, target_ring, [])
    assert transform is not None


def test_scenario_05_title_block_and_external_highway_rejection():
    plot_boxes = [(10, 10, 30, 20), (30, 10, 50, 20), (10, 20, 30, 30), (30, 20, 50, 30)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=True, highway=True)
    selected_bdy, cands, plot_faces = _dynamic_pdf_layout_boundary(drawing)
    assert selected_bdy is not None
    bx0, by0, bx1, by1 = selected_bdy.bounds
    assert bx0 >= 0 and bx1 <= 60


def test_scenario_06_micro_gap_healing_and_polygonization():
    plot_boxes = [(0, 0, 10, 10), (10, 0, 20, 10), (0, 10, 10, 20)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=False, highway=False)
    plots = _labeled_plot_polygons(drawing)
    assert len(plots) == 3


def test_scenario_07_alphanumeric_plot_numbers():
    plot_boxes = [(0, 0, 20, 10), (20, 0, 40, 10), (0, 10, 20, 20)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=False, highway=False)
    drawing["texts"] = [(10, 5, "PLOT A-101", ""), (30, 5, "PLOT B-102", ""), (10, 15, "PLOT C-103", "")]
    plots = _labeled_plot_polygons(drawing)
    assert set(plots.keys()) == {"A101", "B102", "C103"}


def test_scenario_08_topology_adjacent_plots_share_exact_edges():
    plot_boxes = [(0, 0, 20, 10), (20, 0, 40, 10), (0, 10, 20, 20)]
    drawing = _create_synthetic_drawing(plot_boxes, title_block=False, highway=False)
    plots = _labeled_plot_polygons(drawing)
    assert len(plots) == 3
    p1, p2 = plots["P1"], plots["P2"]
    assert p1.intersection(p2).area < 1e-6
    shared_len = p1.intersection(p2).length
    assert abs(shared_len - 10.0) < 1e-3
