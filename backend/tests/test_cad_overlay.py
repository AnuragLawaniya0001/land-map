import os
import pytest
from shapely.geometry import shape
from app.gis import importer, vector_import, cad_overlay

def test_cad_overlay_and_import():
    dwg_path = os.path.join(os.getcwd(), "..", "..", "Shri Ram (1).dwg")
    if not os.path.exists(dwg_path):
        dwg_path = os.path.join(os.getcwd(), "Shri Ram (1).dwg")
    
    kml_path = os.path.join(os.getcwd(), "..", "..", "Shri_Ram_Enclave_NoMirror_Aligned.kml")
    if not os.path.exists(kml_path):
        kml_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "Shri_Ram_Enclave_NoMirror_Aligned.kml")

    if not os.path.exists(dwg_path) or not os.path.exists(kml_path):
        pytest.skip("CAD sample files not found in workspace root")

    with open(kml_path, "rb") as f:
        kml_bytes = f.read()

    with open(dwg_path, "rb") as f:
        dwg_bytes = f.read()

    boundary, _ = vector_import.extract_pdf_boundary(kml_bytes, "boundary.kml")
    assert boundary["type"] in ("Polygon", "MultiPolygon")

    # Test CAD vector plot extraction
    fields, zones, plots, warnings = importer.import_file(
        data=dwg_bytes,
        filename="Shri Ram (1).dwg",
        maps_link="",
        colony_id="test_cad_colony",
        now="2026-10-09T00:00:00Z",
        target_boundary=boundary,
    )

    assert len(plots) > 0, "Failed to extract plots from DWG file"
    assert len(zones) > 0, "Failed to extract zones from DWG file"
    recognized_labels = {
        importer.normalize_plot_no(text[2])
        for text in importer._extract_dxf(dwg_bytes, is_dwg=True, filename="Shri Ram (1).dwg")["texts"]
        if importer.normalize_plot_no(text[2])
    }
    assert {plot["number"] for plot in plots} <= recognized_labels
    assert all(shape(plot["geometry"]).is_valid for plot in plots)
    assert any("unmatched labels were not saved as plots" in warning for warning in warnings)

    # Test CAD visual overlay rendering
    clipped_png, base_png, bounds, fit, plot_regions = cad_overlay.render_cad_overlay_images(
        dwg_bytes, boundary, filename="Shri Ram (1).dwg"
    )

    assert len(clipped_png) > 0
    assert len(base_png) > 0
    assert len(bounds) == 2
    assert len(plot_regions) > 0
    assert fit["source_type"] == "cad"
    assert fit["detected_plot_label_count"] == len(recognized_labels)
    assert fit["matched_plot_label_count"] == len(plot_regions)
    assert fit["interactive_plot_count"] == len(plot_regions)
    assert fit["detected_plot_label_count"] > fit["matched_plot_label_count"]
    assert {region["number"] for region in plot_regions} <= recognized_labels
    assert all(
        shape({"type": "Polygon", "coordinates": [region["coordinates"]]}).is_valid
        for region in plot_regions
    )
    assert fit["unmatched_plot_numbers"]
