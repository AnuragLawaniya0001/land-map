# Backend Merge Inventory Report

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 3 — Unify Python + Node Backends  
**Date:** October 3, 2026  

---

## 1. Overview & Strategy

This document provides a comprehensive inventory of all source files, routes, controllers, services, utilities, database operations, dependencies, and GIS logic across `backend-node/` and `backend/`.

### Architecture Goals
- **Node.js**: Primary application backend (HTTP API, Authentication, Multi-tenant JWT session handling, User/Colony/Plot/Registry CRUD, Storage Orchestration, GIS Dispatching).
- **Python**: Specialized GIS & Processing Engine (PDF/DXF parsing, PyMuPDF vector extraction, ezdxf CAD parsing, Shapely geometry polygonization, PyPROJ coordinate transformations, GeoPandas operations).

---

## 2. Node Functionality Inventory (`backend-node/`)

| Functionality | Source File | Status | Keep/Move/Delete | Reason |
|---|---|---|---|---|
| HTTP API Server Entry | `src/app.js`, `src/server.js` | Active | **Move** to `backend/node/src/` | Primary Express application entry point. |
| DB Connection & Mongo Client | `src/db/index.js` | Active | **Move** to `backend/node/src/db/` | Authoritative MongoDB connection lifecycle for app backend. |
| Central Configuration Layer | `src/config/index.js` | Active | **Move** to `backend/node/src/config/` | Environment config parser & production validator. |
| Authentication Middleware | `src/middleware/auth.js` | Active | **Move** to `backend/node/src/middleware/` | Authoritative JWT HttpOnly cookie auth & role checking. |
| Error Middleware | `src/middleware/errors.js` | Active | **Move** to `backend/node/src/middleware/` | Centralized Express async error handling. |
| Auth Routes | `src/routes/auth.routes.js` | Active | **Move** to `backend/node/src/routes/` | Login, logout, me endpoints. Authoritative auth layer. |
| Colony Management Routes | `src/routes/colonies.routes.js` | Active | **Move** to `backend/node/src/routes/` | Colony CRUD, file upload orchestration, layout dispatching. |
| Plot & Bulk Status Routes | `src/routes/plots.routes.js` | Active | **Move** to `backend/node/src/routes/` | Single & bulk status updates, plot queries. |
| Registry Document Routes | `src/routes/registry.routes.js` | Active | **Move** to `backend/node/src/routes/` | Plot registry deed uploads, versioning, secure downloads. |
| User Admin Routes | `src/routes/users.routes.js` | Active | **Move** to `backend/node/src/routes/` | Super-admin tenant/user management and password resets. |
| Public Colony Viewer Routes | `src/routes/public.routes.js` | Active | **Move** to `backend/node/src/routes/` | Public colony map viewer API (unauthenticated). |
| Audit Log Routes | `src/routes/audit.routes.js` | Active | **Move** to `backend/node/src/routes/` | Tenant-isolated audit trail endpoints. |
| Storage Abstraction Layer | `src/storage/index.js` | Active | **Move** to `backend/node/src/storage/` | Unified local disk / AWS S3 storage provider. |
| Legacy Root Wrappers | `auth.js`, `config.js`, `db.js`, `storage.js`, `server.js`, `importer.js`, etc. | Obsolete Root Files | **Delete** | Deprecated single-line legacy export shims created during earlier refactoring. |
| Node GIS Importer | `src/gis/importer.js` | Failed Parity | **Keep/Deprecate** | Kept for JS fallback/reference, but Python designated as primary GIS engine per parity report. |

---

## 3. Python Functionality Inventory (`backend/`)

| Functionality | Source File | Status | Keep/Move/Delete | Reason |
|---|---|---|---|---|
| DXF & Vector PDF Importer | `importer.py` | Authoritative | **Move** to `backend/python/app/gis/importer.py` | Primary, accurate GIS/CAD parser using PyMuPDF, ezdxf, Shapely, PyPROJ. |
| Layout Geometry & Seeding | `layout.py` | Authoritative GIS | **Move** to `backend/python/app/gis/layout.py` | Synthetic layout math & geometry polygon helpers. |
| Road & Gate Calculation | `roads.py` | Authoritative GIS | **Move** to `backend/python/app/gis/roads.py` | Calculates entrance gates and road intersections from plot polygons. |
| FastAPI Application Server | `server.py` | Monolith API | **Refactor & Move** to `backend/python/app/server.py` | Convert from duplicate monolith app into internal GIS processing microservice on port 8002. |
| Pytest Test Suite | `tests/` | Active | **Move** to `backend/python/tests/` | Test fixtures (`layout_geo.pdf`, DXFs) & test scripts. |

---

## 4. Duplicate Functionality Analysis

| Function / Domain | Node Implementation | Python Implementation | Authoritative Selection | Rationale |
|---|---|---|---|---|
| **User Auth & JWT** | `src/routes/auth.routes.js` & `src/middleware/auth.js` | `server.py` (`/api/auth/*`) | **Node.js** | Node owns full app auth, cookies, and user session management. |
| **Colony & Plot CRUD** | `src/routes/colonies.routes.js`, `plots.routes.js` | `server.py` (`/api/admin/colonies/*`) | **Node.js** | Node is primary SaaS application layer. |
| **Registry PDF Management** | `src/routes/registry.routes.js` | `server.py` (`/api/admin/plots/*/registry`) | **Node.js** | Node owns document metadata and storage orchestration. |
| **Audit Logs** | `src/routes/audit.routes.js` | `server.py` (`/api/admin/audit-logs`) | **Node.js** | Node tracks all application write events. |
| **CAD / PDF Importer** | `src/gis/importer.js` | `importer.py` | **Python** | Python PyMuPDF + Shapely + ezdxf handles GeoPDF xrefs and complex polygonization without topology errors. |
| **Entrance Gate Calculation**| `src/gis/roads.js` (port) | `roads.py` | **Python** | Python Shapely geometry calculations are robust and accurate. |

---

## 5. Dependency Audit

### Node.js (`package.json`)
- **Required Production Dependencies:** `express`, `mongodb`, `jsonwebtoken`, `bcryptjs`, `cookie-parser`, `cors`, `dotenv`, `multer`, `proj4`
- **Optional/Fallback Dependencies:** `dxf-parser`, `pdfjs-dist`, `jsts` (Retained for Node-side utility operations if needed).

### Python (`requirements.txt`)
- **Core GIS Dependencies (MUST KEEP):** `pymupdf` (PyMuPDF), `ezdxf`, `shapely`, `pyproj`, `pandas`, `numpy`
- **Microservice Web Server:** `fastapi`, `uvicorn`, `pydantic`, `python-dotenv`, `requests`, `python-multipart`
- **Legacy Application Dependencies:** `motor`, `pymongo`, `passlib`, `PyJWT` (Retained to ensure legacy script compatibility).
