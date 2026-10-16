import asyncio
import io
import threading
import time
from types import SimpleNamespace

import numpy as np
import pymupdf
import pytest
from PIL import Image, ImageDraw
from shapely.geometry import MultiPolygon, Point, Polygon, mapping, shape

from app import server
from app.gis import importer
from app.gis.pdf_overlay import (
    _detect_raster_plot_cells,
    _inset_quad,
    _matching_plot_labels_for_cell,
    _remove_pdf_page_white,
    _registered_pdf_text_annotations,
    _smooth_registered_plot_geometry,
    detect_registered_overlay_plot_regions,
    render_clipped_pdf_overlay,
    render_pdf_overlay_images,
    transform_pdf_overlay,
)
from app.gis.importer import extract_pdf_plot_numbers


def test_near_white_pdf_fills_become_transparent_without_losing_edges_or_color():
    raster = Image.new("RGB", (16, 12), "white")
    draw = ImageDraw.Draw(raster)
    draw.line((2, 2, 13, 2), fill=(20, 20, 20), width=1)
    draw.line((2, 4, 13, 4), fill=(251, 251, 251), width=1)
    draw.rectangle((1, 7, 4, 10), outline=(20, 20, 20), width=1)
    draw.rectangle((5, 6, 10, 9), fill=(20, 120, 35))
    draw.rectangle((11, 6, 14, 10), outline=(20, 20, 20), width=1)

    result = np.asarray(_remove_pdf_page_white(raster.convert("RGBA")))

    assert result[0, 0, 3] == 0
    assert result[2, 7, 3] == 255
    assert result[2, 7, :3].max() < 30
    assert 0 < result[4, 7, 3] < 255
    assert result[4, 7, :3].min() < 255
    assert result[5, 5, 3] == 0
    assert tuple(result[7, 7]) == (20, 120, 35, 255)
    assert result[7, 11, 3] == 255


def test_pdf_target_quad_is_inset_to_leave_margin_inside_colony_boundary():
    boundary = np.asarray([
        (0.0, 0.0),
        (100.0, 0.0),
        (100.0, 80.0),
        (0.0, 80.0),
    ])

    inset = _inset_quad(boundary)

    assert inset[:, 0].min() > boundary[:, 0].min()
    assert inset[:, 0].max() < boundary[:, 0].max()
    assert inset[:, 1].min() > boundary[:, 1].min()
    assert inset[:, 1].max() < boundary[:, 1].max()
    assert np.allclose(inset.mean(axis=0), boundary.mean(axis=0))


def test_pdf_overlay_crops_page_and_masks_pixels_outside_boundary():
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(10, 10, 90, 90), color=(0, 0, 0), width=1)
    page.insert_text((20, 50), "PLOT MAP", fontsize=8)
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.001, 27.0), (78.0, 27.001), (78.0, 27.0),
    ]))

    png_data, leaflet_bounds, fit = render_clipped_pdf_overlay(pdf_data, boundary)

    image = Image.open(io.BytesIO(png_data)).convert("RGBA")
    assert leaflet_bounds == [[27.0, 78.0], [27.001, 78.001]]
    assert max(image.size) == 2400
    assert image.getpixel((image.width // 2, image.height // 2))[3] < 255
    assert image.getpixel((image.width - 2, 1))[3] == 0
    assert fit["fit_mode"] == "oriented_envelope_fallback"
    assert fit["layout_margin"]["boundary_inset_percent"] == 2.5
    assert fit["layout_margin"]["source_crop_padding_percent"] == 0.5
    assert fit["corner_fit_residual_pixels"] < 1e-6


def test_pdf_overlay_handles_rotated_colored_layout_and_reports_orientation_ambiguity():
    document = pymupdf.open()
    page = document.new_page(width=180, height=260)
    page.draw_rect(pymupdf.Rect(35, 45, 145, 215), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    page.insert_text((60, 120), "30 x 40 M", fontsize=7)
    page.insert_text((148, 235), "HIGHWAY", color=(0.9, 0.1, 0.1), fontsize=5)
    page.set_rotation(90)
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.0014, 27.0002), (78.0011, 27.0011),
        (78.0001, 27.001), (78.0, 27.0),
    ]))

    png_data, _, fit = render_clipped_pdf_overlay(pdf_data, boundary)

    image = Image.open(io.BytesIO(png_data)).convert("RGBA")
    assert fit["fit_mode"] == "quadrilateral_homography"
    assert fit["source_footprint_method"] == "colored_content_minimum_area_rectangle"
    assert fit["source_footprint_pixel_count"] > 0
    assert fit["edge_scale_distortion"] >= 1
    assert fit["page_rotation_deg"] == 90
    assert len(fit["input_pdf_sha256"]) == 64
    assert len(fit["control_points"]) == 4
    assert fit["homography_condition_number"] > 0
    assert fit["boundary_mean_distance_m"] >= 0
    assert fit["postclip_layout_content_retained_percent"] <= 100
    assert fit["metric_scope"].startswith("Boundary distances compare")
    assert len(fit["orientation_candidates"]) > 1
    dimension_annotations = [
        annotation for annotation in fit["pdf_text_annotations"]
        if annotation["type"] == "dimension"
    ]
    assert dimension_annotations
    assert abs(dimension_annotations[0]["angle_deg"]) > 60
    annotation_longitude, annotation_latitude = dimension_annotations[0]["geometry"]["coordinates"]
    assert shape(boundary).covers(Point(annotation_longitude, annotation_latitude))
    assert image.getchannel("A").getbbox() is not None


def test_pdf_overlay_keeps_unclassified_native_text_annotations():
    annotations = _registered_pdf_text_annotations(
        [
            {"x": 25, "y": 25, "text": "LENGTH 12.5", "direction": (1, 0)},
            {"x": 35, "y": 35, "text": "50'", "direction": (1, 0)},
            {"x": 45, "y": 45, "text": "92'-6\"", "direction": (1, 0)},
            {"x": 55, "y": 55, "text": "24'-1\"", "direction": (1, 0)},
        ],
        [(0, 0), (100, 0), (100, 100), (0, 100)],
        np.eye(3),
        Polygon([(-1, -1), (101, -1), (101, 101), (-1, 101)]),
        (0, 0, 100, 100),
        (101, 101),
    )

    assert len(annotations) == 4
    assert annotations[0]["text"] == "LENGTH 12.5"
    assert annotations[0]["type"] == "text"
    assert annotations[0]["geometry"]["type"] == "Point"
    assert [annotation["type"] for annotation in annotations[1:]] == [
        "dimension",
        "dimension",
        "dimension",
    ]


def test_monochrome_layout_crop_uses_vector_plot_cells_not_external_title():
    document = pymupdf.open()
    page = document.new_page(width=600, height=420)
    for row, y in enumerate((120, 200, 280)):
        for column, x in enumerate((180, 300, 420)):
            page.draw_rect(
                pymupdf.Rect(x - 45, y - 30, x + 45, y + 30),
                color=(0, 0, 0),
                width=1,
            )
            page.insert_text((x - 3, y + 3), str(row * 3 + column + 1), fontsize=8)
    page.insert_text((24, 390), "HIGHWAY NO.2", fontsize=15)
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.002, 27.002),
        (78.0, 27.002), (78.0, 27.0),
    ]))
    extracted_pdf = importer._extract_pdf(pdf_data)

    _, _, _, fit, _ = render_pdf_overlay_images(
        pdf_data, boundary, extracted_pdf=extracted_pdf
    )

    crop_x0, crop_y0, crop_x1, crop_y1 = fit["source_crop_bounds_px"]
    assert fit["source_footprint_method"] == "pdf_vector_plot_cells"
    assert fit["source_footprint_plot_cell_count"] == 9
    assert fit["source_footprint_pixel_count"] == 0
    assert crop_x0 > 100
    assert crop_y1 < 1500
    assert any("reconstructed vector parcel cells" in warning for warning in fit["warnings"])


def test_concave_four_vertex_boundary_uses_envelope_instead_of_projective_fit():
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(15, 15, 85, 85), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.001, 27.0005),
        (78.0, 27.002), (78.0, 27.0),
    ]))

    _, _, fit = render_clipped_pdf_overlay(pdf_data, boundary)

    assert fit["fit_mode"] == "oriented_envelope_fallback"
    assert any("is concave" in warning for warning in fit["warnings"])


def test_disjoint_land_polygons_are_rejected_as_ambiguous_for_one_layout():
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(15, 15, 85, 85), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(MultiPolygon([
        Polygon([(78, 27), (78.001, 27), (78.001, 27.001), (78, 27.001)]),
        Polygon([(78.002, 27), (78.003, 27), (78.003, 27.001), (78.002, 27.001)]),
    ]))

    with pytest.raises(ValueError, match="multiple disjoint land polygons"):
        render_clipped_pdf_overlay(pdf_data, boundary)


def test_boundary_outside_wgs84_web_mercator_range_is_rejected():
    document = pymupdf.open()
    document.new_page(width=100, height=100)
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (200, 27), (201, 27), (201, 28), (200, 28),
    ]))

    with pytest.raises(ValueError, match="WGS84 longitude/latitude"):
        render_clipped_pdf_overlay(pdf_data, boundary)


def test_calibration_source_preserves_pixels_outside_irregular_boundary():
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(15, 15, 85, 85), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.0017, 27.0005),
        (78.001, 27.0013), (78.0, 27.001), (78.0, 27.0),
    ]))

    clipped, calibration_source, _, _, _ = render_pdf_overlay_images(pdf_data, boundary)

    clipped_alpha = Image.open(io.BytesIO(clipped)).getchannel("A")
    source_alpha = Image.open(io.BytesIO(calibration_source)).getchannel("A")
    assert source_alpha.histogram()[0] < clipped_alpha.histogram()[0]
    calibrated = transform_pdf_overlay(
        calibration_source,
        boundary,
        {
            "rotation_deg": 3,
            "scale_x": 1,
            "scale_y": 1,
            "translation_x_m": 0,
            "translation_y_m": 0,
        },
    )
    calibrated_alpha = Image.open(io.BytesIO(calibrated)).getchannel("A")
    assert calibrated != clipped
    interpolation_tolerance = int(calibrated_alpha.width * calibrated_alpha.height * 0.001)
    assert calibrated_alpha.histogram()[0] >= (
        clipped_alpha.histogram()[0] - interpolation_tolerance
    )


def test_debug_mode_writes_private_registration_artifacts_and_report(tmp_path, monkeypatch):
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(15, 15, 85, 85), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.001, 27.0), (78.001, 27.001),
        (78.0, 27.001), (78.0, 27.0),
    ]))
    monkeypatch.setenv("PDF_OVERLAY_DEBUG_DIR", str(tmp_path))

    _, _, fit = render_clipped_pdf_overlay(pdf_data, boundary)

    report_path = next(tmp_path.glob("*-registration.json"))
    import json

    saved_report = json.loads(report_path.read_text(encoding="utf-8"))
    assert saved_report["input_pdf_sha256"] == fit["input_pdf_sha256"]
    assert len(list(tmp_path.glob("*.png"))) == 8
    assert str(tmp_path) not in report_path.read_text(encoding="utf-8")


def test_irregular_boundary_uses_oriented_envelope_and_reports_edge_limitations():
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(15, 15, 85, 85), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.001, 27.0), (78.001, 27.0004),
        (78.0005, 27.001), (78.0, 27.001), (78.0, 27.0),
    ]))

    _, _, fit = render_clipped_pdf_overlay(pdf_data, boundary)

    assert fit["fit_mode"] == "oriented_envelope_fallback"
    assert any("not a quadrilateral" in warning for warning in fit["warnings"])


def test_saved_overlay_transform_changes_the_complete_image_and_keeps_boundary_clip():
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(15, 15, 85, 85), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.001, 27.0), (78.001, 27.001),
        (78.0, 27.001), (78.0, 27.0),
    ]))
    automatic, _, _ = render_clipped_pdf_overlay(pdf_data, boundary)

    calibrated = transform_pdf_overlay(
        automatic,
        boundary,
        {
            "rotation_deg": 4,
            "scale_x": 1.05,
            "scale_y": 0.95,
            "translation_x_m": 2,
            "translation_y_m": -2,
        },
    )

    original_image = Image.open(io.BytesIO(automatic)).convert("RGBA")
    calibrated_image = Image.open(io.BytesIO(calibrated)).convert("RGBA")
    assert calibrated_image.size == original_image.size
    assert calibrated != automatic
    assert calibrated_image.getchannel("A").getbbox() is not None
    assert calibrated_image.getpixel((0, 0))[3] == 0


def test_overlay_calibration_route_always_transforms_immutable_auto_fit_source(monkeypatch):
    document = pymupdf.open()
    page = document.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(15, 15, 85, 85), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.001, 27.0), (78.001, 27.001),
        (78.0, 27.001), (78.0, 27.0),
    ]))
    base_png, _, _ = render_clipped_pdf_overlay(pdf_data, boundary)
    colony = {
        "_id": "colony-id",
        "owner_id": "owner-id",
        "boundary": boundary,
        "pdf_overlay": {
            "storage_key": "auto-fit-key",
            "base_storage_key": "immutable-source-key",
            "auto_fit_storage_key": "auto-fit-key",
            "bounds": [[27, 78], [27.001, 78.001]],
        },
    }

    class ColonyCollection:
        async def update_one(self, query, update):
            for path, value in update["$set"].items():
                node = colony
                parts = path.split(".")
                for part in parts[:-1]:
                    node = node.setdefault(part, {})
                node[parts[-1]] = value

        async def find_one(self, query):
            return colony

    stored_objects = {}
    read_keys = []
    generated_keys = []

    async def load_owned_colony(colony_id, user):
        return colony

    async def audit_log(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "load_owned_colony", load_owned_colony)
    monkeypatch.setattr(server, "DB", SimpleNamespace(colonies=ColonyCollection()))
    monkeypatch.setattr(server, "get_object", lambda key: (read_keys.append(key) or base_png, "image/png"))
    monkeypatch.setattr(server, "put_object", lambda key, content, mime: stored_objects.setdefault(key, content))
    monkeypatch.setattr(server, "delete_object", lambda key: stored_objects.pop(key, None))
    monkeypatch.setattr(server, "build_storage_key", lambda **kwargs: generated_keys.append("image-" + str(len(generated_keys))) or generated_keys[-1])
    monkeypatch.setattr(server, "get_signed_url", lambda key, expires: f"/{key}")
    monkeypatch.setattr(server, "now_iso", lambda: "2026-10-09T00:00:00Z")
    monkeypatch.setattr(server, "audit_log", audit_log)

    async def calibrate(transform):
        return await server.update_pdf_overlay_transform(
            "colony-id",
            server.PdfOverlayTransformIn(**transform),
            None,
            {"id": "owner-id"},
        )

    first = asyncio.run(calibrate({
        "rotation_deg": 5, "scale_x": 1.05, "scale_y": 0.95,
        "translation_x_m": 1, "translation_y_m": 1,
    }))
    first_key = first["pdf_overlay"]["url"].removeprefix("/")
    second = asyncio.run(calibrate({
        "rotation_deg": 10, "scale_x": 1.1, "scale_y": 0.9,
        "translation_x_m": 2, "translation_y_m": 2,
    }))
    second_key = second["pdf_overlay"]["url"].removeprefix("/")
    assert first_key != second_key
    assert read_keys == ["immutable-source-key", "immutable-source-key"]
    assert colony["pdf_overlay"]["base_storage_key"] == "immutable-source-key"
    assert colony["pdf_overlay"]["storage_key"] == second_key
    assert colony["pdf_overlay"]["auto_fit_storage_key"] == "auto-fit-key"
    assert first_key not in stored_objects

    reset = asyncio.run(calibrate({
        "rotation_deg": 0, "scale_x": 1, "scale_y": 1,
        "translation_x_m": 0, "translation_y_m": 0,
    }))
    assert reset["pdf_overlay"]["url"] == "/auto-fit-key"
    assert colony["pdf_overlay"]["transform"]["scale_x"] == 1
    assert second_key not in stored_objects


def test_pdf_region_status_is_saved_but_cannot_be_marked_sold(monkeypatch):
    colony = {
        "_id": "colony-id",
        "pdf_overlay": {
            "plot_regions": [{"id": "pdf-region-1", "status_id": "available"}],
        },
    }

    class ColonyCollection:
        async def update_one(self, query, update):
            assert query["pdf_overlay.plot_regions.id"] == "pdf-region-1"
            colony["pdf_overlay"]["plot_regions"][0]["status_id"] = update["$set"][
                "pdf_overlay.plot_regions.$.status_id"
            ]
            return SimpleNamespace(matched_count=1)

    class StatusCollection:
        async def find_one(self, query):
            return {"id": query["id"], "name": query["id"]}

    async def load_owned_colony(colony_id, user):
        return colony

    async def audit_log(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "load_owned_colony", load_owned_colony)
    monkeypatch.setattr(
        server,
        "DB",
        SimpleNamespace(colonies=ColonyCollection(), statuses=StatusCollection()),
    )
    monkeypatch.setattr(server, "audit_log", audit_log)

    response = asyncio.run(server.admin_change_pdf_region_status(
        "colony-id",
        "pdf-region-1",
        server.StatusChangeIn(status_id="hold"),
        None,
        {"id": "admin-id"},
    ))

    assert response == {"ok": True, "region_id": "pdf-region-1", "status_id": "hold"}
    assert colony["pdf_overlay"]["plot_regions"][0]["status_id"] == "hold"
    with pytest.raises(server.HTTPException, match="verified and saved"):
        asyncio.run(server.admin_change_pdf_region_status(
            "colony-id",
            "pdf-region-1",
            server.StatusChangeIn(status_id="sold"),
            None,
            {"id": "admin-id"},
        ))


def test_store_pdf_overlay_uploads_images_concurrently_and_cleans_up_on_failure(monkeypatch):
    monkeypatch.setattr(
        server,
        "render_pdf_overlay_images",
        lambda *args: (b"display", b"source", [[27, 78], [27.001, 78.001]], {}, []),
    )
    monkeypatch.setattr(
        server,
        "build_storage_key",
        lambda **kwargs: f"key-{kwargs['filename']}",
    )
    lock = threading.Lock()
    active_uploads = 0
    peak_uploads = 0
    deleted_keys = []

    def put_object(key, content, content_type):
        nonlocal active_uploads, peak_uploads
        with lock:
            active_uploads += 1
            peak_uploads = max(peak_uploads, active_uploads)
        time.sleep(0.03)
        with lock:
            active_uploads -= 1
        if key == "key-pdf-map.png":
            raise OSError("simulated object storage failure")

    monkeypatch.setattr(server, "put_object", put_object)
    monkeypatch.setattr(server, "delete_object", lambda key: deleted_keys.append(key))

    with pytest.raises(OSError, match="simulated object storage failure"):
        asyncio.run(server.store_pdf_overlay(
            b"pdf", {"type": "Polygon"}, "user-id", "colony-id"
        ))

    assert peak_uploads == 2
    assert set(deleted_keys) == {"key-pdf-map.png", "key-pdf-map-source.png"}


def test_plot_number_extraction_counts_unique_labels_without_registration():
    document = pymupdf.open()
    page = document.new_page(width=200, height=100)
    page.insert_text((20, 25), "1", fontsize=10)
    page.insert_text((50, 25), "2", fontsize=10)
    page.insert_text((80, 25), "2", fontsize=10)
    page.insert_text((110, 25), "PLOT 3", fontsize=10)
    pdf_data = document.tobytes()
    document.close()

    assert extract_pdf_plot_numbers(pdf_data) == ["1", "2", "3"]


@pytest.mark.parametrize("rotation", [0, 90])
def test_pdf_vector_plot_regions_are_registered_and_clipped(rotation, monkeypatch):
    document = pymupdf.open()
    page = document.new_page(width=200, height=140)
    for index in range(3):
        left = 20 + index * 50
        page.draw_rect(pymupdf.Rect(left, 40, left + 40, 100), color=(0, 0, 0), width=0.6)
        page.insert_text((left + 14, 73), str(index + 1), fontsize=8)
    page.set_rotation(rotation)
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.002, 27.002),
        (78.0, 27.002), (78.0, 27.0),
    ]))
    extracted_pdf = importer._extract_pdf(pdf_data)

    def unexpected_pdf_reextraction(data):
        pytest.fail("cached PDF extraction should be reused for plot detection")

    monkeypatch.setattr(importer, "_extract_pdf", unexpected_pdf_reextraction)

    _, _, _, fit, regions = render_pdf_overlay_images(
        pdf_data, boundary, extracted_pdf=extracted_pdf
    )

    assert fit["detected_plot_label_count"] == 3
    assert fit["interactive_plot_count"] == len(regions) >= 3
    assert fit["plot_detection_omitted_count"] == 0
    assert fit["unmatched_plot_numbers"] == []
    assert fit["plot_detection_confidence_type"].startswith("heuristic")
    for region in regions:
        geometry = shape(region["geometry"])
        assert geometry.is_valid
        assert geometry.area > 0
        assert shape(boundary).covers(geometry)
        assert region["detection_source"] == "pdf_vector_polygonization"
        assert region["confidence_type"] == "heuristic"


def test_raster_only_pdf_plot_grid_produces_click_regions():
    raster = Image.new("RGB", (600, 420), "white")
    draw = ImageDraw.Draw(raster)
    for x in (30, 210, 390, 570):
        draw.line((x, 30, x, 390), fill="black", width=3)
    for y in (30, 210, 390):
        draw.line((30, y, 570, y), fill="black", width=3)

    image_bytes = io.BytesIO()
    raster.save(image_bytes, format="PNG")
    document = pymupdf.open()
    page = document.new_page(width=600, height=420)
    page.insert_image(page.rect, stream=image_bytes.getvalue())
    for row, y in enumerate((120, 300)):
        for column, x in enumerate((120, 300, 480)):
            page.insert_text((x - 4, y + 4), str(row * 3 + column + 1), fontsize=12)
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.002, 27.002),
        (78.0, 27.002), (78.0, 27.0),
    ]))

    _, _, _, fit, regions = render_pdf_overlay_images(pdf_data, boundary)

    assert fit["vector_candidate_count"] == 0
    assert fit["raster_candidate_count"] == 6
    assert fit["interactive_plot_count"] == 6
    assert {region["number"] for region in regions} == {"1", "2", "3", "4", "5", "6"}
    assert all(region["detection_source"] == "pdf_raster_vector_trace" for region in regions)


def test_plot_detection_recovers_raster_cells_when_vector_polygonization_fails(monkeypatch):
    document = pymupdf.open()
    page = document.new_page(width=200, height=140)
    for index in range(3):
        left = 20 + index * 50
        page.draw_rect(pymupdf.Rect(left, 40, left + 40, 100), color=(0, 0, 0), width=0.6)
        page.insert_text((left + 14, 73), str(index + 1), fontsize=8)
    pdf_data = document.tobytes()
    document.close()
    extracted_pdf = importer._extract_pdf(pdf_data)
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.002, 27.002),
        (78.0, 27.002), (78.0, 27.0),
    ]))
    def fail_vector_polygonization(extracted):
        raise ValueError("simulated vector polygonization failure")

    monkeypatch.setattr(importer, "_labeled_plot_polygons", fail_vector_polygonization)

    _, _, _, diagnostics, regions = render_pdf_overlay_images(
        pdf_data, boundary, extracted_pdf=extracted_pdf
    )

    assert {region["number"] for region in regions} == {"1", "2", "3"}
    assert diagnostics["detected_plot_label_count"] == 3
    assert diagnostics["plot_detection_candidate_count"] == 3
    assert diagnostics["interactive_plot_count"] == 3
    assert diagnostics["matched_plot_label_count"] == 3
    assert diagnostics["plot_detection_completeness_percent"] == 100
    assert diagnostics["plot_detection_rejected_count"] == 0
    assert diagnostics["plot_detection_omitted_count"] == 0
    assert diagnostics["unmatched_plot_numbers"] == []
    assert "raster cell recovery was attempted" in diagnostics["plot_detection_warning"]


def test_raster_only_pdf_traces_individual_cells_to_unlabeled_vector_regions():
    raster = Image.new("RGB", (600, 420), "white")
    draw = ImageDraw.Draw(raster)
    for x in (30, 190, 350, 510):
        draw.line((x, 30, x, 350), fill="black", width=3)
    for y in (30, 190, 350):
        draw.line((30, y, 510, y), fill="black", width=3)
    image = io.BytesIO()
    raster.save(image, format="PNG")

    document = pymupdf.open()
    page = document.new_page(width=600, height=420)
    page.insert_image(page.rect, stream=image.getvalue())
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.002, 27.002),
        (78.0, 27.002), (78.0, 27.0),
    ]))

    _, _, _, diagnostics, regions = render_pdf_overlay_images(pdf_data, boundary)

    assert diagnostics["plot_detection_method"] == "pdf_raster_vector_trace"
    assert diagnostics["raster_vectorization_method"] == "high_resolution_closed_cell_contours"
    assert diagnostics["raster_vectorization_trace_size_px"][0] > diagnostics["raster_vectorization_source_size_px"][0]
    assert len(regions) == 6
    assert all(region["number"] is None for region in regions)
    assert all(region["detection_source"] == "pdf_raster_vector_trace" for region in regions)
    assert diagnostics["matched_plot_label_count"] == 0
    assert "not verified plot boundaries" in diagnostics["plot_detection_warning"]


def test_vector_pdf_with_incomplete_parcel_paths_uses_high_resolution_contours():
    raster = Image.new("RGB", (600, 420), "white")
    draw = ImageDraw.Draw(raster)
    for x in (30, 210, 390, 570):
        draw.line((x, 30, x, 390), fill="black", width=3)
    for y in (30, 210, 390):
        draw.line((30, y, 570, y), fill="black", width=3)
    image = io.BytesIO()
    raster.save(image, format="PNG")

    document = pymupdf.open()
    page = document.new_page(width=600, height=420)
    page.insert_image(page.rect, stream=image.getvalue())
    page.draw_line((10, 10), (20, 20), color=(0, 0, 0), width=0.5)
    for row, y in enumerate((120, 300)):
        for column, x in enumerate((120, 300, 480)):
            page.insert_text((x - 4, y + 4), str(row * 3 + column + 1), fontsize=12)
    pdf_data = document.tobytes()
    document.close()
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.002, 27.0), (78.002, 27.002),
        (78.0, 27.002), (78.0, 27.0),
    ]))

    _, _, _, diagnostics, regions = render_pdf_overlay_images(pdf_data, boundary)

    assert importer._extract_pdf(pdf_data)["pdf_content"]["pdf_type"] == "mixed"
    assert diagnostics["vector_candidate_count"] == 0
    assert diagnostics["raster_vectorization_method"] == "high_resolution_closed_cell_contours"
    assert diagnostics["raster_detection_labeled_count"] == 6
    assert diagnostics["interactive_plot_count"] == 6
    assert {region["number"] for region in regions} == {"1", "2", "3", "4", "5", "6"}


def test_raster_recovered_plot_label_may_be_near_cell_edge():
    cell = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])
    near_edge_label = [(105, 50, "1", {})]

    matches = _matching_plot_labels_for_cell(
        cell, "1", near_edge_label, raster_recovered=True
    )
    assert len(matches) == 1
    assert _matching_plot_labels_for_cell(
        cell, "1", near_edge_label
    ) == []
    assert _matching_plot_labels_for_cell(
        cell, "1", [(111, 50, "1", {})], raster_recovered=True
    ) == []
    assert _matching_plot_labels_for_cell(
        cell,
        "1",
        near_edge_label + [(109, 50, "2", {})],
        raster_recovered=True,
    ) == []


def test_raster_plot_recovery_uses_local_spacing_for_mixed_scale_colonies():
    raster = Image.new("RGBA", (800, 420), (255, 255, 255, 255))
    draw = ImageDraw.Draw(raster)
    anchors = []

    for index, left in enumerate((30, 210, 390), start=1):
        draw.rectangle((left, 40, left + 120, 160), outline=(0, 0, 0, 255), width=2)
        anchors.append((left + 60, 100, str(index)))

    for index, (left, top) in enumerate(
        ((560, 40), (578, 40), (596, 40), (614, 40),
         (560, 58), (578, 58), (596, 58), (614, 58),
         (560, 76), (578, 76), (596, 76), (614, 76)),
        start=4,
    ):
        draw.rectangle((left, top, left + 12, top + 12), outline=(0, 0, 0, 255), width=1)
        anchors.append((left + 6, top + 6, str(index)))

    regions, diagnostics = _detect_raster_plot_cells(raster, text_anchors=anchors)

    assert {"1", "2", "3"}.issubset(regions)
    assert diagnostics["raster_detection_local_spacing_px"] < 30
    assert diagnostics["raster_detection_labeled_count"] == len(regions)


def test_raster_recovery_closes_small_boundary_gaps_and_smooths_pixel_stair_steps():
    raster = Image.new("RGBA", (200, 200), (255, 255, 255, 255))
    draw = ImageDraw.Draw(raster)
    draw.line((70, 70, 130, 70), fill=(0, 0, 0, 255), width=2)
    draw.line((70, 70, 70, 130), fill=(0, 0, 0, 255), width=2)
    draw.line((70, 130, 130, 130), fill=(0, 0, 0, 255), width=2)
    draw.line((130, 70, 130, 95), fill=(0, 0, 0, 255), width=2)
    draw.line((130, 99, 130, 130), fill=(0, 0, 0, 255), width=2)

    regions, _ = _detect_raster_plot_cells(
        raster, text_anchors=[(100, 100, "1")]
    )

    assert "1" in regions
    jagged = Polygon([
        (0, 0), (10, 0), (10, 1), (11, 1), (11, 0),
        (20, 0), (20, 10), (0, 10), (0, 0),
    ])
    smooth = _smooth_registered_plot_geometry(jagged, 1)
    assert smooth.is_valid
    assert smooth.area == pytest.approx(jagged.area, rel=0.03)
    assert len(smooth.exterior.coords) < len(jagged.exterior.coords)


def test_raster_recovery_ignores_saturated_plot_fills_and_keeps_angled_edges():
    raster = Image.new("RGBA", (300, 220), (255, 255, 255, 255))
    draw = ImageDraw.Draw(raster)
    for row in range(2):
        for column in range(3):
            left = 25 + column * 80
            top = 25 + row * 80
            right = left + 65
            bottom = top + 65
            draw.polygon(
                [(left, top + 8), (right, top), (right - 5, bottom), (left, bottom - 8)],
                fill=(20, 145, 65, 255),
            )
            draw.line(
                [(left, top + 8), (right, top), (right - 5, bottom), (left, bottom - 8), (left, top + 8)],
                fill=(20, 20, 20, 255),
                width=2,
            )

    regions, _ = _detect_raster_plot_cells(raster)

    assert len(regions) == 6
    for polygon in regions.values():
        assert polygon.is_valid
        assert polygon.area > 0
        assert len(polygon.exterior.coords) <= 8


def test_saved_registered_raster_rebuilds_stable_unlabeled_plot_regions():
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
    repeat_regions, _ = detect_registered_overlay_plot_regions(
        png.getvalue(), boundary, bounds
    )

    assert len(regions) == 6
    assert diagnostics["raster_detection_labeled_count"] == 0
    assert diagnostics["plot_detection_method"] == "registered_overlay_raster_closed_cells"
    assert [region["id"] for region in regions] == [region["id"] for region in repeat_regions]
    for region in regions:
        geometry = shape(region["geometry"])
        assert geometry.is_valid
        assert shape(boundary).covers(geometry)
        assert region["number"] is None
        assert region["confidence_type"] == "heuristic"


def test_rebuild_regions_route_persists_unlabeled_regions_and_replaces_old_warning(monkeypatch):
    raster = Image.new("RGBA", (600, 420), (0, 0, 0, 0))
    draw = ImageDraw.Draw(raster)
    draw.rectangle((20, 20, 580, 400), fill=(255, 255, 255, 255))
    for x in (30, 190, 350, 510):
        draw.line((x, 30, x, 350), fill=(0, 0, 0, 255), width=3)
    for y in (30, 190, 350):
        draw.line((30, y, 510, y), fill=(0, 0, 0, 255), width=3)
    png = io.BytesIO()
    raster.save(png, format="PNG")
    boundary = mapping(Polygon([
        (78.0, 27.0), (78.004, 27.0), (78.004, 27.004),
        (78.0, 27.004), (78.0, 27.0),
    ]))
    colony = {
        "_id": "colony-id",
        "boundary": boundary,
        "pdf_overlay": {
            "storage_key": "display-image",
            "base_storage_key": "registered-image",
            "bounds": [[27.0, 78.0], [27.004, 78.004]],
            "fit": {
                "warnings": [
                    "Only 0 plot boundaries were reliable enough to make interactive.",
                    "Existing orientation warning.",
                ],
            },
        },
    }
    saved_updates = []
    audit_events = []

    class ColonyCollection:
        async def update_one(self, query, update):
            saved_updates.append(update["$set"])
            for path, value in update["$set"].items():
                node = colony
                parts = path.split(".")
                for part in parts[:-1]:
                    node = node.setdefault(part, {})
                node[parts[-1]] = value

        async def find_one(self, query):
            return colony

    async def load_owned_colony(colony_id, user):
        return colony

    async def audit_log(*args, **kwargs):
        audit_events.append((args, kwargs))

    monkeypatch.setattr(server, "load_owned_colony", load_owned_colony)
    monkeypatch.setattr(server, "DB", SimpleNamespace(colonies=ColonyCollection()))
    monkeypatch.setattr(server, "get_object", lambda key: (png.getvalue(), "image/png"))
    monkeypatch.setattr(server, "colony_out", lambda doc: {"pdf_overlay": doc["pdf_overlay"]})
    monkeypatch.setattr(server, "audit_log", audit_log)
    monkeypatch.setattr(server, "now_iso", lambda: "2026-10-09T00:00:00Z")

    response = asyncio.run(server.rebuild_pdf_overlay_plot_regions(
        "colony-id", None, {"id": "admin-id"}
    ))

    assert response["status"] == "ok"
    assert response["pdf_overlay"]["fit"]["interactive_plot_count"] == 6
    assert len(response["pdf_overlay"]["plot_regions"]) == 6
    assert all(region["number"] is None for region in response["pdf_overlay"]["plot_regions"])
    assert response["pdf_overlay"]["fit"]["warnings"] == [
        "Existing orientation warning.",
        response["pdf_overlay"]["fit"]["plot_detection_warning"],
    ]
    assert saved_updates[0]["pdf_overlay.plot_regions"] == response["pdf_overlay"]["plot_regions"]
    assert audit_events[0][0][1] == "PDF_OVERLAY_PLOT_REGIONS_REBUILT"
