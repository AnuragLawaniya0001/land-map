# Phase 28 — Property Management UI Unification, Inline Status Control & Registry-Gated Sold Workflow

## Overview
Phase 28 establishes a unified sidebar layout architecture across all admin screens, instant inline status transitions without requiring redundant save buttons, and a strict registry-gated **Sold** workflow.

---

## Key Changes & Implementations

### 1. Sidebar & Layout Unification
- Enforced uniform layout shell using `AdminLayout` for both Super Admin and Partner Admin portals.
- Maintained responsive sidebar with brand identity, role-based navigation links, user profile details, theme support, and logout controls.
- Kept the colony map header, map/plot-list toggle tabs, GIS Import, Settings, GeoJSON download, and Public View buttons intact.

### 2. Instant Inline Status Control
- Converted property status chips on the right-side detail panel into instant-saving controls.
- Normal transitions (`Available`, `Hold`, `Reserved`, `Blocked`) immediately trigger the backend status update API (`PATCH /api/admin/plots/:plotId/status`).
- Showing inline `(Updating…)` indicator during requests without reloading the page or blocking the entire UI.
- Map polygon fill colors and Plot List status badges update dynamically upon server confirmation.

### 3. Registry-Gated Sold Workflow
- Changed the business workflow so registry document attachment is required **BEFORE** a plot can be marked `Sold`.
- Selecting `Sold` for a plot without existing registry documents triggers the **Complete Sale** modal.
- Uploading a PDF deed via the modal invokes `POST /api/admin/plots/:plotId/sold` which atomically saves the registry document, updates the plot status to `Sold`, records status history, and writes audit logs in one operation.
- Updated wording from `"Registry upload unlocks once the plot is marked Sold"` to `"Registry document is required before this plot can be marked Sold."`

### 4. Backend Gating & Security
- Updated `PATCH /api/admin/plots/:plotId/status` and `PATCH /api/admin/plots/bulk-status` to reject `sold` transitions if no registry document exists for the target plot(s).
- Added `POST /api/admin/plots/:plotId/sold` endpoint accepting `multipart/form-data` for atomic upload and status commitment.
- Preserved tenant isolation, HttpOnly authentication, R2 private storage for registry files, maximum 3-version registry cap, and Phase 19 ownership lineage rules.

---

## API Summary

| Method | Path | Description |
| :--- | :--- | :--- |
| `PATCH` | `/api/admin/plots/:plotId/status` | Updates plot status. Returns error 400 if target is `sold` without a registry. |
| `POST` | `/api/admin/plots/:plotId/sold` | Atomic registry upload + status update to `Sold`. Returns updated plot and registry objects. |
| `PATCH` | `/api/admin/plots/bulk-status` | Updates status for multiple plots. Rejects `sold` if any selected plot lacks a registry. |

---

## Verification & Testing

- **Backend Unit Tests**: Added `tests/phase28_property_status_registry.test.js` validating normal status transitions, registry gating on Sold, atomic Sold workflow, status history logging, and registry version cap.
- **Suite Execution**: Ran all 71 node unit tests across 14 test suites (`npm test`) with 100% pass rate.
- **Frontend Build**: Executed `npm run build` with Vite, producing a clean production build (`dist/index.html`).
