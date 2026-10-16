from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import struct

import pymupdf
import pytest
from bson import ObjectId
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pyproj import Transformer
from shapely import to_wkb
from shapely.geometry import Polygon

from app.gis_import_routes import build_gis_import_router
from app.gis.importer import _extract_pdf
import app.gis.importer as importer_module
from app.gis.vector_import import VectorImportError, extract_pdf_boundary, import_vector


class Collection:
    def __init__(self, rows=()):
        self.rows = [deepcopy(row) for row in rows]

    async def find_one(self, query):
        return next((row for row in self.rows if all(row.get(k) == v for k, v in query.items())), None)

    async def insert_one(self, document):
        self.rows.append(deepcopy(document))

    async def insert_many(self, documents):
        self.rows.extend(deepcopy(documents))

    async def update_one(self, query, update):
        row = await self.find_one(query)
        if row:
            row.update(deepcopy(update["$set"]))

    async def count_documents(self, query):
        return sum(all(row.get(k) == v for k, v in query.items()) for row in self.rows)


class Database(dict):
    def __getitem__(self, name):
        return super().setdefault(name, Collection())


USER = {"id": str(ObjectId()), "role": "admin"}
COLONY_ID = ObjectId()
COLONY = {"_id": COLONY_ID, "owner_id": USER["id"]}


class Importer:
    class ImportError_(Exception):
        pass

    calls = []

    @classmethod
    def import_file(cls, **kwargs):
        cls.calls.append(kwargs)
        return (
            {
                "boundary": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
                "map_center": [0.5, 0.5],
                "import_source": {},
            },
            [],
            [{"number": "1", "geometry": {"type": "Polygon", "coordinates": []}}],
            [],
        )


class Roads:
    @staticmethod
    def entrance_fields(boundary, plots):
        return {}


def make_client(colony_override=None, selected_importer=Importer):
    Importer.calls.clear()
    db = Database()
    colony = deepcopy(colony_override or COLONY)
    db["colonies"].rows.append(colony)
    audits = []

    async def require_admin():
        return USER

    async def load_owned_colony(colony_id, user):
        if colony_id not in (str(COLONY_ID), COLONY_ID):
            raise HTTPException(404, "Colony not found")
        return colony

    async def audit_log(*args, **kwargs):
        audits.append((args, kwargs))

    app = FastAPI()
    app.include_router(
        build_gis_import_router(
            db,
            require_admin,
            load_owned_colony,
            audit_log,
            lambda: "2026-10-08T12:00:00+00:00",
            selected_importer,
            Roads,
        ),
        prefix="/api",
    )
    return TestClient(app), db, audits


def test_full_import_preview_validate_commit_flow():
    client, db, audits = make_client()
    uploaded = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        files={"cad_file": ("drawing.dxf", b"dxf", "application/dxf")},
    )
    assert uploaded.status_code == 201
    created = uploaded.json()
    assert created["status"] == "PREVIEW_READY"
    assert created["stats"] == {
        "plots_count": 1,
        "zones_count": 0,
        "greens_count": 0,
        "roads_count": 0,
    }
    assert Importer.calls[0]["filename"] == "drawing.dxf"
    assert Importer.calls[0]["colony_id"] == str(COLONY_ID)

    fetched = client.get(f"/api/admin/gis-imports/{created['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["preview_data"]["plots"][0]["number"] == "1"

    validated = client.post(f"/api/admin/gis-imports/{created['id']}/validate")
    assert validated.status_code == 200
    assert validated.json()["status"] == "VALIDATED"

    committed = client.post(f"/api/admin/gis-imports/{created['id']}/commit")
    assert committed.status_code == 200
    assert committed.json()["summary"] == {
        "plots_inserted": 1,
        "zones_inserted": 0,
        "plots_updated": 0,
        "zones_updated": 0,
    }
    assert len(db["plots"].rows) == 1
    assert db["colonies"].rows[0]["entry_checked"] is True

    db["plots"].rows[0]["status_id"] = "reserved"
    repeated = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        files={"cad_file": ("drawing.dxf", b"dxf", "application/dxf")},
    )
    assert repeated.status_code == 201
    repeated_id = repeated.json()["id"]
    assert client.post(f"/api/admin/gis-imports/{repeated_id}/validate").status_code == 200
    recommitted = client.post(f"/api/admin/gis-imports/{repeated_id}/commit")
    assert recommitted.status_code == 200
    assert recommitted.json()["summary"]["plots_inserted"] == 0
    assert recommitted.json()["summary"]["plots_updated"] == 1
    assert len(db["plots"].rows) == 1
    assert db["plots"].rows[0]["status_id"] == "reserved"
    assert [entry[0][1] for entry in audits] == [
        "GIS_IMPORT_CREATED",
        "GIS_IMPORT_COMMITTED",
        "GIS_IMPORT_CREATED",
        "GIS_IMPORT_COMMITTED",
    ]


def test_cancel_and_calibration_endpoint_statuses():
    client, db, _ = make_client()
    import_id = ObjectId()
    db["gis_imports"].rows.append(
        {
            "_id": import_id,
            "colony_id": str(COLONY_ID),
            "status": "PREVIEW_READY",
            "validation": {"is_valid": False},
        }
    )
    cancelled = client.post(f"/api/admin/gis-imports/{import_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"
    calibrated = client.post(f"/api/admin/gis-imports/{import_id}/calibrate")
    assert calibrated.status_code == 501


def test_geojson_fixture_converts_tagged_features_to_preview():
    client, _, _ = make_client()
    fixture = Path(__file__).parent / "fixtures" / "qgis_import.geojson"
    response = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        data={"import_mode": "qgis", "maps_link": "https://maps.google.com/?q=27,78"},
        files={"file": ("site.geojson", fixture.read_bytes(), "application/geo+json")},
    )
    assert response.status_code == 201, response.text
    preview_id = response.json()["id"]
    fetched = client.get(f"/api/admin/gis-imports/{preview_id}").json()["preview_data"]
    assert fetched["stats"] == {
        "plots_count": 2,
        "zones_count": 1,
        "greens_count": 1,
        "roads_count": 1,
    }
    assert {plot["number"] for plot in fetched["plots"]} == {"A1", "A2"}
    assert all(plot["area_sqm"] > 0 and plot["zone_id"] == f"zone-{COLONY_ID}-a" for plot in fetched["plots"])
    assert fetched["plots"][1]["geometry"]["type"] == "MultiPolygon"
    assert fetched["fields"]["boundary"]["type"] == "Polygon"
    assert fetched["fields"]["greens"][0]["name"] == "Garden"
    assert fetched["fields"]["roads"][0]["name"] == "Main Road"
    assert fetched["fields"]["maps_link"].endswith("q=27,78")


def test_geojson_source_crs_is_transformed_to_wgs84():
    project = Transformer.from_crs(4326, 3857, always_xy=True).transform

    def polygon(bounds):
        west, south, east, north = bounds
        ring = [
            project(west, south), project(east, south), project(east, north),
            project(west, north), project(west, south),
        ]
        return {"type": "Polygon", "coordinates": [ring]}

    payload = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "EPSG:3857"}},
        "features": [
            {
                "type": "Feature",
                "properties": {"feature_type": "site_boundary"},
                "geometry": polygon((78, 27, 78.002, 27.002)),
            },
            {
                "type": "Feature",
                "properties": {"feature_type": "plot_polygon", "plot_number": "B1", "status": "sold"},
                "geometry": polygon((78.0002, 27.0002, 78.0008, 27.0008)),
            },
        ],
    }
    fields, zones, plots, _ = import_vector(
        json.dumps(payload).encode(), "projected.geojson", str(COLONY_ID), "2026-10-08T00:00:00Z"
    )
    assert abs(fields["map_center"]["lng"] - 78.001) < 0.0001
    assert abs(fields["map_center"]["lat"] - 27.001) < 0.0001
    assert plots[0]["area_sqm"] > 0
    assert plots[0]["status_id"] == "available"
    assert zones[0]["code"] == "B"


def test_kml_only_upload_creates_boundary_preview_and_validation_requires_plots():
    client, _, _ = make_client()
    kml = b"""<kml><Placemark><name>Site boundary</name><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>78,27 78.002,27 78.002,27.002 78,27.002 78,27</coordinates></LinearRing></outerBoundaryIs>
    </Polygon></Placemark></kml>"""
    created = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        files={"cad_file": ("boundary.kml", kml, "application/vnd.google-earth.kml+xml")},
    )
    assert created.status_code == 201, created.text
    preview_id = created.json()["id"]
    preview = client.get(f"/api/admin/gis-imports/{preview_id}").json()["preview_data"]
    assert preview["fields"]["boundary"]["type"] == "Polygon"
    assert preview["plots"] == []
    assert preview["warnings"]
    validated = client.post(f"/api/admin/gis-imports/{preview_id}/validate")
    assert validated.status_code == 200
    assert validated.json()["status"] == "CALIBRATION_REQUIRED"


def test_geopackage_import_reads_features_using_sqlite_and_shapely():
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE gpkg_contents (
          table_name TEXT NOT NULL, data_type TEXT NOT NULL, identifier TEXT,
          description TEXT DEFAULT '', last_change DATETIME NOT NULL,
          min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER
        );
        CREATE TABLE gpkg_geometry_columns (
          table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
          srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL
        );
        CREATE TABLE polygons (fid INTEGER PRIMARY KEY, geom BLOB, feature_type TEXT, plot_number TEXT);
        INSERT INTO gpkg_contents (table_name, data_type, identifier, last_change, srs_id)
          VALUES ('polygons', 'features', 'polygons', '2026-01-01T00:00:00Z', 4326);
        INSERT INTO gpkg_geometry_columns VALUES ('polygons', 'geom', 'POLYGON', 4326, 0, 0);
        """
    )
    geometries = [
        ("site_boundary", None, Polygon([(78, 27), (78.002, 27), (78.002, 27.002), (78, 27.002), (78, 27)])),
        ("plot_polygon", "C1", Polygon([(78.0002, 27.0002), (78.0008, 27.0002), (78.0008, 27.0008), (78.0002, 27.0008), (78.0002, 27.0002)])),
    ]
    for feature_type, number, polygon in geometries:
        wkb = to_wkb(polygon, byte_order=1)
        gpkg_blob = b"GP\x00\x01" + struct.pack("<i", 4326) + wkb
        connection.execute(
            "INSERT INTO polygons (geom, feature_type, plot_number) VALUES (?, ?, ?)",
            (gpkg_blob, feature_type, number),
        )
    data = connection.serialize()
    connection.close()

    client, _, _ = make_client()
    response = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        data={"import_mode": "qgis"},
        files={"file": ("site.gpkg", data, "application/geopackage+sqlite3")},
    )
    assert response.status_code == 201, response.text
    preview = client.get(f"/api/admin/gis-imports/{response.json()['id']}").json()["preview_data"]
    assert preview["stats"]["plots_count"] == 1
    assert preview["plots"][0]["number"] == "C1"


def test_pdf_kml_pair_skips_registration_and_creates_boundary_clipped_overlay(monkeypatch):
    monkeypatch.setattr("app.gis_import_routes.put_object", lambda *args, **kwargs: {})
    monkeypatch.setattr(Importer, "extract_pdf_plot_numbers", lambda data: ["1"], raising=False)
    pdf = pymupdf.open()
    page = pdf.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(10, 10, 90, 90), color=(0, 0, 0))
    pdf_bytes = pdf.tobytes()
    pdf.close()
    client, _, _ = make_client()
    response = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        data={"import_mode": "pdf_pair"},
        files=[
            ("layout_pdf", ("layout.pdf", pdf_bytes, "application/pdf")),
            (
                "cad_file",
                (
                    "boundary.kml",
                    b"<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>1,2 3,2 3,4 1,4 1,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>",
                    "application/vnd.google-earth.kml+xml",
                ),
            ),
        ],
    )
    assert response.status_code == 201
    assert Importer.calls == []
    preview = client.get(f"/api/admin/gis-imports/{response.json()['id']}").json()["preview_data"]
    assert preview["pdf_overlay"]["url"].startswith("/api/v1/media/download?")
    assert preview["pdf_overlay"]["bounds"] == [[2.0, 1.0], [4.0, 3.0]]
    assert preview["stats"]["plots_count"] == 1
    assert preview["stats"]["detected_pdf_labels"] == 1
    assert preview["stats"]["saved_plot_records"] == 0
    assert preview["pdf_overlay"]["plot_count"] == 1
    assert preview["fields"]["import_source"]["mode"] == "pdf_overlay_only"
    assert preview["fields"]["import_source"]["pdf_plot_numbers"] == ["1"]
    assert preview["plots"] == []
    assert preview["pdf_overlay"]["fit"]["fit_mode"] == "quadrilateral_homography"
    assert preview["pdf_overlay"]["fit"]["boundary_selection"]["source"] == "uploaded_kml"
    assert preview["pdf_overlay"]["fit"]["boundary_selection"]["selection"]["candidate_boundaries_count"] == 1
    assert len(preview["pdf_overlay"]["fit"]["boundary_selection"]["kml_sha256"]) == 64


def test_pdf_kml_pair_previews_verified_vector_plot_records(monkeypatch):
    monkeypatch.setattr("app.gis_import_routes.put_object", lambda *args, **kwargs: {})
    monkeypatch.setattr(
        "app.gis_import_routes.render_pdf_overlay_images",
        lambda *args, **kwargs: (
            b"png",
            b"base",
            [[27.22, 78.253], [27.221, 78.254]],
            {"fit_mode": "test", "warnings": []},
            [],
        ),
    )
    fixture = Path(__file__).parent / "fixtures" / "layout_scaled.pdf"
    kml = b"""<kml><Placemark><name>Site Boundary</name><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>
        78.253,27.22 78.254,27.22 78.254,27.221 78.253,27.221 78.253,27.22
      </coordinates></LinearRing></outerBoundaryIs>
    </Polygon></Placemark></kml>"""
    client, _, _ = make_client(selected_importer=importer_module)

    response = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        data={"import_mode": "pdf_pair"},
        files=[
            ("layout_pdf", ("layout_scaled.pdf", fixture.read_bytes(), "application/pdf")),
            ("cad_file", ("boundary.kml", kml, "application/vnd.google-earth.kml+xml")),
        ],
    )

    assert response.status_code == 201, response.text
    preview = client.get(
        f"/api/admin/gis-imports/{response.json()['id']}"
    ).json()["preview_data"]
    assert len(preview["plots"]) == 64
    assert len({plot["number"] for plot in preview["plots"]}) == 64
    assert preview["stats"]["detected_pdf_labels"] == 64
    assert preview["stats"]["saved_plot_records"] == 64
    assert preview["fields"]["import_source"]["saved_plot_records"] == 64
    assert preview["fields"]["import_source"]["pdf_processing_mode"] == "vector_plots_and_visual_overlay"
    assert any("64 individual vector-derived plot geometries" in warning for warning in preview["warnings"])


def test_pdf_kml_pair_uses_uploaded_kml_boundary_over_existing_colony_boundary(monkeypatch):
    monkeypatch.setattr("app.gis_import_routes.put_object", lambda *args, **kwargs: {})
    monkeypatch.setattr(Importer, "extract_pdf_plot_numbers", lambda data: ["1"], raising=False)
    existing_boundary = {
        "type": "Polygon",
        "coordinates": [[[70, 20], [70.001, 20], [70.001, 20.001], [70, 20]]],
    }
    colony = {**deepcopy(COLONY), "boundary": existing_boundary}
    pdf = pymupdf.open()
    page = pdf.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(10, 10, 90, 90), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_bytes = pdf.tobytes()
    pdf.close()
    client, _, _ = make_client(colony)
    kml = b"""<kml>
      <Placemark><name>Plot 1</name><Polygon>
        <outerBoundaryIs><LinearRing><coordinates>78.0002,27.0002 78.0004,27.0002 78.0004,27.0004 78.0002,27.0004 78.0002,27.0002</coordinates></LinearRing></outerBoundaryIs>
      </Polygon></Placemark>
      <Placemark><name>Land boundary</name><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>78,27 78.002,27 78.002,27.002 78,27.002 78,27</coordinates></LinearRing></outerBoundaryIs>
      </Polygon></Placemark></kml>"""

    response = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        data={"import_mode": "pdf_pair"},
        files=[
            ("layout_pdf", ("layout.pdf", pdf_bytes, "application/pdf")),
            ("cad_file", ("boundary.kml", kml, "application/vnd.google-earth.kml+xml")),
        ],
    )

    assert response.status_code == 201, response.text
    preview = client.get(
        f"/api/admin/gis-imports/{response.json()['id']}"
    ).json()["preview_data"]
    assert preview["fields"]["boundary"] != existing_boundary
    assert preview["fields"]["boundary"]["coordinates"][0][0] == [78.0, 27.0]
    assert preview["pdf_overlay"]["bounds"] == [[27.0, 78.0], [27.002, 78.002]]
    assert preview["pdf_overlay"]["fit"]["boundary_selection"]["selection"]["candidate_boundaries_count"] == 2


def test_pdf_kml_pair_rejects_equally_plausible_outer_boundaries():
    pdf = pymupdf.open()
    page = pdf.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(10, 10, 90, 90), color=(0.1, 0.2, 0.8), fill=(0.1, 0.7, 0.3))
    pdf_bytes = pdf.tobytes()
    pdf.close()
    kml = b"""<kml><Document>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
        78,27 78.001,27 78.001,27.001 78,27.001 78,27
      </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
        78.002,27 78.003,27 78.003,27.001 78.002,27.001 78.002,27
      </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>"""
    client, _, _ = make_client()

    response = client.post(
        f"/api/admin/colonies/{COLONY_ID}/gis-imports",
        data={"import_mode": "pdf_pair"},
        files=[
            ("layout_pdf", ("layout.pdf", pdf_bytes, "application/pdf")),
            ("cad_file", ("boundaries.kml", kml, "application/vnd.google-earth.kml+xml")),
        ],
    )

    assert response.status_code == 422
    assert "multiple plausible land boundaries" in response.json()["detail"]


def test_pdf_boundary_extraction_rejects_invalid_kml_topology():
    kml = b"""<kml><Placemark><name>Site boundary</name><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>
        78,27 78.002,27.002 78,27.002 78.002,27 78,27
      </coordinates></LinearRing></outerBoundaryIs>
    </Polygon></Placemark></kml>"""

    with pytest.raises(VectorImportError, match="topologically invalid"):
        extract_pdf_boundary(kml, "invalid.kml")


def test_pdf_extraction_reports_raster_vector_mixed_and_page_content():
    image = Image.new("RGB", (24, 24), "white")
    encoded = BytesIO()
    image.save(encoded, format="PNG")

    document = pymupdf.open()
    mixed_page = document.new_page(width=100, height=100)
    mixed_page.insert_image(pymupdf.Rect(10, 10, 50, 50), stream=encoded.getvalue())
    mixed_page.draw_rect(pymupdf.Rect(55, 55, 75, 75))
    raster_page = document.new_page(width=100, height=100)
    raster_page.insert_image(pymupdf.Rect(5, 5, 95, 95), stream=encoded.getvalue())
    drawing = _extract_pdf(document.tobytes())
    document.close()

    assert drawing["pdf_content"]["pdf_type"] == "mixed"
    assert drawing["pdf_content"]["page_count"] == 2
    assert drawing["pdf_content"]["pages"][0]["content_type"] == "mixed"
    assert drawing["pdf_content"]["pages"][1]["content_type"] == "raster"
    assert drawing["pdf_content"]["extracted_page_index"] == 0


def test_get_import_qa_report_endpoint():
    client, db, _ = make_client()
    import_id = ObjectId()
    db["gis_imports"].rows.append({
        "_id": import_id,
        "colony_id": str(COLONY_ID),
        "owner_id": USER["id"],
        "filename": "test_colony.pdf",
        "status": "PREVIEW_READY",
        "preview_data": {
            "plots": [
                {
                    "id": "p1",
                    "number": "1",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[0, 0], [10, 0], [10, 20], [0, 20], [0, 0]]],
                    },
                }
            ],
            "fields": {
                "roads": [],
                "greens": [],
                "boundary": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [50, 0], [50, 50], [0, 50], [0, 0]]],
                },
            },
            "annotations": [],
        },
    })
    res = client.get(f"/api/admin/gis-imports/{import_id}/qa-report")
    assert res.status_code == 200
    data = res.json()
    assert "quality_grade" in data
    assert "summary" in data
    assert "findings" in data
    assert data["summary"]["total_plots"] == 1
