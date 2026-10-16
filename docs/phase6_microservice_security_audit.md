# PHASE 6 — MICROSERVICE SECURITY HARDENING AUDIT

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 6 — Microservice Security Hardening Audit  
**Audit Date:** October 4, 2026  
**Auditor Scope:** Node.js Express Backend (Port 8001) ↔ Python FastAPI GIS Microservice (Port 8002) Boundary  

---

## 1. Executive Security Summary

This document serves as the **single master source of truth** for the Phase 6 Microservice Security Audit of the Interactive Land Mapping & Real Estate GIS Platform.

### Overview & Architecture Scoping
The system architecture verified during this audit comprises:
- **Frontend Layer**: React + Vite SPA. Communicates with Node.js via HTTP API endpoints (`/api/*`) using HttpOnly JWT cookies (`access_token`).
- **Node.js Express Backend (`Port 8001`)**: Authoritative application layer owning user authentication, role enforcement, tenant isolation, database persistence (MongoDB), file storage orchestration, and GIS job dispatching.
- **Python FastAPI GIS Microservice (`Port 8002`)**: Specialized processing engine executing CAD parsing (`ezdxf`), vector PDF parsing (`pymupdf`), geometry polygonization (`shapely`), and CRS coordinate transformations (`pyproj`).

### Core Audit Finding
`SECURITY_GAP`: The internal communication boundary between Node.js and Python (`POST /internal/gis/import` on Port 8002) currently relies on **loopback binding (`127.0.0.1`) only**. Python does not authenticate Node request calls with an internal shared secret token or header, nor does it enforce timing-safe token validation. If any unauthorized process, container, or SSRF vulnerability reaches Port 8002, the Python GIS engine will execute file parsing operations without validating tenant context or application authentication.

### Risk & Severity Breakdown
- **CRITICAL Risk**: **0** (No remote unauthenticated public RCE vulnerabilities exposed on outer internet boundary).
- **HIGH Risk**: **1** (`P6-SEC-001` — Unauthenticated internal GIS microservice endpoint on Port 8002).
- **MEDIUM Risk**: **2** (`P6-SEC-002` — Missing fail-closed configuration enforcement for internal secrets in production; `P6-SEC-003` — Lack of rate limiting on internal loopback worker calls).
- **LOW Risk**: **1** (`P6-SEC-004` — Verbose Python exception detail returned to Node on failed imports).

---

## 2. Actual Service Inventory

| Service Name | Technology Stack | Port | Host Bind Address | Public/Internal Scope | Entry Point File | Current Security Protection |
|---|---|---|---|---|---|---|
| **Node.js Backend** | Express.js / ES Modules | 8001 | `0.0.0.0` | Public API Gateway | `backend/node/src/server.js` | JWT HttpOnly cookies, Bcrypt password hashing, Tenant Isolation (`loadOwnedColony`). |
| **Python GIS Worker** | FastAPI / Uvicorn | 8002 | `127.0.0.1` | Internal Loopback | `backend/python/app/server.py` | Loopback IP binding (`127.0.0.1`) ONLY. **No API key / header check.** |

---

## 3. Internal GIS Endpoint Audit

### Target Endpoint: `POST /internal/gis/import`
- **Location**: `backend/python/app/server.py` (Line 103).
- **HTTP Method**: `POST`
- **Request Format**: `multipart/form-data`
- **Accepted Fields**:
  - `file`: UploadFile (Raw drawing binary, PDF or DXF).
  - `maps_link`: Optional Form string (Google Maps pin link).
- **Authentication**: `VERIFIED: NONE`. The route handler `internal_import` does not attach FastAPI security dependencies or inspect headers.
- **Authorization**: `VERIFIED: NONE`.
- **Response Format**: `JSONResponse` returning GeoJSON boundary, plot polygons array, zones array, green areas, and entrance gate metadata.
- **Error Behavior**: Returns `HTTP 400 Bad Request` if file extension is not `.pdf` or `.dxf`. Returns raw Python traceback in `detail` field if PyMuPDF or ezdxf fails.

---

## 4. Node → Python Request Flow Trace

```text
1. Admin User uploads drawing via Frontend (AdminHome.jsx)
       │
       ▼
2. Node API Route: POST /api/admin/colonies (backend/node/src/routes/colonies.routes.js)
   └── Validates User Auth (getCurrentUser) & Tenant Admin Role (requireAdmin)
       │
       ▼
3. GIS Dispatch Route: POST /api/admin/gis/import (backend/node/src/routes/gis.routes.js)
   └── Checks config.gis.enablePythonFallback === true
   └── Reads file buffer from Multer memory storage
   └── Construct FormData with Blob([file.buffer])
       │
       ▼
4. Node Native Fetch: fetch("http://127.0.0.1:8002/internal/gis/import", { method: "POST", body: formData })
       │
       ▼
5. Python FastAPI Worker: POST /internal/gis/import (backend/python/app/server.py)
   └── Reads file bytes
   └── Executes importer.import_dxf_bytes() or import_pdf_bytes()
   └── Returns GeoJSON & Plot Schema JSON payload
       │
       ▼
6. Node receives Response JSON -> Persists Colony, Zones, and Plots into MongoDB -> Returns to Frontend
```

---

## 5. Current Internal Authentication Audit

`SECURITY_GAP`: Does Python currently validate that requests sent to `/internal/gis/import` originated from Node?  
**Result: NO.**

### Verified Header & Credential Absence
- Node `fetch()` in `backend/node/src/routes/gis.routes.js` (Line 37) does NOT set an `Authorization` or `X-Internal-Token` header.
- Python route handler in `backend/python/app/server.py` (Line 103) accepts any incoming HTTP POST request without token verification.
- **Classification**: `SECURITY_GAP` / `IMPLEMENTATION_REQUIRED`.

---

## 6. Loopback-Only Security Analysis

- **Current Host Binding**: Python FastAPI server is started via Uvicorn bound to `127.0.0.1:8002`.
- **Limitation of Loopback-Only Defense**:
  1. **Multi-Tenant / Shared Host Exposure**: On shared hosting or multi-process servers, any untrusted local script or compromised process running as any user on the same machine can send requests to `127.0.0.1:8002` and invoke expensive CPU-intensive GIS parsing operations.
  2. **Container / Pod Networking**: In Docker or Kubernetes deployments where containers share a network namespace, loopback protection does not prevent lateral container-to-container calls.
  3. **SSRF Vulnerabilities**: If an SSRF (Server-Side Request Forgery) vulnerability is ever introduced in any Node dependency or external API proxy, an attacker could force Node to fetch `http://127.0.0.1:8002/internal/gis/import`.

---

## 7. X-Internal-Token Design Specification (`TECHNICAL_RECOMMENDATION`)

### Shared Secret Architecture
To secure the microservice boundary, Node and Python must share a cryptographically secure internal token.

1. **Token Generation**: 256-bit random secret string generated via `crypto.randomBytes(32).toString('hex')` (64 hexadecimal characters).
2. **Environment Configuration**: Configured via environment variable `INTERNAL_GIS_SECRET`.
3. **Transmission Header**: `X-Internal-Token: <INTERNAL_GIS_SECRET>`.
4. **Timing-Safe Comparison**: Python must compare tokens using `hmac.compare_digest(provided_token, expected_token)` to prevent side-channel timing attacks.
5. **Secret Protection**: `INTERNAL_GIS_SECRET` must be added to `.env.example` as a placeholder (`CHANGE_ME_INTERNAL_GIS_SECRET`) and strictly excluded from Git tracking via `.gitignore`.

---

## 8. Node-Side Security Requirements (`PROPOSED`)

1. **Config Validation**: `backend/node/src/config/env.js` must parse `INTERNAL_GIS_SECRET` (defaulting to a dev placeholder in non-production).
2. **Production Startup Rule**: If `NODE_ENV=production` and `ENABLE_PYTHON_GIS_FALLBACK=true`, Node must **FAIL CLOSED** and refuse to start if `INTERNAL_GIS_SECRET` is missing or set to a default dev placeholder.
3. **Request Header Injection**: `backend/node/src/routes/gis.routes.js` must inject header `X-Internal-Token: config.gis.internalSecret` into the internal `fetch()` call.
4. **Safe Error Logging**: Node must sanitize request logs so `X-Internal-Token` is never written to console or log files.

---

## 9. Python-Side Security Requirements (`PROPOSED`)

1. **FastAPI Security Dependency / Middleware**: Define a reusable FastAPI dependency `verify_internal_token(x_internal_token: Optional[str] = Header(None, alias="X-Internal-Token"))`.
2. **Verification Logic**:
   - If `INTERNAL_GIS_SECRET` is not set in Python environment: Log warning in development; raise HTTP 500 in production.
   - If `x_internal_token` header is missing: Raise `HTTP 401 Unauthorized` (`detail="Missing internal authentication token"`).
   - If `hmac.compare_digest(x_internal_token, expected_secret)` is False: Raise `HTTP 403 Forbidden` (`detail="Invalid internal authentication token"`).
3. **Response Headers**: Include `X-Content-Type-Options: nosniff`.

---

## 10. Direct Access Test Plan (`IMPLEMENTATION_REQUIRED`)

| Test ID | Scenario Description | Action / Payload | Expected Status Code | Expected Response |
|---|---|---|---|---|
| **P6-T01** | Valid Internal Secret | Node passes correct `X-Internal-Token` header with DXF file | `HTTP 200 OK` | Normalized GeoJSON payload |
| **P6-T02** | Missing Internal Header | Direct request to Python `:8002` without `X-Internal-Token` | `HTTP 401 Unauthorized` | `{"detail": "Missing internal authentication token"}` |
| **P6-T03** | Invalid Secret Token | Request sent with `X-Internal-Token: wrong_secret_123` | `HTTP 403 Forbidden` | `{"detail": "Invalid internal authentication token"}` |
| **P6-T04** | Missing Production Secret | Node started in `production` mode without `INTERNAL_GIS_SECRET` | **Startup Abortion** | Error: Production startup aborted (Missing INTERNAL_GIS_SECRET) |
| **P6-T05** | Token Log Sanitization | Failed request logged in server console | `LOG SANITIZED` | Log contains `[REDACTED]` for secret header |

---

## 11. Secret Management Audit

- **Current Status**: `VERIFIED`. No `INTERNAL_GIS_SECRET` variable exists in `.env.example` or source code yet.
- **Git Tracking Verification**: Confirmed via `git status`. No `.env` files with actual secrets are tracked in Git.
- **Environment Template**: `.env.example` files in `backend/node/` and `backend/python/` will require `INTERNAL_GIS_SECRET` additions during implementation.

---

## 12. Logging & Error Leakage Audit

- **Node Logger**: Uses standard Express error handling. Header logging is disabled by default.
- **Python Logger**: FastAPI Uvicorn logs request path and status code. Request body headers are not printed to stdout.
- **Error Response Sanitization**: Python exceptions during GIS parsing currently return raw exception string messages (e.g. PyMuPDF error strings) in the JSON `detail` key. In production, Node should sanitize these messages before forwarding to the client.

---

## 13. File & Temporary Storage Security

- **Node Temp Buffer**: Node Multer uses `memoryStorage()` for drawing uploads (files kept in RAM buffer up to 25 MB). No temporary disk files created by Node.
- **Python Temp Files**: Python importer (`backend/python/app/gis/importer.py` Line 93) writes uploaded bytes to isolated system temp files via `tempfile.NamedTemporaryFile(delete=False)`.
- **Cleanup Audit**: Python temp files created during DXF/PDF parsing must be explicitly deleted in a `finally` block to prevent temp directory disk exhaustion.

---

## 14. Tenant Isolation Through GIS Pipeline

- **Tenant Scoping**: Node validates colony ownership (`loadOwnedColony`) BEFORE calling Python GIS worker.
- **Context Handoff**: Python GIS worker acts as a stateless pure geometry processing engine. It does not store user or colony records in MongoDB, eliminating cross-tenant data corruption risk.

---

## 15. Python Service Data Boundary

- **Input Boundary**: Accepts ONLY raw drawing file bytes (`file`) and optional map location string (`maps_link`). Receives zero user passwords, JWT tokens, or DB session keys.
- **Output Boundary**: Returns ONLY extracted spatial geometries (GeoJSON boundary, plot polygons, zones, greens, roads, entry gate).

---

## 16. Error & Failure Behavior Audit

- **Python Down / Unreachable**: Node fetch throws `ECONNREFUSED`. Node catches error in `gis.routes.js` and returns `HTTP 502 Bad Gateway` / `HTTP 422 Unprocessable Entity` ("GIS processing service unavailable").
- **Timeout Protection**: Node currently relies on default fetch timeout. A 60-second request timeout controller (`AbortSignal.timeout(60000)`) is recommended for internal worker calls.

---

## 17. Replay & Request Forgery Analysis

- **Replay Assessment**: Shared-secret authentication over `127.0.0.1` loopback is sufficient for single-host microservice deployments. Request nonces/timestamps are unnecessary for stateless file conversion calls unless multi-host remote networking is introduced later.

---

## 18. CORS, Network & Reverse Proxy Audit

- **Node Express CORS**: `cors({ origin: config.frontendUrl, credentials: true })`.
- **Python FastAPI CORS**: `CORSMiddleware(allow_origin_regex=".*")`.
- **Network Scope Recommendation**: Python FastAPI CORS middleware should be restricted to allow origin `http://127.0.0.1:8001` or removed entirely since Python is internal-only.

---

## 19. Production vs Development Security Configuration

| Configuration Setting | Development Target | Production Target |
|---|---|---|
| `INTERNAL_GIS_SECRET` | `dev-internal-secret-key-change-in-prod` | Cryptographically generated 256-bit secret |
| `NODE_ENV` | `development` | `production` |
| `ENABLE_PYTHON_GIS_FALLBACK` | `true` | `true` |
| Fail-Closed Secret Check | Log Warning | **ABORT STARTUP** |

---

## 20. Master Security Findings Table

| ID | Area | Finding | Evidence | Severity | Classification | Recommended Action |
|---|---|---|---|---|---|---|
| **P6-SEC-001** | Microservice Auth | Python `:8002` endpoint `/internal/gis/import` accepts calls without secret header validation. | `backend/python/app/server.py` L103 | **HIGH** | `SECURITY_GAP` | Add `X-Internal-Token` header check with `hmac.compare_digest`. |
| **P6-SEC-002** | Config Validation | Production Node startup does not validate `INTERNAL_GIS_SECRET` presence. | `backend/node/src/config/env.js` L21 | **MEDIUM** | `IMPLEMENTATION_REQUIRED` | Add fail-closed validation rule in `env.js` for production mode. |
| **P6-SEC-003** | Python CORS | Python FastAPI server enables wildcard CORS for all origins. | `backend/python/app/server.py` L910 | **LOW** | `TECHNICAL_RECOMMENDATION` | Restrict FastAPI CORS origins or disable CORS on internal routes. |
| **P6-SEC-004** | Temp File Cleanup | Python `_tmp()` helper creates temp files without explicit `try/finally` deletion. | `backend/python/app/gis/importer.py` L93 | **LOW** | `TECHNICAL_RECOMMENDATION` | Wrap temp file operations in `try/finally` blocks to un-link disk files. |

---

## 21. Required Implementation Changes

1. **Node Environment Config (`backend/node/src/config/env.js`)**:
   - Add `gis.internalSecret = process.env.INTERNAL_GIS_SECRET || "dev-internal-secret-key-change-in-prod"`.
   - Add production startup check enforcing `INTERNAL_GIS_SECRET`.
2. **Node GIS Dispatcher (`backend/node/src/routes/gis.routes.js`)**:
   - Add header `"X-Internal-Token": config.gis.internalSecret` to internal `fetch()` call.
3. **Python Server Entry (`backend/python/app/server.py`)**:
   - Add token verification dependency checking `X-Internal-Token` header against `os.environ.get("INTERNAL_GIS_SECRET")` using `hmac.compare_digest`.
   - Protect `internal_gis` router with `dependencies=[Depends(verify_internal_token)]`.
4. **Environment Templates (`.env.example`)**:
   - Add `INTERNAL_GIS_SECRET=CHANGE_ME_TO_A_LONG_RANDOM_INTERNAL_SECRET` to both Node and Python `.env.example` templates.

---

## 22. Ordered Implementation Plan

- **Step 1: Configuration Updates**: Define `INTERNAL_GIS_SECRET` in Node and Python `.env.example` files.
- **Step 2: Node Security Headers**: Update `backend/node/src/routes/gis.routes.js` to send `X-Internal-Token`.
- **Step 3: Python Auth Middleware**: Implement timing-safe token validation dependency in `backend/python/app/server.py`.
- **Step 4: Error Handling & Cleanup**: Wrap Python temp file handling in `try/finally` blocks.
- **Step 5: Verification & Tests**: Execute direct access tests (P6-T01 through P6-T05).

---

## 23. Safe Rollback Plan

If microservice token authentication causes unexpected issues in dev environments:
1. Set `ENABLE_PYTHON_GIS_FALLBACK=false` in `backend/node/.env` to safely fallback to Node internal parsers without restarting services.
2. In emergency scenarios, setting `INTERNAL_GIS_SECRET=""` in development mode will bypass header checks if non-production flag is active.

---

## 24. Security Test Matrix

| Test ID | Test Scenario | Expected Result | Current Status | Post-Implementation Status |
|---|---|---|---|---|
| **P6-T01** | Node sends valid `X-Internal-Token` | `HTTP 200 OK` + GeoJSON payload | `UNTESTED` | Expected `PASS` |
| **P6-T02** | Request to Python without token header | `HTTP 401 Unauthorized` | `UNTESTED` | Expected `PASS` |
| **P6-T03** | Request to Python with wrong token header | `HTTP 403 Forbidden` | `UNTESTED` | Expected `PASS` |
| **P6-T04** | Missing secret in production `NODE_ENV` | Startup Process Abort | `UNTESTED` | Expected `PASS` |

---

## 25. Phase 6 Decision Register

| Decision ID | Decision Title | Recommended Option | Final Status |
|---|---|---|---|
| **P6-D001** | Token Transmission Header | `X-Internal-Token` HTTP Header | `TECHNICAL_RECOMMENDATION` |
| **P6-D002** | Token Comparison Method | `hmac.compare_digest` (Timing-Safe) | `TECHNICAL_RECOMMENDATION` |
| **P6-D003** | Production Missing Secret Policy | Fail Closed (Abort Startup) | `TECHNICAL_RECOMMENDATION` |

---

## 26. Final Security Conclusion

```text
PHASE 6 STATUS: AUDIT COMPLETE — IMPLEMENTATION PENDING
```

The Phase 6 microservice security hardening audit has successfully identified the missing internal authentication header vulnerability (`P6-SEC-001`) between Node.js and Python. The complete architectural design, header specification, timing-safe validation logic, and test matrices are fully documented in this master file. 

The project is **100% READY FOR PHASE 6 IMPLEMENTATION**.
