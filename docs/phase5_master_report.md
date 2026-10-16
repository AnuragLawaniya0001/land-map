# Phase 5 — Business Domain Blueprint & Master Architecture Specification

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 5 — Business Domain & Access Model Design  
**Date:** October 3, 2026  

---

## 1. Executive Summary

This document specifies the target business domain, access control model, property sharing mechanics, and database/API expansion blueprints for the Interactive Land Mapping Platform. 

---

## 2. Master Domain Architecture

```text
Platform Layer (Express API :8001 / FastAPI GIS :8002 / MongoDB)
   │
   ├── Super Admin (`super_admin`)
   │
   └── Tenant / Developer (`admin`)
          │
          └── Project / Colony (`colonies` collection)
                 │
                 ├── Zones (`zones` collection)
                 │
                 ├── GIS Vector Layout (PDF / DXF extracted linework & polygons)
                 │
                 └── Properties / Plots (`plots` collection)
                        │
                        ├── Status System (Available, Hold, Reserved, Sold, Blocked)
                        ├── Property Data (Pricing, Dimensions, Media)
                        ├── Private Registry Deeds (`registry` collection)
                        └── Share Links (`property_shares` collection)
```

---

## 3. Access Control & Visibility Model

- **Private Visibility**: Default state. Accessible only to authenticated Tenant Admin and Super Admin accounts.
- **Public Visibility**: Accessible to anonymous visitors via published colony URL (`/api/public/colonies/:slug`). Exposes map layout, plot numbers, area, and availability status. Does NOT expose private registry deeds.
- **Shared Visibility**: Accessible to buyers/customers possessing an unguessable 256-bit secret token URL (`/share/:token`). Exposes specific plot details, pricing, and media gallery. Private registry deeds remain strictly protected.

---

## 4. Roles & Permissions Matrix

| Permission / Action | Anonymous Public | Customer (Share Token) | Admin (Colony Owner) | Super Admin (Platform Owner) |
| :--- | :---: | :---: | :---: | :---: |
| View Public Map & Statuses | ✅ | ✅ | ✅ | ✅ |
| View Plot Pricing & Dimensions | ❌ | ✅ | ✅ | ✅ |
| View Public Property Media | ❌ | ✅ | ✅ | ✅ |
| Submit Public Inquiry | ✅ | ✅ | ✅ | ✅ |
| Update Plot Availability | ❌ | ❌ | ✅ (Owned Colonies) | ✅ (All Colonies) |
| Upload & View Private Registry Deeds | ❌ | ❌ | ✅ (Owned Colonies) | ✅ (All Colonies) |
| Generate Property Share Links | ❌ | ❌ | ✅ (Owned Colonies) | ✅ (All Colonies) |
| Manage Colony & GIS Import | ❌ | ❌ | ✅ (Owned Colonies) | ✅ (All Colonies) |
| Create/Manage Admin Users | ❌ | ❌ | ❌ | ✅ |

---

## 5. Proposed Implementation Roadmap & Decisions

- **Phase 6 — Security Hardening**: Implement internal shared secret header (`X-Internal-Token`) between Node and Python GIS microservice.
- **Phase 7 — Database & Property Schema**: Add pricing, dimensions, and visibility fields to `plots` collection; create `property_shares` collection.
- **Phase 8 — Property Sharing & Token APIs**: Implement `POST /api/admin/plots/:id/shares`, `DELETE /api/admin/shares/:shareId`, and public `GET /api/share/:token`.
- **Phase 9 — Shared Property Viewer UI**: Build React frontend landing page `/share/:token` and share management modal.
- **Phase 10 — Real-World GIS Validation**: Test production client CAD/PDF files when provided.
