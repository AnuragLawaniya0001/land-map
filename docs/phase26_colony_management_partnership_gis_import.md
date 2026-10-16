# Phase 26 — Colony Management, Property Ownership/Partnership, Public Homepage Visibility, Permanent Preview Links & CAD/PDF GIS Import Workflow

## Executive Summary
Phase 26 delivers a comprehensive Colony Management system, flexible property ownership and partnership governance model, explicit public homepage visibility controls, secure session-authorized permanent preview links, and multi-format GIS source file import support (`.dwg`, `.dxf`, `.pdf`).

---

## 1. Ownership & Partnership Architecture
- **Super Admin Colony Creation**:
  - Super Admin can create colonies and optionally select a **Partner Admin** from active platform administrator accounts.
  - Partner Admins receive authorized access to manage plots, GIS imports, and view details for assigned partner colonies.
- **Admin Colony Creation**:
  - Admin-created colonies automatically derive `created_by`, `owner_id`, and `admin_id` from the authenticated Admin context.
  - Partner selection controls are hidden from regular Admins. Platform-wide Super Admin governance is automatically maintained.
- **Data Model Additions**:
  - `partner_admin_id` (ObjectId / string, nullable): References partner Admin user account.
  - `created_by_role` ("super_admin" | "admin"): Tracks creation context.
  - `is_public` (boolean): Controls homepage visibility (`true` = public, `false` = private).
  - `preview_token` (string, 64-char hex): Opaque cryptographic identifier for permanent preview links.

---

## 2. Public Homepage Visibility
- Super Admin and Colony Owners can explicitly toggle public visibility (`is_public` / `public_enabled`).
- Public homepage API (`GET /api/public/colonies`) filters out any colony where `is_public === false`.
- Private colonies remain fully accessible to authorized Super Admins, assigned Partner Admins, and session-authorized previews.

---

## 3. Permanent Live/Preview Links & Session Security Model
- **Permanent URL Format**: `/preview/:previewToken`
- **Security Rule**: The `preview_token` URL itself does **NOT** grant public access. Direct navigation to `/preview/:previewToken` without a valid preview session yields **403 Access Denied**.
- **Preview Session Flow**:
  1. Authenticated Owner/Admin clicks **Preview** button on their colony control panel card.
  2. Frontend sends `POST /api/admin/colonies/:colonyId/preview-session`.
  3. Server validates user permissions (`user.id === colony.owner_id || user.id === colony.partner_admin_id || user.role === 'super_admin'`).
  4. Server creates a session record in `preview_link_sessions` and sets an `HttpOnly` cookie (`preview_session_token`).
  5. Server returns `{ previewToken }` and opens `/preview/:previewToken` in a new tab.
  6. `/preview/:previewToken/data` route validates the `HttpOnly` cookie session token before delivering colony map GeoJSON payload.

---

## 4. GIS Source Upload & DWG / DXF / PDF Pipeline
- Colony creation and GIS import endpoints accept `.dwg`, `.dxf`, and `.pdf` files.
- Python GIS worker (`backend/python/app/services/importer.py`) processes DXF geometry and extracts layers/entities using `ezdxf` and `shapely`.
- DWG files are validated and passed through conversion pipelines.
- PDF maps serve as visual raster/vector references and overlay control layers.
- Geometry changes require explicit operator calibration and validation; **no auto-commit occurs**.

---

## 5. Test Suite & Verification Results
- **Node Backend Tests**: `node --test tests/*.test.js` executed cleanly: **65 / 65 PASSING**.
- **Frontend Build**: `npm run build` completed with **0 errors**.
- **Security Regression**: Tenant isolation, registry privacy, ownership lineage (Phase 19), public share tokens (Phase 9), and multi-colony portal tokens (Phase 18) remain 100% intact.
