# Backend Node Architecture & Structural Documentation

## 1. Overview & Directory Structure

The `backend-node/` repository has been reorganized into a production-ready, clean, maintainable modular structure under `src/`. Backward compatibility for root entry points and imports is preserved using facade re-exports at the project root.

```text
backend-node/
│
├── src/
│   ├── app.js
│   ├── server.js
│   │
│   ├── config/
│   │   ├── index.js
│   │   └── env.js
│   │
│   ├── db/
│   │   ├── mongo.js
│   │   ├── indexes.js
│   │   └── seeds.js
│   │
│   ├── middleware/
│   │   ├── auth.js
│   │   └── upload.js
│   │
│   ├── routes/
│   │   ├── index.js
│   │   ├── auth.routes.js
│   │   ├── public.routes.js
│   │   ├── users.routes.js
│   │   ├── dashboard.routes.js
│   │   ├── colonies.routes.js
│   │   ├── plots.routes.js
│   │   ├── registry.routes.js
│   │   └── audit.routes.js
│   │
│   ├── storage/
│   │   └── index.js
│   │
│   ├── gis/
│   │   ├── importer.js
│   │   ├── layout.js
│   │   └── roads.js
│   │
│   └── utils/
│       ├── errors.js
│       └── helpers.js
│
├── tests/
│   ├── storage.test.js
│   ├── importer-parity/
│   └── reference/
│
├── scripts/
│   └── probe/
│       ├── README.md
│       ├── tmp-probe-dxf.mjs
│       ├── tmp-probe-jsts.mjs
│       └── tmp-probe-pdf.mjs
│
├── storage/               # Runtime local file storage (runtime generated)
├── docs/
│   └── backend_architecture.md
│
├── auth.js                # Root facade re-export -> src/middleware/auth.js
├── config.js              # Root facade re-export -> src/config/index.js
├── db.js                  # Root facade re-export -> src/db/mongo.js & indexes.js
├── dev.js                 # Local dev launcher with embedded MongoDB option
├── errors.js              # Root facade re-export -> src/utils/errors.js
├── importer.js            # Root facade re-export -> src/gis/importer.js
├── layout.js              # Root facade re-export -> src/gis/layout.js
├── roads.js               # Root facade re-export -> src/gis/roads.js
├── seeds.js               # Root facade re-export -> src/db/seeds.js
├── server.js              # Root facade re-export -> src/server.js
├── storage.js            # Root facade re-export -> src/storage/index.js
├── .env
├── .env.example
├── package.json
└── README.md
```

---

## 2. Directory Responsibilities

| Directory / Module | Responsibility |
| :--- | :--- |
| `src/app.js` | Express app initialization, CORS, cookie parser, JSON body parser, route mounting (`/api`), static frontend fallback, error handling middleware. |
| `src/server.js` | Application bootstrap listener, database connection initialization, storage initialization, seed backfill, and HTTP port binding. |
| `src/config/` | Environment variable validation (`env.js`) and centralized configuration Object (`index.js`). |
| `src/db/` | MongoDB native driver connection pool (`mongo.js`), database collection index creation (`indexes.js`), and initial database seeding/backfills (`seeds.js`). |
| `src/middleware/` | JWT cookie parsing, role enforcement (Admin, Super Admin), colony ownership tenancy validation, audit logging (`auth.js`), and Multer memory storage file upload handler (`upload.js`). |
| `src/routes/` | Sub-routers for auth, public, users, dashboard, colonies, plots, registry, and audit logs, combined into a single router in `routes/index.js`. |
| `src/storage/` | Unified storage abstraction (`index.js`) supporting local disk and AWS S3 drivers, path traversal protection (`safeJoin`), filename sanitization, PDF buffer validation, and key generation. |
| `src/gis/` | GIS layout import logic (`importer.js`), SVG/geometry generation (`layout.js`), and OSM tile-based road & entrance detection (`roads.js`). |
| `src/utils/` | Custom HTTP errors and async wrapper (`errors.js`), string helpers (`slugify`), formatted colony output transformations, and WhatsApp default constants (`helpers.js`). |
| `tests/` | Unit and integration test suites, including unified storage interface tests (`storage.test.js`). |
| `scripts/` | Helper and probe scripts (`scripts/probe/`). |
| `storage/` | Runtime local storage directory for uploaded PDFs, DXF linework, registry files, and temporary processing buffers (excluded from source code). |

---

## 3. Application Entry Point & Dev Flow

- **Development Entry Point:** `npm run dev` executes `node dev.js`.
- `dev.js` starts an embedded in-memory MongoDB instance if `MONGO_URL` is unconfigured, then dynamically imports `src/server.js` and calls `start()`.
- **Production Entry Point:** `node src/server.js` (or `node server.js` facade).

---

## 4. Configuration & Database

- **Config:** Managed exclusively by `src/config/index.js` reading from `.env`. All getters, defaults, and type coercions remain 100% compatible.
- **Database:** Native MongoDB driver (`mongodb`) connection managed in `src/db/mongo.js`. No Mongoose/Prisma ORM introduced.

---

## 5. Authentication & API Compatibility

- **Cookie:** `access_token` HTTP-only cookie.
- **JWT:** Uses HMAC SHA-256 tokens signed with `JWT_SECRET`.
- **Routes:** All API endpoints preserve exact path signatures, HTTP verbs, payload keys, and response schemas:
  - `/api/public/colonies` & `/api/public/colonies/:slug`
  - `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`
  - `/api/admin/users*`
  - `/api/admin/dashboard` & `/api/admin/statuses`
  - `/api/admin/colonies*` (including GeoJSON export)
  - `/api/admin/plots/*`
  - `/api/admin/registry/*`
  - `/api/admin/audit-logs`

---

## 6. Relationship with Python Backend

- `backend-node` is the primary application backend delivering all web APIs, GIS ingestion, user management, and registry storage.
- The legacy `backend/` (FastAPI/Python) remains untouched as a specialized GIS reference / fallback worker.
