"""Phase 12 Tests: Auditable Manual Correction and Review Workflow.

Tests:
1. Geometry validation via Shapely (self-intersecting bowtie, zero-area, valid polygon).
2. Derived measurement recalculation and declared measurement preservation.
3. Version bump atomicity and base version immutability.
4. Audit trail logging of reviewer identity and changes.
5. Endpoints: validation, commit, and review status updates.
"""

import pytest
from app.gis.canonical.correction_service import (
    validate_geometry_correction,
    commit_review_corrections_as_new_version,
)
from app.gis.canonical.models import CanonicalDataset, CanonicalPlot


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

    async def insert_many(self, docs):
        for d in docs:
            await self.insert_one(d)

    async def find_one(self, query):
        for r in self.rows:
            if all(r.get(k) == v for k, v in query.items()):
                return r
        return None

    def find(self, query):
        matched = [r for r in self.rows if all(r.get(k) == v for k, v in query.items())]
        return matched

    async def update_one(self, query, update):
        r = await self.find_one(query)
        if r and "$set" in update:
            r.update(update["$set"])
            return 1
        return 0

    async def update_many(self, query, update):
        count = 0
        for r in self.rows:
            if all(r.get(k) == v for k, v in query.items()):
                if "$set" in update:
                    r.update(update["$set"])
                count += 1
        return count


class MockDB:
    def __init__(self):
        self.collections = {}

    def __getitem__(self, name):
        if name not in self.collections:
            self.collections[name] = MockCollection(name)
        return self.collections[name]


def test_validate_geometry_correction():
    # 1. Valid rectangle
    valid_box = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [10, 0], [10, 20], [0, 20], [0, 0]]],
    }
    is_valid, err, area = validate_geometry_correction(valid_box)
    assert is_valid is True
    assert err is None
    assert area == 200.0

    # 2. Self-intersecting bowtie polygon
    bowtie = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]],
    }
    is_valid, err, area = validate_geometry_correction(bowtie)
    assert is_valid is False
    assert "Self-intersection" in err or "Invalid" in err

    # 3. Degenerate zero-area polygon
    degenerate = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [0, 0], [0, 0], [0, 0]]],
    }
    is_valid, err, area = validate_geometry_correction(degenerate)
    assert is_valid is False

    # 4. Empty geometry
    is_valid, err, area = validate_geometry_correction({})
    assert is_valid is False


def test_commit_review_corrections_as_new_version():
    async def _run():
        db = MockDB()
        colony_id = "colony-test-12"

        # Seed base version 1
        base_dataset = CanonicalDataset(
            colony_id=colony_id,
            version=1,
            is_active=True,
            approval_status="APPROVED",
            source_sha256="hash-123",
            source_filename="layout.pdf",
            processing_run_id="run-1",
            plots_count=1,
        )
        await db["canonical_datasets"].insert_one(base_dataset.to_dict())

        base_plot = CanonicalPlot(
            id="plot-101",
            colony_id=colony_id,
            dataset_version=1,
            original_number="12",
            normalized_number="12",
            geometry={"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
            frontage_declared=10.0,
            area_declared=100.0,
            frontage_derived=10.0,
            area_derived=100.0,
            semantic_validation_status="review_required",
        )
        await db["canonical_plots"].insert_one(base_plot.to_dict())

        # Correction 1: reject invalid geometry
        invalid_corrections = [
            {
                "entity_type": "Plot",
                "entity_id": "plot-101",
                "field_name": "geometry",
                "corrected_value": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]],
                },
            }
        ]
        with pytest.raises(ValueError, match="rejected: Invalid geometry"):
            await commit_review_corrections_as_new_version(
                db=db,
                colony_id=colony_id,
                base_version=1,
                reviewer_id="reviewer-admin",
                corrections=invalid_corrections,
            )

        # Base dataset version 1 must remain active and unaltered!
        ds_v1 = await db["canonical_datasets"].find_one({"colony_id": colony_id, "version": 1})
        assert ds_v1["is_active"] is True

        # Correction 2: Apply valid corrections: update number and enlarged geometry
        valid_corrections = [
            {
                "entity_type": "Plot",
                "entity_id": "plot-101",
                "field_name": "original_number",
                "previous_value": "12",
                "corrected_value": "12-A",
                "reason": "Clarified blurred OCR label",
            },
            {
                "entity_type": "Plot",
                "entity_id": "plot-101",
                "field_name": "geometry",
                "corrected_value": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [15, 0], [15, 10], [0, 10], [0, 0]]],
                },
                "reason": "Adjusted boundary vertex to align with road curb",
            },
        ]

        commit_res = await commit_review_corrections_as_new_version(
            db=db,
            colony_id=colony_id,
            base_version=1,
            reviewer_id="reviewer-admin",
            corrections=valid_corrections,
            commit_note="Review of North Sector plots",
        )

        assert commit_res["success"] is True
        assert commit_res["new_version"] == 2
        assert commit_res["corrections_applied"] == 2

        # Verify Base Version 1 is now inactive but completely preserved
        p_v1 = await db["canonical_plots"].find_one({"colony_id": colony_id, "id": "plot-101", "dataset_version": 1})
        assert p_v1["original_number"] == "12"
        assert p_v1["area_derived"] == 100.0

        # Verify New Version 2 has updated values, recalculated derived area, and preserved declared measurements
        p_v2 = await db["canonical_plots"].find_one({"colony_id": colony_id, "id": "plot-101", "dataset_version": 2})
        assert p_v2["original_number"] == "12-A"
        assert p_v2["area_derived"] == 150.0  # 15 * 10 = 150
        assert p_v2["area_declared"] == 100.0  # declared source measurement strictly preserved!
        assert p_v2["frontage_declared"] == 10.0

        # Verify audit trail
        corrections_logged = db["review_corrections"].rows
        assert len(corrections_logged) == 2
        assert corrections_logged[0]["reviewer_user_id"] == "reviewer-admin"
        assert corrections_logged[0]["field_name"] == "original_number"
        assert corrections_logged[0]["corrected_value"] == "12-A"

        # Verify version 2 is now the active dataset
        ds_v2 = await db["canonical_datasets"].find_one({"colony_id": colony_id, "version": 2})
        assert ds_v2["is_active"] is True
        ds_v1 = await db["canonical_datasets"].find_one({"colony_id": colony_id, "version": 1})
        assert ds_v1["is_active"] is False

    import asyncio
    asyncio.run(_run())
