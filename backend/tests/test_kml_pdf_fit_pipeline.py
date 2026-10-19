import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch, MagicMock
from bson import ObjectId
import json

from app.server import app, get_current_user
from app.gis.pdf_fitter import extract_pdf_content_bbox, compute_auto_fit_transform
from app.gis.vector_import import _kml_features, import_kml_boundary, VectorImportError

client = TestClient(app)

KML_SIMPLE_RECT = b"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Site Boundary</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              78.24,27.23,0 78.25,27.23,0 78.25,27.24,0 78.24,27.24,0 78.24,27.23,0
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>"""

KML_IRREGULAR_L_SHAPE = b"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.google.com/kml/2.0">
  <Document>
    <Placemark>
      <name>Irregular L-Shape Boundary</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              78.240,27.230 78.250,27.230 78.250,27.235 78.245,27.235 78.245,27.240 78.240,27.240 78.240,27.230
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>"""

KML_INVALID_XML = b"""<kml><Placemark><Polygon><coordinates>invalid data</coordinates></Polygon></Placemark>"""

def mock_admin_user():
    return {
        "id": "6ac24af743425c1a3f0d28d9",
        "email": "superadmin@livemap.local",
        "role": "super_admin",
        "name": "Super Admin",
    }


def test_kml_parsing_simple_rect():
    features, crs = _kml_features(KML_SIMPLE_RECT)
    assert len(features) == 1
    geom = features[0]["geometry"]
    assert geom["type"] == "Polygon"
    assert len(geom["coordinates"][0]) == 5
    assert geom["coordinates"][0][0] == [78.24, 27.23]


def test_kml_parsing_irregular_l_shape():
    features, crs = _kml_features(KML_IRREGULAR_L_SHAPE)
    assert len(features) == 1
    geom = features[0]["geometry"]
    assert geom["type"] == "Polygon"
    assert len(geom["coordinates"][0]) == 7


def test_kml_invalid_geometry_rejection():
    with pytest.raises(VectorImportError):
        _kml_features(KML_INVALID_XML)


def test_auto_fit_transform_calculation():
    kml_boundary = {
        "type": "Polygon",
        "coordinates": [[[78.24, 27.23], [78.25, 27.23], [78.25, 27.24], [78.24, 27.24], [78.24, 27.23]]]
    }
    pdf_bbox = {
        "min_x": 50.0,
        "min_y": 50.0,
        "max_x": 550.0,
        "max_y": 750.0,
        "width": 500.0,
        "height": 700.0,
        "page_width": 600.0,
        "page_height": 800.0,
    }
    result = compute_auto_fit_transform(kml_boundary, pdf_bbox)
    assert "transform" in result
    t = result["transform"]
    assert t["auto_scale"] > 0
    assert t["rotation"] == 0.0
    assert t["translation_x"] != 0.0
    assert t["translation_y"] != 0.0
    assert result["placement_status"] == "auto_fitted"


def test_auto_fit_transform_irregular_boundary_uses_safe_anchor():
    kml_boundary = {
        "type": "Polygon",
        "coordinates": [[[78.240, 27.230], [78.250, 27.230], [78.250, 27.235], [78.245, 27.235], [78.245, 27.240], [78.240, 27.240], [78.240, 27.230]]]
    }
    pdf_bbox = {
        "min_x": 10.0,
        "min_y": 20.0,
        "max_x": 260.0,
        "max_y": 320.0,
        "width": 250.0,
        "height": 300.0,
        "page_width": 300.0,
        "page_height": 400.0,
    }
    result = compute_auto_fit_transform(kml_boundary, pdf_bbox)
    t = result["transform"]
    assert t["auto_scale"] > 0
    assert abs(t["translation_x"]) > 0.0
    assert abs(t["translation_y"]) > 0.0
    assert result["placement_status"] == "auto_fitted"


def test_placement_update_endpoint():
    app.dependency_overrides[get_current_user] = mock_admin_user
    fake_cid = "507f1f77bcf86cd799439011"
    fake_colony = {
        "_id": ObjectId(fake_cid),
        "id": fake_cid,
        "name": "Placement Test Colony",
        "boundary": {"type": "Polygon", "coordinates": [[[78.24, 27.23], [78.25, 27.23], [78.25, 27.24], [78.24, 27.24], [78.24, 27.23]]]},
        "placement": {
            "content_bbox": {"width": 500, "height": 700},
            "transform": {"translation_x": 0.0, "translation_y": 0.0, "rotation": 0.0, "auto_scale": 0.0001},
            "placement_status": "auto_fitted",
        }
    }

    mock_db = MagicMock()
    mock_db.colonies.find_one = AsyncMock(return_value=fake_colony)
    mock_db.colonies.update_one = AsyncMock(return_value=None)
    mock_db.audit_logs.insert_one = AsyncMock(return_value=None)

    with patch("app.server.load_owned_colony", AsyncMock(return_value=fake_colony)), \
         patch("app.server.DB", mock_db):

        payload = {
            "translation_x": 0.0002,
            "translation_y": -0.0001,
            "rotation": 15.0,
            "placement_status": "confirmed"
        }
        res = client.patch(f"/api/admin/colonies/{fake_cid}/placement", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        t = data["placement"]["transform"]
        assert t["rotation"] == 15.0
        assert t["translation_x"] == 0.0002
        assert data["placement"]["placement_status"] == "confirmed"

        # Test Reset Endpoint
        reset_res = client.post(f"/api/admin/colonies/{fake_cid}/placement/reset")
        assert reset_res.status_code == 200
        reset_data = reset_res.json()
        assert reset_data["status"] == "ok"
        assert reset_data["placement"]["placement_status"] == "auto_fitted"

    app.dependency_overrides.clear()
