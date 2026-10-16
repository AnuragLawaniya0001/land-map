# LiveMap

LiveMap is a React/Vite application backed by a single Python FastAPI service. The
Python API owns authentication, MongoDB access, GIS imports, file storage, and all
admin/public endpoints. The frontend talks to it through `/api`.

## Quick Start (Docker + Local Backend)

Prerequisites: Docker Desktop installed and running, Python 3.11+ installed locally.

### Step 1: Start Docker Services (MongoDB + Frontend)
```powershell
docker compose up -d
```

### Step 2: Start Python Backend Locally
```powershell
cd backend/python
.venv\Scripts\python.exe -m uvicorn app.server:app --host 127.0.0.1 --port 8001 --reload
```

### Step 3: Access the application
- Frontend: http://localhost:5173
- Backend API: http://localhost:8001
- MongoDB: mongodb://livemap:livemap_password@localhost:27017

### Step 4: Stop services
```powershell
# Stop Docker services
docker compose down

# Stop backend (Ctrl+C in backend terminal)
```

For detailed instructions, see [DOCKER_SETUP.md](./DOCKER_SETUP.md).

## Run locally (without Docker)

Prerequisites: Python 3.11+, Node.js (frontend only), MongoDB, and the
dependencies listed in `backend/python/requirements.txt`.

1. Copy `backend/python/.env.example` to `backend/python/.env`. Configure MongoDB
   and a strong `JWT_SECRET`. To keep current login cookies valid, use the same
   `JWT_SECRET` as the previous API. Keep `.env` private.
2. Create a virtual environment and install the Python dependencies from
   `backend/python`:

   ```powershell
   py -3.11 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   .\.venv\Scripts\python.exe -m pip check
   ```

3. Check that the GIS projection dependency can load, then start the API using
   the same environment:

   ```powershell
   .\.venv\Scripts\python.exe -c "from pyproj import Transformer; print('pyproj import OK')"
   .\.venv\Scripts\python.exe -m uvicorn app.server:app --host 127.0.0.1 --port 8001 --reload
   ```

   If the import reports that an Application Control or Code Integrity policy
   blocked a `.pyd` file, reinstalling the same package or changing the Python
   environment may not resolve it. Do not disable security controls. Ask the
   device administrator to review the matching CodeIntegrity event and approve
   an organization-compliant package or environment.

4. In another terminal, start the frontend:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

Open <http://localhost:5173>. Vite proxies `/api` to the Python API on port 8001.
For a production build, run `npm run build` in `frontend`; when `frontend/dist`
exists, the Python service serves it by default. Set `SERVE_FRONTEND=false` to
serve the frontend separately.

## Tests

The Python API tests are in `backend/python/tests` and run with:

```powershell
cd backend/python
.\.venv\Scripts\python.exe -m pytest
```

GIS fixture files in `backend/python/tests/fixtures` are test inputs and are
intentionally retained. Generated reports, caches, and bytecode are not source.

## PDF image overlays

PDF overlay imports render page 1, detect a layout footprint, map its corners to a
convex four-corner KML boundary when possible, and clip the raster to the selected
land polygon. Non-quadrilateral boundaries are fitted to an oriented envelope;
the overlay diagnostics warn that this does not register every irregular edge.
Disjoint KML land polygons are rejected because one layout image cannot be
unambiguously fitted to multiple separate sites. Orientation cannot be inferred
from polygon dimensions alone, so ambiguous cases must be checked against the
satellite map and corrected with **Calibrate PDF Image**.

Fit diagnostics report the input PDF and boundary-geometry hashes, render and
crop metadata, control points, candidate orientations, homography condition,
approximate boundary residuals, and the raster content clipped away. These
geometric residuals describe the detected footprint against the KML geometry;
they are not evidence of real-world alignment or plot georeferencing.
PDF imports now report structural content classification (`vector`, `raster`,
`mixed`, `text_only`, or `blank`) and per-page drawing, image, and text counts.
For compatibility, vector plot extraction and PDF overlays still use page 1;
multi-page imports include an explicit warning rather than implying every page
was processed. Image-only overlays remain visual evidence and do not create
verified inventory polygons from labels alone. A label without a recovered
parcel boundary is reported as unmatched and is not turned into an estimated
rectangle or Voronoi cell.

DWG/DXF/DWF imports use a separate CAD vector renderer and label-linked plot
selection path. Only CAD labels enclosed by validated plot cells are saved as
plots or exposed as clickable regions; unmatched labels are reported rather
than assigned to arbitrary polygonized linework. CAD diagnostics distinguish
recognized labels from matched boundaries, and a CAD rendering failure is
reported instead of returning a blank image as if rendering had succeeded.
The map identifies this layer as the CAD viewer, separately from PDF artwork.

Re-imported plot documents are matched by stable plot ID or colony/plot number;
geometry and imported attributes are refreshed while each existing plot's
status and creation timestamp are retained. New plots default to `available`.
The colony update path merges records rather than deleting plots, so inventory
that is absent from a partial drawing is not silently removed.
When available, the crop is derived from reconstructed PDF vector parcel cells,
so external page titles do not enlarge the layout footprint. The crop can omit
shared roads or perimeter land not represented by parcel cells; the diagnostic
warning requires visual review. If parcel vectors are unavailable, colored
content is used, followed by a flagged non-white page-content fallback. Neither
fallback is a verified parcel perimeter.
The un-clipped registered source raster is stored separately from the clipped
display raster, so calibration can reposition pixels that were outside the
boundary in the automatic fit; reset restores the original clipped image.
Near-white PDF pixels, including enclosed white plot fills, are converted to
transparent alpha before warping so status colors and satellite imagery remain
visible beneath them. Dark linework and non-white source fills remain visible;
antialiased edge pixels are unmatted to reduce white fringes. The transformed
artwork is clipped to the KML boundary as before. Its transparency threshold
and transparent-pixel ratio are included in fit diagnostics.

PDF artwork is off by default, preserving the clean status-colored map. Admins
can turn the transparent PDF linework/fills on for comparison; the near-white
parcel interiors do not cover digital status colors. Searchable PDF labels such
as `ROAD` or `PARK` can help classify a closed source shape as a road or green
feature, but this remains best-effort: unlabeled, open, overlapping, or
ambiguous shapes are not reliably classified. Provide separately drawn,
closed, uniquely labeled PDF regions for roads and gardens when those areas
must appear as shaded features with PDF artwork off. Re-import an existing
colony's source PDF to populate features recovered by these import changes;
existing saved colony data is not rewritten just by updating the application.
The source crop is padded and the registered artwork is fitted about 2.5%
inside the colony envelope, leaving a small margin so perimeter linework is
less likely to be cut exactly at the land edge. The overlay remains clipped to
the real colony boundary, and the margin amount is reported in fit diagnostics.
Extracted PDF text span centers and baseline directions are also projected
through the same image homography and retained as point annotations. They render
digitally in clean mode from zoom level 19, preserve baseline rotation, and
follow saved overlay calibration. Imperial dimension notation such as `50'` and
`92'-6"` is classified as dimension text. Plot labels and dimensions are prioritized;
road, place, and other native text spans are also retained, with nearby
annotations suppressed to keep dense layouts legible. Exact source font bounds
are unavailable, so their center-point placement and visual scale should be
reviewed against the source artwork. Text printed only into a scanned page image
is not recovered: raster OCR is not currently available.
The admin map's **Plot status colors** switch changes only polygon styling;
it does not change a plot's stored status. Select a saved plot to use its
**Change status** controls, or use the **Plot list** for single and bulk status
updates. Heuristic PDF regions are not inventory records and cannot be assigned
updates. Status changes on heuristic PDF regions are saved to the PDF overlay,
but do not create inventory records or affect inventory totals. A heuristic
region must be verified and saved as a plot before it can be marked Sold.
Newly imported plots default to **Available** (green); updating only a PDF
overlay preserves the existing plot records and their statuses.
Mapping diagnostics are available in a collapsed details section.

When a PDF contains vector parcel lines or closed raster plot cells and enough
unambiguous PDF text labels, the import derives clipped plot-cell click regions
and maps them with the same image transform. Raster detection suppresses
isolated text strokes, keeps only closed cells with a unique plot label, and
is also tried when vector polygonization fails or produces an invalid cell for
a label. It does not invent a boundary when both sources fail or a cell remains
open or ambiguous. When native vector parcel coverage accounts for less than
75% of native plot labels, a higher-resolution raster trace is also attempted;
only uniquely label-associated traced cells become selectable heuristic
regions. Diagnostics compare detected unique labels with labels that have
individual click regions and list unmatched numbers for review. These are
heuristic overlay selections only: they are not saved plot records, surveyed
boundaries, or editable inventory. Existing valid plot geometries take
precedence; PDF regions for plot numbers not represented by selectable saved
plots are still available for map selection. Every detected region is
identified as heuristic in the UI.
Raster cell detection uses dark, low-chroma linework so saturated parcel fills
do not get mistaken for closed boundaries; colored raster-only outlines may
therefore remain heuristic or undetected. Raster boundaries close very small
line breaks and are simplified at roughly one rendered pixel to reduce jagged
edge noise without rounding away major parcel corners. Detected-region length and width are shown as approximate
oriented bounds; they are not surveyed dimensions. PDF road and dimension
annotations are rendered with high-contrast labels in clean mode.
Raster-only PDFs additionally get a higher-resolution closed-cell contour pass.
Its pixel contours become clickable vector polygon approximations on the map;
the uploaded PDF remains raster, and its embedded plot numbers are not OCR'd or
assigned to those regions. These unlabeled candidates remain heuristic and must
not be treated as verified/saved inventory.
For an older overlay that has no click regions, an admin can use **Detect regions
from saved image** on the colony map to rebuild hit regions from the registered
PNG without re-uploading the PDF. Since the stored image has no reliable text
anchors, these rebuilt regions are unlabeled heuristic selections and do not
create or update inventory plot records; re-import the original PDF when plot
numbers are needed.

For source-PDF preparation requirements, measured Durga/Shri Ram sample results,
and the registration/verification checklist, see
[PDF_LAYOUT_IMPORT_GUIDELINES.md](./PDF_LAYOUT_IMPORT_GUIDELINES.md).

To save opt-in local diagnostic artifacts during an import, set
`PDF_OVERLAY_DEBUG_DIR` in the Python API environment to a private directory.
The API writes page render, detected crop, source controls, KML boundary/control
preview, a paired correspondence preview, pre-clip registration, clipping mask,
final raster, and a JSON report.
The directory path is not returned in API responses. Unset the variable to
disable artifact output.

## Data and migration notes

- The API uses `MONGODB_URI` / `MONGODB_DB`; `MONGO_URL` / `DB_NAME` remain
  supported as aliases.
- Local file storage defaults to `backend/node/storage` so existing registry
  documents remain available. Configure `LOCAL_STORAGE_PATH` before relocating
  that data. Alternatively set `STORAGE_DRIVER=emergent` and configure the
  object-storage credentials.
- Keep existing database records and storage files when removing the old Node
  runtime. Never remove `.env` files or uploaded documents as cleanup.
