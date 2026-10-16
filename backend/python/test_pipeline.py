"""
Standalone test pipeline for raster PDF -> plots extraction -> georeference
Run: python test_pipeline.py
"""
import os
import json
import math
import re
from pathlib import Path

import cv2
import pymupdf  # PyMuPDF (new name)
import numpy as np
from fastkml import kml
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import transform as shapely_transform
from pyproj import Transformer


# =============================================================
# CONFIG — CHANGE THESE PATHS
# =============================================================
BASE = Path(__file__).parent
KML_FILE = BASE / "uploads" / "test" / "boundary.kml"
PDF_FILE = BASE / "uploads" / "test" / "layout.pdf"
OUTPUT_DIR = BASE / "test_output"
OUTPUT_DIR.mkdir(exist_ok=True)

PDF_SCALE = 2.0           # Render DPI multiplier
MIN_PLOT_AREA = 2000      # Min pixel area to count as plot


# =============================================================
# 1. Parse KML
# =============================================================
def parse_kml(kml_path):
    print(f"[1/6] Parsing KML: {kml_path}")
    with open(kml_path, "rb") as f:
        doc = f.read()
    k = kml.KML.from_string(doc)
    features = list(k.features)
    while features and hasattr(features[0], "features"):
        features = list(features[0].features)
    for feat in features:
        geom = feat.geometry
        if geom and geom.geom_type == "Polygon":
            print(f"      Boundary: {len(geom.exterior.coords)} vertices")
            print(f"      Bounds: {geom.bounds}")
            return geom
    raise ValueError("No polygon found in KML")


# =============================================================
# 2. Render PDF to image
# =============================================================
def render_pdf(pdf_path, scale=PDF_SCALE):
    print(f"[2/6] Rendering PDF: {pdf_path}")
    doc = pymupdf.open(pdf_path)
    page = doc[0]
    mat = pymupdf.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        img = cv2.cvtColor(img, cv2.COLOR_RGBA2RGB)
    elif pix.n == 3:
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    print(f"      Image: {img.shape[1]} x {img.shape[0]} px")
    cv2.imwrite(str(OUTPUT_DIR / "01_pdf_render.png"), img)
    return img


# =============================================================
# 3. Extract text labels via OCR
# =============================================================
def extract_labels(img):
    print(f"[3/6] Running OCR to find plot numbers...")
    try:
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(use_angle_cls=False, lang="en", show_log=False)
        result = ocr.ocr(img, cls=False)
        labels = []
        if result and result[0]:
            for line in result[0]:
                bbox, (text, conf) = line
                text = text.strip()
                # Keep only numbers like "82", "45A", "12-B"
                if re.match(r"^\d{1,4}[A-Za-z]?$", text):
                    cx = sum(p[0] for p in bbox) / 4
                    cy = sum(p[1] for p in bbox) / 4
                    labels.append({"text": text, "cx": cx, "cy": cy, "bbox": bbox})
        print(f"      Found {len(labels)} numeric labels")
        return labels
    except Exception as e:
        print(f"      OCR failed: {e}")
        return []


# =============================================================
# 4. Extract plot polygons via contour detection
# =============================================================
def extract_polygons(img):
    print(f"[4/6] Detecting plot polygons via OpenCV...")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Invert so dark lines become white
    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    # Morph close to seal small gaps in lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    
    # Find external + internal contours
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    
    polygons = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < MIN_PLOT_AREA:
            continue
        # Approximate polygon to reduce points
        epsilon = 0.005 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, epsilon, True)
        if len(approx) < 4:
            continue
        # Convert to list of [x, y]
        pts = approx.reshape(-1, 2).tolist()
        polygons.append({"pts": pts, "area_px": area, "centroid": (
            sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts),
        )})
    
    print(f"      Found {len(polygons)} polygons")
    
    # Draw for debug
    debug = img.copy()
    for p in polygons:
        pts = np.array(p["pts"], dtype=np.int32)
        cv2.polylines(debug, [pts], True, (0, 255, 0), 2)
    cv2.imwrite(str(OUTPUT_DIR / "02_polygons.png"), debug)
    return polygons


# =============================================================
# 5. Match labels to polygons
# =============================================================
def match_labels(polygons, labels):
    print(f"[5/6] Matching {len(labels)} labels to {len(polygons)} polygons...")
    matched = []
    used = set()
    for poly in polygons:
        cx, cy = poly["centroid"]
        # Find nearest unused label
        best = None
        best_dist = float("inf")
        for i, lbl in enumerate(labels):
            if i in used:
                continue
            d = math.hypot(lbl["cx"] - cx, lbl["cy"] - cy)
            if d < best_dist:
                best_dist = d
                best = (i, lbl)
        # Only accept if within reasonable distance (~half a plot)
        if best and best_dist < 200:
            i, lbl = best
            used.add(i)
            matched.append({
                "pts": poly["pts"],
                "area_px": poly["area_px"],
                "centroid_px": poly["centroid"],
                "number": lbl["text"],
                "label_dist": best_dist,
            })
    print(f"      Matched {len(matched)} plots with numbers")
    return matched


# =============================================================
# 6. Georeference: pixel → lat/lng via homography
# =============================================================
def georeference(plots, boundary, img_width, img_height):
    print(f"[6/6] Georeferencing pixel to lat/lng...")
    
    minx, miny, maxx, maxy = boundary.bounds
    print(f"      KML bounds: [{minx:.6f}, {miny:.6f}, {maxx:.6f}, {maxy:.6f}]")
    
    # Source: PDF pixel corners (top-left, top-right, bottom-right, bottom-left)
    src = np.float32([
        [0, 0],
        [img_width, 0],
        [img_width, img_height],
        [0, img_height],
    ])
    # Destination: KML corner equivalents (in same order)
    # PDF top-left → KML top-left (minx, maxy)
    dst = np.float32([
        [minx, maxy],
        [maxx, maxy],
        [maxx, miny],
        [minx, miny],
    ])
    
    H, _ = cv2.findHomography(src, dst)
    print(f"      Homography computed: {H is not None}")
    
    def pixel_to_geo(x, y):
        pt = np.array([x, y, 1.0])
        out = H @ pt
        return (out[0] / out[2], out[1] / out[2])
    
    features = []
    for i, p in enumerate(plots):
        geo_pts = [pixel_to_geo(x, y) for x, y in p["pts"]]
        try:
            poly = Polygon(geo_pts)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty or poly.area <= 0:
                continue
            # Skip if centroid is outside boundary bounds
            minx, miny, maxx, maxy = boundary.bounds
            cx, cy = poly.centroid.x, poly.centroid.y
            if not (minx <= cx <= maxx and miny <= cy <= maxy):
                continue
            # Compute area in meters via UTM projection (approx)
            # Use simple approximation for display
            area_sq_m = poly.area * 111320 * 111320 * math.cos(math.radians(poly.centroid.y))
            area_sq_yd = area_sq_m * 1.19599
            features.append({
                "type": "Feature",
                "properties": {
                    "plot_number": p.get("number", f"plot_{i}"),
                    "area_sqm": round(area_sq_m, 2),
                    "area_sqyd": round(area_sq_yd, 2),
                    "status": "available",
                },
                "geometry": mapping(poly),
            })
        except Exception as e:
            print(f"      Skip plot {p.get('number')}: {e}")
    
    print(f"      Georeferenced {len(features)} plots")
    return features


# =============================================================
# 7. Generate interactive HTML map (Leaflet)
# =============================================================
def generate_html(boundary, features, out_path):
    print(f"[7/7] Generating HTML map: {out_path}")
    
    boundary_geojson = json.dumps({
        "type": "Feature",
        "properties": {},
        "geometry": mapping(boundary),
    })
    plots_geojson = json.dumps({
        "type": "FeatureCollection",
        "features": features,
    })
    center = [
        (boundary.bounds[1] + boundary.bounds[3]) / 2,  # lat
        (boundary.bounds[0] + boundary.bounds[2]) / 2,  # lng
    ]
    
    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Extracted Plots Test</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{{height:100%;margin:0;background:#111;font-family:Inter,sans-serif}}
  .label{{color:#000;font-weight:700;font-size:11px;text-shadow:0 0 3px #fff}}
  .legend{{position:absolute;bottom:20px;left:20px;background:rgba(0,0,0,.85);color:#fff;padding:12px;border-radius:8px;z-index:1000;font-size:12px}}
  .legend b{{color:#f97316}}
</style>
</head>
<body>
<div id="map"></div>
<div class="legend">
  <b>Extracted Plots:</b> {len(features)}<br/>
  <b>Boundary:</b> dashed yellow<br/>
  <b>Plots:</b> warm ivory
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const boundary = {boundary_geojson};
const plots = {plots_geojson};
const map = L.map('map').setView({center}, 17);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{{z}}/{{y}}/{{x}}', {{
  maxZoom: 22, maxNativeZoom: 19,
}}).addTo(map);
L.geoJSON(boundary, {{
  style: {{ color: '#facc15', weight: 3, dashArray: '8,6', fill: false }}
}}).addTo(map);
L.geoJSON(plots, {{
  style: {{ color: '#1a1c20', weight: 1.2, fillColor: '#ece3d4', fillOpacity: 0.9 }},
  onEachFeature: (f, layer) => {{
    const c = layer.getBounds().getCenter();
    L.marker(c, {{
      icon: L.divIcon({{ className: 'label', html: f.properties.plot_number, iconSize: [30,14] }}),
      interactive: false,
    }}).addTo(map);
    layer.bindTooltip(`Plot ${{f.properties.plot_number}} · ${{f.properties.area_sqyd}} yd²`);
  }}
}}).addTo(map);
</script>
</body>
</html>"""
    
    Path(out_path).write_text(html, encoding="utf-8")
    print(f"      OK - Open in browser: file://{Path(out_path).resolve()}")


# =============================================================
# MAIN
# =============================================================
def main():
    print("=" * 60)
    print("  STANDALONE PIPELINE TEST")
    print("=" * 60)
    
    if not KML_FILE.exists() or not PDF_FILE.exists():
        print(f"\nMissing input files:")
        print(f"   KML: {KML_FILE} (exists: {KML_FILE.exists()})")
        print(f"   PDF: {PDF_FILE} (exists: {PDF_FILE.exists()})")
        print(f"\nEdit KML_FILE and PDF_FILE paths at top of this script.\n")
        return
    
    boundary = parse_kml(KML_FILE)
    img = render_pdf(PDF_FILE)
    labels = extract_labels(img)
    polygons = extract_polygons(img)
    
    # If no labels, just use polygons without numbers
    if not labels:
        print(f"      No labels found, using polygons without numbers")
        matched = [{"pts": p["pts"], "area_px": p["area_px"], "centroid_px": p["centroid"], "number": f"plot_{i}", "label_dist": 0} for i, p in enumerate(polygons)]
    else:
        matched = match_labels(polygons, labels)
    
    features = georeference(matched, boundary, img.shape[1], img.shape[0])
    
    # Save GeoJSON
    geojson_path = OUTPUT_DIR / "plots.geojson"
    geojson_path.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": features,
    }, indent=2), encoding="utf-8")
    print(f"\n[OK] GeoJSON saved: {geojson_path}")
    print(f"[OK] Total plots: {len(features)}")
    
    # Generate HTML
    html_path = OUTPUT_DIR / "test_map.html"
    generate_html(boundary, features, html_path)
    
    print("\n" + "=" * 60)
    print("  DONE")
    print("=" * 60)
    print(f"\nDebug images in: {OUTPUT_DIR}")
    print(f"Open: {html_path}")


if __name__ == "__main__":
    main()
