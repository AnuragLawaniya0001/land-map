import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch, MagicMock
from bson import ObjectId

from app.server import app, get_current_user

client = TestClient(app)

def mock_superadmin_user():
    return {
        "id": "6ac24af743425c1a3f0d28d9",
        "email": "superadmin@livemap.local",
        "role": "super_admin",
        "name": "Super Admin",
    }

def test_admin_get_colony_map_endpoint():
    app.dependency_overrides[get_current_user] = mock_superadmin_user
    fake_cid = "507f1f77bcf86cd799439011"
    fake_colony = {
        "_id": ObjectId(fake_cid),
        "id": fake_cid,
        "name": "RDS Test Colony",
        "slug": "rds-test",
        "boundary": {"type": "Polygon", "coordinates": [[[78.24, 27.23], [78.25, 27.23], [78.25, 27.24], [78.24, 27.24], [78.24, 27.23]]]},
        "map_center": {"lat": 27.235, "lng": 78.245},
    }

    mock_db = MagicMock()
    mock_db.colonies.find_one = AsyncMock(return_value=fake_colony)
    
    mock_cursor = MagicMock()
    mock_cursor.to_list = AsyncMock(return_value=[])
    mock_cursor.sort.return_value.to_list = AsyncMock(return_value=[
        {"_id": ObjectId(), "id": "available", "name": "Available", "sort_order": 1}
    ])
    
    mock_db.zones.find.return_value = mock_cursor
    mock_db.plots.find.return_value = mock_cursor
    mock_db.statuses.find.return_value = mock_cursor
    mock_db.registry.count_documents = AsyncMock(return_value=0)

    with patch("app.server.load_owned_colony", AsyncMock(return_value=fake_colony)), \
         patch("app.server.DB", mock_db):

        response = client.get(f"/api/admin/colonies/{fake_cid}")
        assert response.status_code == 200
        res_data = response.json()
        assert "colony" in res_data
        assert res_data["colony"]["name"] == "RDS Test Colony"
        assert res_data["plots"] == []
        assert len(res_data["statuses"]) >= 1

        # Test GeoJSON route
        geojson_resp = client.get(f"/api/admin/colonies/{fake_cid}/geojson")
        assert geojson_resp.status_code == 200
        geo_data = geojson_resp.json()
        assert geo_data["type"] == "FeatureCollection"

    app.dependency_overrides.clear()
