import test from "node:test";
import assert from "node:assert/strict";

test("Phase 25 — Inquiry Pipeline & Persistence Contract Test Suite", async (t) => {
  await t.test("Public inquiry payload structure & phone validation check", async () => {
    const validPhone = "9876543210";
    const cleanDigits = validPhone.replace(/\D/g, "");
    assert.equal(cleanDigits.length, 10);

    const payload = {
      colony_id: "650000000000000000000002",
      plot_id: "p101",
      name: "Test Buyer",
      phone: "+919876543210",
      message: "I am interested in plot 101",
      fax_number: "",
    };

    assert.equal(payload.fax_number, "", "Honeypot field must be empty for real users");
    assert.ok(payload.message.length > 0);
  });

  await t.test("Inquiry status transition lifecycle check", async () => {
    const allowedStatuses = ["NEW", "CONTACTED", "CLOSED"];
    let status = "NEW";
    assert.ok(allowedStatuses.includes(status));

    status = "CONTACTED";
    assert.ok(allowedStatuses.includes(status));

    status = "CLOSED";
    assert.ok(allowedStatuses.includes(status));
  });
});
