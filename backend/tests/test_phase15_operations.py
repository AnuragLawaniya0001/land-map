"""Phase 15 Tests: Production Health Check, Indexing, and Operations.

Tests:
1. Deep health check service inspecting real dependencies (database ping, disk, GIS modules).
2. Database compound index initialization.
3. Degraded dependency failure handling.
"""

import asyncio
import pytest

from app.gis.canonical.health_service import check_system_health
from app.gis.canonical.init_db_indexes import init_canonical_indexes, INDEX_SPECIFICATIONS


class MockCommandDB:
    def __init__(self, should_fail=False):
        self.should_fail = should_fail
        self.indexes_created = {}

    async def command(self, cmd):
        if self.should_fail:
            raise ConnectionError("MongoDB connection refused")
        if cmd == "ping":
            return {"ok": 1.0}
        return {}

    def __getitem__(self, name):
        if name not in self.indexes_created:
            self.indexes_created[name] = []
        return MockCollection(name, self.indexes_created[name])


class MockCollection:
    def __init__(self, name, record_list):
        self.name = name
        self.record_list = record_list

    async def create_index(self, keys, unique=False):
        self.record_list.append({"keys": keys, "unique": unique})
        return f"idx_{self.name}"


def test_health_check_healthy_system():
    async def _run():
        db = MockCommandDB(should_fail=False)
        report = await check_system_health(db)

        assert report["status"] == "HEALTHY"
        assert report["latency_ms"] >= 0
        assert "checks" in report

        # Database check
        db_check = report["checks"]["database"]
        assert db_check["status"] == "UP"
        assert db_check["engine"] == "MongoDB"

        # Storage check
        storage_check = report["checks"]["storage"]
        assert storage_check["status"] == "UP"
        assert storage_check["free_gb"] > 0

        # GIS Pipeline readiness
        gis_check = report["checks"]["gis_pipeline"]
        assert gis_check["status"] == "READY"
        assert "shapely" in gis_check["modules"]
        assert "ezdxf" in gis_check["modules"]

    asyncio.run(_run())


def test_health_check_database_down():
    async def _run():
        db = MockCommandDB(should_fail=True)
        report = await check_system_health(db)

        assert report["status"] == "UNHEALTHY"
        assert report["checks"]["database"]["status"] == "DOWN"
        assert "error" in report["checks"]["database"]

    asyncio.run(_run())


def test_init_canonical_indexes():
    async def _run():
        db = MockCommandDB()
        counts = await init_canonical_indexes(db)

        assert "canonical_plots" in counts
        assert counts["canonical_plots"] == len(INDEX_SPECIFICATIONS["canonical_plots"])
        assert "canonical_datasets" in counts
        assert counts["canonical_datasets"] == len(INDEX_SPECIFICATIONS["canonical_datasets"])

        # Check unique constraints
        plot_indexes = db.indexes_created["canonical_plots"]
        unique_id_idx = next(i for i in plot_indexes if i["keys"] == [("colony_id", 1), ("dataset_version", 1), ("id", 1)])
        assert unique_id_idx["unique"] is True

    asyncio.run(_run())
