"""Render and dynamically fit PDF layout imagery to a geographic land boundary."""

import hashlib
import io
import json
import math
import os
import re

import cv2
import numpy as np
import pymupdf
from scipy import ndimage
from scipy.spatial import cKDTree
from PIL import Image, ImageChops, ImageDraw
from pyproj import Geod, Transformer
from shapely.geometry import (
    LineString,
    MultiLineString,
    MultiPoint,
    MultiPolygon,
    Point,
    Polygon,
    mapping,
    shape,
)
from shapely.affinity import scale as scale_geometry
from shapely.ops import polygonize, transform as transform_geometry, unary_union


MAX_OVERLAY_EDGE = 2400
MAX_RASTER_TRACE_EDGE = 3600
MAX_INTERACTIVE_PLOT_REGIONS = 5000
PDF_LAYOUT_BOUNDARY_INSET_RATIO = 0.025
PDF_LAYOUT_FOOTPRINT_PADDING_RATIO = 0.005
PDF_WHITE_TRANSPARENCY_THRESHOLD = 252
_TO_MERCATOR = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_FROM_MERCATOR = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
_GEOD = Geod(ellps="WGS84")


def _calculate_safe_render_scale(page, target_max_edge=MAX_OVERLAY_EDGE, max_scale=3.0, min_scale=0.1):
    """Dynamically determine render scale so the resulting pixmap stays within safe bounds

    regardless of whether the PDF page is a standard A4 (595x842 pt) or a massive CAD/A0 sheet (>5000 pt).
    """
    page_max_pt = max(float(page.rect.width), float(page.rect.height), 1.0)
    ideal_scale = float(target_max_edge) / page_max_pt
    return max(min_scale, min(max_scale, ideal_scale))


def _render_page(pdf_data):
    with pymupdf.open(stream=pdf_data, filetype="pdf") as document:
        if not document.page_count:
            raise ValueError("The uploaded PDF contains no pages")
        page = document[0]
        # Dynamically scale page: high DPI for standard A4/A3, safe bounded dimensions for massive CAD sheets
        scale = _calculate_safe_render_scale(page, target_max_edge=MAX_OVERLAY_EDGE)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
        metadata = {
            "page_index": 0,
            "page_count": document.page_count,
            "page_rotation_deg": int(page.rotation),
            "page_rect_points": [round(float(value), 3) for value in page.rect],
            "page_cropbox_points": [round(float(value), 3) for value in page.cropbox],
            "page_mediabox_points": [round(float(value), 3) for value in page.mediabox],
            "render_size_px": [pixmap.width, pixmap.height],
            "render_scale_px_per_point": round(float(scale), 5),
        }
    return image, metadata


def _vectorize_raster_pdf_cells(pdf_data, source, text_anchors=()):
    """Trace raster-only PDF cell outlines into polygons at dynamic safe working resolution."""
    with pymupdf.open(stream=pdf_data, filetype="pdf") as document:
        page = document[0]
        # Dynamically scale trace image safely bounded to MAX_RASTER_TRACE_EDGE
        scale = _calculate_safe_render_scale(page, target_max_edge=MAX_RASTER_TRACE_EDGE, max_scale=6.0)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        trace_image = Image.frombytes(
            "RGB", (pixmap.width, pixmap.height), pixmap.samples
        )

    scale_x = source.width / max(trace_image.width, 1)
    scale_y = source.height / max(trace_image.height, 1)
    trace_anchors = [
        (float(x) / scale_x, float(y) / scale_y, str(number))
        for x, y, number in text_anchors
    ]
    cells, diagnostics = _detect_raster_plot_cells(
        trace_image, text_anchors=trace_anchors
    )
    source_cells = {
        key: scale_geometry(cell, xfact=scale_x, yfact=scale_y, origin=(0, 0))
        for key, cell in cells.items()
    }
    return source_cells, {
        "raster_vectorization_method": "high_resolution_closed_cell_contours",
        "raster_vectorization_source_size_px": [source.width, source.height],
        "raster_vectorization_trace_size_px": [trace_image.width, trace_image.height],
        "raster_vectorization_candidate_count": len(source_cells),
        "raster_vectorization_geometry_type": "heuristic polygons; source remains raster",
        **diagnostics,
    }


def _sample_pixels(xs, ys, max_points=12000):
    stride = max(1, int(np.ceil(len(xs) / max_points)))
    return np.column_stack((xs[::stride], ys[::stride]))


def _source_footprint(image, vector_plot_cells=None):
    """Prefer parcel-vector evidence, then color, and finally flagged page content."""
    if vector_plot_cells:
        cell_polygons = [
            cell for cell in vector_plot_cells.values()
            if isinstance(cell, Polygon) and cell.is_valid and cell.area > 0
        ]
        if len(cell_polygons) >= 3:
            footprint_hull = unary_union(cell_polygons).convex_hull
            rectangle = footprint_hull.minimum_rotated_rectangle
            if isinstance(rectangle, Polygon) and len(rectangle.exterior.coords) == 5:
                corners = np.asarray(rectangle.exterior.coords[:-1], dtype=np.float64)
                coordinates = np.asarray(
                    [point for cell in cell_polygons for point in cell.exterior.coords[:-1]],
                    dtype=np.float64,
                )
                nearest_distances, _ = cKDTree(coordinates).query(coordinates, k=2)
                spacing = float(np.median(nearest_distances[:, 1]))
                footprint_width = footprint_hull.bounds[2] - footprint_hull.bounds[0]
                footprint_height = footprint_hull.bounds[3] - footprint_hull.bounds[1]
                padding = max(
                    2.0,
                    spacing * 0.15,
                    max(footprint_width, footprint_height) * PDF_LAYOUT_FOOTPRINT_PADDING_RATIO,
                )
                footprint_outline = footprint_hull.buffer(padding, join_style="mitre")
                if footprint_outline.is_valid and not footprint_outline.is_empty:
                    return (
                        corners,
                        np.asarray(footprint_outline.exterior.coords),
                        "pdf_vector_plot_cells",
                        0,
                        len(cell_polygons),
                    )

    # Downscale for footprint detection: Footprint bounding box only requires preview resolution (max 800px)
    # This reduces memory allocation from 45MB to ~0.5MB, completely eliminating ArrayMemoryError on Windows
    scale_factor = min(1.0, 800.0 / max(image.width, image.height, 1))
    if scale_factor < 1.0:
        thumb_w = max(1, int(round(image.width * scale_factor)))
        thumb_h = max(1, int(round(image.height * scale_factor)))
        thumb = image.resize((thumb_w, thumb_h), Image.Resampling.BOX)
    else:
        thumb = image
        scale_factor = 1.0

    inv_scale = 1.0 / scale_factor

    # Fast, memory-efficient color detection using uint8 (zero 16-bit casting)
    rgb = np.asarray(thumb if thumb.mode == "RGB" else thumb.convert("RGB"))
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    spread = max_c - min_c
    saturated = (spread >= 28) & (max_c < 250) & (min_c < 238)
    ys, xs = np.nonzero(saturated)
    method = "colored_content_minimum_area_rectangle"

    if len(xs) < max(50, int(thumb.width * thumb.height * 0.0002)):
        gray = np.asarray(thumb.convert("L"))
        ys, xs = np.nonzero(gray < 220)
        method = "nonwhite_content_minimum_area_rectangle"
    if len(xs) < 4:
        raise ValueError("Could not detect the PDF layout footprint; manual crop adjustment is required")

    points = _sample_pixels(xs, ys).astype(np.float64) * inv_scale
    center = points.mean(axis=0)
    _, axes = np.linalg.eigh(np.cov(points, rowvar=False))
    axes = axes[:, ::-1]
    projected = (points - center) @ axes
    lower, upper = np.quantile(projected, [0.002, 0.998], axis=0)
    inlier_mask = np.all((projected >= lower) & (projected <= upper), axis=1)
    inlier_points = points[inlier_mask]
    footprint_hull = MultiPoint(inlier_points.tolist()).convex_hull
    rectangle = footprint_hull.minimum_rotated_rectangle
    if not isinstance(rectangle, Polygon) or len(rectangle.exterior.coords) != 5:
        raise ValueError("The PDF layout footprint is degenerate; manual crop adjustment is required")
    corners = np.asarray(rectangle.exterior.coords[:-1], dtype=np.float64)
    footprint_width = footprint_hull.bounds[2] - footprint_hull.bounds[0]
    footprint_height = footprint_hull.bounds[3] - footprint_hull.bounds[1]
    padding = max(
        2.0,
        max(footprint_width, footprint_height) * PDF_LAYOUT_FOOTPRINT_PADDING_RATIO,
    )
    clipped_hull = footprint_hull.buffer(padding, join_style="mitre")
    return corners, np.asarray(clipped_hull.exterior.coords), method, len(xs), 0


def _remove_pdf_page_white(rgba_image):
    """Make near-white PDF pixels transparent while retaining linework and fills."""
    rgba = np.asarray(rgba_image.convert("RGBA")).copy()
    rgb = rgba[:, :, :3]

    # Calculate luminance with integer math to avoid multi-megabyte float32 arrays
    r = rgb[:, :, 0].astype(np.uint16)
    g = rgb[:, :, 1].astype(np.uint16)
    b = rgb[:, :, 2].astype(np.uint16)
    lum = (r * 77 + g * 150 + b * 29) >> 8

    max_c = np.maximum(np.maximum(rgb[:, :, 0], rgb[:, :, 1]), rgb[:, :, 2])
    min_c = np.minimum(np.minimum(rgb[:, :, 0], rgb[:, :, 1]), rgb[:, :, 2])
    chroma = max_c - min_c

    neutral = chroma <= 18
    page_white = neutral & (lum >= 240) & (rgba[:, :, 3] > 0)

    # In-place alpha calculation
    alpha = rgba[:, :, 3].astype(np.float32)
    if np.any(page_white):
        alpha[page_white] = np.clip(
            (PDF_WHITE_TRANSPARENCY_THRESHOLD - lum[page_white].astype(np.float32))
            / (PDF_WHITE_TRANSPARENCY_THRESHOLD - 240),
            0.0,
            1.0,
        ) * (alpha[page_white] / 255.0) * 255.0

    rgba[:, :, 3] = np.round(alpha).astype(np.uint8)
    return Image.fromarray(rgba, mode="RGBA")


def _rasterize_pdf_extraction(pdf_data, extracted, source):
    """Map extracted PDF vectors and text into rendered-page pixel coordinates."""
    with pymupdf.open(stream=pdf_data, filetype="pdf") as document:
        page = document[0]
        page_height = float(page.cropbox.height)
        scale = source.width / max(float(page.rect.width), 1e-9)
        rotation = page.rotation_matrix

        def raster_point(x, y=None, z=None):
            if y is None:
                x, y = x[:2]
            x_values = np.asarray(x, dtype=np.float64)
            y_values = np.asarray(y, dtype=np.float64)
            if np.isscalar(x):
                point = pymupdf.Point(float(x), page_height - float(y)) * rotation
                return float(point.x) * scale, float(point.y) * scale
            points = [
                pymupdf.Point(float(px), page_height - float(py)) * rotation
                for px, py in zip(x_values, y_values)
            ]
            return (
                np.asarray([point.x for point in points]) * scale,
                np.asarray([point.y for point in points]) * scale,
            )

        annotations = []
        for annotation in extracted.get("annotations", []):
            x, y = raster_point(annotation["x"], annotation["y"])
            direction = annotation.get("direction") or (1.0, 0.0)
            end_x, end_y = raster_point(
                annotation["x"] + float(direction[0]),
                annotation["y"] + float(direction[1]),
            )
            annotations.append({
                "x": x,
                "y": y,
                "text": annotation["text"],
                "direction": (end_x - x, end_y - y),
                "font_size": annotation.get("font_size", 0),
            })
        return {
            "lines": [
                ([raster_point(point) for point in points], layer, fill)
                for points, layer, fill in extracted.get("lines", [])
            ],
            "polys": [
                ([raster_point(point) for point in points], layer, fill)
                for points, layer, fill in extracted.get("polys", [])
            ],
            "texts": [
                (*raster_point((x, y)), text, layer)
                for x, y, text, layer in extracted.get("texts", [])
            ],
            "annotations": annotations,
        }


def _registered_pdf_text_annotations(
    texts, source_outline, forward, projected_boundary, projected_bounds, canvas_size
):
    """Project extracted text centers through the exact PDF-image homography."""
    crop_polygon = Polygon(source_outline)
    min_x, min_y, max_x, max_y = projected_bounds
    width, height = canvas_size
    annotations = []
    for text_annotation in texts:
        if isinstance(text_annotation, dict):
            x = float(text_annotation["x"])
            y = float(text_annotation["y"])
            text = text_annotation["text"]
            direction = text_annotation.get("direction") or (1.0, 0.0)
        else:
            x, y, text, _ = text_annotation
            x, y = float(x), float(y)
            direction = (1.0, 0.0)
        content = str(text).strip()
        if not content or not crop_polygon.covers(Point(x, y)):
            continue
        coordinates = np.asarray([float(x), float(y), 1.0])
        mapped = forward @ coordinates
        if not np.all(np.isfinite(mapped)) or abs(mapped[2]) <= 1e-9:
            continue
        pixel_x, pixel_y = mapped[:2] / mapped[2]
        direction_mapped = forward @ np.asarray(
            [x + float(direction[0]), y + float(direction[1]), 1.0]
        )
        if (
            not np.all(np.isfinite(direction_mapped))
            or abs(direction_mapped[2]) <= 1e-9
        ):
            continue
        direction_pixel = direction_mapped[:2] / direction_mapped[2]
        angle_deg = float(np.degrees(np.arctan2(
            direction_pixel[1] - pixel_y,
            direction_pixel[0] - pixel_x,
        )))
        mercator_x = min_x + pixel_x / max(width - 1, 1) * (max_x - min_x)
        mercator_y = max_y - pixel_y / max(height - 1, 1) * (max_y - min_y)
        projected_point = Point(mercator_x, mercator_y)
        if not projected_boundary.covers(projected_point):
            continue
        longitude, latitude = _FROM_MERCATOR.transform(mercator_x, mercator_y)
        if not np.isfinite(longitude) or not np.isfinite(latitude):
            continue
        if re.fullmatch(
            r"(?:plot\s*(?:no\.?)?\s*)?[A-Z]{0,2}[-/ ]?\d{1,4}[A-Z]?",
            content,
            re.I,
        ):
            annotation_type = "plot"
        elif re.search(r"\b(road|rd|street|lane|wide|width)\b", content, re.I):
            annotation_type = "road"
        elif re.search(r"\b(park|garden|green|amenity|club)\b", content, re.I):
            annotation_type = "place"
        elif re.search(r"\d", content) and re.search(
            r"(?:\b(?:m|ft|feet|sq\.?\s*(?:m|ft|yd)|sqm|sqft)\b|[x×]|"
            r"\d\s*['′″\"]|\d\s*-\s*\d+\s*['′″\"])",
            content,
            re.I,
        ):
            annotation_type = "dimension"
        else:
            annotation_type = "text"
        annotations.append({
            "text": content[:120],
            "type": annotation_type,
            "angle_deg": round(angle_deg, 2),
            "geometry": {
                "type": "Point",
                "coordinates": [round(float(longitude), 8), round(float(latitude), 8)],
            },
        })
        if len(annotations) >= 2000:
            break
    return annotations


def _unique_exterior_vertices(polygon):
    coordinates = list(polygon.exterior.coords)
    if len(coordinates) > 1 and coordinates[0] == coordinates[-1]:
        coordinates.pop()
    unique = []
    for coordinate in coordinates:
        if not unique or coordinate[:2] != unique[-1][:2]:
            unique.append(coordinate[:2])
    if len(unique) > 1 and unique[0] == unique[-1]:
        unique.pop()
    return np.asarray(unique, dtype=np.float64)


def _target_quad(boundary):
    """Use a convex quadrilateral perimeter or a warned envelope fallback."""
    if isinstance(boundary, Polygon):
        vertices = _unique_exterior_vertices(boundary)
        convex_boundary = boundary.convex_hull
        is_convex_quad = (
            len(vertices) == 4
            and convex_boundary.geom_type == "Polygon"
            and abs(convex_boundary.area - boundary.area) <= max(boundary.area, 1.0) * 1e-9
        )
        if is_convex_quad:
            return vertices, "quadrilateral_homography", []

    envelope = boundary.minimum_rotated_rectangle
    if not isinstance(envelope, Polygon) or len(envelope.exterior.coords) != 5:
        raise ValueError("Could not derive a stable outer layout envelope from the KML boundary")
    vertices = _unique_exterior_vertices(envelope)
    warnings = [
        "The KML boundary is not a quadrilateral. The image was fitted to its oriented envelope and clipped to the actual perimeter; not every edge can be registered from one image transform."
    ]
    if isinstance(boundary, Polygon) and len(_unique_exterior_vertices(boundary)) == 4:
        warnings.append(
            "The four-vertex KML boundary is concave and cannot be safely mapped by a single projective transform; its oriented envelope was used instead."
        )
    return vertices, "oriented_envelope_fallback", warnings


def _inset_quad(vertices, ratio=PDF_LAYOUT_BOUNDARY_INSET_RATIO):
    """Move the PDF fit perimeter inward to preserve a small land-edge margin."""
    corners = np.asarray(vertices, dtype=np.float64)
    center = corners.mean(axis=0)
    return center + (corners - center) * (1 - ratio)


def _corner_correspondence(source, target):
    source_lengths = np.linalg.norm(np.roll(source, -1, axis=0) - source, axis=1)
    source_area = float(np.sum(
        source[:, 0] * np.roll(source[:, 1], -1)
        - source[:, 1] * np.roll(source[:, 0], -1)
    ))
    candidates = []
    for reverse in (False, True):
        ordered = target[::-1] if reverse else target
        for shift in range(4):
            candidate = np.roll(ordered, -shift, axis=0)
            candidate_area = float(np.sum(
                candidate[:, 0] * np.roll(candidate[:, 1], -1)
                - candidate[:, 1] * np.roll(candidate[:, 0], -1)
            ))
            if source_area * candidate_area <= 0:
                continue
            target_lengths = np.linalg.norm(np.roll(candidate, -1, axis=0) - candidate, axis=1)
            ratios = np.log(np.maximum(target_lengths, 1e-9) / np.maximum(source_lengths, 1e-9))
            score = float(np.std(ratios))
            candidates.append((score, shift, reverse, candidate, ratios))
    if not candidates:
        raise ValueError("The detected PDF footprint and KML perimeter have incompatible corner order")
    lowest_score = min(item[0] for item in candidates)
    plausible = [item for item in candidates if item[0] <= lowest_score + 0.02]
    source_top_edge = int(np.argmin((source[:, 1] + np.roll(source[:, 1], -1)) / 2))

    def north_up_penalty(candidate):
        # Both PDF image and target canvas coordinates have Y=0 at TOP (North)
        # So the northernmost edge has the minimum Y value (argmin)
        candidate_north_edge = int(
            np.argmin((candidate[:, 1] + np.roll(candidate[:, 1], -1)) / 2)
        )
        return int(candidate_north_edge != source_top_edge)

    plausible.sort(key=lambda item: (north_up_penalty(item[3]), item[0], item[1], item[2]))
    best = plausible[0]
    sorted_scores = sorted(item[0] for item in candidates)
    score_gap = sorted_scores[1] - sorted_scores[0] if len(sorted_scores) > 1 else float("inf")
    warnings = []
    if score_gap < 0.02:
        warnings.append(
            "The KML/PDF edge dimensions do not uniquely determine orientation. Alternative cyclic orientations are available in the fit diagnostics; the selected candidate uses a north-up edge heuristic and must be verified against the satellite map."
        )
    alternatives = [
        {
            "cyclic_shift": int(item[1]),
            "reversed_order": bool(item[2]),
            "edge_ratio_score": round(float(item[0]), 6),
            "target_corners_canvas_px": [
                [round(float(x), 2), round(float(y), 2)] for x, y in item[3]
            ],
        }
        for item in plausible
    ]
    return best[3], best[4], best[0], score_gap, best[1], best[2], warnings, alternatives


def _homography(source, target):
    def normalize(points):
        center = points.mean(axis=0)
        mean_distance = np.linalg.norm(points - center, axis=1).mean()
        if not np.isfinite(mean_distance) or mean_distance <= 1e-12:
            raise ValueError("Could not calculate a stable image-to-boundary transformation")
        scale = np.sqrt(2) / mean_distance
        matrix = np.asarray([
            [scale, 0, -scale * center[0]],
            [0, scale, -scale * center[1]],
            [0, 0, 1],
        ])
        homogeneous = np.column_stack((points, np.ones(len(points))))
        normalized = (matrix @ homogeneous.T).T[:, :2]
        return normalized, matrix

    source_normalized, source_matrix = normalize(np.asarray(source, dtype=np.float64))
    target_normalized, target_matrix = normalize(np.asarray(target, dtype=np.float64))
    rows = []
    for (x, y), (u, v) in zip(source_normalized, target_normalized):
        rows.extend((
            [x, y, 1, 0, 0, 0, -u * x, -u * y],
            [0, 0, 0, x, y, 1, -v * x, -v * y],
        ))
    matrix = np.asarray(rows, dtype=np.float64)
    right = np.asarray([
        coordinate
        for point in target_normalized
        for coordinate in point
    ], dtype=np.float64)
    try:
        coefficients = np.linalg.solve(matrix, right)
        condition = float(np.linalg.cond(matrix))
    except np.linalg.LinAlgError as exc:
        raise ValueError("Could not calculate a stable image-to-boundary transformation") from exc
    if not np.isfinite(condition) or condition > 1e12:
        raise ValueError("The image-to-boundary control points are numerically unstable")
    normalized_homography = np.append(coefficients, 1).reshape(3, 3)
    homography = np.linalg.inv(target_matrix) @ normalized_homography @ source_matrix
    if not np.all(np.isfinite(homography)) or abs(np.linalg.det(homography)) <= 1e-15:
        raise ValueError("The image-to-boundary transformation is degenerate")
    return homography, condition


def _polygons(geometry):
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    raise ValueError("PDF overlay boundary must be a Polygon or MultiPolygon")


def _mask_ring(draw, ring, bounds, size, fill):
    min_x, min_y, max_x, max_y = bounds
    width, height = size
    pixels = [
        (
            (x - min_x) / (max_x - min_x) * (width - 1),
            (max_y - y) / (max_y - min_y) * (height - 1),
        )
        for x, y in ring.coords
    ]
    draw.polygon(pixels, fill=fill)


def _boundary_fit_metrics(mapped_corners, projected_boundary, bounds, canvas_size):
    min_x, min_y, max_x, max_y = bounds
    width, height = canvas_size
    target_pixel_boundary = transform_geometry(
        lambda x, y, z=None: (
            (np.asarray(x) - min_x) / (max_x - min_x) * (width - 1),
            (max_y - np.asarray(y)) / (max_y - min_y) * (height - 1),
        ),
        projected_boundary,
    )
    fitted_boundary = Polygon(mapped_corners)
    if fitted_boundary.is_empty or not fitted_boundary.is_valid:
        raise ValueError("The fitted PDF footprint is invalid or self-intersecting")

    target_line = target_pixel_boundary.boundary
    fitted_line = fitted_boundary.boundary
    sample_count = 256

    def sampled_distances(source_line, destination_line):
        return [
            source_line.interpolate(index / sample_count, normalized=True).distance(destination_line)
            for index in range(sample_count)
        ]

    distances = sampled_distances(target_line, fitted_line) + sampled_distances(
        fitted_line, target_line
    )
    pixel_scale_x = (max_x - min_x) / max(width - 1, 1)
    pixel_scale_y = (max_y - min_y) / max(height - 1, 1)
    meter_scale = (pixel_scale_x + pixel_scale_y) / 2
    return {
        "boundary_mean_distance_m": round(float(np.mean(distances) * meter_scale), 3),
        "boundary_max_sampled_distance_m": round(float(max(distances) * meter_scale), 3),
    }


def _raster_component_polygon(component_mask, offset_x, offset_y):
    rows, columns = np.nonzero(component_mask)
    if not len(rows):
        return None
    height, width = component_mask.shape
    edges = []

    exposed = (columns == 0) | ~component_mask[rows, np.maximum(columns - 1, 0)]
    for row, column in zip(rows[exposed], columns[exposed]):
        edges.append([(column + offset_x, row + offset_y), (column + offset_x, row + 1 + offset_y)])

    exposed = (columns == width - 1) | ~component_mask[rows, np.minimum(columns + 1, width - 1)]
    for row, column in zip(rows[exposed], columns[exposed]):
        edges.append([(column + 1 + offset_x, row + 1 + offset_y), (column + 1 + offset_x, row + offset_y)])

    exposed = (rows == 0) | ~component_mask[np.maximum(rows - 1, 0), columns]
    for row, column in zip(rows[exposed], columns[exposed]):
        edges.append([(column + 1 + offset_x, row + offset_y), (column + offset_x, row + offset_y)])

    exposed = (rows == height - 1) | ~component_mask[np.minimum(rows + 1, height - 1), columns]
    for row, column in zip(rows[exposed], columns[exposed]):
        edges.append([(column + offset_x, row + 1 + offset_y), (column + 1 + offset_x, row + 1 + offset_y)])

    if len(edges) < 12:
        return None
    merged = unary_union(MultiLineString(edges))
    faces = [face for face in polygonize(merged) if face.is_valid and face.area > 0]
    if not faces:
        return None
    polygon = max(faces, key=lambda face: face.area)
    if not isinstance(polygon, Polygon) or not polygon.is_valid or polygon.area <= 0:
        return None
    return polygon.simplify(1.25, preserve_topology=True)


def _smooth_registered_plot_geometry(geometry, pixel_size_m):
    if geometry.is_empty or not geometry.is_valid or pixel_size_m <= 0:
        return geometry
    tolerance = pixel_size_m * 1.25
    smoothed = geometry.simplify(tolerance, preserve_topology=True)
    radius = pixel_size_m * 0.65
    smoothed = smoothed.buffer(radius, quad_segs=2).buffer(-radius, quad_segs=2)
    if smoothed.is_empty or not smoothed.is_valid:
        return geometry
    smoothed = smoothed.simplify(pixel_size_m * 0.4, preserve_topology=True)
    return smoothed if not smoothed.is_empty and smoothed.is_valid else geometry


def _trace_endpoint_direction(skel, ep, max_steps=8):
    y, x = ep
    visited = {(y, x)}
    curr_y, curr_x = y, x
    path = [(curr_x, curr_y)]
    for _ in range(max_steps):
        neighbors = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ny, nx = curr_y + dy, curr_x + dx
                if 0 <= ny < skel.shape[0] and 0 <= nx < skel.shape[1]:
                    if skel[ny, nx] > 0 and (ny, nx) not in visited:
                        neighbors.append((ny, nx))
        if len(neighbors) == 1:
            curr_y, curr_x = neighbors[0]
            visited.add((curr_y, curr_x))
            path.append((curr_x, curr_y))
        else:
            break
    if len(path) < 2:
        return None
    vx = float(path[0][0] - path[-1][0])
    vy = float(path[0][1] - path[-1][1])
    norm = math.hypot(vx, vy)
    if norm < 1e-4:
        return None
    return vx / norm, vy / norm, path


def _complete_topological_boundaries(binary_linework, max_gap_px=10, text_anchors=(), in_crop=None):
    """Conservative edge-completion stage for broken boundary segments.

    Detects dangling endpoints of broken line segments and bridges gaps only when:
    - Endpoints are collinear and facing each other within angle tolerance (Mode A)
      OR form a valid perpendicular corner intersection in front of both endpoints (Mode B).
    - Distance is within scale-aware max_gap_px (preventing connection across roads/lots).
    - Bridge does not cross near text anchors, stamps, or outside the crop boundary.
    """
    mask = (binary_linework > 0).astype(np.uint8) * 255
    if hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "thinning"):
        skel = cv2.ximgproc.thinning(mask)
    else:
        skel = np.zeros_like(mask)
        element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
        temp = mask.copy()
        while cv2.countNonZero(temp) > 0:
            eroded = cv2.erode(temp, element)
            opened = cv2.morphologyEx(eroded, cv2.MORPH_OPEN, element)
            skel = cv2.bitwise_or(skel, cv2.subtract(eroded, opened))
            temp = eroded

    kernel = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], dtype=np.uint8)
    neighbors = cv2.filter2D((skel > 0).astype(np.uint8), -1, kernel)
    endpoint_coords = np.column_stack(np.where((skel > 0) & (neighbors == 1)))

    endpoints = []
    for y, x in endpoint_coords:
        if in_crop is not None and not in_crop[y, x]:
            continue
        res = _trace_endpoint_direction(skel, (y, x))
        if res is not None:
            vx, vy, path = res
            endpoints.append({
                "pt": (int(x), int(y)),
                "dir": (vx, vy),
                "path": path,
            })

    completed = (binary_linework > 0).astype(np.uint8)
    num_endpoints = len(endpoints)
    used = set()
    bridges = []
    anchor_pts = [(float(ax), float(ay)) for ax, ay, _ in text_anchors]

    for i in range(num_endpoints):
        if i in used:
            continue
        ep1 = endpoints[i]
        p1 = ep1["pt"]
        d1 = ep1["dir"]
        best_candidate = None
        best_dist = float("inf")

        for j in range(num_endpoints):
            if i == j or j in used:
                continue
            ep2 = endpoints[j]
            p2 = ep2["pt"]
            d2 = ep2["dir"]

            dx = p2[0] - p1[0]
            dy = p2[1] - p1[1]
            dist = math.hypot(dx, dy)
            if dist < 2.0 or dist > max_gap_px:
                continue

            ux = dx / dist
            uy = dy / dist

            # Mode A: Collinear continuation check
            dot1 = d1[0] * ux + d1[1] * uy
            dot2 = d2[0] * (-ux) + d2[1] * (-uy)
            is_collinear = dot1 >= 0.70 and dot2 >= 0.70

            # Mode B: Perpendicular corner intersection
            is_corner = False
            corner_pt = None
            if not is_collinear:
                dir_dot = abs(d1[0] * d2[0] + d1[1] * d2[1])
                if dir_dot <= 0.40:
                    denom = d1[0] * (-d2[1]) - d1[1] * (-d2[0])
                    if abs(denom) > 1e-4:
                        t = (dx * (-d2[1]) - dy * (-d2[0])) / denom
                        s = (d1[0] * dy - d1[1] * dx) / denom
                        if 1.0 <= t <= max_gap_px and 1.0 <= s <= max_gap_px:
                            c_x = int(round(p1[0] + t * d1[0]))
                            c_y = int(round(p1[1] + t * d1[1]))
                            if in_crop is None or (
                                0 <= c_y < in_crop.shape[0]
                                and 0 <= c_x < in_crop.shape[1]
                                and in_crop[c_y, c_x]
                            ):
                                is_corner = True
                                corner_pt = (c_x, c_y)

            if is_collinear or is_corner:
                mid_x = corner_pt[0] if is_corner else (p1[0] + p2[0]) / 2.0
                mid_y = corner_pt[1] if is_corner else (p1[1] + p2[1]) / 2.0
                near_anchor = any(
                    math.hypot(mid_x - ax, mid_y - ay) < 8.0 for ax, ay in anchor_pts
                )
                if not near_anchor and dist < best_dist:
                    best_dist = dist
                    best_candidate = (j, is_corner, corner_pt)

        if best_candidate is not None:
            j, is_corner, corner_pt = best_candidate
            p2 = endpoints[j]["pt"]
            used.add(i)
            used.add(j)
            bridges.append((p1, p2))
            if is_corner and corner_pt is not None:
                cv2.line(completed, p1, corner_pt, 1, thickness=2)
                cv2.line(completed, corner_pt, p2, 1, thickness=2)
            else:
                cv2.line(completed, p1, p2, 1, thickness=2)

    return completed > 0, len(bridges)


def _detect_raster_plot_cells(source, source_outline=None, text_anchors=()):
    """Find closed raster cells and associate labels only when they are unambiguous.

    Uses adaptive background difference and chroma filtering to handle faint lines,
    uneven illumination, colored fills, and grey paper backgrounds deterministically.
    """
    if source is None:
        return {}, {
            "raster_candidate_count": 0,
            "raster_raw_polygon_count": 0,
            "raster_detection_method": "adaptive_morphology",
            "raster_detection_warning": "Input source image is None.",
        }

    try:
        if source.width < 10 or source.height < 10:
            return {}, {
                "raster_candidate_count": 0,
                "raster_raw_polygon_count": 0,
                "raster_detection_method": "adaptive_morphology",
                "raster_detection_warning": "Image dimensions are too small to detect plot cells.",
            }
        rgba = np.asarray(source.convert("RGBA"))
    except Exception as exc:
        return {}, {
            "raster_candidate_count": 0,
            "raster_raw_polygon_count": 0,
            "raster_detection_method": "adaptive_morphology",
            "raster_detection_warning": f"Failed to process source image: {exc}",
        }

    # In-crop: non-transparent pixels
    in_crop = rgba[:, :, 3] > 128
    if source_outline is not None:
        try:
            crop_mask = Image.new("1", source.size, 0)
            ImageDraw.Draw(crop_mask).polygon(
                [(float(x), float(y)) for x, y in source_outline], fill=1
            )
            in_crop &= np.asarray(crop_mask, dtype=bool)
        except Exception:
            pass

    if not np.any(in_crop):
        return {}, {
            "raster_candidate_count": 0,
            "raster_raw_polygon_count": 0,
            "raster_detection_method": "adaptive_morphology",
            "raster_detection_warning": "No pixels inside crop outline.",
        }

    rgb = rgba[:, :, :3].astype(np.int16)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    gray = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2GRAY)

    # 1. Local background estimation via 25x25 morphological dilation
    # (Avoids median blur on gray to preserve 1px-thin parcel boundaries and sharp corners)
    kernel_bg = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25))
    bg_local = cv2.morphologyEx(gray, cv2.MORPH_DILATE, kernel_bg)
    diff = cv2.subtract(bg_local, gray)

    # 2. Adaptive linework segmentation:
    # - Pixel is darker than local paper background (diff >= 12)
    # - Chroma filter: reject saturated color fills (parks, zones) where chroma >= 110,
    #   while preserving neutral linework (chroma < 65) and dark colored/blueprint ink (gray < 80)
    # - Inside valid crop mask
    is_line = (
        (diff >= 12)
        & ((chroma < 65) | (gray < 80))
        & (chroma < 110)
        & in_crop
    )

    # 3. Filter isolated scanner noise speckles (< 6 px) without eroding continuous 1px lines
    dark_components, dark_count = ndimage.label(is_line)
    if dark_count:
        dark_sizes = np.bincount(dark_components.ravel(), minlength=dark_count + 1)
        small_speckles = dark_sizes < 6
        small_speckles[0] = False
        is_line[small_speckles[dark_components]] = False

    anchors_by_number = {}
    for x, y, number in text_anchors:
        anchors_by_number.setdefault(str(number), set()).add((float(x), float(y)))
    ambiguous_numbers = {
        number for number, points in anchors_by_number.items() if len(points) > 1
    }
    unique_anchors = [
        (x, y, number)
        for number, points in anchors_by_number.items()
        if number not in ambiguous_numbers
        for x, y in points
    ]
    anchor_coordinates = np.asarray(
        [(x, y) for x, y, _ in unique_anchors], dtype=np.float64
    ).reshape((-1, 2))
    if len(anchor_coordinates) > 1:
        nearest_distances, _ = cKDTree(anchor_coordinates).query(anchor_coordinates, k=2)
        local_spacings = nearest_distances[:, 1]
        valid_spacings = local_spacings[np.isfinite(local_spacings) & (local_spacings > 0)]
        spacing = float(np.median(valid_spacings)) if len(valid_spacings) else 0
    else:
        local_spacings = np.zeros(len(anchor_coordinates), dtype=np.float64)
        spacing = 0

    anchor_spacing_by_number = {
        anchor[2]: float(local_spacings[index])
        for index, anchor in enumerate(unique_anchors)
    }

    if unique_anchors and spacing > 0:
        label_crop = Image.new("1", source.size, 0)
        label_crop_draw = ImageDraw.Draw(label_crop)
        for index, (x, y, _) in enumerate(unique_anchors):
            local_spacing = float(local_spacings[index]) or spacing
            margin = max(16, local_spacing * 1.5)
            label_crop_draw.rectangle(
                (x - margin, y - margin, x + margin, y + margin),
                fill=1,
            )
        in_crop &= np.asarray(label_crop, dtype=bool)

    linework = is_line | ~in_crop

    # 4. Bridge minor boundary gaps (1-2 px) using morphological binary closing
    linework = ndimage.binary_closing(
        linework, structure=np.ones((3, 3), dtype=bool), iterations=2
    )

    # 5. Remove isolated text components that might bisect cells
    dark_components, dark_count = ndimage.label(linework)
    dark_sizes = np.bincount(dark_components.ravel(), minlength=dark_count + 1)
    if spacing > 0:
        text_component_limit = max(24, int(spacing * 1.5))
        remove_text = dark_sizes < text_component_limit
        remove_text[0] = False
    # 6. Conservative topological boundary completion for broken segments (> 3 px)
    max_gap = (
        min(18, max(8, int(spacing * 0.20)))
        if spacing > 0
        else min(16, max(10, int(min(source.size) * 0.025)))
    )
    linework, bridge_count = _complete_topological_boundaries(
        linework, max_gap_px=max_gap, text_anchors=text_anchors, in_crop=in_crop
    )

    # 7. Label enclosed parcel candidate regions
    enclosed = ~linework
    components, component_count = ndimage.label(enclosed & in_crop)
    if not component_count:
        return {}, {
            "raster_candidate_count": 0,
            "raster_raw_polygon_count": 0,
            "raster_detection_method": "adaptive_morphology",
            "raster_detection_topological_bridges_count": bridge_count,
            "raster_detection_warning": "Raster linework did not form any closed cells.",
        }

    valid_anchors = []
    for anchor_index, (x, y, number) in enumerate(unique_anchors):
        px, py = int(round(x)), int(round(y))
        if px < 0 or py < 0 or px >= source.width or py >= source.height:
            continue
        local_spacing = (
            float(local_spacings[anchor_index])
            if anchor_index < len(local_spacings) and local_spacings[anchor_index] > 0
            else spacing
        )
        search_radius = max(8, min(32, int(round(local_spacing * 0.12))))
        y0, y1 = max(0, py - search_radius), min(source.height, py + search_radius + 1)
        x0, x1 = max(0, px - search_radius), min(source.width, px + search_radius + 1)
        nearby = components[y0:y1, x0:x1]
        ids, counts = np.unique(nearby[nearby > 0], return_counts=True)
        if not len(ids):
            continue
        component_id = int(ids[np.argmax(counts)])
        valid_anchors.append((x, y, number, component_id))

    anchor_components = {}
    for _, _, number, component_id in valid_anchors:
        anchor_components.setdefault(component_id, set()).add(number)
    unique_anchor_components = {
        component_id: next(iter(numbers))
        for component_id, numbers in anchor_components.items()
        if len(numbers) == 1
    }

    component_bounds = ndimage.find_objects(components, max_label=component_count)
    component_records = []
    for component_id, bbox in enumerate(component_bounds, start=1):
        if bbox is None:
            continue
        row_slice, column_slice = bbox
        height = row_slice.stop - row_slice.start
        width = column_slice.stop - column_slice.start
        area_pixels = int(np.count_nonzero(components[row_slice, column_slice] == component_id))
        if height < 4 or width < 4:
            continue
        component_records.append({
            "id": component_id,
            "bbox": bbox,
            "width": width,
            "height": height,
            "area": area_pixels,
            "aspect": max(width / height, height / width),
        })

    if spacing > 0:
        eligible = []
        for record in component_records:
            number = unique_anchor_components.get(record["id"])
            if number is None:
                continue
            local_spacing = anchor_spacing_by_number.get(number, 0) or spacing
            min_area = max(64, local_spacing * local_spacing * 0.15)
            max_area = max(min_area * 2, local_spacing * local_spacing * 40)
            if min_area <= record["area"] <= max_area:
                eligible.append(record)
    else:
        crop_area = max(int(in_crop.sum()), 1)
        eligible = [
            record for record in component_records
            if max(400, crop_area * 0.001) <= record["area"] <= crop_area * 0.12
            and record["aspect"] <= 5
            and min(record["width"], record["height"]) >= max(16, min(source.size) * 0.015)
        ]
        if eligible:
            log_areas = np.log(np.asarray([record["area"] for record in eligible], dtype=np.float64))
            if log_areas.max() - log_areas.min() < 0.2:
                peak_log_area = float(np.median(log_areas))
            else:
                bin_width = 0.2
                bin_indices = np.floor((log_areas - log_areas.min()) / bin_width).astype(int)
                histogram = np.bincount(bin_indices)
                window = np.convolve(histogram, np.ones(5, dtype=int), mode="same")
                peak_bin = int(np.argmax(window))
                peak_log_area = float(log_areas.min() + peak_bin * bin_width + bin_width / 2.0)
            eligible = [
                record for record in eligible
                if abs(np.log(record["area"]) - peak_log_area) <= 0.55
            ]

    regions = {}
    for record in eligible:
        row_slice, column_slice = record["bbox"]
        component_id = record["id"]
        component_mask = components[row_slice, column_slice] == component_id
        polygon = _raster_component_polygon(
            component_mask, column_slice.start, row_slice.start
        )
        if polygon is None:
            continue
        number = unique_anchor_components.get(component_id)
        if number is not None:
            if number in regions:
                continue
            key = number
        else:
            key = f"raster-{hashlib.sha256(polygon.wkb).hexdigest()[:16]}"
        regions[key] = polygon

    return regions, {
        "raster_candidate_count": len(regions),
        "raster_raw_polygon_count": len(eligible),
        "raster_detection_component_count": int(component_count),
        "raster_detection_labeled_count": sum(
            1 for key in regions if not str(key).startswith("raster-")
        ),
        "raster_detection_ambiguous_label_count": len(ambiguous_numbers),
        "raster_detection_unique_anchor_count": len(unique_anchors),
        "raster_detection_local_spacing_px": round(spacing, 2),
        "raster_detection_topological_bridges_count": bridge_count,
        "raster_detection_method": "adaptive_morphology",
    }


def detect_registered_overlay_plot_regions(png_data, boundary_geo, bounds):
    """Rebuild unlabeled plot hit regions from an already registered overlay raster."""
    if not png_data or not bounds or len(bounds) != 2:
        raise ValueError("A registered overlay image and geographic bounds are required")
    image = Image.open(io.BytesIO(png_data)).convert("RGBA")
    pixel_cells, detection = _detect_raster_plot_cells(image)
    boundary = shape(boundary_geo)
    projected_boundary = transform_geometry(_TO_MERCATOR.transform, boundary)
    south_west, north_east = bounds
    west_x, south_y = _TO_MERCATOR.transform(float(south_west[1]), float(south_west[0]))
    east_x, north_y = _TO_MERCATOR.transform(float(north_east[1]), float(north_east[0]))
    width, height = image.size
    pixel_size_m = min(
        (east_x - west_x) / max(width - 1, 1),
        (north_y - south_y) / max(height - 1, 1),
    )
    image_hash = hashlib.sha256(png_data).hexdigest()
    regions = []

    for cell_id, cell in pixel_cells.items():
        def pixel_to_mercator(x, y, z=None):
            x_values = np.asarray(x, dtype=np.float64)
            y_values = np.asarray(y, dtype=np.float64)
            mapped_x = west_x + x_values / max(width - 1, 1) * (east_x - west_x)
            mapped_y = north_y - y_values / max(height - 1, 1) * (north_y - south_y)
            if np.isscalar(x):
                return float(mapped_x), float(mapped_y)
            return mapped_x, mapped_y

        mapped = _smooth_registered_plot_geometry(
            transform_geometry(pixel_to_mercator, cell), pixel_size_m
        ).intersection(projected_boundary)
        if mapped.is_empty or not mapped.is_valid or mapped.area <= 0:
            continue
        if mapped.geom_type == "Polygon":
            parts = [mapped]
        elif mapped.geom_type == "MultiPolygon":
            parts = list(mapped.geoms)
        elif mapped.geom_type == "GeometryCollection":
            parts = [
                part for part in mapped.geoms
                if part.geom_type == "Polygon" and not part.is_empty
            ]
        else:
            continue
        if not parts:
            continue
        clipped = parts[0] if len(parts) == 1 else MultiPolygon(parts)
        if not clipped.is_valid or clipped.area <= 0:
            continue
        geographic = transform_geometry(_FROM_MERCATOR.transform, clipped)
        area, _ = _GEOD.geometry_area_perimeter(geographic)
        region_hash = hashlib.sha256(
            f"{image_hash}:{cell_id}:{cell.wkb_hex}".encode("utf-8")
        ).hexdigest()[:24]
        regions.append({
            "id": f"pdf-{region_hash}",
            "number": None,
            "label": None,
            "geometry": mapping(geographic),
            "area_sqm": round(abs(float(area)), 2),
            "detection_source": "pdf_raster_closed_cell",
            "detection_confidence": 0.55,
            "confidence_type": "heuristic",
        })

    detection["interactive_plot_count"] = len(regions)
    detection["raster_detection_labeled_count"] = 0
    detection["plot_detection_method"] = "registered_overlay_raster_closed_cells"
    detection["plot_detection_confidence_type"] = "heuristic, not a calibrated probability"
    if not regions:
        detection["plot_detection_warning"] = (
            "No unlabeled plot cells could be reconstructed from the stored overlay image. "
            "Re-import the source PDF to retry using its embedded vector geometry and text labels."
        )
    else:
        detection["plot_detection_warning"] = (
            "Click regions were rebuilt from closed cells in the registered overlay raster. "
            "The original PDF is not retained, so plot numbers could not be associated; "
            "these regions are heuristic and are not saved plot records."
        )
    return regions, detection


def _assign_numbers_to_raster_cells(regions_dict: dict, ocr_detections: list, spacing: float = 40.0) -> dict:
    """
    Spatially joins OCR text detections to raster cell polygons.
    Uses centroid nearest-search with adaptive distance threshold.
    """
    from shapely.geometry import Point
    import re

    PLOT_PATTERN = re.compile(r'^\d{1,4}[A-Za-z]?$')

    ocr_anchors = []
    for det in ocr_detections:
        text = str(getattr(det, "text", "")).strip()
        if PLOT_PATTERN.match(text):
            bbox = getattr(det, "bbox_pixel_px", None) or getattr(det, "bbox", None) or getattr(det, "bbox_page_pt", None)
            if bbox and len(bbox) == 4:
                cx = (bbox[0] + bbox[2]) / 2.0
                cy = (bbox[1] + bbox[3]) / 2.0
                ocr_anchors.append((text, cx, cy))

    if not ocr_anchors:
        return regions_dict

    numbered_regions = {}
    used_numbers = set()

    for cell_key, polygon in regions_dict.items():
        if not str(cell_key).startswith("raster-"):
            numbered_regions[cell_key] = polygon
            used_numbers.add(str(cell_key))
            continue

        centroid = polygon.centroid
        best_match = None
        best_dist = float("inf")

        for plot_num, ax, ay in ocr_anchors:
            if plot_num in used_numbers:
                continue
            dist = centroid.distance(Point(ax, ay))
            if dist < best_dist and dist < max(40.0, spacing * 1.5 if spacing > 0 else 80.0):
                best_dist = dist
                best_match = plot_num

        if best_match and best_match not in numbered_regions:
            numbered_regions[best_match] = polygon
            used_numbers.add(best_match)
        else:
            numbered_regions[cell_key] = polygon

    return numbered_regions


def _matching_plot_labels_for_cell(cell, number, text_spans, raster_recovered=False):
    """
    Returns matching label points for a given cell polygon.
    For raster-recovered cells, uses distance tolerance with ambiguity rejection.
    For vector cells, uses strict containment with Voronoi fallback for merged cells.
    """
    from shapely.geometry import Point, MultiPoint
    from shapely.ops import voronoi_diagram
    from app.gis import importer

    target_num = importer.normalize_plot_no(str(number).strip()) if number else None
    if not target_num:
        return []

    label_entries = []
    for span in text_spans:
        x, y = span[0], span[1]
        label_text = str(span[2]).strip()
        norm_no = importer.normalize_plot_no(label_text)
        if norm_no and importer.PLOT_NO.match(label_text):
            label_entries.append((Point(x, y), norm_no))

    if raster_recovered:
        anchor_tolerance = max(1.5, min(10.0, (cell.area ** 0.5) * 0.12))
        matching_labels = [
            pt for pt, num in label_entries
            if num == target_num and cell.distance(pt) <= anchor_tolerance
        ]
        # Ambiguity check: if another label with a different number is also within tolerance
        for pt, num in label_entries:
            if num != target_num and cell.distance(pt) <= anchor_tolerance:
                return []
        return matching_labels

    tight_buf = cell.buffer(max(0.01, (cell.area ** 0.5) * 0.005))
    contained = [(pt, num) for pt, num in label_entries if tight_buf.covers(pt)]
    if len(contained) == 1:
        return [contained[0][0]] if contained[0][1] == target_num else []

    distinct_numbers = {num for _, num in contained}
    if target_num not in distinct_numbers:
        return []

    all_pts = [pt for pt, _ in contained]
    try:
        vor = voronoi_diagram(MultiPoint(all_pts), envelope=cell.envelope)
        for region_poly in vor.geoms:
            for pt, num in contained:
                if num == target_num and region_poly.covers(pt):
                    sub_cell = region_poly.intersection(cell)
                    if sub_cell.is_valid and not sub_cell.is_empty and sub_cell.area > 10.0:
                        return [pt]
    except Exception:
        pass

    target_pts = [pt for pt, num in contained if num == target_num]
    if target_pts:
        return [min(target_pts, key=lambda p: p.distance(cell.centroid))]

    return []


def _detect_vector_plot_regions(pdf_data, source, source_outline, forward, projected_boundary,
                                projected_bounds, canvas_size, extracted_pdf=None,
                                raster_extracted=None, vector_cells=None,
                                polygonization_error=None, raster_cells=None,
                                raster_vectorization=None):
    """Polygonize label-associated PDF vector cells and map them with the image homography."""
    from app.gis import importer

    extracted = extracted_pdf if extracted_pdf is not None else importer._extract_pdf(pdf_data)
    labels = [
        (x, y, importer.normalize_plot_no(text))
        for x, y, text, _ in extracted.get("texts", [])
        if importer.PLOT_NO.match(str(text).strip())
    ]
    unique_numbers = {number for _, _, number in labels if number}
    if raster_extracted is None:
        raster_extracted = _rasterize_pdf_extraction(pdf_data, extracted, source)

    if raster_cells is None:
        raster_cells, raster_diagnostics = _detect_raster_plot_cells(
            source, source_outline, [
            (
                x,
                y,
                importer.normalize_plot_no(text),
            )
            for x, y, text, _ in raster_extracted["texts"]
            if importer.PLOT_NO.match(str(text).strip()) and importer.normalize_plot_no(text)
            ],
        )
    else:
        raster_diagnostics = dict(raster_vectorization or {})
    cells = dict(vector_cells or {})
    vector_cell_count = len(cells)
    raster_recovered_numbers = set()
    crop_polygon = Polygon(source_outline)
    for number, cell in raster_cells.items():
        existing_cell = cells.get(number)
        usable_vector_cell = not (
            existing_cell is None
            or not isinstance(existing_cell, Polygon)
            or existing_cell.is_empty
            or not existing_cell.is_valid
            or existing_cell.area < 1500.0
        )
        if usable_vector_cell:
            matching_labels = _matching_plot_labels_for_cell(
                existing_cell, number, raster_extracted["texts"]
            )
            visible_cell = existing_cell.intersection(crop_polygon)
            visible_ratio = visible_cell.area / existing_cell.area if existing_cell.area else 0
            usable_vector_cell = (
                len(matching_labels) == 1
                and not visible_cell.is_empty
                and visible_ratio >= 0.95
            )
        if not usable_vector_cell:
            cells[number] = cell
            raster_recovered_numbers.add(number)

    min_x, min_y, max_x, max_y = projected_bounds
    width, height = canvas_size
    pixel_size_m = min(
        (max_x - min_x) / max(width - 1, 1),
        (max_y - min_y) / max(height - 1, 1),
    )
    regions = []
    omitted_invalid = 0
    cell_candidate_count = len(cells)
    for number, cell in cells.items():
        if len(regions) >= MAX_INTERACTIVE_PLOT_REGIONS:
            break
        if not isinstance(cell, Polygon) or cell.is_empty or not cell.is_valid or cell.area <= 0:
            omitted_invalid += 1
            continue
        is_unlabeled_raster_cell = str(number).startswith("raster-")
        matching_labels = (
            []
            if is_unlabeled_raster_cell
            else _matching_plot_labels_for_cell(
                cell,
                number,
                raster_extracted["texts"],
                raster_recovered=number in raster_recovered_numbers,
            )
        )
        if not is_unlabeled_raster_cell and len(matching_labels) != 1:
            omitted_invalid += 1
            continue
        visible_cell = cell.intersection(crop_polygon)
        visible_ratio = visible_cell.area / cell.area if cell.area else 0
        if visible_cell.is_empty or visible_ratio < 0.95:
            omitted_invalid += 1
            continue

        def to_mercator(x, y, z=None):
            x_values = np.asarray(x, dtype=np.float64)
            y_values = np.asarray(y, dtype=np.float64)
            homogeneous = np.stack(
                (x_values, y_values, np.ones_like(x_values)), axis=0
            )
            mapped = forward @ homogeneous
            with np.errstate(divide="ignore", invalid="ignore"):
                px = mapped[0] / mapped[2]
                py = mapped[1] / mapped[2]
            mapped_x = min_x + px / max(width - 1, 1) * (max_x - min_x)
            mapped_y = max_y - py / max(height - 1, 1) * (max_y - min_y)
            if np.isscalar(x):
                return float(mapped_x), float(mapped_y)
            return mapped_x, mapped_y

        registered = transform_geometry(to_mercator, visible_cell)
        if registered.is_empty or not registered.is_valid:
            omitted_invalid += 1
            continue
        registered = _smooth_registered_plot_geometry(registered, pixel_size_m)
        clipped = registered.intersection(projected_boundary)
        if clipped.is_empty:
            omitted_invalid += 1
            continue
        if clipped.geom_type == "Polygon":
            parts = [clipped]
        elif clipped.geom_type == "MultiPolygon":
            parts = list(clipped.geoms)
        elif clipped.geom_type == "GeometryCollection":
            parts = [
                geometry for geometry in clipped.geoms
                if geometry.geom_type == "Polygon" and not geometry.is_empty
            ]
        else:
            omitted_invalid += 1
            continue
        if not parts:
            omitted_invalid += 1
            continue

        clipped_geometry = parts[0] if len(parts) == 1 else MultiPolygon(parts)
        if not clipped_geometry.is_valid or clipped_geometry.area <= 0:
            omitted_invalid += 1
            continue
        geographic = transform_geometry(_FROM_MERCATOR.transform, clipped_geometry)
        if is_unlabeled_raster_cell or (number in raster_recovered_numbers):
            try:
                mrr_geo = geographic.minimum_rotated_rectangle
                if mrr_geo.is_valid and not mrr_geo.is_empty:
                    iou_geo = geographic.intersection(mrr_geo).area / max(geographic.union(mrr_geo).area, 1e-9)
                    if iou_geo >= 0.40:
                        geographic = mrr_geo
            except Exception:
                pass
        geodesic_area, _ = _GEOD.geometry_area_perimeter(geographic)
        geographic_area = abs(float(geodesic_area))
        if not np.isfinite(geographic_area) or geographic_area <= 0:
            omitted_invalid += 1
            continue

        if is_unlabeled_raster_cell:
            minx, miny, maxx, maxy = geographic.bounds
            lat = (miny + maxy) / 2.0
            kx = 111320.0 * math.cos(math.radians(lat))
            ky = 110574.0
            w_m = (maxx - minx) * kx
            h_m = (maxy - miny) * ky
            aspect = max(w_m / max(h_m, 1e-3), h_m / max(w_m, 1e-3))
            num_holes = len(clipped_geometry.interiors) if hasattr(clipped_geometry, "interiors") else 0
            # Reject road corridors, gate spans, divider ribbons, and ornamental badges
            if aspect > 5.2 or (min(w_m, h_m) < 5.0 and max(w_m, h_m) > 20.0) or num_holes >= 8:
                omitted_invalid += 1
                continue

        confidence = min(
            0.95,
            0.65
            + (0.15 if cell.is_valid else 0)
            + (0.1 if len(matching_labels) == 1 else 0)
            + (0.05 if visible_ratio >= 0.995 else 0),
        )
        region_digest = hashlib.sha256(
            f"{hashlib.sha256(pdf_data).hexdigest()}:{number}:{cell.wkb_hex}".encode("utf-8")
        ).hexdigest()[:24]
        is_raster_detected = (
            number in raster_recovered_numbers or is_unlabeled_raster_cell
        )
        regions.append({
            "id": f"pdf-{region_digest}",
            "number": None if is_unlabeled_raster_cell else str(number),
            "geometry": mapping(geographic),
            "area_sqm": round(geographic_area, 2),
            "detection_source": (
                "pdf_raster_vector_trace"
                if is_raster_detected and raster_vectorization
                else "pdf_raster_closed_cell"
                if is_raster_detected
                else "pdf_vector_polygonization"
            ),
            "detection_confidence": round(min(confidence, 0.72) if is_raster_detected else confidence, 3),
            "confidence_type": "heuristic",
        })

    detected_numbers = {
        region["number"] for region in regions if region["number"] is not None
    }
    diagnostics = {
        "detected_plot_label_count": len(unique_numbers),
        "interactive_plot_count": len(regions),
        "matched_plot_label_count": len(detected_numbers),
        "plot_detection_method": (
            "pdf_raster_vector_trace"
            if raster_vectorization
            else "pdf_vector_and_raster_closed_cells"
        ),
        "plot_detection_confidence_type": "heuristic, not a calibrated probability",
        "plot_detection_candidate_count": cell_candidate_count,
        "plot_detection_rejected_count": max(0, cell_candidate_count - len(regions)),
        "vector_candidate_count": vector_cell_count,
        **raster_diagnostics,
    }
    diagnostics["plot_detection_completeness_percent"] = round(
        len(detected_numbers) / len(unique_numbers) * 100, 1
    ) if unique_numbers else 0
    unmatched_numbers = unique_numbers - detected_numbers
    diagnostics["plot_detection_omitted_count"] = len(unmatched_numbers)
    diagnostics["unmatched_plot_numbers"] = sorted(
        unmatched_numbers,
        key=lambda number: (
            not number.isdigit(),
            int(number) if number.isdigit() else number,
        ),
    )
    unlabeled_region_count = sum(region["number"] is None for region in regions)
    if unlabeled_region_count:
        diagnostics["plot_detection_warning"] = (
            f"{unlabeled_region_count} raster outlines were traced as unlabeled heuristic regions. "
            "They are vector polygon approximations of image pixels, not verified plot boundaries; "
            "raster text labels are not available as native PDF text."
        )
    if omitted_invalid or len(unmatched_numbers):
        diagnostics["plot_detection_warning"] = (
            f"{len(detected_numbers)} of {len(unique_numbers)} detected plot labels have "
            "reliable individual click regions; "
            f"{len(unmatched_numbers)} PDF labels have no confidently polygonized plot boundary."
        ) if not unlabeled_region_count else (
            diagnostics["plot_detection_warning"] + " "
            f"{len(unmatched_numbers)} text labels could not be matched to a plot boundary."
        )
    if polygonization_error is not None:
        diagnostics["vector_polygonization_warning"] = (
            "Vector polygonization failed; raster cell recovery was attempted. "
            f"Details: {polygonization_error}"
        )
        if diagnostics.get("plot_detection_warning"):
            diagnostics["plot_detection_warning"] += (
                " Raster recovery was attempted because vector polygonization failed."
            )
        else:
            diagnostics["plot_detection_warning"] = diagnostics["vector_polygonization_warning"]
    return regions, diagnostics


def _write_debug_artifacts(debug_dir, input_hash, source, source_outline, source_corners,
                           target_boundary, target_corners, bounds, canvas_size,
                           warped_before_clip, clip_mask, final_image, report):
    if not debug_dir:
        return
    os.makedirs(debug_dir, exist_ok=True)
    prefix = f"pdf-overlay-{input_hash[:16]}"
    source.save(os.path.join(debug_dir, f"{prefix}-page-render.png"))

    crop = source.convert("RGBA")
    crop_mask = Image.new("L", source.size, 0)
    ImageDraw.Draw(crop_mask).polygon(
        [(float(x), float(y)) for x, y in source_outline], fill=255
    )
    crop.putalpha(crop_mask)
    crop.save(os.path.join(debug_dir, f"{prefix}-layout-crop.png"))

    correspondence = source.convert("RGB")
    draw = ImageDraw.Draw(correspondence)
    control_colors = ("red", "blue", "magenta", "orange")
    for index, (x, y) in enumerate(source_corners):
        radius = max(5, max(source.size) // 300)
        color = control_colors[index]
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
        draw.text((x + radius, y + radius), str(index + 1), fill=color)
    correspondence.save(os.path.join(debug_dir, f"{prefix}-source-control-points.png"))

    boundary_image = Image.new("RGB", canvas_size, "white")
    boundary_draw = ImageDraw.Draw(boundary_image)
    min_x, min_y, max_x, max_y = bounds
    width, height = canvas_size
    boundary_pixels = [
        (
            (x - min_x) / (max_x - min_x) * (width - 1),
            (max_y - y) / (max_y - min_y) * (height - 1),
        )
        for x, y in target_boundary.exterior.coords
    ]
    boundary_draw.line(boundary_pixels, fill="blue", width=max(2, width // 1200), joint="curve")
    for index, (x, y) in enumerate(target_corners):
        radius = max(5, width // 300)
        color = control_colors[index]
        boundary_draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
        boundary_draw.text((x + radius, y + radius), str(index + 1), fill=color)
    boundary_image.save(os.path.join(debug_dir, f"{prefix}-kml-boundary-controls.png"))
    correspondence_preview = Image.new(
        "RGB",
        (source.width + boundary_image.width, max(source.height, boundary_image.height)),
        "white",
    )
    correspondence_preview.paste(correspondence, (0, 0))
    correspondence_preview.paste(boundary_image, (source.width, 0))
    ImageDraw.Draw(correspondence_preview).text(
        (8, 8), "PDF source control points (colors/numbers match KML boundary)", fill="black"
    )
    correspondence_preview.save(
        os.path.join(debug_dir, f"{prefix}-source-to-boundary-correspondence.png")
    )
    warped_before_clip.save(os.path.join(debug_dir, f"{prefix}-registered-before-clip.png"))
    clip_mask.save(os.path.join(debug_dir, f"{prefix}-clipping-mask.png"))
    final_image.save(os.path.join(debug_dir, f"{prefix}-registered-final.png"))
    with open(os.path.join(debug_dir, f"{prefix}-registration.json"), "w", encoding="utf-8") as report_file:
        json.dump(report, report_file, indent=2, sort_keys=True)


def render_pdf_overlay_images(
    pdf_data, boundary_geo, boundary_selection=None, extracted_pdf=None
):
    """Return clipped/source rasters, bounds, registration diagnostics, and image-linked plot regions."""
    try:
        boundary = shape(boundary_geo)
    except (TypeError, ValueError) as exc:
        raise ValueError("The KML land boundary is not valid GeoJSON geometry") from exc
    if boundary.is_empty or not boundary.is_valid or boundary.area <= 0:
        raise ValueError("Cannot create a PDF overlay from an empty or invalid boundary")
    if isinstance(boundary, MultiPolygon):
        raise ValueError(
            "The KML contains multiple disjoint land polygons. Select the colony's outer land boundary before registering one PDF layout."
        )
    if not isinstance(boundary, Polygon):
        raise ValueError("PDF overlay boundary must be a Polygon")
    if not np.all(np.isfinite(np.asarray(boundary.exterior.coords, dtype=np.float64))):
        raise ValueError("The KML land boundary contains non-finite coordinates")
    min_lng, min_lat, max_lng, max_lat = boundary.bounds
    if min_lng < -180 or max_lng > 180 or min_lat < -85.05112878 or max_lat > 85.05112878:
        raise ValueError(
            "The KML boundary must use WGS84 longitude/latitude coordinates within Web Mercator's supported latitude range"
        )

    projected = transform_geometry(_TO_MERCATOR.transform, boundary)
    min_x, min_y, max_x, max_y = projected.bounds
    if max_x <= min_x or max_y <= min_y:
        raise ValueError("Cannot create a PDF overlay from a zero-area boundary")

    source, page_metadata = _render_page(pdf_data)
    if extracted_pdf is None:
        from app.gis import importer

        extracted_pdf = importer._extract_pdf(pdf_data)
    from app.gis import importer

    raster_extracted = _rasterize_pdf_extraction(pdf_data, extracted_pdf, source)
    vector_cells = {}
    polygonization_error = None
    unique_label_count = len({
        importer.normalize_plot_no(text)
        for _, _, text, _ in extracted_pdf.get("texts", [])
        if importer.PLOT_NO.match(str(text).strip())
        and importer.normalize_plot_no(text)
    })
    if unique_label_count >= 3:
        try:
            vector_cells = importer._labeled_plot_polygons(raster_extracted) or {}
        except Exception as exc:
            polygonization_error = exc
    vector_coverage = len(vector_cells) / unique_label_count if unique_label_count else 0
    needs_raster_trace = (
        extracted_pdf.get("pdf_content", {}).get("pdf_type") == "raster"
        or (
            unique_label_count >= 3
            and vector_coverage < 0.75
        )
        or len(vector_cells) == 0
    )
    raster_vector_cells = None
    raster_vectorization = None
    if needs_raster_trace:
        raster_vector_cells, raster_vectorization = _vectorize_raster_pdf_cells(
            pdf_data,
            source,
            [
                (x, y, importer.normalize_plot_no(text))
                for x, y, text, _ in raster_extracted["texts"]
                if importer.PLOT_NO.match(str(text).strip())
                and importer.normalize_plot_no(text)
            ],
        )
    (
        source_corners,
        source_outline,
        footprint_method,
        footprint_pixel_count,
        footprint_label_count,
    ) = _source_footprint(source, vector_cells or raster_vector_cells)
    target_vertices, fit_mode, warnings = _target_quad(projected)
    target_vertices = _inset_quad(target_vertices)
    artwork_clip_boundary = projected.intersection(Polygon(target_vertices))
    if artwork_clip_boundary.is_empty or not artwork_clip_boundary.is_valid:
        raise ValueError("Could not create a valid inset clipping boundary for the PDF artwork")
    if footprint_method == "nonwhite_content_minimum_area_rectangle":
        warnings.append(
            "No reliable colored layout footprint was detected. The non-white page-content envelope was used; confirm that titles and external annotations were excluded."
        )
    elif footprint_method == "pdf_vector_plot_cells":
        warnings.append(
            "The PDF crop was derived from reconstructed vector parcel cells. Confirm it includes the full layout perimeter and any intended shared roads."
        )
    target_canvas_vertices = target_vertices.copy()

    projected_width = max_x - min_x
    projected_height = max_y - min_y
    if projected_width >= projected_height:
        canvas_size = (
            MAX_OVERLAY_EDGE,
            max(1, round(MAX_OVERLAY_EDGE * projected_height / projected_width)),
        )
    else:
        canvas_size = (
            max(1, round(MAX_OVERLAY_EDGE * projected_width / projected_height)),
            MAX_OVERLAY_EDGE,
        )
    canvas_width, canvas_height = canvas_size
    target_canvas_vertices[:, 0] = (
        (target_vertices[:, 0] - min_x) / projected_width * (canvas_width - 1)
    )
    target_canvas_vertices[:, 1] = (
        (max_y - target_vertices[:, 1]) / projected_height * (canvas_height - 1)
    )

    (
        target_corners,
        edge_scale_ratios,
        correspondence_score,
        score_gap,
        cyclic_shift,
        reversed_order,
        fit_warnings,
        orientation_alternatives,
    ) = _corner_correspondence(source_corners, target_canvas_vertices)
    warnings.extend(fit_warnings)
    forward, homography_condition = _homography(source_corners, target_corners)
    source_homogeneous = np.column_stack((source_corners, np.ones(4)))
    mapped_homogeneous = (forward @ source_homogeneous.T).T
    denominators = mapped_homogeneous[:, 2]
    if (
        not np.all(np.isfinite(mapped_homogeneous))
        or np.any(np.abs(denominators) <= 1e-9)
        or np.any(np.sign(denominators) != np.sign(denominators[0]))
    ):
        raise ValueError("The fitted transformation folds or crosses the source layout footprint")
    mapped_corners = mapped_homogeneous[:, :2] / mapped_homogeneous[:, 2, None]
    corner_residual = float(np.max(np.linalg.norm(mapped_corners - target_corners, axis=1)))
    boundary_metrics = _boundary_fit_metrics(
        mapped_corners, projected, (min_x, min_y, max_x, max_y), canvas_size
    )
    inverse = np.linalg.inv(forward)
    inverse /= inverse[2, 2]
    source_rgba = source.convert("RGBA")
    source_mask = Image.new("L", source.size, 0)
    ImageDraw.Draw(source_mask).polygon(
        [(float(x), float(y)) for x, y in source_outline], fill=255
    )
    source_rgba.putalpha(source_mask)
    footprint_pixels = np.asarray(source_mask) > 0
    source_rgba = _remove_pdf_page_white(source_rgba)
    transparent_page_pixels = (
        footprint_pixels & (np.asarray(source_rgba.getchannel("A")) == 0)
    )
    warped = source_rgba.transform(
        canvas_size,
        Image.Transform.PERSPECTIVE,
        tuple(inverse.flatten()[:8]),
        resample=Image.Resampling.BICUBIC,
        fillcolor=(255, 255, 255, 0),
    )
    warped_before_clip = warped.copy()

    mask = Image.new("L", canvas_size, 0)
    draw = ImageDraw.Draw(mask)
    for polygon in _polygons(artwork_clip_boundary):
        _mask_ring(draw, polygon.exterior, (min_x, min_y, max_x, max_y), canvas_size, 255)
        for interior in polygon.interiors:
            _mask_ring(draw, interior, (min_x, min_y, max_x, max_y), canvas_size, 0)
    warped.putalpha(ImageChops.multiply(warped.getchannel("A"), mask))
    pdf_text_annotations = _registered_pdf_text_annotations(
        raster_extracted["annotations"] or raster_extracted["texts"],
        source_outline,
        forward,
        projected,
        (min_x, min_y, max_x, max_y),
        canvas_size,
    )
    alpha_before = np.asarray(warped_before_clip.getchannel("A")) > 0
    alpha_after = np.asarray(warped.getchannel("A")) > 0
    retained_pixels = int(alpha_after.sum())
    source_pixels = int(alpha_before.sum())
    outside_pixels = int((alpha_before & (np.asarray(mask) == 0)).sum())
    edge_scale_distortion = float(
        np.exp(np.max(edge_scale_ratios) - np.min(edge_scale_ratios))
    )
    if edge_scale_distortion > 1.25:
        warnings.append(
            "The fitted perimeter requires substantial edge-scale variation; inspect the overlay before relying on alignment."
        )

    output = io.BytesIO()
    warped.save(output, format="PNG", optimize=True)
    base_output = io.BytesIO()
    warped_before_clip.save(base_output, format="PNG", optimize=True)
    min_lng, min_lat, max_lng, max_lat = boundary.bounds
    leaflet_bounds = [[min_lat, min_lng], [max_lat, max_lng]]
    input_hash = hashlib.sha256(pdf_data).hexdigest()
    boundary_hash = hashlib.sha256(projected.wkb).hexdigest()
    target_corners_mercator = np.column_stack((
        min_x + target_corners[:, 0] / max(canvas_width - 1, 1) * projected_width,
        max_y - target_corners[:, 1] / max(canvas_height - 1, 1) * projected_height,
    ))
    footprint_bounds = [
        round(float(value), 2)
        for value in (
            source_corners[:, 0].min(),
            source_corners[:, 1].min(),
            source_corners[:, 0].max(),
            source_corners[:, 1].max(),
        )
    ]
    diagnostics = {
        "fit_mode": fit_mode,
        "input_pdf_sha256": input_hash,
        "boundary_geometry_sha256": boundary_hash,
        "boundary_selection": boundary_selection or {"source": "unspecified"},
        "input_pdf_bytes": len(pdf_data),
        **page_metadata,
        "source_footprint_method": footprint_method,
        "source_footprint_pixel_count": int(footprint_pixel_count),
        "source_footprint_plot_cell_count": int(footprint_label_count),
        "layout_margin": {
            "boundary_inset_percent": round(PDF_LAYOUT_BOUNDARY_INSET_RATIO * 100, 2),
            "source_crop_padding_percent": round(PDF_LAYOUT_FOOTPRINT_PADDING_RATIO * 100, 2),
            "description": "PDF layout is fitted inside the colony envelope with a small visible perimeter margin; the source crop is padded to retain edge linework.",
        },
        "source_image_size_px": [source.width, source.height],
        "source_crop_bounds_px": footprint_bounds,
        "pdf_page_background_transparency": {
            "mode": "near_white_alpha",
            "threshold": PDF_WHITE_TRANSPARENCY_THRESHOLD,
            "transparent_footprint_pixel_percent": round(
                float(transparent_page_pixels.sum() / max(footprint_pixels.sum(), 1) * 100),
                2,
            ),
        },
        "pdf_text_annotations": pdf_text_annotations,
        "pdf_text_annotation_count": len(pdf_text_annotations),
        "pdf_text_annotation_limit_reached": len(pdf_text_annotations) >= 2000,
        "pdf_text_annotation_position_method": (
            "PDF span centers and baseline directions transformed with image homography"
        ),
        "source_footprint_page_area_ratio": round(
            float(Polygon(source_corners).area / (source.width * source.height)), 6
        ),
        "source_corners_px": [[round(float(x), 2), round(float(y), 2)] for x, y in source_corners],
        "target_corners_mercator": [
            [round(float(x), 2), round(float(y), 2)] for x, y in target_corners_mercator
        ],
        "target_corners_canvas_px": [
            [round(float(x), 2), round(float(y), 2)] for x, y in target_corners
        ],
        "edge_scale_ratios": [round(float(value), 4) for value in edge_scale_ratios],
        "edge_scale_distortion": round(edge_scale_distortion, 4),
        "corner_fit_residual_pixels": round(corner_residual, 8),
        "homography_condition_number": round(homography_condition, 4),
        "homography": [round(float(value), 12) for value in forward.flatten()],
        "homography_coordinate_frames": {
            "source": "PDF page raster pixel coordinates, origin at upper-left",
            "destination": "projected boundary canvas pixel coordinates, origin at upper-left",
            "geographic_projection": "EPSG:3857",
        },
        "orientation_candidates": orientation_alternatives,
        "control_points": [
            {
                "source_px": [round(float(x), 2), round(float(y), 2)],
                "destination_mercator": [
                    round(float(target_corners_mercator[index, 0]), 2),
                    round(float(target_corners_mercator[index, 1]), 2),
                ],
            }
            for index, (x, y) in enumerate(source_corners)
        ],
        "selected_cyclic_shift": int(cyclic_shift),
        "selected_reversed_order": bool(reversed_order),
        "preclip_layout_pixels_outside_boundary_percent": round(
            100 * outside_pixels / max(source_pixels, 1), 3
        ),
        "postclip_layout_content_retained_percent": round(
            100 * retained_pixels / max(source_pixels, 1), 3
        ),
        "clipped_pixel_leakage_count": 0,
        **boundary_metrics,
        "metric_scope": (
            "Boundary distances compare the transformed detected footprint to the projected KML perimeter; "
            "they do not prove semantic or satellite-ground alignment."
        ),
        "boundary_vertex_count": len(_unique_exterior_vertices(projected))
        if isinstance(projected, Polygon)
        else sum(len(_unique_exterior_vertices(part)) for part in projected.geoms),
        "boundary_hole_count": len(projected.interiors),
        "corner_correspondence_score": round(float(correspondence_score), 5),
        "corner_correspondence_score_gap": round(float(score_gap), 5),
        "corner_order_reversed": bool(reversed_order),
        "corner_cyclic_shift": int(cyclic_shift),
        "warnings": warnings,
    }
    plot_regions, plot_diagnostics = _detect_vector_plot_regions(
        pdf_data,
        source,
        source_outline,
        forward,
        projected,
        (min_x, min_y, max_x, max_y),
        canvas_size,
        extracted_pdf,
        raster_extracted=raster_extracted,
        vector_cells=vector_cells,
        polygonization_error=polygonization_error,
        raster_cells=raster_vector_cells,
        raster_vectorization=raster_vectorization,
    )
    diagnostics.update(plot_diagnostics)
    if plot_diagnostics.get("plot_detection_warning"):
        warnings.append(plot_diagnostics["plot_detection_warning"])
    _write_debug_artifacts(
        os.environ.get("PDF_OVERLAY_DEBUG_DIR"),
        hashlib.sha256(f"{input_hash}:{boundary_hash}".encode("ascii")).hexdigest(),
        source,
        source_outline,
        source_corners,
        projected,
        target_corners,
        (min_x, min_y, max_x, max_y),
        canvas_size,
        warped_before_clip,
        mask,
        warped,
        diagnostics,
    )
    return output.getvalue(), base_output.getvalue(), leaflet_bounds, diagnostics, plot_regions


def render_clipped_pdf_overlay(pdf_data, boundary_geo, boundary_selection=None):
    """Backward-compatible clipped image interface for callers that need no source raster."""
    clipped_png, _, leaflet_bounds, diagnostics, _ = render_pdf_overlay_images(
        pdf_data, boundary_geo, boundary_selection
    )
    return clipped_png, leaflet_bounds, diagnostics


def transform_pdf_overlay(png_data, boundary_geo, transform):
    """Apply a previewed affine adjustment once to the immutable auto-fit image."""
    boundary = shape(boundary_geo)
    projected = transform_geometry(_TO_MERCATOR.transform, boundary)
    min_x, min_y, max_x, max_y = projected.bounds
    image = Image.open(io.BytesIO(png_data)).convert("RGBA")
    width, height = image.size
    scale_x = float(transform.get("scale_x", 1))
    scale_y = float(transform.get("scale_y", 1))
    rotation = np.deg2rad(float(transform.get("rotation_deg", 0)))
    translate_x = (
        float(transform.get("translation_x_m", 0))
        * (width - 1) / max(max_x - min_x, 1e-9)
    )
    translate_y = (
        -float(transform.get("translation_y_m", 0))
        * (height - 1) / max(max_y - min_y, 1e-9)
    )
    cosine, sine = np.cos(rotation), np.sin(rotation)
    center_x, center_y = (width - 1) / 2, (height - 1) / 2
    forward = np.asarray([
        [cosine * scale_x, -sine * scale_y, 0],
        [sine * scale_x, cosine * scale_y, 0],
        [0, 0, 1],
    ])
    forward[0, 2] = center_x + translate_x - forward[0, 0] * center_x - forward[0, 1] * center_y
    forward[1, 2] = center_y + translate_y - forward[1, 0] * center_x - forward[1, 1] * center_y
    inverse = np.linalg.inv(forward)
    transformed = image.transform(
        (width, height),
        Image.Transform.AFFINE,
        tuple(inverse[:2].reshape(-1)),
        resample=Image.Resampling.BICUBIC,
        fillcolor=(255, 255, 255, 0),
    )

    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for polygon in _polygons(projected):
        _mask_ring(draw, polygon.exterior, (min_x, min_y, max_x, max_y), (width, height), 255)
        for interior in polygon.interiors:
            _mask_ring(draw, interior, (min_x, min_y, max_x, max_y), (width, height), 0)
    transformed.putalpha(ImageChops.multiply(transformed.getchannel("A"), mask))
    output = io.BytesIO()
    transformed.save(output, format="PNG", optimize=True)
    return output.getvalue()
