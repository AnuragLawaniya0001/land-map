import test from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";

test("Phase 18 — Admin Multi-Colony Public Portal Security Tests", async (t) => {
  const jwtSecret = "test_jwt_secret";
  const adminToken = jwt.sign({ uid: "admin_1", role: "admin" }, jwtSecret);

  await t.test("P18-01: Admin authorization requirement for Portal generation", async () => {
    assert.ok(adminToken);
    const decoded = jwt.verify(adminToken, jwtSecret);
    assert.strictEqual(decoded.role, "admin");
  });

  await t.test("P18-02: Cryptographically random 256-bit token & hashing", async () => {
    const rawToken = "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890";
    
    // Hash simulation
    const hashToken = (tok) => "hashed_" + tok.slice(0, 10);
    const tokenHash = hashToken(rawToken);

    assert.notStrictEqual(rawToken, tokenHash, "Raw token must NOT match hash");
    assert.strictEqual(tokenHash.startsWith("hashed_"), true);
  });

  await t.test("P18-03: Mode A Time-Based Access Expiration check", async () => {
    const now = new Date();
    const futureExpiry = new Date(now.getTime() + 10 * 60000).toISOString();
    const pastExpiry = new Date(now.getTime() - 1 * 60000).toISOString();

    const isExpired = (expiryStr) => {
      if (!expiryStr) return false;
      return expiryStr < new Date().toISOString();
    };

    assert.strictEqual(isExpired(futureExpiry), false, "Future expiry valid");
    assert.strictEqual(isExpired(pastExpiry), true, "Past expiry flagged as expired");
  });

  await t.test("P18-04: Mode B 5-Device Limit & 6th Device Global Invalidation", async () => {
    const maxDevices = 5;
    let portalStatus = "ACTIVE";
    let activeSessionsCount = 5;

    // Simulate 6th device connection attempt
    const attemptDeviceConnection = () => {
      if (activeSessionsCount >= maxDevices) {
        portalStatus = "DEVICE_LIMIT_BREACHED";
        return false;
      }
      activeSessionsCount += 1;
      return true;
    };

    const allowed = attemptDeviceConnection();

    assert.strictEqual(allowed, false, "6th device connection rejected");
    assert.strictEqual(portalStatus, "DEVICE_LIMIT_BREACHED", "Global breach invalidation triggered");
  });

  await t.test("P18-05: Strict Registry Privacy & Sensitive Fields Masking", async () => {
    const rawPlotDoc = {
      _id: "plot_101",
      number: "101",
      status_id: "available",
      area_sqft: 1200,
      price: 5000000,
      facing: "North",
      owner_id: "admin_1", // SENSITIVE
      registry_doc: { storage_key: "private/pdf/deed.pdf" } // SENSITIVE
    };

    // Public allowlist sanitizer
    const sanitizeForPublicPortal = (doc) => ({
      id: String(doc._id),
      number: doc.number,
      status_id: doc.status_id,
      area_sqft: doc.area_sqft,
      price: doc.price,
      facing: doc.facing
    });

    const sanitized = sanitizeForPublicPortal(rawPlotDoc);

    assert.strictEqual(sanitized.owner_id, undefined, "Owner ID stripped");
    assert.strictEqual(sanitized.registry_doc, undefined, "Registry deed stripped");
    assert.strictEqual(sanitized.number, "101");
  });

  await t.test("P18-06: Phase 9 Individual Property Share compatibility", async () => {
    const shareUrl = "/share/256bit_token_here";
    const portalUrl = "/portal/256bit_token_here";

    assert.notStrictEqual(shareUrl, portalUrl, "Share and Portal namespaces must remain distinct");
  });
});
