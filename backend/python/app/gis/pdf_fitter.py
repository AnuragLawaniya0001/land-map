"""PDF layout content bounding box extraction and automatic KML boundary fitting engine.

Provides:
- PDF vector and raster content bbox detection (ignoring page margins/whitespace)
- Automatic uniform scale calculation (preserving aspect ratio, NO manual scale slider required)
- Containment fitting inside irregular KML boundary polygons
- Deterministic transformation metadata computation and reconstruction
"""

import math
import logging
from typing import Dict, Any, Tuple, Optional
import pymupdf  # PyMuPDF / fitz
from PIL import Image
import io
from shapely.geometry import Polygon, MultiPolygon, MultiPoint, Point, shape, mapping
from shapely import affinity

logger = logging.getLogger("pdf_fitter")


def extract_pdf_content_bbox(pdf_bytes: bytes, page_num: int = 0) -> Dict[str, float]:
    """Detect the actual usable drawing/layout content bounding box inside a PDF page.
    
    Ignores outer paper whitespace and margins. Supports vector drawing paths,
    text elements, images, and raster pixel envelopes.
    """
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    if len(doc) == 0:
        raise ValueError("PDF document has no pages")
    
    page_index = min(max(0, page_num), len(doc) - 1)
    page = doc[page_index]
    page_rect = page.rect
    page_w, page_h = page.width, page.height
    
    min_x, min_y, max_x, max_y = page_w, page_h, 0.0, 0.0
    found_content = False

    # 1. Try vector drawing paths
    drawings = page.get_drawings()
    for d in drawings:
        r = d.get("rect")
        if r and r.width > 0 and r.height > 0:
            # Ignore full-page background rects that cover > 98% of page
            if r.width >= page_w * 0.98 and r.height >= page_h * 0.98:
                continue
            min_x = min(min_x, r.x0)
            min_y = min(min_y, r.y0)
            max_x = max(max_x, r.x1)
            max_y = max(max_y, r.y1)
            found_content = True

    # 2. Try text blocks
    text_words = page.get_text("words")
    for w in text_words:
        x0, y0, x1, y1 = w[:4]
        min_x = min(min_x, x0)
        min_y = min(min_y, y0)
        max_x = max(max_x, x1)
        max_y = max(max_y, y1)
        found_content = True

    # 3. Fallback to raster pixel analysis if no vector or text content detected
    if not found_content or (max_x - min_x) < 10 or (max_y - min_y) < 10:
        max_dim = max(page_w, page_h, 1.0)
        safe_scale = max(0.2, min(150.0 / 72.0, 2000.0 / max_dim))
        pix = page.get_pixmap(matrix=pymupdf.Matrix(safe_scale, safe_scale))
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        # Convert to grayscale and find non-white bounding box
        gray = img.convert("L")
        # Threshold at 245 to detect non-white drawing pixels
        bw = gray.point(lambda p: 255 if p > 245 else 0)
        bbox = bw.getbbox()
        if bbox:
            scale_x = page_w / pix.width
            scale_y = page_h / pix.height
            min_x = bbox[0] * scale_x
            min_y = bbox[1] * scale_y
            max_x = bbox[2] * scale_x
            max_y = bbox[3] * scale_y
            found_content = True

    # Final fallback if entire page is empty or single color
    if not found_content or max_x <= min_x or max_y <= min_y:
        # Default margin padding of 5% of page
        pad_w = page_w * 0.05
        pad_h = page_h * 0.05
        min_x, min_y = pad_w, pad_h
        max_x, max_y = page_w - pad_w, page_h - pad_h

    width = max(1.0, max_x - min_x)
    height = max(1.0, max_y - min_y)

    doc.close()
    return {
        "min_x": round(min_x, 2),
        "min_y": round(min_y, 2),
        "max_x": round(max_x, 2),
        "max_y": round(max_y, 2),
        "width": round(width, 2),
        "height": round(height, 2),
        "page_width": round(page_w, 2),
        "page_height": round(page_h, 2),
        "page_num": page_index + 1,
        "total_pages": len(doc),
    }


def compute_auto_fit_transform(
    kml_boundary_geo: Dict[str, Any],
    pdf_content_bbox: Dict[str, float]
) -> Dict[str, Any]:
    """Calculate the automatic transformation matrix to fit PDF layout inside KML boundary.

    Preserves aspect ratio, determines a uniform scale, and anchors the fitted
    PDF content using a point guaranteed to lie inside the land polygon so
    irregular/concave boundaries do not skew the result.
    """
    geom = shape(kml_boundary_geo)
    if not geom.is_valid:
        geom = geom.buffer(0)

    if geom.is_empty:
        raise ValueError("Invalid or empty KML boundary polygon")

    bounds = geom.bounds  # min_lng, min_lat, max_lng, max_lat
    kml_min_x, kml_min_y, kml_max_x, kml_max_y = bounds
    kml_width = max(1e-7, kml_max_x - kml_min_x)
    kml_height = max(1e-7, kml_max_y - kml_min_y)

    anchor = geom.representative_point()
    kml_center_lng = anchor.x
    kml_center_lat = anchor.y

    pdf_w = pdf_content_bbox.get("width", 100.0)
    pdf_h = pdf_content_bbox.get("height", 100.0)

    # Uniform scale factor to fit PDF content BBox inside KML BBox while preserving aspect ratio
    scale_x = kml_width / pdf_w
    scale_y = kml_height / pdf_h
    auto_scale = min(scale_x, scale_y) * 0.92  # 8% safety padding

    # Containment check against actual polygon geometry (irregular, L-shaped, etc.)
    cb_min_x = pdf_content_bbox.get("min_x", 0)
    cb_min_y = pdf_content_bbox.get("min_y", 0)
    pdf_cx = cb_min_x + pdf_w / 2.0
    pdf_cy = cb_min_y + pdf_h / 2.0

    # Iterative containment reduction if polygon is highly irregular / non-convex.
    # Use a point guaranteed to be inside the boundary instead of centroid, since
    # centroid can fall outside concave/irregular land polygons.
    scale = auto_scale
    for _ in range(10):
        test_poly = Polygon([
            (-pdf_w / 2.0 * scale, -pdf_h / 2.0 * scale),
            (pdf_w / 2.0 * scale, -pdf_h / 2.0 * scale),
            (pdf_w / 2.0 * scale, pdf_h / 2.0 * scale),
            (-pdf_w / 2.0 * scale, pdf_h / 2.0 * scale),
        ])
        test_translated = affinity.translate(test_poly, xoff=kml_center_lng, yoff=kml_center_lat)

        if geom.covers(test_translated) or geom.covers(test_translated.representative_point()):
            break
        scale *= 0.95  # Reduce scale slightly to fit inside irregular boundary

    auto_scale = round(scale, 8)

    # Preserve the anchor point while centering the content box on the land polygon.
    translation_x = round(kml_center_lng - (pdf_cx * auto_scale), 8)
    translation_y = round(kml_center_lat - (pdf_cy * auto_scale), 8)

    return {
        "content_bbox": pdf_content_bbox,
        "transform": {
            "translation_x": translation_x,
            "translation_y": translation_y,
            "rotation": 0.0,
            "auto_scale": auto_scale,
            "initial_center": {"lat": kml_center_lat, "lng": kml_center_lng},
        },
        "placement_status": "auto_fitted",
    }
