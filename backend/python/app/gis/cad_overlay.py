"""Render and dynamically fit CAD layout drawings (.dwg, .dxf, .dwf) to a geographic land boundary."""

import hashlib
import io
import logging
import os
import numpy as np
from PIL import Image, ImageChops, ImageDraw
import shapely.geometry as sg
from shapely.ops import transform as transform_geometry
from pyproj import Transformer

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import ezdxf
from app.gis import importer, vector_import

logger = logging.getLogger("cad_overlay")

_TO_MERCATOR = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_FROM_MERCATOR = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


def _ensure_oda_path():
    converter_path = os.environ.get("ODA_FILE_CONVERTER", "").strip()
    if not converter_path and os.name == "nt":
        default_oda = r"C:\Program Files\ODA\ODAFileConverter 27.9.0\ODAFileConverter.exe"
        if os.path.exists(default_oda):
            converter_path = default_oda
            os.environ["ODA_FILE_CONVERTER"] = converter_path
    if converter_path:
        option = "win_exec_path" if os.name == "nt" else "unix_exec_path"
        ezdxf.options.set("odafc-addon", option, converter_path)


def render_cad_overlay_images(cad_data: bytes, boundary_geo: dict, boundary_selection=None, filename=""):
    """Render a CAD (.dwg, .dxf, .dwf) layout drawing and warp it inside a KML land boundary."""
    _ensure_oda_path()
    name = (filename or "").lower()
    is_dwg_or_dwf = name.endswith(".dwg") or name.endswith(".dwf") or not name.endswith(".dxf")

    # 1. Extract CAD vector entities and build transformation
    ex = importer._extract_dxf(cad_data, is_dwg=is_dwg_or_dwf)
    warnings = []
    to_wgs, mode = importer.build_transform(ex, None, warnings, target_boundary=boundary_geo)

    # 2. Parse land boundary
    boundary = sg.shape(boundary_geo)
    if not boundary.is_valid:
        boundary = boundary.buffer(0)
    projected = transform_geometry(_TO_MERCATOR.transform, boundary)
    min_x, min_y, max_x, max_y = projected.bounds
    proj_w = max(1e-7, max_x - min_x)
    proj_h = max(1e-7, max_y - min_y)

    canvas_width = 2400
    canvas_height = max(1, int(canvas_width * (proj_h / proj_w)))
    canvas_size = (canvas_width, canvas_height)

    # 3. Render CAD modelspace drawing to PIL image using ezdxf matplotlib backend
    fig = None
    try:
        from ezdxf.addons import odafc
        from ezdxf.addons.drawing import RenderContext, Frontend
        from ezdxf.addons.drawing.matplotlib import MatplotlibBackend

        tmp_path = importer._tmp(cad_data, ".dwg" if is_dwg_or_dwf else ".dxf")
        if is_dwg_or_dwf:
            doc = odafc.readfile(tmp_path)
        else:
            doc = ezdxf.readfile(tmp_path)

        fig = plt.figure(figsize=(16, 16), dpi=200)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.axis("off")
        ctx = RenderContext(doc)
        out = MatplotlibBackend(ax)
        frontend = Frontend(ctx, out)
        frontend.draw_layout(doc.modelspace(), finalize=True)

        cad_min_x, cad_max_x = ax.get_xlim()
        cad_min_y, cad_max_y = ax.get_ylim()

        buf = io.BytesIO()
        fig.savefig(buf, format="png", transparent=True, pad_inches=0, dpi=200)
        plt.close(fig)
        buf.seek(0)
        cad_image = Image.open(buf).convert("RGBA")

        # 4. Perform geometric affine warp from CAD modelspace to Mercator canvas
        def cad_to_canvas_px(x, y):
            lng, lat = to_wgs(x, y)
            mx, my = _TO_MERCATOR.transform(lng, lat)
            px = (mx - min_x) / proj_w * canvas_width
            py = (max_y - my) / proj_h * canvas_height
            return px, py

        in_pts = np.float64([
            [0.0, 0.0],
            [float(cad_image.width), 0.0],
            [float(cad_image.width), float(cad_image.height)]
        ])

        out_pts = np.float64([
            cad_to_canvas_px(cad_min_x, cad_max_y),
            cad_to_canvas_px(cad_max_x, cad_max_y),
            cad_to_canvas_px(cad_max_x, cad_min_y)
        ])

        A = np.column_stack([out_pts, np.ones(3)])
        X_aff = np.linalg.solve(A, in_pts)
        affine_data = (X_aff[0, 0], X_aff[1, 0], X_aff[2, 0], X_aff[0, 1], X_aff[1, 1], X_aff[2, 1])

        warped = cad_image.transform(
            canvas_size,
            Image.Transform.AFFINE,
            affine_data,
            resample=Image.Resampling.BICUBIC
        )
    except Exception as exc:
        if fig is not None:
            plt.close(fig)
        raise importer.ImportError_(
            f"Could not render the CAD drawing; no blank overlay was created: {exc}"
        ) from exc

    warped_before_clip = warped.copy()

    # 5. Mask warped layout image to boundary polygon contour
    mask = Image.new("L", canvas_size, 0)
    draw = ImageDraw.Draw(mask)

    def mask_ring(ring, val):
        coords = ring.coords
        pts = [
            ((x - min_x) / proj_w * canvas_width, (max_y - y) / proj_h * canvas_height)
            for x, y in coords
        ]
        draw.polygon(pts, fill=val)

    if projected.geom_type == "Polygon":
        mask_ring(projected.exterior, 255)
        for interior in projected.interiors:
            mask_ring(interior, 0)
    elif projected.geom_type == "MultiPolygon":
        for poly in projected.geoms:
            mask_ring(poly.exterior, 255)
            for interior in poly.interiors:
                mask_ring(interior, 0)

    warped.putalpha(ImageChops.multiply(warped.getchannel("A"), mask))

    output = io.BytesIO()
    warped.save(output, format="PNG", optimize=True)
    base_output = io.BytesIO()
    warped_before_clip.save(base_output, format="PNG", optimize=True)

    min_lng, min_lat, max_lng, max_lat = boundary.bounds
    leaflet_bounds = [[min_lat, min_lng], [max_lat, max_lng]]

    input_hash = hashlib.sha256(cad_data).hexdigest()
    boundary_hash = hashlib.sha256(projected.wkb).hexdigest()

    # 6. Build selectable regions only from validated, label-linked CAD cells.
    plot_regions = []
    label_numbers = {
        number
        for text in ex.get("texts", [])
        if len(text) >= 3 and (number := importer.normalize_plot_no(text[2]))
    }
    labeled_cells = importer._labeled_plot_polygons(ex) or {}
    for number, cell in labeled_cells.items():
        if cell.is_empty or not cell.is_valid or cell.area <= 0:
            continue
        geo_coords = [to_wgs(x, y) for x, y in cell.exterior.coords]
        leaflet_coords = [[lat, lng] for lng, lat in geo_coords]
        plot_regions.append({
            "id": f"cad_plot_{number}",
            "number": str(number),
            "status_id": "available",
            "coordinates": leaflet_coords,
            "detection_source": "cad_label_linked_polygon",
        })

    matched_numbers = {region["number"] for region in plot_regions}
    unmatched_numbers = sorted(
        label_numbers - matched_numbers,
        key=lambda number: (not number.isdigit(), int(number) if number.isdigit() else number),
    )
    if unmatched_numbers:
        warnings.append(
            f"{len(unmatched_numbers)} of {len(label_numbers)} recognized CAD plot labels "
            "could not be linked to a verified boundary; those regions were not made clickable."
        )

    diagnostics = {
        "fit_mode": "cad_vector_registration",
        "source_type": "cad",
        "input_cad_sha256": input_hash,
        "boundary_geometry_sha256": boundary_hash,
        "boundary_selection": boundary_selection or {"source": "unspecified"},
        "input_cad_bytes": len(cad_data),
        "source_image_size_px": [cad_image.width, cad_image.height],
        "leaflet_bounds": leaflet_bounds,
        "transform_mode": mode,
        "warnings": warnings,
        "plot_region_count": len(plot_regions),
        "detected_plot_label_count": len(label_numbers),
        "matched_plot_label_count": len(matched_numbers),
        "interactive_plot_count": len(plot_regions),
        "unmatched_plot_numbers": unmatched_numbers,
    }

    return output.getvalue(), base_output.getvalue(), leaflet_bounds, diagnostics, plot_regions
