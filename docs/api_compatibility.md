# API Compatibility Specification

**Project:** Interactive Land Mapping & Real Estate GIS Platform  
**Phase:** Phase 3 — Unify Python + Node Backends  
**Date:** October 3, 2026  

---

## Endpoint Mapping Table

The following table documents all endpoints consumed by the frontend and their routing integrity across the backend migration:

| Endpoint Path | Existing Backend | Unified Backend | HTTP Method | Auth Required | Status |
|---|---|---|---|---|---|
| `/api/auth/login` | Python / Node | Node Express (`auth.routes.js`) | `POST` | Public | **100% Compatible** |
| `/api/auth/logout` | Python / Node | Node Express (`auth.routes.js`) | `POST` | Public | **100% Compatible** |
| `/api/auth/me` | Python / Node | Node Express (`auth.routes.js`) | `GET` | Authenticated | **100% Compatible** |
| `/api/public/colonies/:slug` | Python / Node | Node Express (`public.routes.js`) | `GET` | Public | **100% Compatible** |
| `/api/admin/colonies` | Python / Node | Node Express (`colonies.routes.js`) | `GET`, `POST` | Admin / Super | **100% Compatible** |
| `/api/admin/colonies/:id` | Python / Node | Node Express (`colonies.routes.js`) | `GET`, `PATCH`, `DELETE` | Admin / Super | **100% Compatible** |
| `/api/admin/colonies/:id/geojson` | Python / Node | Node Express (`colonies.routes.js`) | `GET` | Admin / Super | **100% Compatible** |
| `/api/admin/plots/:id/status` | Python / Node | Node Express (`plots.routes.js`) | `PATCH` | Admin / Super | **100% Compatible** |
| `/api/admin/plots/bulk-status` | Python / Node | Node Express (`plots.routes.js`) | `PATCH` | Admin / Super | **100% Compatible** |
| `/api/admin/plots/:id/registry` | Python / Node | Node Express (`registry.routes.js`) | `GET`, `POST` | Admin / Super | **100% Compatible** |
| `/api/admin/registry/:docId/download` | Python / Node | Node Express (`registry.routes.js`) | `GET` | Admin / Super | **100% Compatible** |
| `/api/admin/users` | Python / Node | Node Express (`users.routes.js`) | `GET`, `POST` | Super Admin | **100% Compatible** |
| `/api/admin/users/:id` | Python / Node | Node Express (`users.routes.js`) | `PATCH`, `DELETE` | Super Admin | **100% Compatible** |
| `/api/admin/users/:id/reset-password` | Python / Node | Node Express (`users.routes.js`) | `POST` | Super Admin | **100% Compatible** |
| `/api/admin/dashboard` | Python / Node | Node Express (`dashboard.routes.js`)| `GET` | Admin / Super | **100% Compatible** |
| `/api/admin/audit-logs` | Python / Node | Node Express (`audit.routes.js`) | `GET` | Admin / Super | **100% Compatible** |
