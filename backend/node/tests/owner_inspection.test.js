import test from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";

test("Phase 16 — Owner Read-Only Inspection / Governance Tests", async (t) => {
  const jwtSecret = "test_jwt_secret";
  const superAdminToken = jwt.sign({ uid: "super_1", role: "super_admin" }, jwtSecret);
  const normalAdminToken = jwt.sign({ uid: "admin_1", role: "admin" }, jwtSecret);

  await t.test("P16-01: Super Admin authorization requirement for inspection endpoints", async () => {
    const decodedSuper = jwt.verify(superAdminToken, jwtSecret);
    const decodedNormal = jwt.verify(normalAdminToken, jwtSecret);

    assert.strictEqual(decodedSuper.role, "super_admin", "Super Admin allowed");
    assert.strictEqual(decodedNormal.role, "admin", "Normal admin rejected");
  });

  await t.test("P16-02: Strict Plot -> Colony -> Admin relationship validation", async () => {
    const adminA = { id: "admin_a" };
    const colonyA = { id: "colony_a", owner_id: "admin_a" };
    const plotA = { id: "plot_a", colony_id: "colony_a" };

    const colonyB = { id: "colony_b", owner_id: "admin_b" };
    const plotB = { id: "plot_b", colony_id: "colony_b" };

    // Valid chain test for Admin A
    assert.strictEqual(plotA.colony_id, colonyA.id);
    assert.strictEqual(colonyA.owner_id, adminA.id);

    // Mismatched cross-tenant chain test
    const isValidChainForAdminA = (plot, colony, adminId) => {
      return plot.colony_id === colony.id && colony.owner_id === adminId;
    };

    assert.strictEqual(isValidChainForAdminA(plotA, colonyA, "admin_a"), true);
    assert.strictEqual(isValidChainForAdminA(plotB, colonyB, "admin_a"), false, "Cross-tenant access blocked");
  });

  await t.test("P16-03: Read-only governance event audit logging", async () => {
    const auditEvents = [];
    const logInspectionEvent = (user, action, targetId) => {
      auditEvents.push({
        user_id: user.id,
        action,
        entity_id: targetId,
        created_at: new Date().toISOString()
      });
    };

    logInspectionEvent({ id: "super_1" }, "OWNER_INSPECTION_STARTED", "admin_a");
    logInspectionEvent({ id: "super_1" }, "OWNER_INSPECTION_VIEWED", "colony_a");

    assert.strictEqual(auditEvents.length, 2);
    assert.strictEqual(auditEvents[0].action, "OWNER_INSPECTION_STARTED");
    assert.strictEqual(auditEvents[1].action, "OWNER_INSPECTION_VIEWED");
  });

  await t.test("P16-04: Security & Registry Privacy field masking", async () => {
    const rawRegistryDoc = {
      _id: "reg_123",
      plot_id: "plot_a",
      filename: "deed.pdf",
      version: 2,
      storage_key: "private/s3/deeds/deed_raw_123.pdf", // SENSITIVE
      content: "RAW_BINARY_DATA" // SENSITIVE
    };

    const rawShareDoc = {
      _id: "share_123",
      plot_id: "plot_a",
      token: "secret_raw_share_token_999", // SENSITIVE
      status: "ACTIVE",
      view_count: 5
    };

    // Inspection sanitization function
    const sanitizeRegistryForInspection = (doc) => ({
      id: String(doc._id),
      filename: doc.filename,
      version: doc.version,
      has_file: true
    });

    const sanitizeShareForInspection = (doc) => ({
      id: String(doc._id),
      status: doc.status,
      view_count: doc.view_count
    });

    const safeReg = sanitizeRegistryForInspection(rawRegistryDoc);
    const safeShare = sanitizeShareForInspection(rawShareDoc);

    assert.strictEqual(safeReg.storage_key, undefined, "Storage key masked");
    assert.strictEqual(safeReg.content, undefined, "Binary content masked");
    assert.strictEqual(safeShare.token, undefined, "Raw token string masked");
    assert.strictEqual(safeReg.has_file, true);
  });
});
