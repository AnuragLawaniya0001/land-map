"""Comprehensive Test Suite for Phase 7-8: Canonical Colony Data Model, Persistence, Versioning & Provenance.

Validates:
1. Canonical model serialization and deserialization round trips.
2. Irregular polygon and multipart geometry handling.
3. CRS and coordinate metadata preservation (local drawing, metric, WGS84).
4. Raw measurement text preservation alongside normalized values.
5. Semantic relationship persistence.
6. QA-gated commit behavior and blocking of corrupted datasets.
7. Idempotent commits on identical document hashes.
8. Version snapshotting and incrementation.
9. Preservation of last approved active version when reprocessing fails or is rejected.
10. End-to-end provenance retrieval.
11. Human review correction audit history.
12. Paginated queries and filters.
13. Colony tenant authorization and cross-project access protection.
14. Canonical API routes via FastAPI TestClient.
"""

from copy import deepcopy
import asyncio
import json
import pytest
from bson import ObjectId
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.gis.canonical.crs import (
    CRSType,
    CoordinateSystemMetadata,
    validate_and_normalize_geometry,
    round_coordinates,
)
from app.gis.canonical.models import (
    CanonicalDataset,
    CanonicalDimensionAnnotation,
    CanonicalGeometryEdge,
    CanonicalPlot,
    CanonicalRelationshipType,
    CanonicalRoad,
    CanonicalSemanticRelationship,
    ProcessingRun,
    ReviewCorrection,
)
from app.gis.canonical.adapter import (
    build_canonical_entities_from_preview,
    compute_sha256,
    extract_polygon_edges,
)
from app.gis.canonical.persistence import (
    commit_canonical_dataset,
    get_active_canonical_dataset,
    get_canonical_dataset_by_version,
    get_canonical_plot,
    get_entity_provenance,
    list_canonical_dimensions,
    list_canonical_plots,
    list_canonical_relationships,
    list_canonical_roads,
    list_canonical_versions,
    list_processing_runs,
    list_qa_findings,
    list_review_corrections,
    record_review_correction,
)
from app.gis.canonical.routes import build_canonical_router, _overlay_plot_candidates


class MockCollection:
    def __init__(self, rows=()):
        self.rows = [deepcopy(row) for row in rows]

    async def find_one(self, query):
        for row in self.rows:
            if all(row.get(k) == v for k, v in query.items()):
                return deepcopy(row)
        return None

    async def insert_one(self, doc):
        self.rows.append(deepcopy(doc))

    async def insert_many(self, docs):
        self.rows.extend(deepcopy(docs))

    async def update_one(self, query, update):
        for row in self.rows:
            if all(row.get(k) == v for k, v in query.items()):
                if "$set" in update:
                    row.update(deepcopy(update["$set"]))
                return

    async def update_many(self, query, update):
        for row in self.rows:
            if all(row.get(k) == v for k, v in query.items()):
                if "$set" in update:
                    row.update(deepcopy(update["$set"]))

    async def count_documents(self, query):
        return sum(all(row.get(k) == v for k, v in query.items()) for row in self.rows)

    def find(self, query):
        matched = [deepcopy(r) for r in self.rows if all(r.get(k) == v for k, v in query.items())]
        return MockCursor(matched)


class MockCursor:
    def __init__(self, items):
        self.items = items
        self._skip = 0
        self._limit = None

    def skip(self, n):
        self._skip = n
        return self

    def limit(self, n):
        self._limit = n
        return self

    async def to_list(self, length=None):
        start = self._skip
        end = start + self._limit if self._limit is not None else None
        res = self.items[start:end]
        return res[:length] if length is not None else res


class MockDB(dict):
    def __getitem__(self, name):
        return super().setdefault(name, MockCollection())


@pytest.fixture
def mock_db():
    return MockDB()


@pytest.fixture
def sample_preview_data():
    return {
        "fields": {
            "scale_ratio": 0.05,
            "roads": [
                {
                    "id": "road-main",
                    "name": "Main Road 40' Wide",
                    "width": 12.19,
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[0, 0], [100, 0], [100, 20], [0, 20], [0, 0]]],
                    },
                }
            ],
            "boundary": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]],
            },
        },
        "plots": [
            {
                "id": "plot-colony-1",
                "number": "Plot 101",
                "original_number": "Plot 101",
                "normalized_number": "101",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[10, 20], [30, 20], [30, 60], [10, 60], [10, 20]]],
                },
                "frontage_declared": 20.0,
                "depth_declared": 40.0,
                "area_declared": 800.0,
                "declared_units": "ft",
                "adjacent_road_ids": ["road-main"],
                "neighboring_plot_ids": ["plot-colony-2"],
            },
            {
                "id": "plot-colony-2",
                "number": "Plot 102",
                "original_number": "Plot 102",
                "normalized_number": "102",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[30, 20], [50, 20], [50, 60], [30, 60], [30, 20]]],
                },
                "frontage_declared": 20.0,
                "depth_declared": 40.0,
                "adjacent_road_ids": ["road-main"],
                "neighboring_plot_ids": ["plot-colony-1"],
            },
        ],
        "spatial_understanding": {
            "answers": {
                "adjacent_roads": {"plot-colony-1": ["Main Road 40' Wide"]},
                "shared_boundaries": {"plot-colony-1": ["plot-colony-2"]},
            },
            "canonical_relationships": [
                {
                    "raw_text": "40'-0\"",
                    "parsed_value": 40.0,
                    "unit": "ft",
                    "measurement_type": "plot_depth",
                    "candidate_target_features": ["plot-colony-1"],
                    "association_status": "verified",
                    "evidence": ["Dimension text 40' adjacent to side boundary of Plot 101"],
                    "confidence_signals": {"aggregate": 0.95},
                }
            ],
        },
        "qa_report": {
            "validation_passed": True,
            "quality_grade": "A_VERIFIED",
            "findings": [
                {"severity": "info", "message": "All geometries validated successfully"}
            ],
            "recovery_records": [],
        },
    }


# ============================================================================
# 1. Canonical Model Serialization & Deserialization Round Trips
# ============================================================================

def test_canonical_plot_serialization_round_trip():
    plot = CanonicalPlot(
        id="plot-101",
        colony_id="colony-abc",
        dataset_version=1,
        original_number="Plot #101/A",
        normalized_number="101A",
        geometry={"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
        frontage_declared=10.0,
        frontage_derived=10.0,
        depth_declared=10.0,
        depth_derived=10.0,
        area_declared=100.0,
        area_derived=100.0,
        adjacent_road_ids=["road-1"],
        neighboring_plot_ids=["plot-102"],
        semantic_validation_status="verified",
        confidence_signals={"geometry": 1.0, "ocr": 0.98},
        unresolved_warnings=[],
        source_document_id="drawing.pdf",
        source_page=1,
        provenance={"extraction": "vector"},
    )
    d = plot.to_dict()
    reconstructed = CanonicalPlot.from_dict(d)

    assert reconstructed.id == "plot-101"
    assert reconstructed.original_number == "Plot #101/A"
    assert reconstructed.normalized_number == "101A"
    assert reconstructed.frontage_declared == 10.0
    assert reconstructed.frontage_derived == 10.0
    assert reconstructed.area_declared == 100.0
    assert reconstructed.area_derived == 100.0
    assert reconstructed.adjacent_road_ids == ["road-1"]
    assert reconstructed.neighboring_plot_ids == ["plot-102"]


def test_canonical_road_and_dimension_round_trip():
    road = CanonicalRoad(
        id="road-1",
        colony_id="colony-abc",
        dataset_version=1,
        source_label="30 FT ROAD",
        geometry={"type": "Polygon", "coordinates": [[[0, 0], [50, 0], [50, 10], [0, 10], [0, 0]]]},
        declared_width_m=9.144,
        derived_width_m=10.0,
        declared_width_raw="30 FT",
    )
    road_dict = road.to_dict()
    rec_road = CanonicalRoad.from_dict(road_dict)
    assert rec_road.source_label == "30 FT ROAD"
    assert rec_road.declared_width_m == 9.144
    assert rec_road.derived_width_m == 10.0

    dim = CanonicalDimensionAnnotation(
        id="dim-1",
        colony_id="colony-abc",
        dataset_version=1,
        original_text="30'-0\"",
        parsed_value=30.0,
        original_unit="ft",
        normalized_value_m=9.144,
        measurement_category="road_width",
        selected_target_id="road-1",
        association_status="verified",
    )
    dim_dict = dim.to_dict()
    rec_dim = CanonicalDimensionAnnotation.from_dict(dim_dict)
    assert rec_dim.original_text == "30'-0\""
    assert rec_dim.parsed_value == 30.0
    assert rec_dim.normalized_value_m == 9.144
    assert rec_dim.selected_target_id == "road-1"


# ============================================================================
# 2. Polygon & Multipart Geometry Round Trips & Precision
# ============================================================================

def test_irregular_and_multipart_geometry_normalization():
    # Irregular polygon
    irregular = {
        "type": "Polygon",
        "coordinates": [[[0.00001, 0.00002], [10.123456, 0.0], [8.0, 12.0], [0.0, 10.0], [0.00001, 0.00002]]],
    }
    normalized, is_valid, note = validate_and_normalize_geometry(irregular, precision=4)
    assert is_valid is True
    assert normalized["type"] == "Polygon"
    assert normalized["coordinates"][0][1] == [10.1235, 0.0]

    # Multipart MultiPolygon
    multipoly = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
            [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]],
        ],
    }
    norm_multi, multi_valid, _ = validate_and_normalize_geometry(multipoly)
    assert multi_valid is True
    assert norm_multi["type"] == "MultiPolygon"
    assert len(norm_multi["coordinates"]) == 2


def test_invalid_polygon_self_intersection_repair():
    # Bowtie polygon (self-intersecting)
    bowtie = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]],
    }
    norm, is_valid, note = validate_and_normalize_geometry(bowtie)
    assert is_valid is True
    assert note is not None
    assert "repaired" in note.lower()


# ============================================================================
# 3. CRS & Coordinate Metadata Preservation
# ============================================================================

def test_crs_metadata_preservation():
    crs_local = CoordinateSystemMetadata(
        crs_type=CRSType.LOCAL_DRAWING,
        units="px",
        scale_uncertain=True,
    )
    assert crs_local.scale_uncertain is True
    assert crs_local.is_georeferenced is False

    crs_metric = CoordinateSystemMetadata(
        crs_type=CRSType.PROJECTED_METRIC,
        units="m",
        scale_ratio=0.05,
        scale_uncertain=False,
    )
    d = crs_metric.to_dict()
    rec_crs = CoordinateSystemMetadata.from_dict(d)
    assert rec_crs.crs_type == CRSType.PROJECTED_METRIC
    assert rec_crs.scale_ratio == 0.05
    assert rec_crs.scale_uncertain is False


# ============================================================================
# 4. Raw Measurement vs Normalized Values
# ============================================================================

def test_declared_vs_derived_measurements_separation(sample_preview_data):
    colony_id = "colony-test-1"
    (
        dataset,
        proc_run,
        plots,
        roads,
        dims,
        rels,
    ) = build_canonical_entities_from_preview(
        colony_id=colony_id,
        preview_data=sample_preview_data,
        source_filename="colony_layout.pdf",
    )

    plot1 = next(p for p in plots if p.original_number == "Plot 101")
    # Declared was explicitly provided
    assert plot1.frontage_declared == 20.0
    assert plot1.depth_declared == 40.0
    assert plot1.area_declared == 800.0
    # The drawing scale is 0.05 m per coordinate unit, so the derived area is 2 m².
    assert plot1.area_derived == 2.0
    assert plot1.frontage_derived is not None
    assert plot1.frontage_derived == 1.0
    assert plot1.depth_derived is None

    # Check edges
    assert len(plot1.edges) >= 4
    frontage_edge = next((e for e in plot1.edges if e.road_frontage_classification == "frontage"), None)
    assert frontage_edge is not None
    assert frontage_edge.parent_feature_id == plot1.id
    assert dims[0].normalized_value_m == 12.192


def test_geographic_plot_measurements_use_wgs84_and_preserve_precision():
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [78.24371, 27.23651],
            [78.24401, 27.23651],
            [78.24401, 27.23681],
            [78.24371, 27.23681],
            [78.24371, 27.23651],
        ]],
    }
    _, _, plots, _, _, _ = build_canonical_entities_from_preview(
        colony_id="colony-wgs84",
        preview_data={
            "fields": {"is_georeferenced": True},
            "plots": [{"id": "geo-plot", "number": "1", "geometry": geometry}],
        },
        source_filename="registered.pdf",
    )

    plot = plots[0]
    assert plot.geometry["coordinates"][0][0] == [78.24371, 27.23651]
    assert plot.crs_metadata.units == "deg"
    assert 950 < plot.area_derived < 1100
    assert all(edge.measured_length_m is not None for edge in plot.edges)
    assert plot.semantic_validation_status == "review_required"


def test_local_drawing_coordinates_are_not_assumed_to_be_geographic_or_metric():
    geometry = {
        "type": "Polygon",
        "coordinates": [[[10, 20], [30, 20], [30, 60], [10, 60], [10, 20]]],
    }
    _, _, plots, _, _, _ = build_canonical_entities_from_preview(
        colony_id="colony-local",
        preview_data={"plots": [{"id": "local-plot", "number": "1", "geometry": geometry}]},
        source_filename="local.pdf",
    )

    plot = plots[0]
    assert plot.crs_metadata.crs_type.value == "local_drawing"
    assert plot.area_derived is None
    assert all(edge.measured_length_m is None for edge in plot.edges)


def test_imported_area_sqm_is_not_misreported_as_source_declared_area():
    geometry = {
        "type": "Polygon",
        "coordinates": [[[10, 20], [30, 20], [30, 60], [10, 60], [10, 20]]],
    }
    _, _, plots, _, _, _ = build_canonical_entities_from_preview(
        colony_id="colony-imported-area",
        preview_data={
            "plots": [{
                "id": "area-plot",
                "number": "1",
                "area_sqm": 200,
                "geometry": geometry,
            }],
        },
        source_filename="layout.pdf",
    )

    assert plots[0].area_declared is None
    assert plots[0].area_derived is None


def test_overlay_hit_regions_are_not_canonical_plots_and_missing_qa_is_not_passed():
    dataset, run, plots, roads, dimensions, relationships = build_canonical_entities_from_preview(
        colony_id="colony-overlay-only",
        preview_data={
            "pdf_overlay": {
                "plot_regions": [{
                    "number": "heuristic-1",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[
                            [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
                        ]],
                    },
                }],
            },
        },
        source_filename="scanned-layout.pdf",
    )

    assert plots == []
    assert dataset.plots_count == 0
    assert dataset.qa_quality_grade == "C_REVIEW_NEEDED"
    assert run.qa_summary["validation_passed"] is False


def test_unlabeled_raster_regions_receive_explicit_review_ids_not_plot_numbers():
    candidates = _overlay_plot_candidates("colony-raster", [
        {"geometry": {"type": "Polygon", "coordinates": []}},
        {"number": "42", "geometry": {"type": "Polygon", "coordinates": []}},
    ])

    assert candidates[0]["number"] == "R-001"
    assert candidates[0]["original_number"] is None
    assert candidates[0]["is_generated_candidate_id"] is True
    assert candidates[1]["number"] == "42"
    assert candidates[1]["original_number"] == "42"
    assert candidates[1]["is_generated_candidate_id"] is False


def test_valid_geometry_does_not_automatically_mark_entities_verified():
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
        ]],
    }
    dataset, run, plots, roads, dimensions, relationships = build_canonical_entities_from_preview(
        colony_id="colony-unreviewed-geometry",
        preview_data={
            "plots": [{"id": "plot-1", "number": "1", "geometry": geometry}],
            "roads": [{"id": "road-1", "name": "Road 1", "geometry": geometry}],
        },
        source_filename="layout.pdf",
    )

    assert plots[0].geometry_valid is True
    assert plots[0].semantic_validation_status == "review_required"
    assert plots[0].confidence_signals == {}
    assert roads[0].validation_status == "review_required"


def test_unreviewed_entities_remain_review_required_even_with_import_qa_grade(sample_preview_data):
    data = deepcopy(sample_preview_data)
    data["qa_report"]["quality_grade"] = "A_VERIFIED"
    _, run, plots, roads, _, _ = build_canonical_entities_from_preview(
        colony_id="colony-unreviewed-grade",
        preview_data=data,
        source_filename="layout.pdf",
    )

    assert plots[0].semantic_validation_status == "review_required"
    assert roads[0].validation_status == "review_required"
    assert run.quality_grade == "A_VERIFIED"


def test_road_width_approximation_is_provenanced(sample_preview_data):
    _, _, _, roads, _, _ = build_canonical_entities_from_preview(
        colony_id="colony-road-width-provenance",
        preview_data=sample_preview_data,
        source_filename="layout.pdf",
    )

    assert roads[0].derived_width_m is not None
    assert roads[0].provenance["derived_width_method"] == "area_perimeter_approximation"


# ============================================================================
# 5. Semantic Relationships Persistence & Provenance
# ============================================================================

def test_semantic_relationships_generation(sample_preview_data):
    colony_id = "colony-test-2"
    (
        dataset,
        proc_run,
        plots,
        roads,
        dims,
        rels,
    ) = build_canonical_entities_from_preview(
        colony_id=colony_id,
        preview_data=sample_preview_data,
        source_filename="colony_layout.pdf",
    )

    types = [r.relationship_type for r in rels]
    assert CanonicalRelationshipType.PLOT_ADJACENT_TO_ROAD.value in types
    assert CanonicalRelationshipType.PLOT_ADJACENT_TO_PLOT.value in types
    assert CanonicalRelationshipType.DIMENSION_MEASURES_FEATURE.value in types

    dim_rel = next(r for r in rels if r.relationship_type == CanonicalRelationshipType.DIMENSION_MEASURES_FEATURE.value)
    assert dim_rel.target_entity_id == "plot-colony-1"
    assert len(dim_rel.source_evidence) > 0


# ============================================================================
# 6. QA-Gated Commit & Recovery Logic
# ============================================================================

# ============================================================================
# 6. QA-Gated Commit & Recovery Logic
# ============================================================================

def test_qa_gated_commit_blocks_rejected_grade(mock_db, sample_preview_data):
    colony_id = "colony-qa-fail"
    corrupt_preview = deepcopy(sample_preview_data)
    corrupt_preview["qa_report"]["quality_grade"] = "F_REJECTED"
    corrupt_preview["qa_report"]["validation_passed"] = False
    corrupt_preview["qa_report"]["findings"] = [
        {"severity": "critical", "message": "Total polygon corruption detected"}
    ]

    async def _run():
        with pytest.raises(ValueError, match="QA gating rejected commit"):
            await commit_canonical_dataset(
                db=mock_db,
                colony_id=colony_id,
                preview_data=corrupt_preview,
                source_filename="corrupted.pdf",
                source_data=b"corrupt-bytes",
            )

        active = await get_active_canonical_dataset(mock_db, colony_id)
        assert active is None

        runs = await list_processing_runs(mock_db, colony_id)
        assert len(runs) == 1
        assert runs[0]["status"] == "REJECTED"

    asyncio.run(_run())


# ============================================================================
# 7. Idempotent Commits
# ============================================================================

def test_idempotent_commit_same_source_hash(mock_db, sample_preview_data):
    colony_id = "colony-idempotent"
    pdf_bytes = b"sample-pdf-layout-bytes-v1"

    async def _run():
        res1 = await commit_canonical_dataset(
            db=mock_db,
            colony_id=colony_id,
            preview_data=sample_preview_data,
            source_filename="layout.pdf",
            source_data=pdf_bytes,
        )
        assert res1["success"] is True
        assert res1["idempotent"] is False
        assert res1["dataset_version"] == 1

        res2 = await commit_canonical_dataset(
            db=mock_db,
            colony_id=colony_id,
            preview_data=sample_preview_data,
            source_filename="layout.pdf",
            source_data=pdf_bytes,
        )
        assert res2["success"] is True
        assert res2["idempotent"] is True
        assert res2["dataset_version"] == 1

        versions = await list_canonical_versions(mock_db, colony_id)
        assert len(versions) == 1

    asyncio.run(_run())


# ============================================================================
# 8. Version Increment & Preservation of Active Version on Failed Reprocessing
# ============================================================================

def test_version_increment_and_failed_reprocessing_isolation(mock_db, sample_preview_data):
    colony_id = "colony-versioning"

    async def _run():
        # 1. Commit Version 1 (Approved)
        res1 = await commit_canonical_dataset(
            db=mock_db,
            colony_id=colony_id,
            preview_data=sample_preview_data,
            source_filename="rev1.pdf",
            source_data=b"rev1-bytes",
        )
        assert res1["dataset_version"] == 1
        active_v1 = await get_active_canonical_dataset(mock_db, colony_id)
        assert active_v1["version"] == 1
        assert active_v1["is_active"] is True

        # 2. Attempt failed reprocessing with new document rev2
        fail_preview = deepcopy(sample_preview_data)
        fail_preview["qa_report"]["quality_grade"] = "F_REJECTED"
        fail_preview["qa_report"]["validation_passed"] = False
        fail_preview["qa_report"]["findings"] = [{"severity": "critical", "message": "Corrupted"}]

        with pytest.raises(ValueError):
            await commit_canonical_dataset(
                db=mock_db,
                colony_id=colony_id,
                preview_data=fail_preview,
                source_filename="rev2_bad.pdf",
                source_data=b"rev2-bytes",
            )

        # 3. CRITICAL: Version 1 must still be active!
        active_still_v1 = await get_active_canonical_dataset(mock_db, colony_id)
        assert active_still_v1 is not None
        assert active_still_v1["version"] == 1
        assert active_still_v1["is_active"] is True

        # 4. Now commit valid revision 3
        res3 = await commit_canonical_dataset(
            db=mock_db,
            colony_id=colony_id,
            preview_data=sample_preview_data,
            source_filename="rev3_good.pdf",
            source_data=b"rev3-bytes",
        )
        assert res3["dataset_version"] >= 2
        active_v3 = await get_active_canonical_dataset(mock_db, colony_id)
        assert active_v3["version"] == res3["dataset_version"]
        assert active_v3["is_active"] is True

        # Check that Version 1 is no longer active
        v1_doc = await get_canonical_dataset_by_version(mock_db, colony_id, 1)
        assert v1_doc["is_active"] is False

    asyncio.run(_run())


# ============================================================================
# 9. Provenance Retrieval & Manual Corrections Audit
# ============================================================================

def test_provenance_and_manual_correction_history(mock_db, sample_preview_data):
    colony_id = "colony-provenance"

    async def _run():
        res = await commit_canonical_dataset(
            db=mock_db,
            colony_id=colony_id,
            preview_data=sample_preview_data,
            source_filename="colony.pdf",
            source_data=b"colony-bytes",
        )
        version = res["dataset_version"]

        plots_res = await list_canonical_plots(mock_db, colony_id, version=version)
        target_plot = plots_res["plots"][0]
        target_plot_id = target_plot["id"]

        # 1. Retrieve provenance trace
        prov = await get_entity_provenance(mock_db, colony_id, target_plot_id, version=version)
        assert prov is not None
        assert prov["entity_id"] == target_plot_id
        assert prov["entity_type"] == "Plot"
        assert prov["dataset_version"] == version
        assert prov["source_document_id"] == "colony.pdf"

        # 2. Record manual reviewer correction
        corr = ReviewCorrection(
            correction_id="corr-1",
            colony_id=colony_id,
            dataset_version=version,
            entity_type="Plot",
            entity_id=target_plot_id,
            field_name="frontage_declared",
            previous_value=target_plot.get("frontage_declared"),
            corrected_value=25.5,
            reviewer_user_id="gis_officer_42",
            timestamp="2026-10-10T12:00:00Z",
            reason="Field survey verified frontage is 25.5 ft",
        )
        corr_res = await record_review_correction(mock_db, colony_id, corr)
        assert corr_res["success"] is True

        # Verify plot was updated
        updated_plot = await get_canonical_plot(mock_db, colony_id, target_plot_id, version=version)
        assert updated_plot["frontage_declared"] == 25.5

        # Verify audit history is logged
        corrections = await list_review_corrections(mock_db, colony_id, version=version)
        assert len(corrections) == 1
        assert corrections[0]["corrected_value"] == 25.5
        assert corrections[0]["reviewer_user_id"] == "gis_officer_42"

    asyncio.run(_run())


# ============================================================================
# 10. Paginated Queries & Filters
# ============================================================================

def test_paginated_queries_and_filters(mock_db, sample_preview_data):
    colony_id = "colony-queries"

    async def _run():
        await commit_canonical_dataset(
            db=mock_db,
            colony_id=colony_id,
            preview_data=sample_preview_data,
            source_filename="colony.pdf",
        )

        # Limit 1
        page1 = await list_canonical_plots(mock_db, colony_id, limit=1, skip=0)
        assert len(page1["plots"]) == 1
        assert page1["total"] == 2

        # Skip 1
        page2 = await list_canonical_plots(mock_db, colony_id, limit=1, skip=1)
        assert len(page2["plots"]) == 1
        assert page2["plots"][0]["id"] != page1["plots"][0]["id"]

        # Filter by plot original number
        filtered = await list_canonical_plots(mock_db, colony_id, plot_number="Plot 101")
        assert len(filtered["plots"]) == 1
        assert filtered["plots"][0]["original_number"] == "Plot 101"

    asyncio.run(_run())


# ============================================================================
# 11. Canonical API Endpoints & Authorization Protection
# ============================================================================

def test_canonical_api_endpoints_and_authorization(mock_db, sample_preview_data):
    colony_id = "64f1a2b3c4d5e6f7a8b9c0d1"
    user_owner = {"id": "user-owner", "role": "admin"}
    user_unauthorized = {"id": "user-unauthorized", "role": "admin"}

    app = FastAPI()

    # Pre-populate database with committed canonical dataset
    import asyncio
    asyncio.run(
        commit_canonical_dataset(
            db=mock_db,
            colony_id=colony_id,
            preview_data=sample_preview_data,
            source_filename="layout.pdf",
            source_data=b"layout-pdf-bytes",
            created_by="user-owner",
        )
    )

    current_user_holder = {"user": user_owner}

    async def mock_require_admin():
        return current_user_holder["user"]

    async def mock_owned_colony(c_id, user):
        if user["id"] != "user-owner":
            raise HTTPException(404, "Colony not found or access denied")
        return {
            "_id": ObjectId(c_id),
            "name": "Shri Ram Enclave",
            "owner_id": user["id"],
            "pdf_overlay": {
                "storage_key": "map_overlay/source.png",
                "bounds": [[27.0, 78.0], [27.002, 78.002]],
                "fit": {"fit_mode": "quadrilateral_homography"},
            },
            "import_source": {"filename": "layout.pdf"},
        }

    canonical_router = build_canonical_router(
        db=mock_db,
        require_admin_dep=mock_require_admin,
        owned_colony_fn=mock_owned_colony,
        now_iso_fn=lambda: "2026-10-10T12:00:00Z",
    )
    app.include_router(canonical_router, prefix="/api")

    client = TestClient(app)

    # 1. Successful GET /canonical summary
    resp = client.get(f"/api/admin/colonies/{colony_id}/canonical")
    assert resp.status_code == 200
    data = resp.json()
    assert data["colony_id"] == colony_id
    assert data["dataset"]["is_active"] is True
    assert data["dataset"]["plots_count"] == 2

    resp_bundle = client.get(f"/api/admin/colonies/{colony_id}/canonical/bundle")
    assert resp_bundle.status_code == 200
    bundle = resp_bundle.json()
    assert bundle["pdf_overlay"]["url"].startswith("/api/v1/media/download?")
    assert bundle["pdf_overlay"]["bounds"] == [[27.0, 78.0], [27.002, 78.002]]
    assert bundle["legacy_import_source"]["filename"] == "layout.pdf"

    # 2. GET /canonical/plots paginated
    resp_plots = client.get(f"/api/admin/colonies/{colony_id}/canonical/plots?limit=1&skip=0")
    assert resp_plots.status_code == 200
    plots_data = resp_plots.json()
    assert len(plots_data["plots"]) == 1
    assert plots_data["total"] == 2

    # 3. GET /canonical/roads
    resp_roads = client.get(f"/api/admin/colonies/{colony_id}/canonical/roads")
    assert resp_roads.status_code == 200
    roads_data = resp_roads.json()
    assert len(roads_data["roads"]) >= 1

    # 4. POST /canonical/corrections
    plot_id = plots_data["plots"][0]["id"]
    corr_payload = {
        "dataset_version": data["dataset"]["version"],
        "entity_type": "Plot",
        "entity_id": plot_id,
        "field_name": "frontage_declared",
        "previous_value": 20.0,
        "corrected_value": 24.0,
        "reason": "Corrected from verified deed",
    }
    resp_corr = client.post(f"/api/admin/colonies/{colony_id}/canonical/corrections", json=corr_payload)
    assert resp_corr.status_code == 200

    # 5. GET /canonical/corrections audit log
    resp_corr_list = client.get(f"/api/admin/colonies/{colony_id}/canonical/corrections")
    assert resp_corr_list.status_code == 200
    assert len(resp_corr_list.json()["corrections"]) == 1

    # 6. GET /canonical/provenance/{entityId}
    resp_prov = client.get(f"/api/admin/colonies/{colony_id}/canonical/provenance/{plot_id}")
    assert resp_prov.status_code == 200
    prov_data = resp_prov.json()
    assert prov_data["entity_id"] == plot_id
    assert prov_data["source_document_id"] == "layout.pdf"

    # 7. Cross-project authorization check: unauthorized user
    current_user_holder["user"] = user_unauthorized
    resp_unauth = client.get(f"/api/admin/colonies/{colony_id}/canonical")
    assert resp_unauth.status_code == 404
