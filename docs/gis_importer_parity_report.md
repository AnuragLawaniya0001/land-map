# Real-World GIS Importer Validation & Parity Test Report

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Real-World GIS Importer Validation & Parity Test  
**Date:** October 3, 2026  

---

## 1. Executive Summary

This report documents the empirical comparison and parity testing between the reference Python GIS importer (`backend/importer.py`) and the Node.js target GIS importer (`backend-node/importer.js`). 

### Core Conclusion
- **Real Client File Availability:** **REAL CLIENT FILES NOT AVAILABLE IN WORKSPACE — PARITY TEST CANNOT BE COMPLETED ON PRODUCTION CLIENT DATA.**
- **Automated Synthetic Fixture Results:** On the 4 available test fixtures (`layout_geo.pdf`, `layout_latlng.dxf`, `layout_scaled.pdf`, `layout_utm_lines.dxf`), **`backend-node/importer.js` failed on 3 out of 4 test fixtures**, whereas `backend/importer.py` succeeded on 3 out of 4.
- **Node Importer Readiness:** **NODE IMPORTER IS NOT READY TO REPLACE THE PYTHON IMPORTER.**
- **Python Fallback Requirement:** **MANDATORY.** Python backend (`backend/importer.py`) must remain as a specialized GIS/CAD worker microservice (`ENABLE_PYTHON_GIS_FALLBACK=true`).

---

## 2. Test Files Inventory

The workspace contains 4 test files located in `backend/tests/fixtures/`:

| File Name | File Type | Size (Bytes) | Classification / Source | Can Test? |
|---|---|---|---|---|
| `layout_geo.pdf` | GeoPDF | 24,827 | **Synthetic Test Fixture** (GeoPDF `/VP` `/Measure` spec) | Yes |
| `layout_latlng.dxf` | DXF (CAD) | 48,986 | **Synthetic Test Fixture** (WGS84 Lat/Lng linework) | Yes |
| `layout_scaled.pdf` | Vector PDF | 24,485 | **Synthetic Test Fixture** (Scaled drawing note spec) | Yes |
| `layout_utm_lines.dxf` | DXF (CAD) | 84,083 | **Synthetic Test Fixture** (UTM Zone 43N linework) | Yes |

> [!IMPORTANT]
> **No real client PDF/DXF drawings were found in the workspace.** Success cannot be declared for production land files until real client drawings are provided and tested.

---

## 3. Python Importer Architecture (`backend/importer.py`)

The reference Python importer uses native C-bindings and robust GIS libraries:
1. **DXF Parsing:** `ezdxf` reads LWPOLYLINE, POLYLINE, LINE, HATCH, TEXT, MTEXT entities and `$INSUNITS` header headers.
2. **PDF Vector Extraction:** `pymupdf` (PyMuPDF) extracts raw vector graphics streams (`items`), coordinates, drawing fills, and text blocks (`get_text("words")`).
3. **GeoPDF Parsing:** `_pdf_georef` parses raw PDF cross-reference dictionaries for `/VP`, `/Measure`, `BBox`, `GPTS` (GeoPoints), and `LPTS` (LocalPoints).
4. **Polygonization Engine:** `shapely.ops.polygonize(unary_union(lines + polys))` constructs topology faces.
5. **Coordinate Transformation:** `pyproj.Transformer.from_crs` handles EPSG UTM projections to WGS84 (`EPSG:4326`).
6. **Feature Classification:** Regex matching (`GREEN_WORDS`, `ROAD_WORDS`, `PLOT_NO`) and geometric area aspect ratio rules classify polygons into Outer Boundary, Plots, Green Areas, and Internal Roads.

---

## 4. Node Importer Architecture (`backend-node/importer.js`)

The Node.js target importer attempts a pure JavaScript port:
1. **DXF Parsing:** `dxf-parser` parses ASCII DXF entities into JS objects.
2. **PDF Parsing:** `pdfjs-dist` iterates page operator lists (`getOperatorList`).
3. **Polygonization Engine:** `jsts` (JTS Topology Suite port for JS: `Polygonizer`, `UnaryUnionOp`, `GeometryFactory`).
4. **Coordinate Transformation:** `proj4` for UTM to WGS84 transformation.

---

## 5. Comparative Execution Results

A non-destructive comparison harness (`backend-node/tests/importer-parity/run_parity_comparison.mjs`) was created to execute both importers on the exact same files under identical parameters.

| Fixture File | Python Result | Python Time | Node Result | Node Time | Parity Status | Failure Diagnostics |
|---|---|---|---|---|---|---|
| `layout_geo.pdf` | **SUCCESS** (64 plots, 4 zones, 4 greens, 10 roads) | 362.88 ms | **FAIL** | 65.21 ms | **NODE FAILED** | Node `pdfjs-dist` lacks GeoPDF `/VP` `/Measure` dictionary parsing. |
| `layout_latlng.dxf` | **SUCCESS** (64 plots, 4 zones, 3 greens, 0 roads) | 149.43 ms | **FAIL** | 5.00 ms | **NODE FAILED** | JSTS topology engine failed to form closed faces from DXF linework. |
| `layout_scaled.pdf` | **FAIL** (Expected: Requires Maps Link) | 15.72 ms | **FAIL** (Expected: Requires Maps Link) | 8.05 ms | **MATCH** | Both correctly require Google Maps location link. |
| `layout_utm_lines.dxf` | **SUCCESS** (64 plots, 4 zones, 2 greens, 0 roads) | 105.10 ms | **FAIL** | 2.73 ms | **NODE FAILED** | Node failed to polygonize UTM lines into faces. |

---

## 6. Detailed Failure Root Cause Analysis

### 1. GeoPDF `/VP` / `/Measure` Dictionary Missing in Node
- **Python:** `_pdf_georef` parses `/VP` (Viewport) and `/Measure` cross-references to retrieve `/GPTS` (latitude/longitude coordinates) and `/LPTS` (local page points), establishing affine transformation matrices without requiring user-provided Google Maps links.
- **Node:** `backend-node/importer.js` does not parse PDF xref dictionaries. It throws: `"The file has no real-world coordinates. Add a Google Maps link so the layout can be placed on the land."`

### 2. JSTS Polygonization & Face Formation Discrepancy
- **Python:** `shapely.ops.polygonize(unary_union(segs))` handles floating-point precision snapping and complex linework intersections seamlessly.
- **Node:** `backend-node/importer.js` creates JSTS `LineString` elements and feeds them to `Polygonizer`. JSTS throws an empty polygon set (`"No closed shapes could be formed from the drawing"`), breaking DXF layout parsing.

---

## 7. Performance Comparison

- **Python Importer Average Time:** ~205 ms per layout file (PyMuPDF + Shapely + ezdxf C-bindings).
- **Node Importer Average Time (when failing early):** ~20 ms.

---

## 8. Difference & Risk Matrix

| File / Component | Python Importer | Node Importer | Severity | Required Action |
|---|---|---|---|---|
| **GeoPDF Viewport Parsing** | Fully Supported (`PyMuPDF`) | Unsupported | **CRITICAL** | Route GeoPDF files to Python GIS worker |
| **DXF Linework Polygonization** | Fully Supported (`Shapely`) | Fails (`JSTS`) | **CRITICAL** | Route DXF polygonization to Python GIS worker |
| **UTM Projection Transformation** | Fully Supported (`PyPROJ`) | Unsupported | **HIGH** | Use Python GIS worker for UTM CRS handling |
| **Standard Scaled PDF** | Fails without Maps Link | Fails without Maps Link | **NONE** | Both behave identically |

---

## 9. Node Importer Readiness Determination

### Status: **NOT READY**

`backend-node/importer.js` cannot replace `backend/importer.py` for land drawing imports. Attempting to replace the Python importer now will break PDF and DXF layout uploads for real estate colonies.

---

## 10. Required Python GIS Fallback Microservice Architecture

The primary application architecture must implement the Python fallback microservice model:

```
[ Frontend Upload ]
       │
       ▼
[ Node.js Primary Backend ] (Express / Port 8001)
       │
       ▼ (Check ENABLE_PYTHON_GIS_FALLBACK)
       ├── True ──► [ Python GIS Worker Service ] (FastAPI / Port 8002)
       │                 │ (PyMuPDF + ezdxf + Shapely + PyPROJ)
       │                 ▼
       │            Returns Normalized GeoJSON & Plot Schema
       │                 │
       └─────────────────┴──► Stores Metadata in MongoDB & Files in Storage
```

---

## 11. Recommended Next Steps

1. **Keep Python Backend Active:** Maintain `backend/` as the specialized GIS processing worker.
2. **Expose Dedicated Python Importer Endpoint:** Expose a clean microservice endpoint on the Python backend (e.g. `POST /internal/gis/import`) that accepts PDF/DXF buffers and returns normalized colony/zone/plot GeoJSON documents.
3. **Connect Node Backend to Python GIS Worker:** When `ENABLE_PYTHON_GIS_FALLBACK=true`, `backend-node/server.js` delegates PDF/DXF layout parsing to the Python worker endpoint.
