"""Real Document Test Suite for Spatial Understanding Engine.

Tests spatial understanding and measurement association pipeline on real engineering
drawings from the repository:
1. Durga_Enclave_Final_Clean.pdf
2. Shri_Ram_Vector_Clean.pdf
"""

from pathlib import Path
import pytest
import pymupdf
from shapely.geometry import Polygon, Point, LineString

from app.gis.spatial_understanding.engine import SpatialUnderstandingEngine
from app.gis.spatial_understanding.models import (
    EntityType,
    MeasurementType,
    RelationshipType,
    ValidationStatus,
)


@pytest.fixture
def repo_root():
    # CWD is backend/python or workspace root
    cwd = Path.cwd()
    if (cwd / "Durga_Enclave_Final_Clean.pdf").exists():
        return cwd
    elif (cwd.parent / "Durga_Enclave_Final_Clean.pdf").exists():
        return cwd.parent
    elif (cwd.parent.parent / "Durga_Enclave_Final_Clean.pdf").exists():
        return cwd.parent.parent
    raise FileNotFoundError("Could not find Durga_Enclave_Final_Clean.pdf")


def _extract_drawing_from_pdf(pdf_path: Path):
    doc = pymupdf.open(str(pdf_path))
    page = doc[0]
    H = page.cropbox.height
    flip = lambda x, y: (x, H - y)

    lines = []
    texts = []
    polys = []

    for d in page.get_drawings():
        fill = d.get("fill")
        chain = []
        for it in d["items"]:
            if it[0] == "l":
                a, b = it[1], it[2]
                if not chain:
                    chain = [(a.x, a.y)]
                chain.append((b.x, b.y))
            elif it[0] == "re":
                r = it[1]
                pts = [flip(r.x0, r.y0), flip(r.x1, r.y0), flip(r.x1, r.y1), flip(r.x0, r.y1)]
                polys.append(pts)

        if len(chain) >= 2:
            for s, e in zip(chain, chain[1:]):
                lines.append(([flip(*s), flip(*e)], "", fill))

    for w in page.get_text("words"):
        x0, y0, x1, y1, s = w[:5]
        cx, cy = flip((x0 + x1) / 2, (y0 + y1) / 2)
        texts.append({
            "text": s.strip(),
            "geometry": Point(cx, cy),
            "bbox": [x0, H - y1, x1, H - y0],
            "source": "native_pdf",
        })

    doc.close()
    return lines, polys, texts


def test_real_doc_durga_enclave(repo_root):
    pdf_path = repo_root / "Durga_Enclave_Final_Clean.pdf"
    assert pdf_path.exists()

    lines, polys, texts = _extract_drawing_from_pdf(pdf_path)
    assert len(texts) > 0
    assert len(lines) > 0 or len(polys) > 0

    # Build synthetic plots from extracted boxes or polygons
    plots = []
    for idx, poly_pts in enumerate(polys[:30]):
        if len(poly_pts) >= 3:
            try:
                p = Polygon(poly_pts)
                if p.is_valid and p.area > 50:
                    plots.append({"id": f"plot_{idx+1}", "geometry": p})
            except Exception:
                pass

    engine = SpatialUnderstandingEngine()
    graph = engine.process_drawing(
        plots=plots if plots else None,
        text_elements=texts,
    )

    # Verify semantic graph integrity
    assert graph.metadata["source_page"] == 1
    assert len(graph.entities) > 0

    answers = engine.answer_semantic_questions(graph)
    assert "plot_label_associations" in answers
    assert "dimension_associations" in answers
    assert "shared_boundaries" in answers


def test_real_doc_shri_ram_vector(repo_root):
    pdf_path = repo_root / "Shri_Ram_Vector_Clean.pdf"
    assert pdf_path.exists()

    lines, polys, texts = _extract_drawing_from_pdf(pdf_path)
    assert len(texts) > 0

    engine = SpatialUnderstandingEngine()
    graph = engine.process_drawing(
        text_elements=texts,
    )

    assert len(graph.entities) > 0
    # Canonical relationships generated for all detected dimension texts
    dim_rels = graph.canonical_relationships
    assert isinstance(dim_rels, list)
    for cr in dim_rels:
        assert cr.raw_text is not None
        assert cr.association_status in {
            ValidationStatus.VERIFIED.value,
            ValidationStatus.CANDIDATE.value,
            ValidationStatus.REVIEW_REQUIRED.value,
            ValidationStatus.CONFLICTED.value,
            ValidationStatus.UNRESOLVED.value,
        }
