# Phase 14 — Owner Control, Admin Management & Product Architecture Blueprint

## 1. Executive Summary
This document defines the comprehensive product architecture, role/authorization expansion model, multi-tenancy rules, public portal access mechanics, resale ownership lineage, CAD/PDF GIS import lifecycle, database schema design, and implementation sequencing for the next-generation evolution of the Jasjot Sir Spacer Land Platform.

**Zero production source code, APIs, database collections, or live business logic were modified during Phase 14.** All specifications herein serve as the authoritative blueprint for subsequent implementation phases (Phases 15–24).

---

## 2. Owner Requirements Summary
The platform owner requires the evolution of the platform from a simple developer tool into an enterprise-grade SaaS platform structured as:
```text
OWNER / SUPER ADMIN
        ↓
   MULTIPLE ADMINS (Tenants)
        ↓
   MULTIPLE COLONIES (Projects)
        ↓
     ZONES
        ↓
      PLOTS (Properties)
```
Key Owner Capabilities:
- Full platform-level governance and tenant administration via a dedicated configurable route (e.g., `/owners-panel`).
- Ability to inspect any admin's colonies, inventory statuses, public links, and sales activity without requiring admin passwords.
- Configurable Admin Public Portals allowing admins to share interactive multi-colony portfolios via time-bound and session-capped links.
- Immutable ownership and resale lineage tracking for plots (`Reseller 1 -> Reseller 2 -> Reseller 3`).
- CAD (.DXF) and PDF GIS layout processing with mandatory pre-commit import preview and coordinate calibration.

---

## 3. Current Platform Audit
- **Application Backend**: Node.js / Express on Port `8001` handling auth, tenant isolation, CRUD, MongoDB persistence, storage, and sharing.
- **GIS Microservice**: Python / FastAPI worker on Port `8002` handling CAD/PDF vector parsing, georeferencing, and geometry extraction, bound to `127.0.0.1` with `X-Internal-Token` HMAC validation.
- **Database**: MongoDB managing `users`, `colonies`, `zones`, `plots`, `registry`, `statuses`, `property_shares`, `share_access_logs`, `property_media`, `property_inquiries`, and `audit_logs`.
- **Storage**: Unified storage interface ([storage/index.js](file:///c:/Users/wasib/Desktop/Project/spacer%20map%20jasjot%20sir/backend/node/src/storage/index.js)) supporting local filesystem and AWS S3 object storage.

---

## 4. Current Architecture
```text
Frontend (React 19 + Vite)
      ↓ HttpOnly JWT Cookie
Node.js Express API :8001 ──(X-Internal-Token HMAC)──> Python FastAPI GIS :8002
      │
      ├── MongoDB (spacer_land)
      └── Unified Storage (Local / S3)
```

---

## 5. Target Architecture
```text
                                 OWNER / SUPER ADMIN
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   ▼                                             ▼
          Owner Control Panel                            Admin Workspaces
         (/owners-panel route)                          (/admin /superadmin)
                   │                                             │
                   ├──────────────────────┬──────────────────────┤
                   ▼                      ▼                      ▼
           Admin Governance       Analytics & Audit      Public Portals & Shares
       (Manage Admins, Scopes)    (Platform Monitoring)  (Time & Session Capped)
```

---

## 6. Owner / Super Admin Model
- **Role Identifier**: `super_admin`
- **Owner Control Panel Route**: Configurable route alias (e.g., `/owners-panel` mapped to `PortalRoute` with `PORTALS.owner`).
- **Owner Capabilities**: Full read/write access to all system tenants, admins, colonies, inventory, registry metadata, public links, inquiries, and platform audit logs.

---

## 7. Admin Model
- **Role Identifier**: `admin`
- **Admin Capabilities**: Full control over colonies owned by the admin (`owner_id = admin.id`).
- **Isolation Rule**: Admins can never inspect, modify, or list colonies, plots, media, inquiries, registry deeds, or share links belonging to other admins.

---

## 8. Permission Matrix
| Capability | `super_admin` | `admin` | Public Visitor |
| :--- | :--- | :--- | :--- |
| **Manage Admins / System Users** | **YES** | NO | NO |
| **Create / Edit / Delete Colonies** | **YES** (All) | **YES** (Owned) | NO |
| **Manage Plots & Pricing** | **YES** (All) | **YES** (Owned) | NO |
| **Attach / Download Registry Deeds** | **YES** (All) | **YES** (Owned) | **NEVER** |
| **Upload / Manage Property Media** | **YES** (All) | **YES** (Owned) | Read (Via Share) |
| **Generate Property Share Token** | **YES** (All) | **YES** (Owned) | NO |
| **Generate Admin Public Portal** | **YES** (All) | **YES** (Owned) | NO |
| **Access Shared Property Page** | **YES** | **YES** | **YES** (With Token) |
| **Submit Customer Inquiry** | NO | NO | **YES** (With Token) |
| **Review Customer Inquiries** | **YES** (All) | **YES** (Owned) | NO |
| **Audit Logs & Analytics** | **YES** (Platform) | **YES** (Tenant Scope) | NO |

---

## 9. Admin Tenancy Model
- Every colony maintains an `owner_id` string matching the creating `admin._id`.
- Helper function `loadOwnedColony(colonyId, user)` enforces tenant isolation:
  - If `user.role === 'super_admin'`: Access granted.
  - If `colony.owner_id === String(user._id)`: Access granted.
  - Otherwise: Throws `HttpError(404, "Colony not found")`.

---

## 10. Admin Inspection / Impersonation
- **Selected Model**: **Option B — Audited Context-Switching (Read-Only Inspection Mode)**.
- **Rules**:
  - Super admin selects an admin from the Owner Panel to view their environment.
  - Generates an audited session context: `{ actor_id: super_admin.id, target_admin_id: admin.id, mode: "INSPECTION" }`.
  - Displayed with an explicit top warning banner ("INSPECTING WORKSPACE OF ADMIN X").
  - Requires zero password knowledge; logouts or exits immediately restore super admin context.
  - Every action during inspection writes an audit log with `impersonator_id`.

---

## 11. Owner Dashboard
- **Owner Panel Metrics**:
  - Platform Totals: Admins, Colonies, Total Plots, Total Value.
  - Aggregate Status Breakdowns: Available, Booked, Hold, Sold, Blocked.
  - Admin Activity Leaderboard: Total Inquiries, Active Shared Links, Expired Links.
  - Real-Time Audit Feed: Sensitive write operations across all tenants.

---

## 12. Admin Dashboard
- **Tenant Workspace Metrics**:
  - My Colonies, My Plots, Status Distribution (Available, Sold, Reserved, Hold, Blocked).
  - My Property Media Count, Active Share Tokens, Customer Inquiries (`NEW`, `CONTACTED`, `CLOSED`).

---

## 13. Admin Public Portal
- **Concept**: A single tokenized link allowing an admin to showcase an entire curated portfolio of colonies.
- **Collection**: `admin_portal_shares`
- **Visibility Inheritance**:
  `Portal Share Active` ➔ `Admin Account Active` ➔ `Colony Public Enabled` ➔ `Plot Public Enabled`

---

## 14. Public Link Security
- **Raw Token Generation**: 32 random bytes (`crypto.randomBytes(32)`), producing a 64-char hex string (>256 bits entropy).
- **Storage**: Only SHA-256 digests (`token_hash`) stored in MongoDB.
- **Exposure**: Raw tokens returned once upon creation and never logged or exposed in list APIs.

---

## 15. Time-Based Expiry
- Configurable per link (`expires_at` timestamp).
- Checked server-side on every request (`nowIso() >= expires_at`). Returns safe HTTP 404 when expired.

---

## 16. Session / Device Expiry
- Configurable device session cap (`max_sessions`, e.g., 5 devices).
- **Device Limit Breach Rule**: When the 6th distinct device attempts access, the server marks `status = "EXHAUSTED"` and revokes the link for **all** devices immediately.
- Device identification utilizes salted SHA-256 hashes of client IP + User-Agent + session cookie tokens.

---

## 17. Existing Phase 9 Property Share Compatibility
- Both share scopes co-exist:
  1. `PROPERTY_SHARE` (Phase 9): Single plot showcase (`/share/:token`).
  2. `ADMIN_PORTAL_SHARE` (Phase 14): Multi-colony admin showcase (`/portal/:token`).
- Legacy Phase 9 links remain 100% operational.

---

## 18. Ownership & Resale Model
- Plot resale lineage is recorded immutably in `property_ownership_history`.
- Chain of Title: `Original Buyer ➔ Reseller 1 ➔ Reseller 2 ➔ Reseller 3`.
- Historical records are append-only and never overwritten or deleted.

---

## 19. Registry Chain
- Legal registry deeds (`registry` collection) attach to specific ownership history transactions.
- Up to 3 registry deed versions per plot allowed (`MAX_REGISTRY_VERSIONS = 3`).
- Registry deeds remain strictly private to authorized admins and super admins.

---

## 20. Sales Activity Model
- Decouples physical plot status from buyer negotiation state:
  - **Inventory Status**: `available`, `booked`, `hold`, `sold`, `blocked`.
  - **Sales Activity Stage**: `NO_DISCUSSION`, `INQUIRY`, `DISCUSSION`, `NEGOTIATION`, `TOKEN_RECEIVED`, `BOOKED`, `SOLD`, `LOST`.

---

## 21. GIS Import Architecture
```text
CAD (.DXF) / PDF Layout Drawing
               ↓
Upload to Node.js (/api/admin/colonies/import-preview)
               ↓
Forward to Python GIS Worker (/internal/gis/import)
               ↓
VectorLinework Parsing & Polygon Extraction
               ↓
Return Import Preview JSON (Plots, Zones, Roads, Greens, Bounds)
               ↓
Admin UI Preview & Manual Calibration Confirmation
               ↓
Commit to MongoDB (Colony + Plots + Zones)
```

---

## 22. CAD/PDF Processing
- Python `ezdxf` extracts DXF POLYLINE / LWPOLYLINE entities.
- Python `pdfplumber` / `pypdf` extracts vector paths and GeoPDF georeferencing metadata.

---

## 23. GIS Calibration
- If layout drawing lacks native CRS georeferencing:
  - Calculates bounding box centroid.
  - Aligns to admin-supplied Google Maps PIN or manual control points (3-point affine transformation).

---

## 24. Zone Architecture
- Collection: `zones`
- Fields: `id`, `colony_id`, `name`, `code`, `color`, `description`, `sort_order`, `geometry`.
- UI Toggle: "Zones View" displays colored polygon overlays and zone legends.

---

## 25. Status Architecture
- Visual map styling maps status IDs to high-contrast colors:
  - `available` (#22c55e - Green)
  - `booked` / `reserved` (#eab308 - Yellow)
  - `hold` (#f97316 - Orange)
  - `sold` (#ef4444 - Red)
  - `blocked` (#64748b - Slate Gray)

---

## 26. Public Viewer Controls
- **Control Bar**: 3D View, Reset Home, Zones Toggle, Status Toggle, Media Gallery, Search, GPS Geolocation, Brochure Download, Project Info, Google Maps Locate.

---

## 27. Gallery
- Property & Colony Image Galleries supported via `property_media` collection.
- Serves signed URLs; lazy loads secondary images.

---

## 28. Brochure System
- Admins attach project PDF/Image brochures to colonies.
- Access bound to active public portal share token.

---

## 29. Info
- Public drawer displays developer contact details, colony amenities, and location descriptions.

---

## 30. GPS
- Browser `navigator.geolocation` calculates visitor distance & bearing to colony bounds.

---

## 31. Locate
- One-click trigger opens Google Maps navigation (`https://www.google.com/maps/dir/?api=1&destination=LAT,LNG`).

---

## 32. Search
- Live search filtering by plot number, zone code, area range, or status with animated map fly-to transitions.

---

## 33. Proposed Database Models

### Collection: `admin_portal_shares`
```json
{
  "_id": "ObjectId",
  "id": "UUIDv4",
  "admin_id": "String (User ID)",
  "token_hash": "String (SHA-256 Hex)",
  "title": "String",
  "allowed_colony_ids": ["Array of Colony ObjectIds"],
  "expires_at": "ISO Date | null",
  "max_sessions": "Number | null",
  "session_count": "Number",
  "status": "ACTIVE | REVOKED | EXPIRED | EXHAUSTED",
  "created_at": "ISO Date",
  "revoked_at": "ISO Date | null"
}
```

### Collection: `public_link_sessions`
```json
{
  "_id": "ObjectId",
  "share_id": "UUIDv4",
  "session_hash": "String (SHA-256)",
  "ip_hash": "String",
  "user_agent_hash": "String",
  "first_seen": "ISO Date",
  "last_seen": "ISO Date"
}
```

### Collection: `property_ownership_history`
```json
{
  "_id": "ObjectId",
  "plot_id": "String",
  "colony_id": "String",
  "owner_name": "String",
  "owner_contact": "String",
  "transaction_type": "ORIGINAL_PURCHASE | RESALE | TRANSFER",
  "transaction_price": "Number",
  "transaction_date": "ISO Date",
  "registry_document_id": "String | null",
  "created_by": "String",
  "created_at": "ISO Date"
}
```

### Collection: `property_activity`
```json
{
  "_id": "ObjectId",
  "plot_id": "String",
  "colony_id": "String",
  "event_type": "STATUS_CHANGE | PRICE_UPDATE | INQUIRY | NEGOTIATION | BOOKING | SALE | RESALE",
  "description": "String",
  "actor_id": "String",
  "created_at": "ISO Date"
}
```

---

## 34. Index Strategy
- `admin_portal_shares`: `{ token_hash: 1 }` (unique), `{ admin_id: 1, status: 1 }`
- `public_link_sessions`: `{ share_id: 1, session_hash: 1 }` (unique)
- `property_ownership_history`: `{ plot_id: 1, transaction_date: -1 }`
- `property_activity`: `{ plot_id: 1, created_at: -1 }`

---

## 35. API Blueprint
```text
Owner Routes:
POST   /api/owner/admins                  - Create new admin tenant
GET    /api/owner/admins                  - List admin tenants & metrics
PATCH  /api/owner/admins/:id              - Deactivate/Activate admin
POST   /api/owner/inspect/:adminId        - Enter read-only inspection mode

Admin Portal Share Routes:
POST   /api/admin/portal-shares           - Create multi-colony portal link
GET    /api/admin/portal-shares           - List admin portal links
DELETE /api/admin/portal-shares/:id       - Revoke portal link

Ownership & Resale Routes:
GET    /api/admin/plots/:plotId/ownership - Get plot title history
POST   /api/admin/plots/:plotId/ownership - Record sale/resale transaction

Public Portal Routes:
GET    /api/public/portal/:token          - Access multi-colony portal showcase
```

---

## 36. Security Threat Analysis & Mitigations
- **Token Guessing**: 256-bit entropy renders brute-force token enumeration impossible.
- **Session Cap Bypass**: Atomic increment and distinct device hash tracking invalidates link on 6th device access.
- **Registry Exposure**: Hard-coded projection exclusion; registry collection never queried by public endpoints.
- **Microservice Bypassing**: Python GIS worker bound strictly to `127.0.0.1` requiring `X-Internal-Token`.

---

## 37. Tenant Isolation Model
- Database queries enforce `owner_id` constraints for regular admins. Super admin inspection sessions carry explicit audit logs.

---

## 38. Migration Strategy
- Fully additive schema expansion. Existing collections (`users`, `colonies`, `plots`, `registry`, `property_shares`) remain untouched.

---

## 39. Performance Considerations
- Public portal payloads use spatial indexing and single-query projections to stream geometry and signed image URLs efficiently.

---

## 40. Implementation Roadmap
- **Phase 15**: Owner / Super Admin Control Panel (`/owners-panel`).
- **Phase 16**: Multi-Admin Governance & Inspection Mode.
- **Phase 17**: CAD/PDF GIS Import Preview & Calibration.
- **Phase 18**: Admin Public Portals & Device Session Limits.
- **Phase 19**: Ownership History & Resale Lineage Tracking.
- **Phase 20**: Sales Activity Tracking & Advanced Public Viewer Controls.

---

## 41. Decision Register
| Decision ID | Subject | Approved Model | Status |
| :--- | :--- | :--- | :--- |
| **P14-001** | Owner Control Panel Route | Configurable route alias (e.g., `/owners-panel`) | `APPROVED` |
| **P14-002** | Owner Inspection Mode | Audited read-only context switching with top banner | `APPROVED` |
| **P14-003** | Public Portal Token Security | SHA-256 token hash storage with raw token return once | `APPROVED` |
| **P14-004** | Session Cap Enforcement | 6th device access marks status `EXHAUSTED` & invalidates link | `APPROVED` |
| **P14-005** | Ownership & Resale Lineage | Immutable append-only `property_ownership_history` | `APPROVED` |
| **P14-006** | GIS Import Lifecycle | Mandatory GIS Import Preview & Calibration before DB commit | `APPROVED` |
| **P14-007** | Registry Deed Privacy | Absolute Rule: Registry deeds remain 100% private | `APPROVED` |

---

## 42. Operational Risks
- **Device Fingerprint Ambiguity**: Client browser clearing may count as new device. Clear UX messaging required.

---

## 43. Deferred Decisions
- Redis session clustering (deferred until multi-server deployment is required).

---

## 44. Final Phase 14 Status

```text
Phase 14 Status:
COMPLETE

Architecture Audit:
PASS

Owner Model:
DEFINED

Admin Model:
DEFINED

Public Portal:
DEFINED

Public Link Security:
DEFINED

Ownership / Resale:
DEFINED

GIS Import:
DEFINED

Zones:
DEFINED

Status:
DEFINED

Database Blueprint:
PASS

API Blueprint:
PASS

Security Review:
PASS

Migration Strategy:
PASS

Implementation Roadmap:
PASS

Existing System Regression:
PASS

Production Code Modified:
NO

Files Created:
docs/phase14_owner_admin_product_architecture_blueprint.md

Files Changed:
None

Open Decisions:
None

Deferred:
Redis session clustering

Final Status:
COMPLETE
```
