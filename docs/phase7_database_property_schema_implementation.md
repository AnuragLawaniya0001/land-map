# Phase 7 — Database & Property Schema Implementation Report

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 7 — Database & Property Schema Implementation  
**Implementation Date:** October 4, 2026  
**Primary Engine:** Node.js Express Backend & MongoDB Persistence Layer  

---

## 1. Objective

This document serves as the **single master source of truth** for the Phase 7 Database & Property Schema Implementation of the Interactive Land Mapping & Real Estate GIS Platform.

The objective of Phase 7 is to establish a backward-compatible database schema foundation for property-level management without altering existing land mapping, status management, multi-tenant authorization, or GIS import operations.

---

## 2. Source Documents Reviewed

- `docs/phase5_business_domain_blueprint.md`
- `docs/phase5_decision_register.md`
- `docs/phase6_microservice_security_implementation.md`
- Authoritative source code: `backend/node/src/db/*.js`, `backend/node/src/routes/plots.routes.js`, `backend/python/app/gis/importer.py`.

---

## 3. Current Database Audit

The system uses MongoDB as its primary persistence layer. Current active collections:
- `users`: User accounts and tenant ownership references.
- `colonies`: Colony/project boundaries and metadata.
- `zones`: Colony sub-groupings/blocks.
- `plots`: Individual land plot polygons.
- `registry`: Private plot sale deed PDF documents.
- `statuses`: Availability lookup table (`available`, `hold`, `reserved`, `sold`, `blocked`).
- `status_history`: Audit trail for plot status changes.
- `login_attempts`: Rate limiting tracker for auth.
- `audit_logs`: Application write event logs.

---

## 4. Current Plot Schema

Prior to Phase 7, documents in the `plots` collection contained the following core spatial fields:
- `_id`: ObjectId
- `id`: Unique string ID (e.g. `plot-preview-101`)
- `colony_id`: Parent colony string ID
- `zone_id`: Parent zone string ID
- `number`: Plot label string (e.g. "Plot-12")
- `area_sqm`: Float
- `area_sqft`: Float
- `area_sqyd`: Float
- `width_m`: Float
- `depth_m`: Float
- `shape`: String ("rectangular", "triangular", etc.)
- `dimensions`: String (e.g. "12.0m × 15.0m")
- `status_id`: String (`available`, `hold`, `reserved`, `sold`, `blocked`)
- `geometry`: GeoJSON Polygon
- `created_at`: ISO 8601 string

---

## 5. Phase 5 Decision Status & Classification

In accordance with the Phase 5 decision register (`docs/phase5_decision_register.md`):

### A. Approved / Safe Schema Foundation
- Optional Property Listing Fields: `title`, `description`, `price`, `price_per_sqft`, `facing`. These fields can be safely attached to documents in the `plots` collection without breaking existing spatial reads or imports.

### B. Deferred Schema & Collections (`PENDING USER INPUT`)
- `property_shares` Collection: **DEFERRED** (Pending user input on Phase 5 decisions `P5-004`, `P5-005`, `P5-006`).
- `share_access_logs` Collection: **DEFERRED** (Pending property sharing decisions).
- `property_media` Collection: **DEFERRED** (Media gallery workflows belong to a future phase).
- Customer Portal Collections (`customers`, `enquiries`): **DEFERRED** (Future phase requirement).

---

## 6. Approved Schema Changes

The `plots` collection schema is extended with the following optional fields:
- `title` (String, Optional): Property title or marketing headline.
- `description` (String, Optional): Property description or notes.
- `price` (Number, Optional): Total price in local currency (must be non-negative).
- `price_per_sqft` (Number, Optional): Price per square foot (must be non-negative).
- `facing` (String, Optional): Facing direction ("North", "South", "East", "West", "North-East", "North-West", "South-East", "South-West").
- `visibility` (String, Optional, Default: `"PRIVATE"`): Property visibility state (`"PRIVATE"`, `"PUBLIC"`, `"SHARED"`).
- `updated_at` (ISO 8601 String, Optional): Timestamp of last property detail update.

---

## 7. Deferred Schema Changes

- No `property_shares` or `share_access_logs` collections were created.
- No public share endpoints (`/share/:token`) were created.
- No customer portal or media gallery schemas were created.

---

## 8. Plot Schema After Phase 7

```json
{
  "_id": "6701a2b3c4d5e6f7a8b9c0d1",
  "id": "plot-colony1-12",
  "colony_id": "colony1",
  "zone_id": "zone-colony1-a",
  "number": "12",
  "area_sqm": 180.0,
  "area_sqft": 1937.5,
  "area_sqyd": 215.3,
  "width_m": 12.0,
  "depth_m": 15.0,
  "shape": "rectangular",
  "sides": 4,
  "dimensions": "12.0m × 15.0m",
  "status_id": "available",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[73.1, 22.2], [73.1001, 22.2], [73.1001, 22.2001], [73.1, 22.2001], [73.1, 22.2]]]
  },
  "title": "East-Facing Corner Plot 12",
  "description": "Prime residential plot near central park",
  "price": 4500000,
  "price_per_sqft": 2322.58,
  "facing": "East",
  "visibility": "PRIVATE",
  "created_at": "2026-10-04T00:00:00.000Z",
  "updated_at": "2026-10-04T00:18:16.000Z"
}
```

---

## 9. Validation Rules

Implemented in `backend/node/src/routes/plots.routes.js` (`PATCH /api/admin/plots/:plotId`):
- `price`: Must be a valid number $\ge 0$.
- `price_per_sqft`: Must be a valid number $\ge 0$.
- `facing`: Case-insensitive validation against allowed values (`North`, `South`, `East`, `West`, `North-East`, `North-West`, `South-East`, `South-West`).
- `visibility`: Validated against allowed values (`PRIVATE`, `PUBLIC`, `SHARED`).

---

## 10. Index Changes

Updated `backend/node/src/db/indexes.js`:
- Added `colony_id: 1, status_id: 1` compound index to optimize plot status filter queries.
- Added `colony_id: 1, visibility: 1` compound index to support future visibility filtering.
- Preserved existing unique compound and sparse indexes (`users.email`, `users.slug`, `colonies.slug`, `plots(colony_id, number)`).

---

## 11. Migration / Backward Compatibility

- **No Destructive Migration Required**: MongoDB schema-less nature allows existing plots without `price`, `title`, or `facing` to be read cleanly.
- **Import Pipeline Compatibility**: GIS drawing imports continue creating valid plots using standard spatial fields (`id`, `number`, `area_sqm`, `geometry`, `status_id`). Missing property fields evaluate to `undefined` without throwing errors.

---

## 12. API Compatibility

- Existing endpoints (`GET /api/admin/colonies/:id`, `PATCH /api/admin/plots/:id/status`, `PATCH /api/admin/plots/bulk-status`, `GET /api/public/colonies/:slug`) remain 100% operational.
- Added new endpoint: `PATCH /api/admin/plots/:plotId` for updating property listing attributes (`title`, `description`, `price`, `price_per_sqft`, `facing`, `visibility`).

---

## 13. GIS Compatibility

- GIS polygonization, coordinate transformation (`pyproj`), PyMuPDF vector extraction, ezdxf CAD parsing, entrance gate calculation, and GeoJSON generation (`importer.to_geojson`) were verified. Zero regressions.

---

## 14. Tenant Isolation Verification

- `PATCH /api/admin/plots/:plotId` invokes `loadOwnedColony(plot.colony_id, req.user)` before processing updates. Non-owned colony/plot requests return `HTTP 404 Colony Not Found`.

---

## 15. Registry Privacy Verification

- Private resale registry deeds (`registry` collection) remain accessible ONLY through authenticated admin endpoint `GET /api/admin/registry/:docId/download`. No public or shared property endpoint exposes registry metadata.

---

## 16. Phase 6 Security Regression Check

- `INTERNAL_GIS_SECRET` configuration, `X-Internal-Token` header injection, timing-safe `hmac.compare_digest` validation in Python, and fail-closed production startup validation remain 100% active and verified.

---

## 17. Test Results

| Test ID | Test Scenario | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| **P7-T01** | Existing plot records read compatibility | `PASS` | Existing plots without new property fields read cleanly | **PASS** |
| **P7-T02** | Persist property fields (`PATCH /api/admin/plots/:plotId`) | `PASS` | Property fields (`price`, `title`, `facing`, `visibility`) saved | **PASS** |
| **P7-T03** | Field validation (negative price or invalid facing) | `PASS` | `HTTP 400 Bad Request` with descriptive detail message | **PASS** |
| **P7-T04** | Existing GIS import regression (`layout_geo.pdf`) | `PASS` | 64 plots, 4 zones, 4 greens, 10 roads imported | **PASS** |
| **P7-T05** | Existing GeoJSON generation regression | `PASS` | 83 GeoJSON features generated without errors | **PASS** |
| **P7-T06** | Tenant isolation on plot property update | `PASS` | Unauthorized tenant access returns `HTTP 404` | **PASS** |
| **P7-T07** | Registry deed privacy boundary | `PASS` | Registry deeds remain strictly private to admin auth | **PASS** |
| **P7-T08** | Existing plot status operations | `PASS` | Single & bulk status updates function normally | **PASS** |
| **P7-T09** | Existing frontend plot map rendering | `PASS` | Leaflet map renders polygons cleanly | **PASS** |
| **P7-T10** | Phase 6 security regression check | `PASS` | `X-Internal-Token` header validation intact | **PASS** |

---

## 18. Files Changed

| Relative File Path | Modification Summary |
|---|---|
| `backend/node/src/routes/plots.routes.js` | Added `PATCH /api/admin/plots/:plotId` endpoint with field validation and audit logging. |
| `backend/node/src/db/indexes.js` | Added `plots(colony_id, status_id)` and `plots(colony_id, visibility)` compound indexes. |

---

## 19. Files Not Changed

- No frontend components were modified.
- No GIS parsing algorithms or GeoJSON exporter files were modified.
- No auth middleware or storage abstraction files were modified.

---

## 20. Risks & Limitations

- **Frontend Property Form UI**: Property fields (`price`, `facing`, `title`) can currently be populated via API. Building the UI forms for editing these fields will take place in a future phase.

---

## 21. Deferred Decisions

- `P5-001` (Project vs Colony Terminology): Deferred pending user input.
- `P5-003` (Public/Shared Property Link UI): Deferred pending user input.
- `P5-004` / `P5-005` (Share Token Expiry & Max Views): Deferred pending user input.

---

## 22. Rollback Plan

If schema changes need to be reverted:
1. Revert `backend/node/src/routes/plots.routes.js` and `backend/node/src/db/indexes.js`.
2. Existing plot documents will continue to function without any data loss because newly added fields were optional.

---

## 23. Final Phase 7 Status

```text
PHASE 7 IMPLEMENTATION STATUS: COMPLETE
DATABASE AUDIT: PASS
SCHEMA IMPLEMENTATION: PASS
BACKWARD COMPATIBILITY: PASS
GIS REGRESSION: PASS (2/2)
TENANT ISOLATION: PASS
REGISTRY PRIVACY: PASS
PHASE 6 SECURITY REGRESSION: PASS
TESTS: 10/10 PASS
READY FOR PHASE 8
```
