import asyncio
import math
from io import BytesIO
from pathlib import Path

import ezdxf
import pymupdf
import pytest
from PIL import Image
from shapely.geometry import Point, Polygon, shape

import app.gis.importer as gis_importer
from app.gis.importer import (
    ImportError_,
    _faces,
    _extract_dxf,
    _extract_pdf,
    _labeled_plot_polygons,
    _point_label_calibration,
    _clip_plots_to_boundary,
    _plot_footprint_ratio,
    _target_boundary_ring,
    build_transform,
    import_file,
)
import app.server as server_module


def test_pdf_extraction_preserves_disconnected_subpaths_in_one_filled_drawing():
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=200)
    content_xref = doc.get_new_xref()
    doc.update_object(content_xref, "<<>>")
    doc.update_stream(
        content_xref,
        b"q 1 0 0 rg "
        b"20 20 m 30 20 l 30 30 l h "
        b"40 20 m 50 20 l 50 30 l h f Q",
    )
    doc.xref_set_key(page.xref, "Contents", f"{content_xref} 0 R")

    drawing = _extract_pdf(doc.tobytes())

    assert len(drawing["polys"]) == 2
    assert sorted(Polygon(points).area for points, _, _ in drawing["polys"]) == [50, 50]


def test_faces_snap_near_duplicate_pdf_edges_before_polygonizing():
    square = [(593.6, 1055.52), (603.83, 1055.52), (603.83, 1065.52), (593.6, 1065.52)]
    duplicate_bottom_edge = [(593.6, 1055.52), (603.8299999999999, 1055.52)]
    drawing = {
        "lines": [
            ([square[0], square[1]], "", None),
            (duplicate_bottom_edge, "", None),
            ([square[1], square[2]], "", None),
            ([square[2], square[3]], "", None),
            ([square[3], square[0]], "", None),
        ],
        "polys": [],
    }

    faces = _faces(drawing)

    assert len(faces) == 1
    assert abs(faces[0].area - 102.3) < 0.01


def test_classify_uses_pdf_semantic_text_on_smallest_enclosing_shape(monkeypatch):
    boundary = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])
    plot = Polygon([(10, 10), (20, 10), (20, 20), (10, 20)])
    garden = Polygon([(30, 30), (50, 30), (50, 50), (30, 50)])
    garden_text_glyph = Polygon([(38, 39), (40, 39), (40, 41), (38, 41)])
    road = Polygon([(60, 30), (90, 30), (90, 40), (60, 40)])
    faces = [boundary, plot, garden, garden_text_glyph, road]
    monkeypatch.setattr(gis_importer, "_faces", lambda _extracted: faces)
    monkeypatch.setattr(gis_importer, "_layer_of", lambda _face, _extracted: ("", None))

    def to_wgs(x, y):
        return 78 + x * 0.00001, 27 + y * 0.00001

    extracted = {
        "pdf_content": {"pdf_type": "vector"},
        "texts": [
            (15, 15, "1", ""),
            (39, 40, "PARK", ""),
            (70, 35, "ROAD", ""),
        ],
    }

    _, plots, greens, roads = gis_importer.classify(extracted, to_wgs, [])

    assert sum(bool(gis_importer._plot_number(plot)) for plot in plots) == 1
    assert len(greens) == 1
    assert len(roads) == 1
    assert "PARK" in [text[2] for text in greens[0]["texts"]]
    assert "ROAD" in [text[2] for text in roads[0]["texts"]]


def test_labeled_plot_polygons_splits_pdf_blocks_and_preserves_plot_numbers():
    drawing = {
        "lines": [
            ([(10, 0), (10, 10)], "", None),
            ([(20, 0), (20, 10)], "", None),
        ],
        "polys": [([(0, 0), (30, 0), (30, 10), (0, 10)], "", None)],
        "texts": [(5, 5, "1", ""), (15, 5, "2", ""), (25, 5, "3", "")],
    }

    cells = _labeled_plot_polygons(drawing)

    assert cells is not None
    assert set(cells) == {"1", "2", "3"}
    assert sorted(round(cell.area) for cell in cells.values()) == [100, 100, 100]


def test_labeled_plot_polygons_rejects_tiny_faces_around_plot_labels():
    plots = []
    for x in (0, 20, 40):
        plots.append(([(x, 0), (x + 10, 0), (x + 10, 10), (x, 10)], "", None))
        plots.append(([(x + 4.8, 4.8), (x + 5.2, 4.8), (x + 5.2, 5.2), (x + 4.8, 5.2)], "", None))
    drawing = {
        "lines": [],
        "polys": plots,
        "texts": [(5, 5, "1", ""), (25, 5, "2", ""), (45, 5, "3", "")],
    }

    cells = _labeled_plot_polygons(drawing)

    assert cells is not None
    assert set(cells) == {"1", "2", "3"}
    assert [round(cells[number].area) for number in ("1", "2", "3")] == [100, 100, 100]


def test_labeled_plot_polygons_returns_recoverable_partial_cells_for_validation():
    drawing = {
        "lines": [([(10, 0), (10, 10)], "", None)],
        "polys": [([(0, 0), (30, 0), (30, 10), (0, 10)], "", None)],
        "texts": [(5, 5, "1", ""), (15, 5, "2", ""), (25, 5, "3", "")],
    }

    cells = _labeled_plot_polygons(drawing)

    assert set(cells) == {"1"}


def test_plot_number_normalization_accepts_hyphenated_numeric_suffix():
    assert gis_importer.normalize_plot_no("1-A") == "1A"
    assert gis_importer.normalize_plot_no("Plot No. 2-A") == "2A"


def test_colony_output_keeps_cad_overlay_type_and_detects_legacy_cad(monkeypatch):
    monkeypatch.setattr(server_module, "get_signed_url", lambda key, _expires: f"/{key}")
    overlay = {"storage_key": "cad-layout", "source_type": "cad"}
    result = server_module.colony_out({"pdf_overlay": overlay})
    assert result["pdf_overlay"]["source_type"] == "cad"

    legacy = server_module.colony_out({
        "pdf_overlay": {"storage_key": "legacy-cad-layout"},
        "import_source": {"filename": "legacy-layout.DWG"},
    })
    assert legacy["pdf_overlay"]["source_type"] == "cad"


def test_cad_import_saves_only_label_linked_plot_cells(monkeypatch, tmp_path):
    cells = {
        "1A": Polygon([(0, 0), (10, 0), (10, 10), (0, 10)]),
        "2": Polygon([(20, 0), (30, 0), (30, 10), (20, 10)]),
    }
    false_positive = {
        "face": Polygon([(40, 0), (41, 0), (41, 1), (40, 1)]),
        "m": Polygon([(40, 0), (41, 0), (41, 1), (40, 1)]),
        "area": 1,
        "texts": [],
    }
    source_boundary = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])
    target_boundary = {
        "type": "Polygon",
        "coordinates": [[
            [78, 27], [78.001, 27], [78.001, 27.001],
            [78, 27.001], [78, 27],
        ]],
    }
    monkeypatch.setenv("GIS_DEBUG_DIR", str(tmp_path))
    monkeypatch.setattr(gis_importer, "_extract_dxf", lambda *args, **kwargs: {
        "texts": [(5, 5, "1-A", ""), (25, 5, "2", ""), (45, 5, "99", "")],
        "lines": [],
        "polys": [],
    })
    monkeypatch.setattr(gis_importer, "_labeled_plot_polygons", lambda _: cells)
    monkeypatch.setattr(
        gis_importer,
        "build_transform",
        lambda *args, **kwargs: (
            lambda x, y: (78 + x * 0.00001, 27 + y * 0.00001),
            "boundary_fitted",
        ),
    )
    monkeypatch.setattr(
        gis_importer,
        "classify",
        lambda *args, **kwargs: (source_boundary, [false_positive], [], []),
    )

    fields, zones, plots, warnings = import_file(
        b"cad",
        "layout.dxf",
        "",
        "colony",
        "2026-01-01T00:00:00Z",
        target_boundary=target_boundary,
    )

    assert {plot["number"] for plot in plots} == {"1A", "2"}
    assert len(zones) == 1
    assert fields["import_source"]["plots"] == 2
    assert fields["import_source"]["registration_metrics"]["detected_plot_label_count"] == 3
    assert fields["import_source"]["registration_metrics"]["unmatched_plot_numbers"] == ["99"]
    assert any("unmatched labels were not saved as plots" in warning for warning in warnings)


def test_plot_footprint_ratio_measures_area_covered_by_imported_plots():
    boundary = {"type": "Polygon", "coordinates": [[
        [78.0, 27.0], [78.001, 27.0], [78.001, 27.001], [78.0, 27.001], [78.0, 27.0]
    ]]}
    plots = [
        {"geometry": {"type": "Polygon", "coordinates": [[
            [78.0, 27.0], [78.0005, 27.0], [78.0005, 27.001], [78.0, 27.001], [78.0, 27.0]
        ]]}}
    ]

    assert _plot_footprint_ratio(plots, boundary) == pytest.approx(0.5, abs=0.002)


def test_boundary_clipping_persists_repaired_plot_geometry():
    boundary = {
        "type": "Polygon",
        "coordinates": [[
            [78.0, 27.0], [78.001, 27.0], [78.001, 27.001],
            [78.0, 27.001], [78.0, 27.0],
        ]],
    }
    plots = [{
        "number": "X1",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [78.0002, 27.0002], [78.0008, 27.0008],
                [78.0002, 27.0008], [78.0008, 27.0002],
                [78.0002, 27.0002],
            ]],
        },
    }]

    clipped = _clip_plots_to_boundary(plots, boundary, lambda x, y: (x, y))
    geometry = shape(clipped[0]["geometry"])

    assert geometry.is_valid
    assert geometry.area > 0
    assert shape(boundary).covers(geometry)


def test_point_calibration_resolves_repeated_pdf_label_using_geojson_anchor():
    features = []
    texts = []
    for number in range(1, 7):
        x, y = number * 10, number * 7
        texts.append((x, y, str(number), ""))
        features.append({
            "type": "Feature",
            "properties": {"plot_no": str(number)},
            "geometry": {
                "type": "Point",
                "coordinates": [78 + x * 0.00001, 27 + y * 0.00001],
            },
        })
    texts.extend([(70, 49, "7", ""), (700, 490, "7", "")])
    features.append({
        "type": "Feature",
        "properties": {"plot_no": "7"},
        "geometry": {
            "type": "Point",
            "coordinates": [78.0007, 27.00049],
        },
    })

    calibration = _point_label_calibration(
        {"texts": texts},
        {"type": "FeatureCollection", "features": features},
    )

    assert calibration is not None
    assert calibration["plot_texts"]["7"] == (70, 49)


def test_import_does_not_fabricate_missing_pdf_plot_boundaries(monkeypatch):
    monkeypatch.setattr(
        gis_importer,
        "_extract_pdf",
        lambda _: {
            "texts": [],
            "lines": [],
            "polys": [([(0, 0), (1, 0), (1, 1), (0, 1)], "", None)],
        },
    )
    monkeypatch.setattr(
        gis_importer,
        "_point_label_calibration",
        lambda *_: {
            "plot_texts": {"1": (0, 0), "2": (1, 1)},
            "solution": __import__("numpy").array([[0.0005, 0, 0], [0, 0.0005, 0], [78.2532, 27.2202, 1]]),
        },
    )
    monkeypatch.setattr(
        gis_importer,
        "_labeled_plot_polygons",
        lambda _: {"1": Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])},
    )

    target = Polygon([(78.253, 27.22), (78.254, 27.22), (78.254, 27.221), (78.253, 27.221), (78.253, 27.22)])
    target_boundary = {"type": "Polygon", "coordinates": [list(target.exterior.coords)]}
    fields, zones, plots, warnings = import_file(
        b"pdf",
        "layout.pdf",
        "",
        "colony",
        "2026-01-01T00:00:00Z",
        target_boundary=target_boundary,
    )
    numbers = {p["number"] for p in plots}
    assert numbers == {"1"}
    assert any("1 of 2 PDF plot labels" in warning for warning in warnings)
    assert any("were not created as plot records" in warning for warning in warnings)


def test_colony_pdf_import_saves_vector_plot_geometry_with_overlay(monkeypatch):
    pdf_path = Path(__file__).parent / "fixtures" / "layout_scaled.pdf"
    boundary = {
        "type": "Polygon",
        "coordinates": [[
            [78.253, 27.22], [78.254, 27.22], [78.254, 27.221],
            [78.253, 27.221], [78.253, 27.22],
        ]],
    }
    extraction_calls = []
    extract_pdf = gis_importer._extract_pdf

    def track_extraction(data):
        extraction_calls.append(data)
        return extract_pdf(data)

    async def fake_store_overlay(*args, **kwargs):
        return {"fit": {"warnings": []}, "plot_regions": []}

    monkeypatch.setattr(gis_importer, "_extract_pdf", track_extraction)
    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)

    class Upload:
        def __init__(self):
            self.filename = pdf_path.name

        async def read(self):
            return pdf_path.read_bytes()

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=Upload(),
            maps_link="",
            colony_id="fixture-colony",
            now="2026-10-09T00:00:00Z",
            existing_boundary=boundary,
            visual_overlay_only=True,
            user_id="fixture-user",
        )
    )

    assert len(extraction_calls) == 1
    assert len(plots) == 64
    assert len({plot["number"] for plot in plots}) == 64
    assert all(
        shape(plot["geometry"]).is_valid and shape(plot["geometry"]).area > 0
        for plot in plots
    )
    assert fields["import_source"]["saved_plot_records"] == 64
    assert fields["import_source"]["pdf_processing_mode"] == "vector_plots_and_visual_overlay"
    assert fields["pdf_overlay"]["plot_regions"] == []
    assert any("64 individual plot geometries" in warning for warning in warnings)


def test_colony_raster_only_pdf_uses_visual_overlay_without_inventing_plots(monkeypatch):
    png = BytesIO()
    Image.new("RGB", (32, 32), "white").save(png, format="PNG")
    pdf = pymupdf.open()
    page = pdf.new_page(width=100, height=100)
    page.insert_image(pymupdf.Rect(0, 0, 100, 100), stream=png.getvalue())
    pdf_data = pdf.tobytes()
    pdf.close()

    async def fake_store_overlay(*args, **kwargs):
        return {
            "fit": {"warnings": []},
            "plot_regions": [{
                "number": None,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[78, 27], [78.001, 27], [78.001, 27.001], [78, 27.001], [78, 27]]],
                },
            }],
        }

    class Upload:
        filename = "scanned-layout.pdf"

        async def read(self):
            return pdf_data

    boundary = {
        "type": "Polygon",
        "coordinates": [[
            [78.253, 27.22], [78.254, 27.22], [78.254, 27.221],
            [78.253, 27.221], [78.253, 27.22],
        ]],
    }
    monkeypatch.setattr(server_module, "store_pdf_overlay", fake_store_overlay)

    fields, zones, plots, warnings = asyncio.run(
        server_module.import_colony_bundle_py(
            layout_pdf=Upload(),
            colony_id="raster-colony",
            existing_boundary=boundary,
            visual_overlay_only=True,
        )
    )

    assert zones == []
    assert plots == []
    assert fields["import_source"]["mode"] == "pdf_overlay_only"
    assert fields["import_source"]["pdf_processing_mode"] == "visual_overlay_only"
    assert any("No verified vector plot boundaries were recovered" in warning for warning in warnings)


def test_dwg_import_reports_missing_oda_converter(monkeypatch):
    from ezdxf.addons import odafc

    monkeypatch.delenv("ODA_FILE_CONVERTER", raising=False)
    monkeypatch.setattr(odafc, "is_installed", lambda: False)

    with pytest.raises(ImportError_, match="requires ODA File Converter"):
        _extract_dxf(b"AC1032", is_dwg=True)


def test_dwg_import_uses_oda_conversion_and_extracts_dxf_entities(monkeypatch):
    from ezdxf.addons import odafc

    document = ezdxf.new()
    document.modelspace().add_lwpolyline(
        [(0, 0), (10, 0), (10, 10), (0, 10)],
        close=True,
    )
    original_win_path = ezdxf.options.get("odafc-addon", "win_exec_path")
    monkeypatch.setenv("ODA_FILE_CONVERTER", r"C:\CAD\ODAFileConverter.exe")
    monkeypatch.setattr(odafc, "is_installed", lambda: True)
    monkeypatch.setattr(odafc, "readfile", lambda filename: document)

    try:
        drawing = _extract_dxf(b"AC1032", is_dwg=True)
    finally:
        ezdxf.options.set("odafc-addon", "win_exec_path", original_win_path)

    assert drawing["src"] == "dxf"
    points, layer, color = drawing["polys"][0]
    assert [(float(x), float(y)) for x, y in points] == pytest.approx(
        [(0, 0), (10, 0), (10, 10), (0, 10)]
    )
    assert layer == "0"
    assert color is None


def test_boundary_fit_uses_explicit_site_polygon_not_first_plot():
    drawing = {
        "lines": [
            ([(0, 0), (20, 0)], "", None),
            ([(20, 0), (20, 10)], "", None),
            ([(20, 10), (0, 10)], "", None),
            ([(0, 10), (0, 0)], "", None),
        ],
        "polys": [],
        "texts": [],
    }
    target_boundary = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"feature_type": "plot_polygon"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[78.2531, 27.2201], [78.2532, 27.2201], [78.2532, 27.2202], [78.2531, 27.2202], [78.2531, 27.2201]]],
                },
            },
            {
                "type": "Feature",
                "properties": {"feature_type": "site_boundary"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]]],
                },
            },
        ],
    }

    transform, mode = build_transform(drawing, None, [], target_boundary=target_boundary)

    assert mode == "boundary_fitted"
    west_south = transform(0, 0)
    east_south = transform(20, 0)
    east_north = transform(20, 10)
    west_north = transform(0, 10)
    kx = 111320 * math.cos(math.radians((west_south[1] + east_south[1]) / 2))
    width_m = math.hypot((east_south[0] - west_south[0]) * kx, (east_south[1] - west_south[1]) * 110574)
    height_m = math.hypot((east_north[0] - east_south[0]) * kx, (east_north[1] - east_south[1]) * 110574)
    assert abs(width_m / height_m - 2) < 1e-5
    site = Polygon(_target_boundary_ring(target_boundary))
    for corner in (west_south, east_south, east_north, west_north):
        assert site.covers(Point(corner))


def test_boundary_fit_optimizes_translation_without_distorting_plot_aspect_ratio():
    target = Polygon([(0, 0), (12, 0), (8, 10), (2, 10)])
    drawing = {
        "lines": [
            ([(0, 0), (6, 0)], "", None),
            ([(6, 0), (6, 4)], "", None),
            ([(6, 4), (0, 4)], "", None),
            ([(0, 4), (0, 0)], "", None),
        ],
        "polys": [],
    }
    warnings = []

    transform = build_transform(
        drawing,
        None,
        warnings,
        target_boundary={"type": "Polygon", "coordinates": [list(target.exterior.coords)]},
    )[0]
    fitted = Polygon(transform(x, y) for x, y in [(0, 0), (6, 0), (6, 4), (0, 4)])

    assert target.covers(fitted)
    assert fitted.area / target.area > 0.60
    assert any("uniform scale" in warning and "aspect ratio preserved" in warning for warning in warnings)


def test_scaled_pdf_import_fits_all_plots_to_land_without_distorting_them():
    pdf_path = Path(__file__).parent / "fixtures" / "layout_scaled.pdf"
    target_boundary = {
        "type": "Polygon",
        "coordinates": [[[78.253, 27.22], [78.254, 27.22], [78.254, 27.221], [78.253, 27.221], [78.253, 27.22]]],
    }

    fields, _, plots, warnings = import_file(
        pdf_path.read_bytes(),
        pdf_path.name,
        "",
        "scaled-pdf",
        "2026-10-07T00:00:00Z",
        target_boundary=target_boundary,
    )

    assert len(plots) > 0
    assert fields["import_source"]["mode"] == "boundary_fitted"
    assert any("uniform scale" in warning and "aspect ratio preserved" in warning for warning in warnings)
    diagnostics = fields["import_source"]["registration_metrics"]
    assert diagnostics["plot_footprint_ratio"] > 0.1
    assert diagnostics["registration_confidence"] is None
    assert diagnostics["plot_extraction_confidence"] is None
    assert diagnostics["registration_requires_review"] is True
    assert diagnostics["recovered_plot_count"] == len(plots)
    site = Polygon(target_boundary["coordinates"][0])
    for plot in plots:
        polygon = Polygon(plot["geometry"]["coordinates"][0])
        assert polygon.intersection(site).area / polygon.area > 0.99


def test_invalid_explicit_boundary_does_not_fall_through_to_google_pin_requirement():
    drawing = {
        "lines": [([(0, 0), (10, 0)], "", None), ([(10, 0), (10, 10)], "", None)],
        "polys": [],
        "texts": [],
        "src": "pdf",
    }

    try:
        build_transform(drawing, None, [], target_boundary={"type": "Point", "coordinates": [78, 27]})
    except ImportError_ as error:
        assert "supplied land boundary could not be used" in str(error)
    else:
        raise AssertionError("Invalid explicit boundary unexpectedly fell through to pin placement")
