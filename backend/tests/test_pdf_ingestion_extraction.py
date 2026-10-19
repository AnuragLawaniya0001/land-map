"""Tests for Multi-Page PDF Intake, Coordinate Spaces, and Native Extraction."""

import pytest
import pymupdf
from shapely.geometry import Polygon

from app.gis.ingestion.coordinates import CoordinateSpace, PageCoordinateTransform
from app.gis.ingestion.intake import DocumentIntakeService
from app.gis.ingestion.native_extractor import NativePDFExtractor


@pytest.fixture
def multi_page_sample_pdf():
    """Generates a synthetic 2-page test PDF with vector linework and text."""
    doc = pymupdf.open()
    # Page 1: Vector layout drawing
    p1 = doc.new_page(width=500, height=500)
    p1.draw_rect(pymupdf.Rect(50, 50, 450, 450), color=(0, 0, 0), width=2)
    p1.draw_rect(pymupdf.Rect(100, 100, 250, 250), color=(0, 0, 1), fill=(0.9, 0.9, 1))
    p1.insert_text(pymupdf.Point(120, 140), "Plot 101", fontsize=14)
    p1.insert_text(pymupdf.Point(120, 170), "Main Road 40ft", fontsize=10)

    # Page 2: Text schedule / notes
    p2 = doc.new_page(width=500, height=500)
    p2.insert_text(pymupdf.Point(50, 50), "Colony General Notes and Schedule", fontsize=12)
    p2.insert_text(pymupdf.Point(50, 80), "Padra, Vadodara", fontsize=10)

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def test_document_intake_multi_page(multi_page_sample_pdf):
    intake = DocumentIntakeService()
    res = intake.inspect_document(multi_page_sample_pdf, "sample_multi.pdf")

    assert res.is_valid is True
    assert res.page_count == 2
    assert res.primary_page_number == 1
    assert len(res.pages) == 2
    assert res.pages[0].content_type in ("vector_heavy", "mixed")
    assert res.pages[1].content_type in ("text_only", "empty")
    assert len(res.sha256) == 64


def test_document_intake_corrupt_file():
    intake = DocumentIntakeService()
    res = intake.inspect_document(b"not a valid pdf content", "corrupt.pdf")
    assert res.is_valid is False
    assert len(res.errors) > 0


def test_coordinate_transforms():
    transform = PageCoordinateTransform(
        page_number=1,
        width_points=600.0,
        height_points=400.0,
        render_dpi=150,
        render_scale_factor=150.0 / 72.0,
    )

    # Point to pixel and back
    px, py = transform.point_to_pixel(72.0, 72.0)
    assert round(px) == 150
    assert round(py) == 150

    ptx, pty = transform.pixel_to_point(150.0, 150.0)
    assert round(ptx, 1) == 72.0
    assert round(pty, 1) == 72.0

    # Geometry transform
    poly = Polygon([(100, 100), (200, 100), (200, 200), (100, 200), (100, 100)])
    px_poly = transform.transform_geometry(poly, CoordinateSpace.PDF_POINTS, CoordinateSpace.RENDERED_PIXELS)
    assert px_poly.area > poly.area


def test_native_pdf_extractor(multi_page_sample_pdf):
    extractor = NativePDFExtractor()
    pages = extractor.extract_all_pages(multi_page_sample_pdf)

    assert len(pages) == 2
    # Page 1 has extracted text and vectors
    p1 = pages[0]
    assert len(p1.text_spans) >= 2
    assert any("Plot 101" in t.text for t in p1.text_spans)
    assert len(p1.vector_paths) >= 2

    # Verify stable evidence IDs
    assert p1.text_spans[0].evidence_id.startswith("ev_txt_p1_")
    assert p1.vector_paths[0].evidence_id.startswith("ev_vec_p1_")
