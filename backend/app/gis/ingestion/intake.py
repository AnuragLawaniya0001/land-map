"""Document Intake Service.

Validates PDF readability, file integrity, encryption, computing durable hashes,
enumerating all pages, and classifying document properties (vector, raster, mixed, scan quality).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import logging
from typing import Any, Dict, List, Optional, Tuple

import pymupdf
from PIL import Image

from app.gis.ingestion.coordinates import PageCoordinateTransform

logger = logging.getLogger("livemap.ingestion.intake")


@dataclass
class PageMetadata:
    page_number: int  # 1-indexed
    width_points: float
    height_points: float
    rotation_deg: int
    content_type: str  # "vector_heavy", "raster_heavy", "mixed", "text_only", "empty"
    vector_path_count: int
    text_word_count: int
    embedded_image_count: int
    largest_image_dimensions: Tuple[int, int]
    is_low_res_scan: bool
    coordinate_transform: PageCoordinateTransform

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page_number": self.page_number,
            "width_points": self.width_points,
            "height_points": self.height_points,
            "rotation_deg": self.rotation_deg,
            "content_type": self.content_type,
            "vector_path_count": self.vector_path_count,
            "text_word_count": self.text_word_count,
            "embedded_image_count": self.embedded_image_count,
            "largest_image_dimensions": list(self.largest_image_dimensions),
            "is_low_res_scan": self.is_low_res_scan,
            "coordinate_transform": self.coordinate_transform.to_dict(),
        }


@dataclass
class DocumentIntakeResult:
    is_valid: bool
    sha256: str
    file_size_bytes: int
    filename: str
    page_count: int
    primary_page_number: int
    document_content_type: str  # "vector", "raster", "mixed", "scanned_layout"
    pages: List[PageMetadata] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_valid": self.is_valid,
            "sha256": self.sha256,
            "file_size_bytes": self.file_size_bytes,
            "filename": self.filename,
            "page_count": self.page_count,
            "primary_page_number": self.primary_page_number,
            "document_content_type": self.document_content_type,
            "pages": [p.to_dict() for p in self.pages],
            "warnings": self.warnings,
            "errors": self.errors,
        }


class DocumentIntakeService:
    """Multi-page PDF intake and validation service."""

    def __init__(self, render_dpi: int = 150):
        self.render_dpi = render_dpi
        self.render_scale = render_dpi / 72.0

    def inspect_document(self, pdf_bytes: bytes, filename: str = "layout.pdf") -> DocumentIntakeResult:
        sha256_hash = hashlib.sha256(pdf_bytes).hexdigest()
        file_size = len(pdf_bytes)

        if file_size < 100:
            return DocumentIntakeResult(
                is_valid=False,
                sha256=sha256_hash,
                file_size_bytes=file_size,
                filename=filename,
                page_count=0,
                primary_page_number=1,
                document_content_type="invalid",
                errors=["Uploaded file is too small to be a valid PDF."],
            )

        if not pdf_bytes.startswith(b"%PDF"):
            return DocumentIntakeResult(
                is_valid=False,
                sha256=sha256_hash,
                file_size_bytes=file_size,
                filename=filename,
                page_count=0,
                primary_page_number=1,
                document_content_type="invalid",
                errors=["Invalid PDF header: Missing %PDF magic bytes."],
            )

        try:
            doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        except Exception as exc:
            return DocumentIntakeResult(
                is_valid=False,
                sha256=sha256_hash,
                file_size_bytes=file_size,
                filename=filename,
                page_count=0,
                primary_page_number=1,
                document_content_type="corrupt",
                errors=[f"Corrupt or unreadable PDF: {exc}"],
            )

        if doc.is_encrypted:
            doc.close()
            return DocumentIntakeResult(
                is_valid=False,
                sha256=sha256_hash,
                file_size_bytes=file_size,
                filename=filename,
                page_count=0,
                primary_page_number=1,
                document_content_type="encrypted",
                errors=["PDF is password-protected or encrypted; decryption is required before import."],
            )

        page_count = doc.page_count
        if page_count == 0:
            doc.close()
            return DocumentIntakeResult(
                is_valid=False,
                sha256=sha256_hash,
                file_size_bytes=file_size,
                filename=filename,
                page_count=0,
                primary_page_number=1,
                document_content_type="empty",
                errors=["PDF contains zero pages."],
            )

        pages_meta: List[PageMetadata] = []
        warnings: List[str] = []

        for p_idx in range(page_count):
            page = doc[p_idx]
            page_num = p_idx + 1
            rect = page.rect
            w_pt = float(rect.width)
            h_pt = float(rect.height)
            rot = int(page.rotation)

            drawings = page.get_drawings()
            v_count = sum(len(d.get("items", [])) for d in drawings)
            words = page.get_text("words")
            images = page.get_images(full=True)
            img_info = page.get_image_info(xrefs=True)

            max_img_w, max_img_h = 0, 0
            for item in img_info:
                w, h = int(item.get("width", 0)), int(item.get("height", 0))
                if w * h > max_img_w * max_img_h:
                    max_img_w, max_img_h = w, h

            # Check if raster scan is low resolution
            is_low_res = False
            if images and max_img_w > 0 and max_img_h > 0:
                est_dpi_x = max_img_w / max(w_pt / 72.0, 1e-3)
                if est_dpi_x < 120:
                    is_low_res = True
                    warnings.append(
                        f"Page {page_num} contains a low-resolution scan (~{int(est_dpi_x)} DPI). "
                        "OCR digit recognition and boundary snapping may have higher uncertainty."
                    )

            # Classify page content type
            has_vector = v_count > 0
            has_raster = bool(images or img_info)
            if has_vector and has_raster:
                p_type = "mixed"
            elif has_vector:
                p_type = "vector_heavy"
            elif has_raster:
                p_type = "raster_heavy"
            elif words:
                p_type = "text_only"
            else:
                p_type = "empty"

            transform = PageCoordinateTransform(
                page_number=page_num,
                width_points=w_pt,
                height_points=h_pt,
                rotation_deg=rot,
                render_dpi=self.render_dpi,
                render_scale_factor=self.render_scale,
            )

            pages_meta.append(
                PageMetadata(
                    page_number=page_num,
                    width_points=w_pt,
                    height_points=h_pt,
                    rotation_deg=rot,
                    content_type=p_type,
                    vector_path_count=v_count,
                    text_word_count=len(words),
                    embedded_image_count=len(images),
                    largest_image_dimensions=(max_img_w, max_img_h),
                    is_low_res_scan=is_low_res,
                    coordinate_transform=transform,
                )
            )

        doc.close()

        # Overall document content type
        types = {p.content_type for p in pages_meta}
        if "mixed" in types or ({"vector_heavy", "raster_heavy"} <= types):
            doc_type = "mixed"
        elif "vector_heavy" in types:
            doc_type = "vector"
        elif "raster_heavy" in types:
            doc_type = "raster"
        else:
            doc_type = "scanned_layout"

        # Determine primary layout page (the page with the highest linework/drawing density)
        primary_p = 1
        max_content = -1
        for p in pages_meta:
            score = (p.vector_path_count * 10) + (p.text_word_count * 2) + (500 if p.embedded_image_count else 0)
            if score > max_content:
                max_content = score
                primary_p = p.page_number

        return DocumentIntakeResult(
            is_valid=True,
            sha256=sha256_hash,
            file_size_bytes=file_size,
            filename=filename,
            page_count=page_count,
            primary_page_number=primary_p,
            document_content_type=doc_type,
            pages=pages_meta,
            warnings=warnings,
            errors=[],
        )
