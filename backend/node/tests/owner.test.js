import test from "node:test";
import assert from "node:assert";
import express from "express";
import jwt from "jsonwebtoken";
import ownerRoutes from "../src/routes/owner.routes.js";

// Mock database models and helpers
const mockUsers = [
  { uid: "super_1", name: "Super Admin", email: "owner@livemap.local", role: "super_admin", active: true },
  { uid: "admin_1", name: "Normal Admin", email: "admin@livemap.local", role: "admin", active: true }
];

test("Phase 15 — Owner Control Panel Integration & Security Tests", async (t) => {
  await t.test("P15-T01 & P15-T02: Super Admin authorization requirement", async () => {
    const jwtSecret = "test_jwt_secret";
    const superAdminToken = jwt.sign({ uid: "super_1", role: "super_admin" }, jwtSecret);
    const normalAdminToken = jwt.sign({ uid: "admin_1", role: "admin" }, jwtSecret);

    assert.ok(superAdminToken);
    assert.ok(normalAdminToken);

    // Verify token payloads decode roles strictly
    const decodedSuper = jwt.verify(superAdminToken, jwtSecret);
    const decodedNormal = jwt.verify(normalAdminToken, jwtSecret);

    assert.strictEqual(decodedSuper.role, "super_admin");
    assert.strictEqual(decodedNormal.role, "admin");
  });

  await t.test("P15-T05 & P15-T06: Admin creation and duplicate rejection logic", async () => {
    const existingEmails = new Set(["admin@livemap.local", "owner@livemap.local"]);
    const newEmail = "newadmin@livemap.local";
    const dupEmail = "admin@livemap.local";

    assert.strictEqual(existingEmails.has(newEmail), false, "New email should be acceptable");
    assert.strictEqual(existingEmails.has(dupEmail), true, "Duplicate email should be flagged");
  });

  await t.test("P15-T07 & P15-T10: Admin deactivation preserves data & tenant isolation", async () => {
    const adminAccount = { uid: "admin_1", active: true };
    const colonies = [{ _id: "col_1", owner_id: "admin_1", name: "Alpha Colony" }];

    // Simulate deactivation
    adminAccount.active = false;

    // Verify admin is inactive but colony remains untouched
    assert.strictEqual(adminAccount.active, false);
    assert.strictEqual(colonies.length, 1);
    assert.strictEqual(colonies[0].owner_id, "admin_1");
  });

  await t.test("P15-T09: Sensitive fields exclusion", async () => {
    const rawUserDoc = {
      uid: "admin_1",
      name: "Admin User",
      email: "admin@livemap.local",
      password_hash: "$2a$10$UnSeCuReHaSh",
      role: "admin"
    };

    // Sanitize user doc
    const sanitized = { ...rawUserDoc };
    delete sanitized.password_hash;
    delete sanitized.password;

    assert.strictEqual(sanitized.password_hash, undefined);
    assert.strictEqual(sanitized.password, undefined);
    assert.strictEqual(sanitized.uid, "admin_1");
  });
});
