# Phase 4 — System Functional Mapping & Audit Master Report

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 4 — System Functional Mapping & Audit  
**Date:** October 3, 2026  

---

## 1. Executive Summary & Current Architecture

During Phase 4, a complete source code audit was conducted across the unified repository (`frontend/`, `backend/node/`, `backend/python/`, `storage/`, `docs/`).

```text
                        FRONTEND (React + Vite)
                                  │
                                  ▼ (HttpOnly JWT Cookies)
                     ┌──────────────────────────┐
                     │   NODE.JS BACKEND (API)  │
                     │    Port 8001 / Express   │
                     └────────────┬─────────────┘
                                  │
          ┌───────────────────────┼──────────────────────┐
          │                       │                      │
          ▼                       ▼                      ▼
    MongoDB Database         File Storage        Python GIS Worker
  (Users, Colonies, Plots,  (Local Disk / S3)    (FastAPI / Port 8002)
   Registry Metadata)                                    │
                                                         ▼
                                                PDF / DXF Parsing &
                                               Geometry Extraction Engine
```

---

## 2. Key Audit Findings by Subsystem

### A. Authentication & Session Management
- **Implementation**: Node Express JWT cookie authentication (`backend/node/src/middleware/auth.js`).
- **Cookie Security**: `access_token` stored in HttpOnly cookie (`SameSite=Lax`, 7-day TTL).
- **Password Hashing**: Bcrypt (`BCRYPT_ROUNDS=12`).
- **Endpoints**: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.

### B. User Roles & Tenant Isolation
- **Roles Implemented**: `super_admin` (Platform Owner) and `admin` (Real Estate Developer Tenant).
- **Tenant Isolation**: Admin queries are strictly scoped to `{ owner_id: req.user.id }`. `loadOwnedColony` masks non-owned colony/plot/registry requests with an HTTP 404 response to prevent tenant enumeration and IDOR attacks.

### C. PDF & DXF GIS Pipeline
- **PDF Pipeline**: Node receives layout PDF at `POST /api/admin/colonies` → dispatches buffer to Python FastAPI worker (`POST /internal/gis/import` on Port 8002) → PyMuPDF extracts vectors & GeoPDF `/VP` `/Measure` xref dictionaries → Shapely polygonizes closed plot faces → returns GeoJSON payload to Node → Node saves colony, zones, and plots in MongoDB.
- **DXF Pipeline**: `ezdxf` reads LWPOLYLINE, POLYLINE, LINE, HATCH, and TEXT entities → Shapely performs topology polygonization → PyPROJ transforms UTM/WGS84 coordinates.

### D. Map & Plot Status System
- **Map Renderer**: `frontend/src/components/InteractiveMap.jsx` using Leaflet.
- **Statuses**: `Available` (`#28c98b`), `Hold` (`#f2b84b`), `Reserved` (`#55a8ff`), `Sold` (`#f06b5f`), `Blocked` (`#9aa6a3`).
- **APIs**: `PATCH /api/admin/plots/:id/status` and `PATCH /api/admin/plots/bulk-status`.

### E. Document & File Storage System
- **Storage Layer**: `backend/node/src/storage/index.js` supporting `STORAGE_DRIVER=local` and `s3`.
- **Registry Deeds**: Private plot resale deeds stored up to 3 versions per plot under key `storage/users/{userId}/colonies/{colonyId}/registry/{plotId}/v{version}-{docId}-{filename}`.
- **Download Security**: `GET /api/admin/registry/:docId/download` verifies tenant ownership before streaming binary content.

### F. Node ↔ Python Microservice Boundary
- Node calls Python via internal HTTP loopback (`http://127.0.0.1:8002/internal/gis/import`).

---

## 3. Admin Workflow Map

```text
[ Admin Login ]
   │  Frontend Route: /admin/login
   │  Component: AdminLogin.jsx
   │  API Endpoint: POST /api/auth/login
   │  Database: users, login_attempts
   │
   ▼
[ Admin Dashboard / Colony List ]
   │  Frontend Route: /admin
   │  Component: AdminHome.jsx
   │  API Endpoint: GET /api/admin/dashboard, GET /api/admin/colonies
   │  Database: colonies, plots, statuses, users
   │
   ├──► [ Create Colony & Upload Drawing ]
   │       Frontend Component: AdminHome.jsx (Colony Form / File Upload Modal)
   │       API Endpoint: POST /api/admin/colonies
   │       Database: colonies, zones, plots, audit_logs
   │       Storage: Isolated temp workspace during import
   │       Python GIS: Loopback POST /internal/gis/import (PyMuPDF / ezdxf)
   │
   ▼
[ Colony Interactive Map & Plot Workspace ]
   │  Frontend Route: /admin/colony/:id
   │  Component: AdminColonyMap.jsx
   │  API Endpoint: GET /api/admin/colonies/:id
   │  Database: colonies, zones, plots, statuses, registry
   │
   ├──► [ Plot Status Management ]
   │       Frontend Component: AdminColonyMap.jsx (Status Pill Select / Bulk Action Toolbar)
   │       API Endpoint: PATCH /api/admin/plots/:id/status, PATCH /api/admin/plots/bulk-status
   │       Database: plots, status_history, audit_logs
   │
   └──► [ Registry Deed Management ]
           Frontend Component: AdminColonyMap.jsx (Registry Modal)
           API Endpoint: POST /api/admin/plots/:id/registry (Upload), GET /api/admin/registry/:docId/download (Download)
           Database: registry, audit_logs
           Storage: storage/users/{userId}/colonies/{colonyId}/registry/{plotId}/v{version}-{docId}-{filename}
```

---

## 4. API Functional Specification

### 1. `POST /api/auth/login`
- **Auth / Role:** Public
- **Input:** `{ email, password, portal }`
- **Validation:** Validates email format, password non-empty, checks `login_attempts` rate limiting lock.
- **Business Function:** Authenticates user and establishes HttpOnly cookie session.
- **Database:** Reads `users` collection, writes `login_attempts` (reset or increment).
- **Response:** 200 OK with HttpOnly cookie `access_token` and serialized user JSON object.

### 2. `POST /api/auth/logout`
- **Auth / Role:** Public
- **Input:** None.
- **Business Function:** Invalidates active user session cookie.
- **Response:** 200 OK with cleared `access_token` cookie.

### 3. `GET /api/auth/me`
- **Auth / Role:** Authenticated (`getCurrentUser`)
- **Input:** Cookie `access_token` or `Authorization: Bearer <token>`.
- **Business Function:** Returns current user profile.
- **Database:** Reads `users` collection.
- **Response:** 200 OK with serialized user JSON object.

### 4. `POST /api/admin/colonies`
- **Auth / Role:** Admin / Super Admin (`requireAdmin`)
- **Input:** Multipart form data containing `file` (.pdf / .dxf), `name`, `whatsapp_number`, `location`, `description`, `public_enabled`, `maps_link`.
- **Validation:** File presence, file format (.pdf / .dxf), max layout size (25 MB), WhatsApp digit count (10-15 digits).
- **Business Function:** Creates a new colony project and imports layout geometry.
- **Database:** Inserts into `colonies`, `zones`, `plots`, `audit_logs`.
- **Python:** Dispatches to Python worker `POST /internal/gis/import` when `ENABLE_PYTHON_GIS_FALLBACK=true`.
- **Response:** 200 OK with serialized colony object and import summary statistics.

### 5. `GET /api/admin/colonies/:id`
- **Auth / Role:** Admin / Super Admin (`requireAdmin`)
- **Input:** Path param `colonyId` (or slug).
- **Validation:** Validates colony ownership via `loadOwnedColony(colonyId, user)`.
- **Business Function:** Retrieves detailed colony data, zones, plots, and registry document counts.
- **Database:** Reads `colonies`, `zones`, `plots`, `registry`, `statuses`.
- **Response:** 200 OK with `{ colony, zones, plots, statuses }`.

### 6. `PATCH /api/admin/plots/:id/status`
- **Auth / Role:** Admin / Super Admin (`requireAdmin`)
- **Input:** Path param `plotId`, Body `{ status_id }`.
- **Validation:** Validates `status_id` exists in `statuses` collection, validates plot ownership via colony owner ID.
- **Business Function:** Updates availability status of a single plot.
- **Database:** Updates `plots`, inserts `status_history`, inserts `audit_logs`.
- **Response:** 200 OK with serialized updated plot.

### 7. `PATCH /api/admin/plots/bulk-status`
- **Auth / Role:** Admin / Super Admin (`requireAdmin`)
- **Input:** Body `{ plot_ids: [...], status_id }`.
- **Validation:** Validates `status_id` exists, validates ownership of all requested plot IDs.
- **Business Function:** Bulk updates availability status for multiple plots simultaneously.
- **Database:** Updates `plots`, inserts `status_history`, inserts `audit_logs`.
- **Response:** 200 OK with `{ updated: count }`.

### 8. `POST /api/admin/plots/:id/registry`
- **Auth / Role:** Admin / Super Admin (`requireAdmin`)
- **Input:** Path param `plotId`, Multipart form data `file` (PDF deed).
- **Validation:** Validates plot ownership, file presence, max PDF size (25 MB), PDF magic header `%PDF`, max version limit (3 versions per plot).
- **Business Function:** Uploads resale deed PDF for a plot.
- **Database:** Inserts record into `registry`, inserts `audit_logs`.
- **Storage:** Persists binary file via `putObject`.
- **Response:** 200 OK with serialized registry document record.

### 9. `GET /api/admin/registry/:docId/download`
- **Auth / Role:** Admin / Super Admin (`requireAdmin`)
- **Input:** Path param `docId`.
- **Validation:** Retrieves document metadata from `registry`, validates tenant colony ownership.
- **Business Function:** Downloads/streams private registry deed PDF.
- **Storage:** Fetches binary buffer via `getObject(doc.storage_key)`.
- **Response:** 200 OK streaming `application/pdf` binary with `Content-Disposition: attachment`.

### 10. `GET /api/public/colonies/:slug`
- **Auth / Role:** Public (Unauthenticated)
- **Input:** Path param `slug`.
- **Validation:** Validates colony exists and `public_enabled=true`.
- **Business Function:** Provides public colony layout & plot data for customer web viewer.
- **Database:** Reads `colonies`, `zones`, `plots`, `statuses`.
- **Response:** 200 OK with `{ colony, zones, plots, statuses }`.
