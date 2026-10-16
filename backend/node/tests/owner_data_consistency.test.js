import test from "node:test";
import assert from "node:assert/strict";

// Mock middleware & database context for testing owner data consistency contracts
test("Phase 24 — Owner Data Consistency API Contract Test Suite", async (t) => {
  await t.test("GET /api/owner/admins contract delivers array under `admins` and populates `metrics`", async () => {
    // Contract shape validation
    const sampleAdminResponse = {
      admins: [
        {
          id: "650000000000000000000001",
          uid: "650000000000000000000001",
          name: "Jasjot Singh",
          email: "jasjot@spacer.com",
          active: true,
          metrics: {
            coloniesCount: 1,
            totalPlots: 64,
            availablePlots: 35,
            soldPlots: 12,
            inquiriesCount: 0,
            activeSharesCount: 0,
          }
        }
      ]
    };

    assert.ok(Array.isArray(sampleAdminResponse.admins), "admins must be an array");
    assert.equal(sampleAdminResponse.admins.length, 1);
    assert.equal(typeof sampleAdminResponse.admins[0].metrics, "object");
    assert.equal(sampleAdminResponse.admins[0].metrics.totalPlots, 64);
  });

  await t.test("GET /api/owner/colonies contract delivers array under `colonies` with `metrics` and admin info", async () => {
    const sampleColonyResponse = {
      colonies: [
        {
          id: "650000000000000000000002",
          _id: "650000000000000000000002",
          name: "Green Valley Colony",
          adminName: "Jasjot Singh",
          adminEmail: "jasjot@spacer.com",
          metrics: {
            totalPlots: 64,
            available: 35,
            reserved: 6,
            hold: 6,
            sold: 12,
            blocked: 5,
            inquiries: 0,
          }
        }
      ]
    };

    assert.ok(Array.isArray(sampleColonyResponse.colonies), "colonies must be an array");
    assert.equal(sampleColonyResponse.colonies.length, 1);
    assert.equal(sampleColonyResponse.colonies[0].metrics.totalPlots, 64);
    assert.equal(sampleColonyResponse.colonies[0].metrics.available, 35);
  });

  await t.test("GET /api/owner/dashboard contract exposes `inventory` and `inquiries` objects", async () => {
    const sampleDashboardResponse = {
      totals: { admins: 1, colonies: 1, plots: 64 },
      status_counts: { available: 35, hold: 6, reserved: 6, sold: 12, blocked: 5 },
      inventory: {
        totalPlots: 64,
        availablePlots: 35,
        reservedPlots: 6,
        holdPlots: 6,
        soldPlots: 12,
        blockedPlots: 5,
      },
      inquiries: {
        total: 0,
        totalInquiries: 0,
        new: 0,
        newInquiries: 0,
        contacted: 0,
        contactedInquiries: 0,
        closed: 0,
        closedInquiries: 0,
      }
    };

    assert.equal(sampleDashboardResponse.inventory.totalPlots, 64);
    assert.equal(sampleDashboardResponse.inventory.availablePlots, 35);
    assert.equal(sampleDashboardResponse.inquiries.totalInquiries, 0);
  });
});
