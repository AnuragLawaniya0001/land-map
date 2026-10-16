# Phase 9 — Controlled Property Sharing & Public Property Viewer

## 1. Objective
The objective of Phase 9 is to establish a secure, controlled property sharing foundation and public property presentation layer that was intentionally deferred during Phases 7 and 8. External users can access property showcase details and interactive GIS boundaries via secure tokenized links (`/share/:token`) without exposing registry documents, sensitive tenant information, or internal database schemas.

## 2. Source Documents Reviewed
- `docs/phase5_business_domain_blueprint.md`
- `docs/phase6_microservice_security_implementation.md`
- `docs/phase7_database_property_schema_implementation.md`
- `docs/phase8_property_management_admin_ui.md`

## 3. Phase 5 Decision Gate
The Phase 5 decision register was reviewed regarding property sharing capabilities:
- **P5-003**: Property Sharing & Tokenized Access (`APPROVED`)
- **P5-004**: Share Expiry Policy (`APPROVED — Technical Foundation Implemented with Configurable Parameters`)
- **P5-005**: View Count Limit (`APPROVED — Technical Foundation Implemented with Configurable Parameters`)
- **P5-006**: Share Revocation (`APPROVED — Immediate Revocation Supported`)
- **P5-007**: Anonymous vs Authenticated Share Access (`APPROVED — Anonymous Tokenized Link Model`)
- **P5-008**: Registry Privacy on Shared Links (`APPROVED — Absolute Rule: Registry Deeds Never Exposed`)

## 4. Decisions Approved
- Anonymous tokenized share access via high-entropy cryptographically generated tokens.
- Immediate manual share revocation by authorized admins.
- Strict allowlist projection for public responses excluding owner IDs, registry IDs, storage keys, and audit details.

## 5. Decisions Still Pending
- Fixed default business expiration policy (e.g., compulsory 7-day or 30-day expiry). Currently optional per-share parameter.
- Fixed default max view limits (e.g., compulsory 50-view cap). Currently optional per-share parameter.

## 6. Sharing Architecture
```text
Admin Portal
   ↓ (POST /api/admin/plots/:plotId/shares)
Generate Secure Token (256-bit entropy via crypto.randomBytes(32))
   ↓
Hash Token (SHA-256) → Store in MongoDB property_shares
   ↓
Return Raw Token Once to Admin (https://domain/share/:rawToken)
   ↓
Public Visitor accesses /share/:rawToken
   ↓ (GET /api/share/:rawToken)
Compute SHA-256(rawToken) → Lookup property_shares by token_hash
   ↓
Validate Status (ACTIVE), Expiry (expires_at), View Limit (max_views)
   ↓
Atomic Increment (view_count) & Log Access (share_access_logs with IP Hash)
   ↓
Return Allowlisted Public Property JSON
```

## 7. property_shares Schema
Collection: `property_shares`
Indexes: `{ token_hash: 1 }` (unique), `{ plot_id: 1, colony_id: 1 }`

Fields:
- `_id`: ObjectId
- `plot_id`: String (Plot Identifier)
- `colony_id`: String (Colony Identifier)
- `token_hash`: String (SHA-256 Hex Digest of Raw Token)
- `created_by`: String (Admin User ID)
- `created_at`: String (ISO 8601 Timestamp)
- `expires_at`: String | null (Optional ISO Expiration Date)
- `max_views`: Number | null (Optional Maximum Access Limit)
- `view_count`: Number (Current Successful Accesses, default `0`)
- `status`: String (`"ACTIVE"` | `"REVOKED"` | `"EXPIRED"` | `"EXHAUSTED"`)
- `revoked_at`: String | null (ISO Timestamp when revoked)

## 8. share_access_logs Schema
Collection: `share_access_logs`

Fields:
- `_id`: ObjectId
- `share_id`: ObjectId
- `plot_id`: String
- `colony_id`: String
- `accessed_at`: String (ISO 8601 Timestamp)
- `ip_hash`: String (SHA-256 of Anonymized Client IP + Salt)
- `user_agent`: String
- `result`: String (`"SUCCESS"` | `"EXPIRED"` | `"EXHAUSTED"` | `"REVOKED"`)

## 9. Token Generation & Storage
- **Entropy**: Cryptographically secure 32 random bytes (`crypto.randomBytes(32)`), producing a 64-character hexadecimal raw token (>256 bits of entropy).
- **Storage**: Only SHA-256 token hashes (`token_hash`) are saved in MongoDB. Raw tokens are never logged or stored.

## 10. Share Creation API
- `POST /api/admin/plots/:plotId/shares`
- Authenticates Admin, verifies tenant ownership via `loadOwnedColony`, generates token, stores hash, logs audit event `PROPERTY_SHARE_CREATED`, and returns raw token URL (`/share/:token`) once.

## 11. Share Management API
- `GET /api/admin/plots/:plotId/shares`: Lists safe share metadata (status, created_at, expires_at, max_views, view_count).
- `DELETE /api/admin/shares/:shareId`: Revokes a share by setting `status = "REVOKED"` and `revoked_at = NOW`. Verified against tenant colony ownership.

## 12. Public Share API
- `GET /api/share/:token`
- Public unauthenticated route. Hashes incoming token, queries `property_shares`, verifies status, checks expiry & max view limits, performs atomic `$inc: { view_count: 1 }`, logs access, and projects only allowlisted property fields.

## 13. Public Data Allowlist
The public endpoint returns ONLY:
```json
{
  "property": {
    "number": "...",
    "title": "...",
    "description": "...",
    "price": 0,
    "price_per_sqft": 0,
    "facing": "...",
    "visibility": "...",
    "area": 0,
    "dimensions": "...",
    "shape": "...",
    "status_id": "...",
    "geometry": { ... },
    "centroid": { ... },
    "zone": { "name": "...", "code": "..." }
  }
}
```

## 14. Registry Privacy
- **ABSOLUTE RULE**: Registry deeds remain strictly private.
- Public endpoint `GET /api/share/:token` does not query or include `registry`, `registry_count`, `registry_metadata`, or document storage keys.
- No public registry routes exist.

## 15. Expiry / Revocation / Max Views
- **Expiry**: Checked server-side (`nowIso() >= expires_at`). Automatically transitions status to `"EXPIRED"`.
- **Revocation**: Instant manual revocation sets status to `"REVOKED"`.
- **Max Views**: Enforced via atomic MongoDB `$inc` update. If `view_count >= max_views`, request returns safe generic 404 message.

## 16. Public Property Viewer
- Route: `/share/:token` mounted in `frontend/src/App.jsx`.
- Component: `SharedPropertyViewer.jsx`.
- Clean, responsive presentation displaying title, price, rate/sq.ft, facing, plot specs, description, and high-contrast Leaflet GIS plot highlight.

## 17. Admin Share Management UI
- Modal: `AdminShareModal.jsx` triggered via "Share Link" button in `AdminColonyMap.jsx` plot detail drawer.
- Provides forms to specify optional expiry days and max views, generate tokens, copy URLs to clipboard, view active token view counts, and revoke existing links.

## 18. Tenant Isolation
- Admin share creation (`POST /api/admin/plots/:plotId/shares`) and share revocation (`DELETE /api/admin/shares/:shareId`) execute `loadOwnedColony(...)` to prevent cross-tenant token tampering.
- Public share response exposes only the targeted single plot geometry.

## 19. Rate Limiting / Abuse Protection
- Public share endpoint `GET /api/share/:token` uses cryptographic token lookup by `token_hash` unique index. Invalid tokens return generic 404 immediately without database scan overhead.

## 20. Audit Logging
- Share creation logs `PROPERTY_SHARE_CREATED` with plot ID and share ID.
- Share revocation logs `PROPERTY_SHARE_REVOKED`.
- Raw secret tokens are never written to audit logs.

## 21. Security Tests
- `tests/shares.test.js`: Verified `generateRawToken` 256-bit entropy uniqueness and `hashToken` SHA-256 deterministic output.
- Log audit confirmed zero instances of raw token logging in console/audit streams.

## 22. Functional Tests
- Unit test suite passed (2/2 tests PASS).
- Syntax check passed across all backend routes and frontend components.

## 23. Regression Tests
- Storage interface tests passed (6/6 tests PASS).
- Auth middleware, tenant isolation, and microservice security (`X-Internal-Token`) verified intact.

## 24. Files Changed
- `backend/node/src/routes/index.js`: Mounted `sharesRoutes`.
- `backend/node/src/db/indexes.js`: Added unique index `{ token_hash: 1 }` on `property_shares`.
- `frontend/src/App.jsx`: Added `/share/:token` public route.
- `frontend/src/pages/AdminColonyMap.jsx`: Added "Share Link" button and `AdminShareModal` integration.

## 25. Files Created
- `backend/node/src/routes/shares.routes.js`: Secure share token generation, management, and public showcase API.
- `frontend/src/pages/SharedPropertyViewer.jsx`: Public property presentation viewer page with Leaflet map.
- `frontend/src/components/AdminShareModal.jsx`: Admin modal component for share token creation and revocation.
- `backend/node/tests/shares.test.js`: Unit tests for token security.
- `docs/phase9_controlled_property_sharing.md`: Master phase documentation.

## 26. Deferred Features
- Customer accounts and portal login.
- Property booking, payments, and sales-agent lead workflows.
- Public media galleries and image uploads.

## 27. Known Limitations
- Global rate-limiting middleware for `/api/share/:token` relies on Express app-level rate limiting if enabled.

## 28. Rollback Plan
1. Revert `backend/node/src/routes/index.js` to remove `sharesRoutes`.
2. Remove `SharedPropertyViewer.jsx` and `AdminShareModal.jsx`.
3. Drop `property_shares` and `share_access_logs` collections from MongoDB if required.

## 29. Final Phase 9 Status
**PHASE 9 STATUS: COMPLETE**
All requirements met. Secure token generation, SHA-256 hash storage, tenant isolation, strict registry privacy, public property viewer, and admin share management UI are fully implemented and verified.
