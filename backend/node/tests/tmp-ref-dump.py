"""Dump Python importer outputs for the four fixtures so the JS port can be diffed against them."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import importer  # noqa: E402

FIX = os.path.join(ROOT, "backend", "tests", "fixtures")
OUT = os.path.join(HERE, "reference")
os.makedirs(OUT, exist_ok=True)

FIXTURES = [
    ("layout_latlng.dxf", None),
    ("layout_utm_lines.dxf", "https://www.google.com/maps/place/@22.2325,73.1120,17z"),
    ("layout_geo.pdf", "https://www.google.com/maps/place/@22.2325,73.1120,17z"),
    ("layout_scaled.pdf", "https://www.google.com/maps/place/@22.2325,73.1120,17z"),
]

CID = "testcolony"
NOW = "2026-01-01T00:00:00.000Z"

for fname, link in FIXTURES:
    with open(os.path.join(FIX, fname), "rb") as f:
        data = f.read()
    try:
        fields, zones, plots, warnings = importer.import_file(data, fname, link or "", CID, NOW)
        rec = {"ok": True, "fields": fields, "zones": zones, "plots": plots, "warnings": warnings}
    except Exception as e:  # noqa: BLE001
        rec = {"ok": False, "error": type(e).__name__, "message": str(e)}
    dest = os.path.join(OUT, fname + ".json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=1, sort_keys=False)
    if rec["ok"]:
        print(f"{fname}: mode={fields['import_source']['mode']} plots={len(plots)} "
              f"zones={len(zones)} greens={len(fields['greens'])} roads={len(fields['roads'])} "
              f"warnings={len(warnings)}")
    else:
        print(f"{fname}: ERROR {rec['error']}: {rec['message']}")
