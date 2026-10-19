import asyncio
from copy import deepcopy
import pytest
from shapely.geometry import Polygon, shape

import app.gis.importer as importer
import app.server as server_module


class DummyUpload:
    def __init__(self, filename="test.pdf", data=b"%PDF-1.4 dummy"):
        self.filename = filename
        self._data = data

    async def read(self):
        return self._data


def make_colony_boundary():
    return {
        "type": "Polygon",
        "coordinates": [[
            [78.2530, 27.2200],
            [78.2550, 27.2200],
            [78.2550, 27.2220],
            [78.2530, 27.2220],
            [78.2530, 27.2200],
        ]],
    }


def make_valid_plot_doc(colony_id, number, min_lng, min_lat, max_lng, max_lat):
    return {
        "id": f"plot-{colony_id}-{number}",
        "colony_id": colony_id,
        "zone_id": f"zone-{colony_id}-a",
        "number": str(number),
        "area_sqm": 120.0,
        "area_sqft": 1291.7,
        "area_sqyd": 143.5,
        "width_m": 10.0,
        "depth_m": 12.0,
        "shape": "rectangular",
        "sides": 4,
        "dimensions": "10.0m × 12.0m",
        "status_id": "available",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [min_lng, min_lat],
                [max_lng, min_lat],
                [max_lng, max_lat],
                [min_lng, max_lat],
                [min_lng, min_lat],
            ]],
        },
        "notes": "",
        "created_at": "2026-10-14T00:00:00Z",
    }


def make_overlay_region(number=None, min_lng=78.2532, min_lat=27.2202, max_lng=78.2534, max_lat=27.2204, area_sqm=120.0):
    return {
        "number": number,
        "area_sqm": area_sqm,
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [min_lng, min_lat],
                [max_lng, min_lat],
                [max_lng, max_lat],
                [min_lng, max_lat],
                [min_lng, min_lat],
            ]],
        },
    }


# ==============================================================================
# 1. PREDICATE & HELPER TESTS: _has_usable_vector_plots & _promote_overlay_regions
# ==============================================================================

def test_predicate_has_usable_vector_plots():
    boundary = make_colony_boundary()

    # Empty list
    assert not server_module._has_usable_vector_plots([], boundary)
    assert not server_module._has_usable_vector_plots(None, boundary)

    # Degenerate geometry (None geometry, invalid, or area < 15)
    tiny_plot = make_valid_plot_doc("c1", "1", 78.2532, 27.2202, 78.2533, 27.2203)
    tiny_plot["area_sqm"] = 5.0
    assert not server_module._has_usable_vector_plots([tiny_plot], boundary)

    # Plot completely outside boundary
    outside_plot = make_valid_plot_doc("c1", "2", 70.0, 20.0, 70.001, 20.001)
    outside_plot["area_sqm"] = 100.0
    assert not server_module._has_usable_vector_plots([outside_plot], boundary)

    # Valid plot inside boundary
    valid_plot = make_valid_plot_doc("c1", "3", 78.2532, 27.2202, 78.2534, 27.2204)
    valid_plot["area_sqm"] = 150.0
    assert server_module._has_usable_vector_plots([valid_plot], boundary)


def test_promote_overlay_regions_filters_outside_and_extreme_areas():
    boundary = make_colony_boundary()

    # Region 1: Valid inside boundary
    r1 = make_overlay_region("1", 78.2532, 27.2202, 78.2534, 27.2204, area_sqm=120.0)
    # Region 2: Far outside boundary (should be rejected)
    r2 = make_overlay_region("2", 70.0, 20.0, 70.001, 20.001, area_sqm=120.0)
    # Region 3: Mega region > 900 sqm (should be rejected)
    r3 = make_overlay_region("3", 78.2532, 27.2202, 78.2545, 27.2215, area_sqm=2000.0)
    # Region 4: Tiny sliver < 15 sqm (should be rejected)
    r4 = make_overlay_region("4", 78.2532, 27.2202, 78.25321, 27.22021, area_sqm=5.0)

    zones, plots = server_module._promote_overlay_regions_to_plots(
        [r1, r2, r3, r4], "test-colony", "2026-10-14T00:00:00Z", boundary
    )

    assert len(plots) == 1
    assert plots[0]["number"] == "1"
    assert plots[0]["area_sqm"] == 120.0
    assert len(zones) == 4


# ==============================================================================
# 2. SCENARIO 1 (Case A): Clean Vector PDF
# ==============================================================================

def test_case_a_clean_vector_pdf_preserves_vector_plots(monkeypatch):
    """Case A: Clean vector PDF with valid plot boundaries continues through vector path."""
    boundary = make_colony_boundary()
    vector_plots = [
        make_valid_plot_doc("c-vec", str(i), 78.2531 + i*0.0001, 27.2201, 78.2532 + i*0.0001, 27.2203)
        for i in range(1, 11)
    ]

    async def fake_store_overlay(*args, **kwargs):
        # Overlay also has candidate regions detected from rendering
        return {
            "fit": {"warnings": []},
            "plot_regions": [
                make_overlay_region(str(i), 78.2531 + i*0.0001, 27.2201, 78.2532 + i*0.0001, 27.2203)
                for i in range(1, 11)
            ],
        }

    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)
    monkeypatch.setattr(
        importer, "_extract_pdf",
        lambda data: {"lines": [(0, 0, 10, 10)], "polys": [], "pdf_content": {"pages": [{"page_number": 1}]}}
    )
    monkeypatch.setattr(
        importer, "extract_pdf_plot_numbers",
        lambda data, extracted: [str(i) for i in range(1, 11)]
    )
    monkeypatch.setattr(
        importer, "import_file",
        lambda **kwargs: ({"boundary": boundary}, [], vector_plots, [])
    )

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=DummyUpload(),
            colony_id="c-vec",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    # Assert vector plots were preserved and not duplicated by raster promotion
    assert len(plots) == 10
    assert fields["import_source"]["pdf_processing_mode"] == "vector_plots_and_visual_overlay"
    assert fields["import_source"]["registration_metrics"]["pdf_vector_plot_count"] == 10
    assert fields["import_source"]["registration_metrics"]["raster_fallback_applied"] is False


# ==============================================================================
# 3. SCENARIO 2 (Case B): Pure Scanned / Raster PDF
# ==============================================================================

def test_case_b_pure_raster_pdf_invokes_raster_fallback(monkeypatch):
    """Case B: Pure scanned PDF with no vector lines invokes raster fallback promotion."""
    boundary = make_colony_boundary()
    raster_regions = [
        make_overlay_region(str(i), 78.2532 + i*0.0001, 27.2202, 78.2533 + i*0.0001, 27.2204, area_sqm=100.0)
        for i in range(1, 6)
    ]

    async def fake_store_overlay(*args, **kwargs):
        return {"fit": {"warnings": []}, "plot_regions": raster_regions}

    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)
    # Extractor returns no vector lines and no vector polygons
    monkeypatch.setattr(
        importer, "_extract_pdf",
        lambda data: {"lines": [], "polys": [], "pdf_content": {"pages": [{"page_number": 1}]}}
    )
    monkeypatch.setattr(importer, "extract_pdf_plot_numbers", lambda data, extracted: [])

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=DummyUpload(),
            colony_id="c-raster",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    assert len(plots) == 5
    assert fields["import_source"]["pdf_processing_mode"] == "raster_plots_and_visual_overlay"
    assert fields["import_source"]["registration_metrics"]["raster_fallback_applied"] is True
    assert fields["import_source"]["registration_metrics"]["raster_promoted_plot_count"] == 5
    assert any("from raster layout detection into inventory" in w for w in warnings)


# ==============================================================================
# 4. SCENARIO 3 (Case C): Hybrid PDF with Irrelevant Digital Vectors
# ==============================================================================

def test_case_c_hybrid_pdf_with_irrelevant_stamp_triggers_raster_fallback(monkeypatch):
    """Case C: PDF has isolated digital line/stamp but vector reconstruction fails to yield usable plots.

    Verifies system does not get trapped into empty vector result, but falls back to raster promotion.
    """
    boundary = make_colony_boundary()
    raster_regions = [
        make_overlay_region(str(i), 78.2532 + i*0.0001, 27.2202, 78.2533 + i*0.0001, 27.2204, area_sqm=110.0)
        for i in range(1, 9)
    ]

    async def fake_store_overlay(*args, **kwargs):
        return {"fit": {"warnings": []}, "plot_regions": raster_regions}

    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)
    # Extracted PDF has lines from a digital border or stamp
    monkeypatch.setattr(
        importer, "_extract_pdf",
        lambda data: {"lines": [(10, 10, 50, 10), (50, 10, 50, 50)], "polys": [], "pdf_content": {"pages": [{"page_number": 1}]}}
    )
    monkeypatch.setattr(importer, "extract_pdf_plot_numbers", lambda data, extracted: ["1"])

    # Vector reconstruction raises exception or yields 0 plots due to non-closed linework
    def mock_import_file(**kwargs):
        raise importer.ImportError_("Linework failed to form closed plot polygons")

    monkeypatch.setattr(importer, "import_file", mock_import_file)

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=DummyUpload(),
            colony_id="c-hybrid",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    # Must successfully fall back to raster layout detection
    assert len(plots) == 8
    assert fields["import_source"]["pdf_processing_mode"] == "raster_plots_and_visual_overlay"
    assert fields["import_source"]["registration_metrics"]["raster_fallback_applied"] is True
    assert any("from raster layout detection into inventory" in w for w in warnings)


def test_case_c_hybrid_pdf_with_isolated_stamp_box_promotes_raster_layout(monkeypatch):
    """Case C variant: Vector reconstruction returns 1 isolated non-plot box (stamp), while raster found 8 plots."""
    boundary = make_colony_boundary()
    stamp_box = make_valid_plot_doc("c-hybrid", "stamp", 78.2531, 27.2201, 78.2532, 27.2202)
    stamp_box["area_sqm"] = 20.0

    raster_regions = [
        make_overlay_region(str(i), 78.2532 + i*0.0001, 27.2202, 78.2533 + i*0.0001, 27.2204, area_sqm=110.0)
        for i in range(1, 9)
    ]

    async def fake_store_overlay(*args, **kwargs):
        return {"fit": {"warnings": []}, "plot_regions": raster_regions}

    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)
    monkeypatch.setattr(
        importer, "_extract_pdf",
        lambda data: {"lines": [(0, 0, 10, 10)], "polys": [], "pdf_content": {"pages": [{"page_number": 1}]}}
    )
    monkeypatch.setattr(importer, "extract_pdf_plot_numbers", lambda data, extracted: ["1"])
    # Vector returns only 1 plot (a peripheral stamp box)
    monkeypatch.setattr(
        importer, "import_file",
        lambda **kwargs: ({"boundary": boundary}, [], [stamp_box], [])
    )

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=DummyUpload(),
            colony_id="c-hybrid-stamp",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    # Because raster detected a multi-plot layout (8 regions) and vector only had 1 artifact, it promotes raster
    assert len(plots) == 8
    assert fields["import_source"]["pdf_processing_mode"] == "raster_plots_and_visual_overlay"
    assert fields["import_source"]["registration_metrics"]["raster_fallback_applied"] is True


# ==============================================================================
# 5. SCENARIO 4 (Case D): Hybrid PDF with Valid Vector Plots Preserved
# ==============================================================================

def test_case_d_hybrid_pdf_with_valid_vectors_does_not_duplicate_or_replace(monkeypatch):
    """Case D: Usable vector plots exist alongside raster overlay; keep vector plots without duplicates."""
    boundary = make_colony_boundary()
    vector_plots = [
        make_valid_plot_doc("c-hybrid-valid", str(i), 78.2531 + i*0.0001, 27.2201, 78.2532 + i*0.0001, 27.2203)
        for i in range(1, 15)
    ]
    raster_regions = [
        make_overlay_region(str(i), 78.2531 + i*0.0001, 27.2201, 78.2532 + i*0.0001, 27.2203, area_sqm=120.0)
        for i in range(1, 15)
    ]

    async def fake_store_overlay(*args, **kwargs):
        return {"fit": {"warnings": []}, "plot_regions": raster_regions}

    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)
    monkeypatch.setattr(
        importer, "_extract_pdf",
        lambda data: {"lines": [(0, 0, 10, 10)], "polys": [], "pdf_content": {"pages": [{"page_number": 1}]}}
    )
    monkeypatch.setattr(
        importer, "extract_pdf_plot_numbers",
        lambda data, extracted: [str(i) for i in range(1, 15)]
    )
    monkeypatch.setattr(
        importer, "import_file",
        lambda **kwargs: ({"boundary": boundary}, [], vector_plots, [])
    )

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=DummyUpload(),
            colony_id="c-hybrid-valid",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    assert len(plots) == 14
    assert fields["import_source"]["pdf_processing_mode"] == "vector_plots_and_visual_overlay"
    assert fields["import_source"]["registration_metrics"]["raster_fallback_applied"] is False


# ==============================================================================
# 6. SCENARIO 5 & 6 (Case E): Both Methods Fail
# ==============================================================================

def test_case_e_both_methods_fail_marks_visual_overlay_only_when_regions_empty(monkeypatch):
    """Case E: Vector yields 0 plots and raster yields 0 plot regions; returns explicit 0 plots and visual overlay only mode."""
    boundary = make_colony_boundary()

    async def fake_store_overlay(*args, **kwargs):
        return {"fit": {"warnings": []}, "plot_regions": []}

    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)
    monkeypatch.setattr(
        importer, "_extract_pdf",
        lambda data: {"lines": [(0, 0, 10, 10)], "polys": [], "pdf_content": {"pages": [{"page_number": 1}]}}
    )
    monkeypatch.setattr(importer, "extract_pdf_plot_numbers", lambda data, extracted: [])
    monkeypatch.setattr(
        importer, "import_file",
        lambda **kwargs: ({"boundary": boundary}, [], [], [])
    )

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=DummyUpload(),
            colony_id="c-fail",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    assert plots == []
    assert zones == []
    assert fields["import_source"]["pdf_processing_mode"] == "visual_overlay_only"
    assert any("No verified vector plot boundaries were recovered" in w for w in warnings)


# ==============================================================================
# 7. SCENARIO 7: Malformed or Degenerate Geometry Handled Safely
# ==============================================================================

def test_malformed_geometry_does_not_raise_unhandled_exception(monkeypatch):
    """Malformed geometry in extracted vectors or overlay regions does not crash the pipeline."""
    boundary = make_colony_boundary()

    malformed_regions = [
        {"number": "1", "geometry": None},
        {"number": "2", "geometry": {"type": "InvalidType"}},
        {"number": "3", "geometry": {"type": "Polygon", "coordinates": []}},
        {"number": "4", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 0], [0, 0], [0, 0]]]}},
    ]

    async def fake_store_overlay(*args, **kwargs):
        return {"fit": {"warnings": []}, "plot_regions": malformed_regions}

    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)
    monkeypatch.setattr(
        importer, "_extract_pdf",
        lambda data: {"lines": [(0, 0, 10, 10)], "polys": [], "pdf_content": {"pages": [{"page_number": 1}]}}
    )
    monkeypatch.setattr(importer, "extract_pdf_plot_numbers", lambda data, extracted: [])

    # Vector reconstruction raises an unexpected ValueError
    def mock_import_file(**kwargs):
        raise ValueError("Self-intersecting polygon topology error")

    monkeypatch.setattr(importer, "import_file", mock_import_file)

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=DummyUpload(),
            colony_id="c-malformed",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    # Pipeline gracefully handles malformed geometries without crashing
    assert plots == []
    assert fields["import_source"]["pdf_processing_mode"] == "visual_overlay_only"
