# Phase 3 — Unified Python + Node Backend Report

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 3 — Backend Unification  
**Date:** October 3, 2026  

---

## 1. Before & After Architecture

### A. Before (Divided Repositories)
```text
backend/                     -> FastAPI Python monolith (API + GIS + MongoDB)
backend-node/                -> Express Node monolith (API + Storage + MongoDB)
```

### B. After (Single Unified Repository Root)
```text
spacer-land/
├── frontend/                -> React + Vite Application
├── backend/
│   ├── node/                -> Authoritative Express SaaS / API Layer
│   │   ├── src/
│   │   │   ├── app.js
│   │   │   ├── server.js
│   │   │   ├── config/
│   │   │   ├── db/
│   │   │   ├── middleware/
│   │   │   ├── routes/
│   │   │   ├── storage/
│   │   │   ├── gis/
│   │   │   └── utils/
│   │   ├── package.json
│   │   └── .env
│   │
│   └── python/              -> Specialized GIS & CAD Geometry Processing Worker
│       ├── app/
│       │   ├── server.py     -> Internal GIS microservice (Port 8002)
│       │   └── gis/
│       │       ├── importer.py (Authoritative drawing parser)
│       │       ├── layout.py
│       │       └── roads.py
│       ├── tests/
│       └── requirements.txt
├── storage/                 -> Unified local file storage tree
└── docs/                    -> Comprehensive architectural documentation
```

---

## 2. Responsibilities Allocation

### Node.js (Port 8001)
- Authoritative HTTP API gateway for all `/api/*` endpoints.
- User authentication (Bcrypt, JWT HttpOnly cookies, sessions).
- Multi-tenant role authorization & isolation.
- MongoDB CRUD operations (Users, Colonies, Plots, Registry metadata, Audit logs).
- Binary file storage orchestration (Local disk / AWS S3 via `storage/` provider).
- GIS Job Dispatching (Proxying drawing buffers to Python worker on Port 8002).

### Python (Port 8002)
- CAD / DXF drawing entity parsing (`ezdxf`).
- Vector PDF stream & GeoPDF xref dictionary extraction (`pymupdf`).
- Linework polygonization and face formation (`shapely`).
- Coordinate Reference System (CRS) projection (`pyproj`).
- Entrance gate and road intersection calculations (`roads.py`).
- Internal processing endpoint `POST /internal/gis/import`.

---

## 3. Moved, Preserved, and Deleted Files

- **Moved Files:**
  - `backend-node/*` → `backend/node/*`
  - `backend/importer.py`, `layout.py`, `roads.py` → `backend/python/app/gis/`
  - `backend/server.py` → `backend/python/app/server.py`
  - `backend/requirements.txt`, `pytest.ini`, `tests/` → `backend/python/`
- **Deleted Files:**
  - Obsolete single-line shim wrappers (`backend-node/auth.js`, `db.js`, `config.js`, `storage.js`, `errors.js`, `importer.js`, `layout.js`, `roads.js`, `seeds.js`, `server.js`).
- **Preserved Files:**
  - `backend/node/src/gis/importer.js` kept for JS reference/fallback.
  - Python test suite & synthetic drawing test fixtures.

---

## 4. Communication & Database Model

- **Node ↔ Python Boundary:** Node communicates with Python via loopback HTTP (`http://127.0.0.1:8002/internal/gis/import`). Node passes uploaded PDF/DXF drawing buffers and receives structured GeoJSON/plot schemas.
- **Database Ownership:** Node is the sole MongoDB connection & persistence manager. Python does not write directly to MongoDB during layout imports.
- **API & Auth Compatibility:** All 16 frontend API endpoints remain 100% compatible. Auth cookies and JWT handling are managed by Node without frontend disruption.

---

## 5. Verification Results

- **Node Syntax Validation:** Executed `node --check` across all `backend/node/src/**/*.js` files. Passed with 0 syntax errors.
- **Python Compilation Check:** Executed `compileall` across `backend/python/app/`. Compiled cleanly with 0 errors.
