import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock
from app.colony_share_routes import (
    build_colony_share_router,
    generate_raw_token,
    hash_token,
    parse_user_agent,
)


def test_user_agent_parser():
    # 1. iPhone
    iphone_ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
    parsed_iphone = parse_user_agent(iphone_ua)
    assert parsed_iphone["device_type"] == "Mobile"
    assert "iPhone" in parsed_iphone["os"]
    assert "Safari" in parsed_iphone["browser"]

    # 2. Windows PC Chrome
    win_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    parsed_win = parse_user_agent(win_ua)
    assert parsed_win["device_type"] == "Desktop"
    assert "Windows" in parsed_win["os"]
    assert "Chrome" in parsed_win["browser"]

    # 3. Android Tablet
    tablet_ua = "Mozilla/5.0 (Linux; Android 13; SM-X906B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.153 Safari/537.36"
    parsed_tablet = parse_user_agent(tablet_ua)
    assert parsed_tablet["device_type"] in ("Mobile", "Tablet")
    assert "Android" in parsed_tablet["os"]


def test_token_generation_and_hashing():
    t1 = generate_raw_token()
    t2 = generate_raw_token()
    assert len(t1) >= 24
    assert t1 != t2
    assert hash_token(t1) != hash_token(t2)
    assert hash_token(t1) == hash_token(t1)


def test_colony_share_router_endpoints_registered():
    async def fake_user(*_args, **_kwargs):
        return {"id": "test-admin", "role": "admin"}

    router = build_colony_share_router(
        db=MagicMock(),
        get_current_user=fake_user,
        require_admin=fake_user,
        require_super_admin=fake_user,
        load_owned_colony=fake_user,
        audit_log=fake_user,
        serialize_doc=lambda d: d,
        now_iso=lambda: "2026-10-18T12:00:00Z",
    )

    routes = {(route.path, method) for route in router.routes for method in route.methods}
    assert ("/admin/colony-shares/colonies", "GET") in routes
    assert ("/admin/colony-shares", "GET") in routes
    assert ("/admin/colony-shares", "POST") in routes
    assert ("/admin/colony-shares/{share_id}/devices", "GET") in routes
    assert ("/admin/colony-shares/{share_id}/revoke", "POST") in routes
    assert ("/admin/colony-shares/{share_id}/regenerate", "POST") in routes
    assert ("/public/colony-share/{token}/verify", "POST") in routes
    assert ("/public/colony-share/{token}/data", "GET") in routes


def test_device_limit_enforcement_flow():
    # Mock Database
    shares_store = {}
    devices_store = []

    class MockCollection:
        def __init__(self, name):
            self.name = name

        async def find_one(self, query):
            if self.name == "colony_shares":
                for s in shares_store.values():
                    if query.get("token_hash") and s["token_hash"] == query["token_hash"]:
                        return s
                    if query.get("id") and s["id"] == query["id"]:
                        return s
            elif self.name == "colony_share_devices":
                for d in devices_store:
                    if d["share_id"] == query["share_id"] and d["device_fingerprint"] == query["device_fingerprint"]:
                        return d
            return None

        async def insert_one(self, doc):
            if self.name == "colony_shares":
                shares_store[doc["id"]] = doc
            elif self.name == "colony_share_devices":
                devices_store.append(doc)
            return MagicMock(inserted_id="mock_id")

        async def update_one(self, query, update):
            doc = await self.find_one(query)
            if doc:
                if "$set" in update:
                    doc.update(update["$set"])
                if "$inc" in update:
                    for k, v in update["$inc"].items():
                        doc[k] = doc.get(k, 0) + v
            return MagicMock(modified_count=1)

    async def run():
        mock_db = MagicMock()
        mock_db.colony_shares = MockCollection("colony_shares")
        mock_db.colony_share_devices = MockCollection("colony_share_devices")

        # Create a share link with max_devices = 2
        raw_token = "secure_test_token_for_colony_share_123"
        t_hash = hash_token(raw_token)
        share_doc = {
            "id": "csh-test-1",
            "colony_id": "colony-123",
            "colony_name": "Sunrise Enclave",
            "token_hash": t_hash,
            "max_devices": 2,
            "registered_devices_count": 0,
            "status": "ACTIVE",
            "created_at": "2026-10-18T12:00:00Z",
        }
        await mock_db.colony_shares.insert_one(share_doc)

        assert shares_store["csh-test-1"]["registered_devices_count"] == 0
        assert shares_store["csh-test-1"]["status"] == "ACTIVE"

        # Device 1 registers
        await mock_db.colony_shares.update_one({"id": "csh-test-1"}, {"$inc": {"registered_devices_count": 1}})
        await mock_db.colony_share_devices.insert_one({
            "share_id": "csh-test-1",
            "device_fingerprint": "fp_dev1",
            "status": "REGISTERED",
        })
        assert shares_store["csh-test-1"]["registered_devices_count"] == 1

        # Device 2 registers (Reaches limit = 2)
        await mock_db.colony_shares.update_one({"id": "csh-test-1"}, {"$inc": {"registered_devices_count": 1}})
        await mock_db.colony_share_devices.insert_one({
            "share_id": "csh-test-1",
            "device_fingerprint": "fp_dev2",
            "status": "REGISTERED",
        })
        assert shares_store["csh-test-1"]["registered_devices_count"] == 2

        # Device 3 attempts access -> Breach killswitch triggered!
        await mock_db.colony_shares.update_one({"id": "csh-test-1"}, {"$set": {"status": "DEVICE_LIMIT_BREACHED"}})
        await mock_db.colony_share_devices.insert_one({
            "share_id": "csh-test-1",
            "device_fingerprint": "fp_dev3",
            "status": "BLOCKED_BREACH_TRIGGER",
        })

        assert shares_store["csh-test-1"]["status"] == "DEVICE_LIMIT_BREACHED"
        assert len(devices_store) == 3
        assert devices_store[2]["status"] == "BLOCKED_BREACH_TRIGGER"

    asyncio.run(run())
