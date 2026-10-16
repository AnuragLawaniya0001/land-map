# Storage Architecture & Implementation Document

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 3 — Unified File / Object Storage Architecture  
**Date:** October 3, 2026  

---

## 1. Storage Architecture Overview

The system employs a decoupled, provider-agnostic storage abstraction layer in `backend-node/storage.js`.

### Key Architectural Principles
1. **Decoupled Binary Storage**: MongoDB stores only document metadata, ownership references, storage keys, and checksums. Binary contents are never stored in MongoDB.
2. **Provider Agnostic**: The application business logic invokes a single unified interface (`upload`, `download`, `exists`, `deleteObject`, `getSignedUrl`) regardless of whether the active driver is `local` disk storage or AWS `s3`.
3. **Strict Path & Key Sanitization**: All incoming keys and filenames are sanitized to eliminate path traversal vulnerabilities (`../`), null-byte injections, or filesystem escapes.
4. **Isolated Temporary Workspace**: Processing files generated during DXF/PDF vector conversion or entrance gate calculation are created in an isolated `storage/tmp/` directory and explicitly cleaned up upon job completion or failure.

---

## 2. Directory & Key Organization Hierarchy

When `STORAGE_DRIVER=local` is active, files are stored relative to `LOCAL_STORAGE_PATH` (`./storage`).

```
storage/
├── users/
│   └── :userId/
│       └── colonies/
│           └── :colonyId/
│               ├── source/
│               │   ├── pdf/       # Original uploaded layout PDFs
│               │   ├── dxf/       # Original uploaded CAD DXF drawings
│               │   └── dwg/       # Original uploaded CAD DWG drawings
│               │
│               ├── generated/
│               │   ├── geojson/   # Cached GeoJSON export artifacts
│               │   └── previews/  # Rendered layout thumbnails/previews
│               │
│               ├── registry/
│               │   └── :plotId/   # Private plot registry PDFs (v1, v2, v3)
│               │
│               ├── documents/     # General colony attachments
│               └── media/         # Public images and video assets
│
└── tmp/                           # Isolated temporary GIS processing files
```

### Storage Key Format Examples
- **Registry Document:** `users/{userId}/colonies/{colonyId}/registry/{plotId}/v{version}-{docId}-{filename}`
- **Source DXF File:** `users/{userId}/colonies/{colonyId}/source/dxf/{docId}-{filename}`
- **Generated GeoJSON:** `users/{userId}/colonies/{colonyId}/generated/geojson/{docId}-{filename}`

---

## 3. Storage Drivers

### A. Local Storage Driver (`STORAGE_DRIVER=local`)
- **Default for Development**: Default storage driver.
- **Root Directory**: Configured via `LOCAL_STORAGE_PATH` (defaults to `./storage`).
- **Path Traversal Protection**: Evaluated via `safeJoin(root, key)`. Any resolved path attempting to exit the root directory raises a `Path traversal restriction violated` exception.

### B. AWS S3 Storage Driver (`STORAGE_DRIVER=s3`)
- **Production Driver**: Integrates dynamically with `@aws-sdk/client-s3`.
- **Environment Variables**:
  - `STORAGE_DRIVER=s3`
  - `S3_BUCKET` (Required)
  - `S3_REGION` (e.g. `us-east-1`)
  - `S3_ENDPOINT` (Optional custom endpoint / MinIO compatibility)
  - `AWS_ACCESS_KEY_ID` & `AWS_SECRET_ACCESS_KEY` (Handled via SDK credential provider)

---

## 4. File Metadata & Database Compatibility

### Registry Document Collection (`registry`)
The `registry` collection stores plot sale deeds and ownership lineage (up to 3 resale versions per plot). 

```json
{
  "_id": "6701a2b3c4d5e6f7a8b9c0d1",
  "id": "doc-uuid-1234",
  "plot_id": "plot-56",
  "colony_id": "colony-durga-enclave",
  "filename": "registry_plot_56.pdf",
  "size": 1425000,
  "mime": "application/pdf",
  "checksum": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "version": 1,
  "uploaded_by": "user-admin-01",
  "uploaded_by_name": "Durga Realty",
  "created_at": "2026-10-03T16:00:00.000+00:00",
  "storage_key": "users/user-admin-01/colonies/colony-durga-enclave/registry/plot-56/v1-doc-uuid-1234-registry_plot_56.pdf"
}
```

---

## 5. Security & Authorization Audit

### Public vs. Private Asset Classification

| Asset Category | Visibility | Endpoint Route | Authorization & Tenant Check |
|---|---|---|---|
| **Registry PDFs** | **PRIVATE** | `/api/admin/registry/:docId/download` | Strict: Auth Token + Admin Role + Colony Ownership Verification (`loadOwnedColony`) |
| **Source CAD/PDF Layouts** | **PRIVATE** | `/api/admin/colonies/:id` | Strict: Admin Auth + Colony Ownership |
| **Colony GeoJSON** | **PUBLIC** | `/api/public/colonies/:slug` / `/api/admin/colonies/:id/geojson` | Public read allowed for published colonies |
| **Colony Media/Images** | **PUBLIC** | `/api/public/colonies/:slug` | Public read allowed |

### IDOR Attack Prevention
1. In `/api/admin/registry/:docId/download`:
   - Retrieves document metadata from `registry` collection.
   - Executes `loadOwnedColony(rec.colony_id, req.user)`.
   - If Admin A attempts to request document ID belonging to Admin B's colony, `loadOwnedColony` throws a masked `HTTP 404 Colony Not Found`, preventing IDOR access and tenant enumeration.

---

## 6. Audit of Existing Emergent Storage in Python Backend

- **Python Reference (`backend/server.py`)**: Uses Emergent Object Storage HTTP proxy (`INTEGRATION_PROXY_URL` / `https://integrations.emergentagent.com`).
- **Keys in DB**: Python backend generates storage keys prefixed with `livemap/registry/...`.
- **Node Storage Compatibility**: `backend-node/storage.js` seamlessly maps `livemap/registry/...` storage keys to local disk or S3 paths under `getObject(key)`.
- **Migration Status**: **No files have been deleted or migrated in this phase.** All Python code and Emergent storage integration remain 100% intact for reference and side-by-side execution.

---

## 7. Testing Results

Unit test suite in `backend-node/tests/storage.test.js` verified:
- **Filename Sanitization**: Rejects path separators, null bytes, and dot traversal attempts.
- **Path Traversal Protection**: Rejects `../` escape attempts out of storage root.
- **PDF Signature Validation**: Validates `%PDF` magic header bytes.
- **Local Storage Lifecycle**: Confirmed `putObject`, `exists`, `getObject`, and `deleteObject`.
- **Temporary GIS File Lifecycle**: Confirmed `createTempFile` creation and `deleteTempFile` cleanup.
- **Test Result**: **6 / 6 tests passed cleanly.**
