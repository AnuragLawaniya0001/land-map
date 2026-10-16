from copy import deepcopy

from bson import ObjectId
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.owner_routes import build_owner_router


class Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def sort(self, key, direction=1):
        self.rows.sort(key=lambda row: row.get(key) or "", reverse=direction < 0)
        return self

    def limit(self, value):
        self.rows = self.rows[:value]
        return self

    def skip(self, value):
        self.rows = self.rows[value:]
        return self

    async def to_list(self, length=None):
        return self.rows if length is None else self.rows[:length]

    def __aiter__(self):
        self._iter = iter(self.rows)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


def matches(row, query):
    for key, expected in query.items():
        actual = row.get(key)
        if isinstance(expected, dict) and "$in" in expected:
            if actual not in expected["$in"]:
                return False
        elif actual != expected:
            return False
    return True


class Collection:
    def __init__(self, rows=()):
        self.rows = [deepcopy(row) for row in rows]

    async def count_documents(self, query):
        return sum(matches(row, query) for row in self.rows)

    def find(self, query, projection=None):
        rows = [row for row in self.rows if matches(row, query)]
        if projection and projection.get("_id") == 1:
            rows = [{"_id": row["_id"]} for row in rows]
        return Cursor(rows)

    async def find_one(self, query):
        return next((row for row in self.rows if matches(row, query)), None)

    async def update_one(self, query, update):
        row = await self.find_one(query)
        if row:
            row.update(update["$set"])

    async def insert_one(self, document):
        self.rows.append(deepcopy(document))


class Database(dict):
    def __getitem__(self, name):
        return super().setdefault(name, Collection())


def serialize_doc(doc):
    result = dict(doc)
    if "_id" in result:
        result["id"] = str(result.pop("_id"))
    result.pop("content", None)
    result.pop("storage_key", None)
    return result


def serialize_user(doc):
    if not doc:
        return None
    return {
        "id": str(doc.get("_id", doc.get("id"))),
        "name": doc.get("name"),
        "email": doc.get("email"),
        "role": doc.get("role"),
        "active": doc.get("active"),
    }


OWNER = {
    "id": str(ObjectId()),
    "name": "Platform Owner",
    "role": "super_admin",
}


def make_client(db, user=OWNER):
    async def require_super_admin():
        if user["role"] != "super_admin":
            raise HTTPException(403, "Super admin access required")
        return user

    app = FastAPI()
    app.include_router(
        build_owner_router(db, require_super_admin, serialize_doc, serialize_user)
    )
    return TestClient(app)


def test_owner_dashboard_preserves_aggregate_response_shape():
    db = Database(
        {
            "users": Collection([{"_id": ObjectId(), "role": "admin"}]),
            "colonies": Collection([{"_id": ObjectId()}]),
            "plots": Collection(
                [
                    {"_id": ObjectId(), "status_id": "available"},
                    {"_id": ObjectId(), "status_id": "sold"},
                    {"_id": ObjectId()},
                ]
            ),
            "statuses": Collection(
                [{"_id": ObjectId(), "id": "available", "sort_order": 1}]
            ),
            "property_inquiries": Collection(
                [
                    {"status": "NEW"},
                    {"status": "CONTACTED"},
                    {"status": "CLOSED"},
                    {"status": "SPAM"},
                ]
            ),
            "property_shares": Collection(
                [
                    {"status": "ACTIVE", "revoked_at": None},
                    {"status": "ACTIVE", "revoked_at": "x"},
                ]
            ),
            "registry": Collection([{"_id": ObjectId()}]),
            "property_media": Collection([{"_id": ObjectId()}]),
            "audit_logs": Collection([{"_id": ObjectId(), "created_at": "2026-01-01"}]),
        }
    )

    response = make_client(db).get("/owner/dashboard")

    assert response.status_code == 200
    data = response.json()
    assert data["totals"] == {
        "admins": 1,
        "colonies": 1,
        "plots": 3,
        "registry_docs": 1,
        "media_total": 1,
    }
    assert data["status_counts"] == {"available": 2, "sold": 1}
    assert data["inquiries"] == {
        "total": 3,
        "totalInquiries": 3,
        "new": 1,
        "newInquiries": 1,
        "contacted": 1,
        "contactedInquiries": 1,
        "closed": 1,
        "closedInquiries": 1,
    }
    assert data["shares"] == {"active": 1, "total": 2}


def test_plot_inspection_checks_parent_and_never_exposes_sensitive_keys():
    owner_id, colony_id, plot_id = ObjectId(), ObjectId(), ObjectId()
    db = Database(
        {
            "plots": Collection(
                [{"_id": plot_id, "colony_id": str(colony_id), "content": "bytes"}]
            ),
            "colonies": Collection(
                [
                    {
                        "_id": colony_id,
                        "name": "North",
                        "slug": "north",
                        "owner_id": str(owner_id),
                    }
                ]
            ),
            "users": Collection([{"_id": owner_id, "name": "Admin", "role": "admin"}]),
            "registry": Collection(
                [
                    {
                        "_id": ObjectId(),
                        "plot_id": str(plot_id),
                        "storage_key": "private-key",
                    }
                ]
            ),
            "property_media": Collection(
                [
                    {
                        "_id": ObjectId(),
                        "plot_id": str(plot_id),
                        "title": "Front",
                        "storage_key": "private-key",
                    }
                ]
            ),
            "property_shares": Collection(
                [
                    {
                        "_id": ObjectId(),
                        "plot_id": str(plot_id),
                        "token": "private-token",
                        "status": "ACTIVE",
                    }
                ]
            ),
        }
    )

    response = make_client(db).get(f"/owner/inspection/plots/{plot_id}")

    assert response.status_code == 200
    data = response.json()
    assert data["registry"]["has_file"] is True
    assert "storage_key" not in data["registry"]
    assert data["media"] == [
        {
            "id": data["media"][0]["id"],
            "title": "Front",
            "is_primary": False,
            "created_at": None,
        }
    ]
    assert data["shares"][0]["status"] == "ACTIVE"
    assert "token" not in data["shares"][0]
    assert "content" not in data["plot"]

    db["colonies"].rows.clear()
    missing_parent = make_client(db).get(f"/owner/inspection/plots/{plot_id}")
    assert missing_parent.status_code == 404
    assert missing_parent.json() == {"detail": "Plot not found"}


def test_status_update_validates_and_audits_admin_change():
    admin_id = ObjectId()
    user = dict(OWNER, id=str(ObjectId()))
    db = Database(
        {
            "users": Collection(
                [
                    {
                        "_id": admin_id,
                        "name": "Tenant",
                        "email": "tenant@example.test",
                        "role": "admin",
                    }
                ]
            ),
            "audit_logs": Collection(),
        }
    )
    client = make_client(db, user)

    invalid = client.patch(f"/owner/admins/{admin_id}/status", json={"active": "false"})
    assert invalid.status_code == 400
    assert invalid.json() == {"detail": "Field 'active' boolean required"}

    response = client.patch(f"/owner/admins/{admin_id}/status", json={"active": False})
    assert response.status_code == 200
    assert response.json()["active"] is False
    assert db["audit_logs"].rows[0]["action"] == "ADMIN_DEACTIVATED"
    assert db["audit_logs"].rows[0]["metadata"] == {
        "target_email": "tenant@example.test",
        "active": False,
    }


def test_owner_router_enforces_super_admin_dependency():
    db = Database()
    client = make_client(db, {"id": str(ObjectId()), "role": "admin"})

    assert client.get("/owner/admins").status_code == 403
