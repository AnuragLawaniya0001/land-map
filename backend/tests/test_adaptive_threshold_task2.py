import io
import pytest
import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Polygon, mapping

from app.gis.pdf_overlay import (
    _detect_raster_plot_cells,
    detect_registered_overlay_plot_regions,
)


def _create_synthetic_grid(
    size=(600, 420),
    cols=3,
    rows=2,
    cell_w=120,
    cell_h=120,
    start_x=50,
    start_y=50,
    bg_color=(255, 255, 255, 255),
    line_color=(0, 0, 0, 255),
    line_width=2,
    gap_coords=None,
    noise_sigma=0,
    bg_gradient=False,
    tint_color=None,
):
    """Generate deterministic synthetic plans with controlled properties."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Base paper rectangle
    paper_rect = (20, 20, size[0] - 20, size[1] - 20)
    if bg_gradient:
        # Create non-uniform illumination gradient (darker on left/top, lighter on right/bottom)
        arr = np.zeros((size[1], size[0], 4), dtype=np.uint8)
        for y in range(20, size[1] - 20):
            for x in range(20, size[0] - 20):
                val = int(160 + 80 * (x / size[0] * 0.5 + y / size[1] * 0.5))
                arr[y, x] = [val, val, val, 255]
        img = Image.fromarray(arr, "RGBA")
        draw = ImageDraw.Draw(img)
    elif tint_color is not None:
        draw.rectangle(paper_rect, fill=tint_color)
    else:
        draw.rectangle(paper_rect, fill=bg_color)

    # Draw vertical lines
    for c in range(cols + 1):
        x = start_x + c * cell_w
        draw.line((x, start_y, x, start_y + rows * cell_h), fill=line_color, width=line_width)

    # Draw horizontal lines
    for r in range(rows + 1):
        y = start_y + r * cell_h
        draw.line((start_x, y, start_x + cols * cell_w, y), fill=line_color, width=line_width)

    # Add optional gap to simulate cracked/broken boundaries
    if gap_coords:
        gx0, gy0, gx1, gy1 = gap_coords
        draw.line((gx0, gy0, gx1, gy1), fill=bg_color if tint_color is None else tint_color, width=line_width + 1)

    # Add Gaussian noise/speckle if requested
    if noise_sigma > 0:
        np.random.seed(42)  # Deterministic seed
        arr = np.array(img, dtype=np.float32)
        noise = np.random.normal(0, noise_sigma, (size[1], size[0]))
        for ch in range(3):
            arr[:, :, ch] = np.clip(arr[:, :, ch] + noise, 0, 255)
        img = Image.fromarray(arr.astype(np.uint8), "RGBA")

    return img


def test_1_clean_black_and_white_plan_retains_behavior():
    """1. Clean black-and-white scan produces exactly the closed parcel cells."""
    img = _create_synthetic_grid(cols=3, rows=2, line_color=(0, 0, 0, 255), line_width=2)
    regions, diag = _detect_raster_plot_cells(img)

    assert diag["raster_candidate_count"] == 6
    assert len(regions) == 6
    for poly in regions.values():
        assert isinstance(poly, Polygon)
        assert poly.is_valid
        assert poly.area > 5000


def test_2_faint_boundary_synthetic_plan_recovers_cells():
    """2. Faint gray linework (e.g., pencil or low-contrast scan at gray 225) is reliably extracted."""
    # Light gray boundary lines: (225, 225, 225, 255) on white paper (255, 255, 255, 255)
    # The old threshold (gray < 200) missed 100% of these lines.
    img = _create_synthetic_grid(cols=3, rows=2, line_color=(225, 225, 225, 255), line_width=2)
    regions, diag = _detect_raster_plot_cells(img)

    assert diag["raster_candidate_count"] == 6
    assert len(regions) == 6
    for poly in regions.values():
        assert poly.is_valid
        assert poly.area > 5000


def test_3_uneven_grey_background_does_not_cause_excessive_regions():
    """3. Non-uniform grey gradient illumination does not produce false-positive artifacts."""
    img = _create_synthetic_grid(cols=3, rows=2, line_color=(30, 30, 30, 255), bg_gradient=True)
    regions, diag = _detect_raster_plot_cells(img)

    # Must find the 6 true plots without explosion of false regions
    assert len(regions) == 6
    assert diag["raster_candidate_count"] == 6


def test_4_blue_tinted_or_colored_plan_handled_correctly():
    """4. Blue-tinted blueprint background (cyan/blue paper) is normalized without erasing linework."""
    # Blue tinted paper: (210, 225, 245, 255) with dark blue linework (10, 30, 80, 255)
    img = _create_synthetic_grid(
        cols=3,
        rows=2,
        tint_color=(210, 225, 245, 255),
        line_color=(10, 30, 80, 255),
        line_width=2,
    )
    regions, diag = _detect_raster_plot_cells(img)

    assert len(regions) == 6
    assert diag["raster_candidate_count"] == 6


def test_5_noisy_scan_rejects_speckles_without_region_explosion():
    """5. High-frequency scanner noise does not generate hundreds of false fragment regions."""
    img = _create_synthetic_grid(cols=3, rows=2, line_color=(0, 0, 0, 255), noise_sigma=12)
    regions, diag = _detect_raster_plot_cells(img)

    # Median denoising suppresses speckles; valid plots remain intact
    assert len(regions) == 6
    assert diag["raster_candidate_count"] == 6


def test_6_adjacent_plots_shared_boundary_preserved():
    """6. Two adjacent plots sharing a 1px boundary remain completely separate."""
    # Grid with 2 columns, 1 row sharing a single 1px dividing line
    img = _create_synthetic_grid(cols=2, rows=1, cell_w=150, cell_h=150, line_width=1)
    regions, _ = _detect_raster_plot_cells(img)

    assert len(regions) == 2
    polys = list(regions.values())
    p1, p2 = polys[0], polys[1]
    # Verify both exist and do not overlap internally
    assert p1.is_valid and p2.is_valid
    intersection_area = p1.intersection(p2).area
    assert intersection_area == pytest.approx(0.0, abs=1.0)


def test_7_thin_boundaries_and_narrow_gaps_bridged():
    """7. Micro-gaps (1-2 px gap in boundary line) are closed by binary closing without merging plots."""
    # Gap on horizontal line between (100, 50) and (102, 50)
    img = _create_synthetic_grid(cols=2, rows=1, gap_coords=(100, 50, 102, 50))
    regions, _ = _detect_raster_plot_cells(img)

    assert len(regions) == 2


def test_8_blank_page_produces_no_fabricated_plots():
    """8. A blank page produces 0 fabricated plot regions."""
    blank = Image.new("RGBA", (600, 400), (255, 255, 255, 255))
    regions, diag = _detect_raster_plot_cells(blank)

    assert len(regions) == 0
    assert diag["raster_candidate_count"] == 0


def test_9_invalid_or_degenerate_input_fails_safely():
    """9. Degenerate or malformed images fail gracefully without crashing."""
    # None input
    r1, d1 = _detect_raster_plot_cells(None)
    assert len(r1) == 0
    assert "None" in d1.get("raster_detection_warning", "")

    # Microscopic 2x2 image
    micro = Image.new("RGBA", (2, 2), (255, 255, 255, 255))
    r2, d2 = _detect_raster_plot_cells(micro)
    assert len(r2) == 0

    # Degenerate bounds to detect_registered_overlay_plot_regions
    with pytest.raises(ValueError):
        detect_registered_overlay_plot_regions(b"", None, [])


def test_10_output_coordinates_and_metadata_contract_compatibility():
    """10. Geometry structure, coordinate bounds, and area metadata remain compatible with downstream consumers."""
    raster = Image.new("RGBA", (600, 420), (0, 0, 0, 0))
    draw = ImageDraw.Draw(raster)
    draw.rectangle((20, 20, 580, 400), fill=(255, 255, 255, 255))
    for x in (30, 190, 350, 510):
        draw.line((x, 30, x, 390), fill=(0, 0, 0, 255), width=3)
    for y in (30, 190, 350):
        draw.line((30, y, 510, y), fill=(0, 0, 0, 255), width=3)
    png = io.BytesIO()
    raster.save(png, format="PNG")
    bounds = [[27.0, 78.0], [27.004, 78.004]]
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.004, 27.0), (78.004, 27.004),
        (78.0, 27.004), (78.0, 27.0),
    ]))

    regions, diagnostics = detect_registered_overlay_plot_regions(
        png.getvalue(), boundary, bounds
    )

    assert len(regions) == 6
    assert diagnostics["raster_candidate_count"] == 6
    for region in regions:
        assert "id" in region
        assert "geometry" in region
        assert region["geometry"]["type"] == "Polygon"
        assert len(region["geometry"]["coordinates"][0]) >= 4
        # Verify coordinates are in valid geographical range
        lons = [pt[0] for pt in region["geometry"]["coordinates"][0]]
        lats = [pt[1] for pt in region["geometry"]["coordinates"][0]]
        assert all(78.0 <= lon <= 78.004 for lon in lons)
        assert all(27.0 <= lat <= 27.004 for lat in lats)
