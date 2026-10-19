import io
import pytest
import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Point, Polygon, mapping

from app.gis.pdf_overlay import (
    _matching_plot_labels_for_cell,
    _detect_raster_plot_cells,
    _complete_topological_boundaries,
    detect_registered_overlay_plot_regions,
)


def _create_grid_with_broken_line(
    size=(600, 420),
    cols=3,
    rows=2,
    cell_w=120,
    cell_h=120,
    start_x=50,
    start_y=50,
    gap_info=None,
    text_anchors=(),
):
    """Generate a clean synthetic grid with optional broken boundary lines."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle((20, 20, size[0] - 20, size[1] - 20), fill=(255, 255, 255, 255))

    # Vertical lines
    for c in range(cols + 1):
        x = start_x + c * cell_w
        draw.line((x, start_y, x, start_y + rows * cell_h), fill=(0, 0, 0, 255), width=2)

    # Horizontal lines
    for r in range(rows + 1):
        y = start_y + r * cell_h
        draw.line((start_x, y, start_x + cols * cell_w, y), fill=(0, 0, 0, 255), width=2)

    # Apply intentional gap if requested
    if gap_info:
        gx0, gy0, gx1, gy1 = gap_info
        draw.line((gx0, gy0, gx1, gy1), fill=(255, 255, 255, 255), width=3)

    return img


def test_1_label_close_to_parcel_corner():
    """1. Plot label placed outside near a parcel corner is associated when raster_recovered=True."""
    cell = Polygon([(50, 50), (150, 50), (150, 150), (50, 150)])
    # Corner at (150, 150), label at (154, 154) -> distance = hypot(4, 4) = 5.65px <= 10px
    corner_label = [(154, 154, "12", {})]

    # For raster-recovered cell: matched
    matched_raster = _matching_plot_labels_for_cell(cell, "12", corner_label, raster_recovered=True)
    assert len(matched_raster) == 1
    assert matched_raster[0].coords[0] == (154, 154)

    # For vector-derived cell: tight buffer rejects outside label
    matched_vector = _matching_plot_labels_for_cell(cell, "12", corner_label, raster_recovered=False)
    assert matched_vector == []


def test_2_label_close_to_parcel_edge():
    """2. Plot label placed 5px outside parcel edge is matched for raster recovery but rejected for vector."""
    cell = Polygon([(100, 100), (200, 100), (200, 200), (100, 200)])
    edge_label = [(205, 150, "45", {})]

    matched_raster = _matching_plot_labels_for_cell(cell, "45", edge_label, raster_recovered=True)
    assert len(matched_raster) == 1

    matched_vector = _matching_plot_labels_for_cell(cell, "45", edge_label, raster_recovered=False)
    assert matched_vector == []


def test_3_labels_near_shared_boundaries_ambiguity_rejection():
    """3. If two conflicting plot labels are within tolerance of the same boundary, reject to prevent misattribution."""
    cell = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])
    # Both label "1" and label "2" are close to the boundary at x=100
    competing_labels = [(104, 50, "1", {}), (107, 50, "2", {})]

    # Ambiguity detected -> returns []
    matches = _matching_plot_labels_for_cell(cell, "1", competing_labels, raster_recovered=True)
    assert matches == []


def test_4_broken_collinear_boundaries_gaps_greater_than_3px_healed():
    """4. Broken line with a 6px gap (larger than morphological closing) is bridged by topological completion."""
    # Introduce 6px gap in internal dividing vertical line at x=170, between y=100 and y=106
    img = _create_grid_with_broken_line(gap_info=(170, 100, 170, 106))
    regions, diag = _detect_raster_plot_cells(img)

    # With topological bridge, the 6px gap is closed and all 6 plots are preserved
    assert len(regions) == 6
    assert diag["raster_candidate_count"] == 6
    assert diag.get("raster_detection_topological_bridges_count", 0) >= 1


def test_5_parallel_unrelated_boundaries_must_not_connect():
    """5. Parallel lines separated by a gap (e.g. road or setback) must not be bridged across."""
    img = np.zeros((100, 100), dtype=bool)
    # Two parallel vertical lines separated by 8px
    img[20:80, 40] = True
    img[20:80, 48] = True

    completed, bridges = _complete_topological_boundaries(img, max_gap_px=10)
    assert bridges == 0
    # Center between parallel lines remains empty
    assert not np.any(completed[20:80, 44])


def test_6_nearby_endpoints_different_parcels_remain_separate():
    """6. Two parallel boundary lines ending at a street must not connect across the parcel frontage."""
    img = np.zeros((100, 100), dtype=bool)
    # Two lines ending at y=50 facing downward: (40, 20)->(40, 50) and (50, 20)->(50, 50)
    img[20:51, 40] = True
    img[20:51, 50] = True

    completed, bridges = _complete_topological_boundaries(img, max_gap_px=12)
    assert bridges == 0


def test_7_boundary_completion_around_text_anchors_safeguard():
    """7. Boundary completion must not draw a bridge through or across a text anchor label."""
    img = np.zeros((100, 100), dtype=bool)
    # Collinear gap between x=40 and x=50 at y=50 (10px gap)
    img[50, 10:41] = True
    img[50, 50:80] = True

    # Text anchor located directly inside the gap at (45, 50)
    anchors = [(45, 50, "99")]
    completed, bridges = _complete_topological_boundaries(img, max_gap_px=12, text_anchors=anchors)

    # Bridge is safely inhibited by text anchor presence
    assert bridges == 0
    assert not completed[50, 45]


def test_8_invalid_or_self_intersecting_geometry_prevention():
    """8. Reconstructed parcel geometries must be strictly valid polygons with positive area."""
    img = _create_grid_with_broken_line(gap_info=(170, 100, 170, 107))
    regions, _ = _detect_raster_plot_cells(img)

    for key, poly in regions.items():
        assert poly.is_valid
        assert not poly.is_empty
        assert poly.area > 1000.0
        # No self-intersections
        assert poly.exterior.is_simple


def test_9_existing_fixtures_compatibility():
    """9. Clean B&W, faint line, and blue-tinted plans continue to produce 6 valid regions with topological completion."""
    from tests.test_adaptive_threshold_task2 import _create_synthetic_grid

    # Clean
    img_clean = _create_synthetic_grid(cols=3, rows=2)
    r1, d1 = _detect_raster_plot_cells(img_clean)
    assert len(r1) == 6

    # Faint lines
    img_faint = _create_synthetic_grid(cols=3, rows=2, line_color=(225, 225, 225, 255))
    r2, d2 = _detect_raster_plot_cells(img_faint)
    assert len(r2) == 6

    # Blue tint
    img_blue = _create_synthetic_grid(
        cols=3, rows=2, tint_color=(210, 225, 245, 255), line_color=(10, 30, 80, 255)
    )
    r3, d3 = _detect_raster_plot_cells(img_blue)
    assert len(r3) == 6


def test_10_blank_page_safety_and_degenerate_input():
    """10. Blank page and degenerate inputs produce zero false bridges and fail gracefully."""
    blank = Image.new("RGBA", (400, 300), (255, 255, 255, 255))
    regions, diag = _detect_raster_plot_cells(blank)
    assert len(regions) == 0
    assert diag.get("raster_detection_topological_bridges_count", 0) == 0

    # None input
    r_none, d_none = _detect_raster_plot_cells(None)
    assert len(r_none) == 0
