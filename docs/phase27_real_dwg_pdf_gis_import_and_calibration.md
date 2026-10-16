# Phase 27 — Real DWG + PDF GIS Import, Dual-File Upload, CAD/PDF Calibration & Accurate GeoJSON Map Placement

## Executive Summary
Phase 27 provides corrective fixes and architectural enhancements for the GIS Import workflow to support real-world `.dwg` CAD drawings and `.pdf` reference layout plans. It resolves the upload validation failures (Error #1: `"Upload a .dxf (CAD) or .pdf layout file"` for `.dwg` files) and internal server errors (Error #2: status 500 exceptions), introduces a dual-file upload interface (`cad_file` + `layout_pdf`), and enforces clear server dependency messaging when a local DWG converter is not installed.

---

## 1. Root Cause Analysis & Audit Findings
- **Error #1 (DWG Upload Rejection)**:
  - Both Node (`backend/node/src/gis/importer.js`) and Python (`backend/python/app/gis/importer.py`) hard-checked for `.dxf` or `.pdf` extensions. Uploading `.dwg` returned a 400 validation error.
- **Error #2 (PDF Server Error 500)**:
  - Passing complex or un-georeferenced PDF files without fallback handling crashed PyMuPDF / JS importer when trying to resolve unit scales or missing vector layers.
- **Single-File UI Restriction**:
  - The UI only allowed selecting a single file (`upload.single("file")`), forcing users to choose between CAD or PDF rather than combining CAD site geometry with PDF layout references.

---

## 2. Implemented Fixes & Enhancements

### A. Extension & Converter Validation
- DWG companions are now sent to the Python GIS worker, converted to DXF with `ezdxf`'s ODA File Converter integration, and imported using the same DXF geometry pipeline.
- Install ODA File Converter on the Python worker. If it is not discoverable at the standard ODA path or on `PATH`, set `ODA_FILE_CONVERTER` in `backend/python/.env` to the absolute executable path and restart Uvicorn.
- Converted DWG plot geometry must match available GeoJSON plot numbers or PDF number labels and must fit the target land boundary. If neither reference has labels, only uniquely numbered DWG parcels can be used. Failed conversion or incomplete parcel extraction rejects the import; the file is not accepted as an unanalyzed attachment.
- The admin PDF+DWG preview uses the colony's saved land boundary and existing plot numbers as references. A preview needs that saved boundary; if there are no saved plot numbers, it cross-checks against selectable PDF labels or requires uniquely numbered parcels in the DWG itself.
- The KML and DWG branches are intentionally separate. KML mode imports parcel geometry from PDF vectors and uses KML only to verify the land outline. DWG mode imports parcel geometry from converted DWG entities and uses PDF text only to cross-check parcel numbers; it does not run PDF parcel recovery as a fallback.
- The internal Python import request carries the real colony ID and import timestamp. Node also normalizes worker-returned preview IDs before saving, preventing successful import summaries from persisting plots under a non-colony `preview` ID (which made the map show `0 / 0`).
- For the supplied Durga Enclave GeoJSON/PDF/KML files, the current Node importer was run end-to-end: 66 unique plots, 4 zones, all plot IDs assigned to the requested colony, 66/66 PDF label matches, exact KML/land-boundary overlap, and every fitted parcel passed the 98%-area containment check.

### B. Dual-File Upload Contract (`cad_file` + `layout_pdf`)
- Updated Multer middleware in `gis_import.routes.js` to `upload.fields([{ name: "cad_file" }, { name: "layout_pdf" }, { name: "file" }])`.
- Upgraded `AdminGisImportPreview.jsx` UI to provide separate drag-and-drop / file selection areas for **1. CAD / Site Plan (.DWG / .DXF)** and **2. Reference Layout PDF (.PDF)**.

### C. CAD Geometry & WGS84 Calibration Pipeline
- Intermediate local GeoJSON extracted from DXF/PDF vector layers is stored in `gis_imports` preview session.
- Coordinate calibration accepts control points (`[{ source: { x, y }, target: { lat, lng } }]`) and applies affine transformation to project local CAD coordinates onto EPSG:4326 WGS84 `[longitude, latitude]`.

### D. Existing Land Boundary Priority
- When mapping plots for a colony that already has a land boundary, that boundary remains authoritative; a companion KML cannot replace it.
- Plot polygons are extracted from the PDF and fitted to the existing boundary by the Python GIS worker, and the committed import preserves the existing land boundary and map center.
- The Node-to-Python PDF/DXF worker request uses the `X-Internal-Token` header required by the Python service and sends the resolved land polygon—not the full plot GeoJSON collection—as the PDF fitting target.
- Mapping replacement passes the colony's saved boundary into the bundle importer. QGIS and PDF plot polygons are checked by their intersected area (not just center points); if QGIS plots fall outside and PDF processing fails, the replacement is rejected without changing the map.
- A local/unreferenced PDF is fitted with one uniform scale, rotation, and translation; independent horizontal/vertical stretching is avoided so plot and layout proportions remain intact. For convex land outlines, the importer searches for the largest placement that keeps the complete parcel footprint inside the land polygon, then centers the remaining feasible placement area. The Node fallback uses the same fitting strategy. This is a shape fit, not GPS calibration; accurate satellite registration still requires georeferenced source data or trusted control points.
- After PDF parcels replace the imported plot geometry, the colony `map_center` is recalculated from the authoritative land boundary rather than retained from the PDF-derived footprint.
- When the PDF provides numbered labels and shared block/divider linework instead of closed plot polygons, the Python importer splits those vector blocks at their divider lines and associates each recovered parcel with its PDF label. It uses the parcel footprint for fitting, verifies all labels were recovered, and returns the explicit land boundary as the authoritative colony outline.
- Compound filled PDF drawings can contain multiple disconnected line subpaths; the extractor retains each subpath rather than silently dropping all but the last. Repeated PDF labels are used for affine calibration only when a single GeoJSON point has one unambiguous match within 3 m of the fit from unique labels. If any calibrated label has no unique parcel cell, the Python importer rejects the partial result and lists the missing plot numbers instead of returning a fallback map.
- The currently supplied Shri Ram Enclave bundle still does not contain recoverable vector parcel cells for every label: after calibration, only 100 of 110 unique plot labels have a unique PDF vector cell. The importer now rejects this bundle and reports missing labels `27, 28, 34, 35, 43, 44, 55, 90, 100, 115`; these parcels must not be approximated or committed without an approved inference workflow or corrected parcel geometry.
- For the Durga Enclave source set, the importer recovers all 66 numbered parcels, matches all 66 GeoJSON point labels by plot number, and keeps every fitted plot within the supplied KML land boundary. GeoJSON point coordinates are not used to position the parcels.
- Point-label GeoJSON uploads are supported for new-colony creation when a tagged site boundary and vector PDF provide enough information to recover every numbered plot. Partial recovery is rejected.
- DWG conversion uses ODA File Converter, which is an external worker dependency and must be installed on the GIS worker.

---

## 3. Verification & Safety Results
- **Backend Tests**: `node --test tests/*.test.js` -> **65 / 65 PASSING**.
- **Frontend Build**: `npm run build` -> **0 errors**.
- **Data Safety**: Existing 64-plot production colony (`Durga Enclave`) remains completely untouched; GIS imports operate on draft preview sessions until explicit operator commit.
- **DWG Environment Dependency**: The supplied DWG signature is valid, but ODA File Converter is not installed/configured in the current Python worker environment. DWG conversion therefore cannot be end-to-end verified here; install/configure ODA on that worker before retrying the DWG branch.
