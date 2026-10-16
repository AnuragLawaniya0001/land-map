import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { generateRawToken, hashToken } from "../src/routes/shares.routes.js";

test("Phase 9 — Share Token Generation & Hashing", async (t) => {
  await t.test("generateRawToken should return a 64-char hex string with high entropy", () => {
    const token1 = generateRawToken();
    const token2 = generateRawToken();
    assert.strictEqual(token1.length, 64);
    assert.strictEqual(token2.length, 64);
    assert.notStrictEqual(token1, token2);
  });

  await t.test("hashToken should deterministically SHA-256 hash tokens", () => {
    const token = "sample_raw_token_1234567890_abcdef";
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    const expected = crypto.createHash("sha256").update(token).digest("hex");
    assert.strictEqual(hash1, expected);
    assert.strictEqual(hash1, hash2);
  });
});
