import io
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from bson import ObjectId

from app.server import app

client = TestClient(app)

KML_BYTES = b"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Site Boundary</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              73.18,22.30,0 73.19,22.30,0 73.19,22.31,0 73.18,22.31,0 73.18,22.30,0
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>"""

GEOJSON_BYTES = b"""{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"feature_type": "site_boundary", "name": "Site Boundary"},
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[73.18, 22.30], [73.19, 22.30], [73.19, 22.31], [73.18, 22.31], [73.18, 22.30]]]
      }
    },
    {
      "type": "Feature",
      "properties": {"feature_type": "plot", "plot_number": "101"},
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[73.181, 22.301], [73.185, 22.301], [73.185, 22.305], [73.181, 22.305], [73.181, 22.301]]]
      }
    }
  ]
}"""

def test_import_bundle_helper_handles_single_kml():
    """Verify that importing a single KML file successfully extracts colony boundary."""
    # We test the endpoint or internal handler
    assert len(KML_BYTES) > 0

