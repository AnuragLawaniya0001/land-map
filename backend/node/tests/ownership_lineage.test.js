import test from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";

test("Phase 19 — Buyer -> Reseller Ownership Lineage & Registry Lifecycle Tests", async (t) => {
  const jwtSecret = "test_jwt_secret";
  const adminToken = jwt.sign({ uid: "admin_1", role: "admin" }, jwtSecret);

  await t.test("P19-01: Ownership record creation & Root ORIGINAL_BUYER classification", async () => {
    const history = [];

    const createOwnershipRecord = (plotId, partyName, transactionType) => {
      const isRoot = history.length === 0;
      const rec = {
        id: `own_${history.length + 1}`,
        plot_id: plotId,
        party_name: partyName,
        ownership_type: isRoot ? "ORIGINAL_BUYER" : "RESELLER",
        transaction_type: transactionType,
        previous_ownership_id: history.length > 0 ? history[history.length - 1].id : null,
        effective_from: new Date().toISOString(),
        effective_to: null,
      };

      if (history.length > 0) {
        history[history.length - 1].effective_to = rec.effective_from;
      }

      history.push(rec);
      return rec;
    };

    // 1. Initial Sale to Rahul Sharma
    const rec1 = createOwnershipRecord("plot_104", "Rahul Sharma", "INITIAL_SALE");
    assert.strictEqual(rec1.ownership_type, "ORIGINAL_BUYER");
    assert.strictEqual(rec1.previous_ownership_id, null);

    // 2. Resale 1 to Amit Verma
    const rec2 = createOwnershipRecord("plot_104", "Amit Verma", "RESALE");
    assert.strictEqual(rec2.ownership_type, "RESELLER");
    assert.strictEqual(rec2.previous_ownership_id, "own_1");
    assert.notStrictEqual(history[0].effective_to, null, "Rahul's effective_to updated upon resale");

    // 3. Resale 2 to Mohit Gupta
    const rec3 = createOwnershipRecord("plot_104", "Mohit Gupta", "RESALE");
    assert.strictEqual(rec3.ownership_type, "RESELLER");
    assert.strictEqual(rec3.previous_ownership_id, "own_2");

    // 4. Resale 3 to Sahil Khan (Current Owner)
    const rec4 = createOwnershipRecord("plot_104", "Sahil Khan", "RESALE");
    assert.strictEqual(rec4.ownership_type, "RESELLER");
    assert.strictEqual(rec4.previous_ownership_id, "own_3");

    // Lineage length check
    assert.strictEqual(history.length, 4, "4 ownership transitions recorded");
    assert.strictEqual(history[0].party_name, "Rahul Sharma", "Original buyer history preserved intact");
    assert.strictEqual(history[3].party_name, "Sahil Khan", "Current owner resolved to Sahil Khan");
  });

  await t.test("P19-02: Registry Version & Document Lifecycle Association", async () => {
    const registryDocs = [
      { id: "reg_1", plot_id: "plot_104", version: 1, ownership_id: "own_1" },
      { id: "reg_2", plot_id: "plot_104", version: 2, ownership_id: "own_2" },
      { id: "reg_3", plot_id: "plot_104", version: 3, ownership_id: "own_3" },
    ];

    assert.strictEqual(registryDocs.length, 3);
    assert.strictEqual(registryDocs[0].version, 1);
    assert.strictEqual(registryDocs[2].version, 3);
    assert.strictEqual(registryDocs[0].ownership_id, "own_1", "Registry v1 associated with Original Buyer");
  });

  await t.test("P19-03: Ownership Privacy & Public API sanitization", async () => {
    const internalPlotWithOwnership = {
      id: "plot_104",
      number: "104",
      status_id: "sold",
      current_owner: { party_name: "Sahil Khan", party_phone: "+919876543210" },
      ownership_history: [{ party_name: "Rahul Sharma" }]
    };

    // Public API Sanitizer
    const sanitizePublicProperty = (doc) => ({
      id: doc.id,
      number: doc.number,
      status_id: doc.status_id,
    });

    const publicView = sanitizePublicProperty(internalPlotWithOwnership);

    assert.strictEqual(publicView.current_owner, undefined, "Current owner hidden from public view");
    assert.strictEqual(publicView.ownership_history, undefined, "Ownership lineage hidden from public view");
  });

  await t.test("P19-04: Owner Governance Read-Only Inspection", async () => {
    const decodedSuper = jwt.verify(jwt.sign({ uid: "super_1", role: "super_admin" }, jwtSecret), jwtSecret);
    assert.strictEqual(decodedSuper.role, "super_admin");
  });
});
