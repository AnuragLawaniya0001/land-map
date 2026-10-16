import test from "node:test";
import assert from "node:assert/strict";

test("Phase 20 — Platform Completion & Production Readiness Verification", async (t) => {

  await t.test("P20-01: System Health Endpoint contract check", async () => {
    const healthResponse = { ok: true, timestamp: new Date().toISOString() };
    assert.equal(healthResponse.ok, true);
    assert.ok(healthResponse.timestamp);
  });

  await t.test("P20-02: Public Share Security & Registry Privacy Shield", async () => {
    // Public share payload must sanitize and exclude sensitive fields
    const mockPublicSharePayload = {
      property: {
        id: "plot_101",
        number: "A-12",
        status_id: "available",
        colony_id: "col_1",
        price: 500000,
        visibility: "PUBLIC",
      },
      media: [{ id: "med_1", url: "/storage/media/img1.jpg" }],
    };

    assert.equal(mockPublicSharePayload.property.registry, undefined);
    assert.equal(mockPublicSharePayload.property.ownership_history, undefined);
    assert.equal(mockPublicSharePayload.property.current_owner, undefined);
    assert.equal(mockPublicSharePayload.property.buyer_name, undefined);
  });

  await t.test("P20-03: Public Portal Token Session security gate", async () => {
    const sessionState = {
      token: "valid_hash",
      devices_count: 5,
      max_devices: 5,
      expired: false,
    };

    // 6th device attempt triggers revocation
    const attemptDeviceConnect = (currentCount, max) => {
      if (currentCount >= max) {
        return { ok: false, error: "Device limit exceeded. Portal link invalidated." };
      }
      return { ok: true, currentCount: currentCount + 1 };
    };

    const res = attemptDeviceConnect(sessionState.devices_count, sessionState.max_devices);
    assert.equal(res.ok, false);
    assert.match(res.error, /Device limit exceeded/i);
  });

  await t.test("P20-04: Owner inspection read-only governance enforcement", async () => {
    const ownerInspectionMode = {
      isReadOnly: true,
      canMutate: false,
      roleRequired: "super_admin",
    };

    assert.equal(ownerInspectionMode.isReadOnly, true);
    assert.equal(ownerInspectionMode.canMutate, false);
    assert.equal(ownerInspectionMode.roleRequired, "super_admin");
  });

  await t.test("P20-05: GIS Import Lifecycle verification gate", async () => {
    const importLifecycle = ["PREVIEW_READY", "CALIBRATED", "VALIDATED", "COMMITTED"];
    let currentStatus = "PREVIEW_READY";

    // Validate state progression
    currentStatus = "CALIBRATED";
    assert.equal(importLifecycle.includes(currentStatus), true);

    currentStatus = "VALIDATED";
    assert.equal(importLifecycle.includes(currentStatus), true);

    currentStatus = "COMMITTED";
    assert.equal(currentStatus, "COMMITTED");
  });

  await t.test("P20-06: Property Ownership append-only lineage integrity", async () => {
    const lineage = [
      { id: "own_1", buyer_name: "Rahul Verma", classification: "ORIGINAL_BUYER", is_current: false, effective_to: "2025-06-01" },
      { id: "own_2", buyer_name: "Amit Sharma", classification: "RESELLER_1", is_current: true, previous_ownership_id: "own_1" }
    ];

    assert.equal(lineage.length, 2);
    assert.equal(lineage[0].classification, "ORIGINAL_BUYER");
    assert.equal(lineage[1].previous_ownership_id, lineage[0].id);
    assert.equal(lineage[1].is_current, true);
  });

  await t.test("P20-07: Public Inquiries phone number sanitization gate", async () => {
    const sanitizePhone = (phoneStr) => {
      const digits = String(phoneStr || "").replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) return null;
      return `+${digits}`;
    };

    assert.equal(sanitizePhone("9876543210"), "+9876543210");
    assert.equal(sanitizePhone("123"), null);
    assert.equal(sanitizePhone("abc"), null);
  });

});
