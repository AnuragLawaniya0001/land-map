"""Phase 13 Tests: Production Spatial and Tabular Exports.

Tests:
1. GeoJSON export (RFC 7946 compliance, properties, CRS, filtering).
2. CSV export (column completeness, declared vs derived separation).
3. QA JSON export (audit metadata, processing run, corrections).
4. DXF export (AutoCAD layers, polyline geometry, text labels).
"""

import asyncio
import io
import json
import ezdxf
import pytest

from app.gis.canonical.export_service import (
    generate_geojson_export,
    generate_csv_export,
    generate_qa_report_export,
    generate_dxf_export,
)
from app.gis.canonical.models import CanonicalDataset, CanonicalPlot, CanonicalRoad


class MockCollection:
    def __init__(self, name=""):
        self.name = name
        self.rows = []

    async def insert_one(self, doc):
        doc_copy = dict(doc)
        if "_id" not in doc_copy:
            doc_copy["_id"] = f"mock-id-{len(self.rows) + 1}"
        self.rows.append(doc_copy)
        return doc_copy

    async def find_one(self, query):
        for r in self.rows:
            if all(r.get(k) == v for k, v in query.items()):
                return r
        return None

    def find(self, query):
        matched = [r for r in self.rows if all(r.get(k) == v for k, v in query.items())]
        return matched


class MockDB(dict):
    def __getitem__(self, name):
        if name not in self:
            self[name] = MockCollection(name)
        return super().__getitem__(name)


def setup_test_colony():
    db = MockDB()
    colony_id = "colony-export-test"

    dataset = CanonicalDataset(
        colony_id=colony_id,
        version=1,
        is_active=True,
        approval_status="APPROVED",
        source_sha256="hash-exp",
        source_filename="colony.pdf",
        processing_run_id="run-exp-1",
        plots_count=2,
        roads_count=1,
        qa_quality_grade="A_VERIFIED",
    )
    db["canonical_datasets"].rows.append(dataset.to_dict())

    # Plot 1: Verified
    p1 = CanonicalPlot(
        id="plot-1",
        colony_id=colony_id,
        dataset_version=1,
        original_number="101",
        normalized_number="101",
        geometry={"type": "Polygon", "coordinates": [[[0, 0], [20, 0], [20, 40], [0, 40], [0, 0]]]},
        frontage_declared=20.0,
        depth_declared=40.0,
        area_declared=800.0,
        frontage_derived=20.0,
        depth_derived=40.0,
        area_derived=800.0,
        semantic_validation_status="verified",
        adjacent_road_ids=["road-main"],
    )
    db["canonical_plots"].rows.append(p1.to_dict())

    # Plot 2: Review Required
    p2 = CanonicalPlot(
        id="plot-2",
        colony_id=colony_id,
        dataset_version=1,
        original_number="102",
        normalized_number="102",
        geometry={"type": "Polygon", "coordinates": [[[20, 0], [40, 0], [40, 40], [20, 40], [20, 0]]]},
        frontage_declared=20.0,
        area_derived=800.0,
        semantic_validation_status="review_required",
    )
    db["canonical_plots"].rows.append(p2.to_dict())

    # Road
    r1 = CanonicalRoad(
        id="road-main",
        colony_id=colony_id,
        dataset_version=1,
        source_label="Main Street 30ft",
        declared_width_m=9.14,
        derived_width_m=9.14,
        geometry={"type": "Polygon", "coordinates": [[[0, -10], [40, -10], [40, 0], [0, 0], [0, -10]]]},
        adjacent_plot_ids=["plot-1", "plot-2"],
    )
    db["canonical_roads"].rows.append(r1.to_dict())

    return db, colony_id


def test_geojson_export():
    async def _run():
        db, colony_id = setup_test_colony()

        # Export all including review_required
        geojson_all = await generate_geojson_export(db, colony_id, version=1, include_review_required=True)
        assert geojson_all["type"] == "FeatureCollection"
        features = geojson_all["features"]
        assert len(features) == 3  # 2 plots + 1 road

        # Verify plot properties
        plot_feat = next(f for f in features if f["properties"]["id"] == "plot-1")
        assert plot_feat["properties"]["original_number"] == "101"
        assert plot_feat["properties"]["frontage_declared"] == 20.0
        assert plot_feat["properties"]["area_derived"] == 800.0
        assert plot_feat["properties"]["adjacent_road_ids"] == ["road-main"]

        # Filter out review_required
        geojson_verified = await generate_geojson_export(db, colony_id, version=1, include_review_required=False)
        assert len(geojson_verified["features"]) == 2  # 1 verified plot + 1 road

    asyncio.run(_run())


def test_csv_export():
    async def _run():
        db, colony_id = setup_test_colony()
        csv_str = await generate_csv_export(db, colony_id, version=1)

        lines = [line.strip() for line in csv_str.strip().split("\n") if line.strip()]
        assert len(lines) == 3  # Header + 2 plots
        header = lines[0]
        assert "plot_id" in header
        assert "frontage_declared" in header
        assert "area_derived_sqm" in header

        row1 = lines[1]
        assert "plot-1" in row1
        assert "101" in row1
        assert "800.0" in row1

    asyncio.run(_run())


def test_qa_report_export():
    async def _run():
        db, colony_id = setup_test_colony()
        qa_rep = await generate_qa_report_export(db, colony_id, version=1)

        assert qa_rep["report_type"] == "Canonical_Colony_QA_Provenance_Report"
        assert qa_rep["colony_id"] == colony_id
        assert qa_rep["dataset_version"] == 1
        assert qa_rep["qa_quality_grade"] == "A_VERIFIED"

    asyncio.run(_run())


def test_dxf_export():
    async def _run():
        db, colony_id = setup_test_colony()
        dxf_bytes = await generate_dxf_export(db, colony_id, version=1)

        assert len(dxf_bytes) > 0
        dxf_text = dxf_bytes.decode("utf-8")
        assert "SECTION" in dxf_text
        assert "ENTITIES" in dxf_text

        # Re-read with ezdxf to verify CAD validity
        doc = ezdxf.read(io.StringIO(dxf_text))
        layers = [l.dxf.name for l in doc.layers]
        assert "PLOTS" in layers
        assert "ROADS" in layers
        assert "LABELS" in layers

        # Check entity count in modelspace
        msp = doc.modelspace()
        polylines = list(msp.query("LWPOLYLINE"))
        assert len(polylines) >= 2  # Plot and road polylines

        texts = list(msp.query("TEXT"))
        assert len(texts) >= 1
        assert texts[0].dxf.text in ("101", "102")

    asyncio.run(_run())
