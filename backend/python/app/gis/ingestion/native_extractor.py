"""Native PDF Extraction Engine.

Extracts native PDF drawing vectors, bezier curves, stroke widths, fill colors,
text spans with precise bounding boxes, font metadata, and embedded images across all pages.
Every extracted entity receives a deterministic Evidence ID tied to its page and coordinate provenance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import logging
from typing import Any, Dict, List, Optional, Tuple

import pymupdf
from shapely.geometry import LineString, Point, Polygon, mapping

logger = logging.getLogger("livemap.ingestion.native_extractor")


@dataclass
class ExtractedTextSpan:
    evidence_id: str
    page_number: int
    text: str
    bbox_points: List[float]  # [x1, y1, x2, y2] in PDF points
    font_name: str
    font_size: float
    font_flags: int
    color_rgb: Optional[Tuple[int, int, int]]
    orientation_deg: float
    origin_point: Tuple[float, float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evidence_id": self.evidence_id,
            "page_number": self.page_number,
            "text": self.text,
            "bbox_points": self.bbox_points,
            "font_name": self.font_name,
            "font_size": self.font_size,
            "color_rgb": list(self.color_rgb) if self.color_rgb else None,
            "orientation_deg": self.orientation_deg,
            "origin_point": list(self.origin_point),
        }


@dataclass
class ExtractedVectorPath:
    evidence_id: str
    page_number: int
    path_type: str  # "line", "rect", "curve", "polyline", "closed_polygon"
    points: List[Tuple[float, float]]  # Vertices in PDF points
    is_closed: bool
    stroke_color: Optional[Tuple[float, float, float]]
    stroke_width: float
    fill_color: Optional[Tuple[float, float, float]]
    geometry: Dict[str, Any]  # GeoJSON geometry

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evidence_id": self.evidence_id,
            "page_number": self.page_number,
            "path_type": self.path_type,
            "points": [list(pt) for pt in self.points],
            "is_closed": self.is_closed,
            "stroke_color": list(self.stroke_color) if self.stroke_color else None,
            "stroke_width": self.stroke_width,
            "fill_color": list(self.fill_color) if self.fill_color else None,
            "geometry": self.geometry,
        }


@dataclass
class ExtractedImagePlacement:
    evidence_id: str
    page_number: int
    bbox_points: List[float]
    width_px: int
    height_px: int
    xref: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evidence_id": self.evidence_id,
            "page_number": self.page_number,
            "bbox_points": self.bbox_points,
            "width_px": self.width_px,
            "height_px": self.height_px,
            "xref": self.xref,
        }


@dataclass
class PageExtractionResult:
    page_number: int
    width_points: float
    height_points: float
    text_spans: List[ExtractedTextSpan] = field(default_factory=list)
    vector_paths: List[ExtractedVectorPath] = field(default_factory=list)
    image_placements: List[ExtractedImagePlacement] = field(default_factory=list)
    duplicate_lines_removed: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page_number": self.page_number,
            "width_points": self.width_points,
            "height_points": self.height_points,
            "text_spans": [t.to_dict() for t in self.text_spans],
            "vector_paths": [v.to_dict() for v in self.vector_paths],
            "image_placements": [img.to_dict() for img in self.image_placements],
            "duplicate_lines_removed": self.duplicate_lines_removed,
        }


class NativePDFExtractor:
    """Extracts raw vector and textual evidence across all PDF pages."""

    def extract_all_pages(self, pdf_bytes: bytes) -> List[PageExtractionResult]:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        results: List[PageExtractionResult] = []

        for p_idx in range(doc.page_count):
            page = doc[p_idx]
            page_num = p_idx + 1
            res = self._extract_single_page(page, page_num)
            results.append(res)

        doc.close()
        return results

    def _extract_single_page(self, page: pymupdf.Page, page_num: int) -> PageExtractionResult:
        w_pt = float(page.rect.width)
        h_pt = float(page.rect.height)

        # 1. Extract Text Spans with Font Info and Direction
        text_spans: List[ExtractedTextSpan] = []
        page_dict = page.get_text("dict", flags=pymupdf.TEXT_DEHYPHENATE)
        span_idx = 0

        for block in page_dict.get("blocks", []):
            if block.get("type") == 0:  # text block
                for line in block.get("lines", []):
                    line_dir = line.get("dir", (1, 0))
                    # Calculate angle
                    angle = 0.0
                    if line_dir != (1, 0):
                        angle = round((180.0 / 3.1415926535) * pymupdf.Point(line_dir).theta, 1)

                    for span in line.get("spans", []):
                        raw_text = span.get("text", "").strip()
                        if not raw_text:
                            continue

                        span_idx += 1
                        bbox = [round(float(v), 3) for v in span.get("bbox", [0, 0, 0, 0])]
                        ev_id = f"ev_txt_p{page_num}_{span_idx}_{hashlib.md5(f'{page_num}_{bbox}_{raw_text}'.encode()).hexdigest()[:8]}"

                        color_val = span.get("color")
                        color_rgb = None
                        if isinstance(color_val, int):
                            r = (color_val >> 16) & 255
                            g = (color_val >> 8) & 255
                            b = color_val & 255
                            color_rgb = (r, g, b)

                        text_spans.append(
                            ExtractedTextSpan(
                                evidence_id=ev_id,
                                page_number=page_num,
                                text=raw_text,
                                bbox_points=bbox,
                                font_name=span.get("font", "unknown"),
                                font_size=round(float(span.get("size", 10.0)), 2),
                                font_flags=int(span.get("flags", 0)),
                                color_rgb=color_rgb,
                                orientation_deg=angle,
                                origin_point=(round(float(span.get("origin", [0, 0])[0]), 3), round(float(span.get("origin", [0, 0])[1]), 3)),
                            )
                        )

        # 2. Extract Vector Drawings & Linework
        raw_drawings = page.get_drawings()
        vector_paths: List[ExtractedVectorPath] = []
        seen_segments = set()
        duplicates_removed = 0
        vec_idx = 0

        for d in raw_drawings:
            stroke_color = d.get("color")
            stroke_width = float(d.get("width", 1.0))
            fill_color = d.get("fill")

            for item in d.get("items", []):
                op = item[0]

                if op == "l":  # Line
                    p1, p2 = item[1], item[2]
                    x1, y1 = round(float(p1.x), 2), round(float(p1.y), 2)
                    x2, y2 = round(float(p2.x), 2), round(float(p2.y), 2)

                    # Deduplicate exact overlapping line segments
                    seg_key = tuple(sorted([(x1, y1), (x2, y2)]))
                    if seg_key in seen_segments:
                        duplicates_removed += 1
                        continue
                    seen_segments.add(seg_key)

                    vec_idx += 1
                    ev_id = f"ev_vec_p{page_num}_{vec_idx}"
                    geom = mapping(LineString([(x1, y1), (x2, y2)]))

                    vector_paths.append(
                        ExtractedVectorPath(
                            evidence_id=ev_id,
                            page_number=page_num,
                            path_type="line",
                            points=[(x1, y1), (x2, y2)],
                            is_closed=False,
                            stroke_color=stroke_color,
                            stroke_width=stroke_width,
                            fill_color=fill_color,
                            geometry=geom,
                        )
                    )

                elif op == "re":  # Rectangle
                    rect = item[1]
                    rx1, ry1, rx2, ry2 = round(float(rect.x0), 2), round(float(rect.y0), 2), round(float(rect.x1), 2), round(float(rect.y1), 2)
                    pts = [(rx1, ry1), (rx2, ry1), (rx2, ry2), (rx1, ry2), (rx1, ry1)]
                    vec_idx += 1
                    ev_id = f"ev_vec_p{page_num}_{vec_idx}"

                    geom = mapping(Polygon(pts)) if fill_color else mapping(LineString(pts))

                    vector_paths.append(
                        ExtractedVectorPath(
                            evidence_id=ev_id,
                            page_number=page_num,
                            path_type="rect",
                            points=pts,
                            is_closed=True,
                            stroke_color=stroke_color,
                            stroke_width=stroke_width,
                            fill_color=fill_color,
                            geometry=geom,
                        )
                    )

                elif op == "c":  # Bezier curve
                    p1, p2, p3, p4 = item[1], item[2], item[3], item[4]
                    # Sample cubic bezier curve into 8 line segments
                    sampled_pts = []
                    for t in [0.0, 0.25, 0.5, 0.75, 1.0]:
                        bx = (1 - t)**3 * p1.x + 3 * (1 - t)**2 * t * p2.x + 3 * (1 - t) * t**2 * p3.x + t**3 * p4.x
                        by = (1 - t)**3 * p1.y + 3 * (1 - t)**2 * t * p2.y + 3 * (1 - t) * t**2 * p3.y + t**3 * p4.y
                        sampled_pts.append((round(float(bx), 2), round(float(by), 2)))

                    vec_idx += 1
                    ev_id = f"ev_vec_p{page_num}_{vec_idx}"
                    geom = mapping(LineString(sampled_pts))

                    vector_paths.append(
                        ExtractedVectorPath(
                            evidence_id=ev_id,
                            page_number=page_num,
                            path_type="curve",
                            points=sampled_pts,
                            is_closed=False,
                            stroke_color=stroke_color,
                            stroke_width=stroke_width,
                            fill_color=fill_color,
                            geometry=geom,
                        )
                    )

        # 3. Extract Image Placements
        image_placements: List[ExtractedImagePlacement] = []
        img_info = page.get_image_info(xrefs=True)
        img_idx = 0
        for item in img_info:
            img_idx += 1
            bbox = [round(float(v), 3) for v in item.get("bbox", [0, 0, 0, 0])]
            image_placements.append(
                ExtractedImagePlacement(
                    evidence_id=f"ev_img_p{page_num}_{img_idx}",
                    page_number=page_num,
                    bbox_points=bbox,
                    width_px=int(item.get("width", 0)),
                    height_px=int(item.get("height", 0)),
                    xref=int(item.get("xref", 0)),
                )
            )

        return PageExtractionResult(
            page_number=page_num,
            width_points=w_pt,
            height_points=h_pt,
            text_spans=text_spans,
            vector_paths=vector_paths,
            image_placements=image_placements,
            duplicate_lines_removed=duplicates_removed,
        )
