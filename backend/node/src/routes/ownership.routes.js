import express from "express";
import { dbHandle, ObjectId } from "../db/mongo.js";
import { HttpError, wrap } from "../utils/errors.js";
import { nowIso, getCurrentUser, requireAdmin, requireSuperAdmin, loadOwnedColony, auditLog } from "../middleware/auth.js";

const router = express.Router();

// 1. GET /api/admin/plots/:plotId/ownership — Get current owner and append-only ownership lineage
router.get(
  "/admin/plots/:plotId/ownership",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const db = dbHandle();
    const { plotId } = req.params;
    const plot = await db.collection("plots").findOne({ id: plotId });
    if (!plot) throw new HttpError(404, "Plot not found");

    await loadOwnedColony(plot.colony_id, req.user);

    // Fetch chronological append-only ownership history
    const history = await db
      .collection("property_ownership_history")
      .find({ plot_id: plotId })
      .sort({ created_at: 1 })
      .toArray();

    // Determine current active owner (record with effective_to === null)
    const currentRecord = history.find((h) => h.effective_to === null) || history[history.length - 1] || null;

    res.json({
      plot_id: plotId,
      colony_id: plot.colony_id,
      current_owner: currentRecord
        ? {
            party_name: currentRecord.party_name,
            party_phone: currentRecord.party_phone,
            party_email: currentRecord.party_email,
            ownership_type: currentRecord.ownership_type,
            effective_from: currentRecord.effective_from,
          }
        : null,
      history: history.map((h) => ({
        id: String(h._id),
        ownership_type: h.ownership_type, // ORIGINAL_BUYER or RESELLER
        transaction_type: h.transaction_type, // INITIAL_SALE, RESALE, TRANSFER
        party_name: h.party_name,
        party_phone: h.party_phone || "",
        party_email: h.party_email || "",
        effective_from: h.effective_from,
        effective_to: h.effective_to,
        previous_ownership_id: h.previous_ownership_id || null,
        registry_id: h.registry_id || null,
        registry_version: h.registry_version || null,
        created_by_name: h.created_by_name || "",
        created_at: h.created_at,
      })),
    });
  })
);

// 2. POST /api/admin/plots/:plotId/ownership/transfer — Resell/Transfer property & append new ownership record
router.post(
  "/admin/plots/:plotId/ownership/transfer",
  getCurrentUser,
  requireAdmin,
  wrap(async (req, res) => {
    const db = dbHandle();
    const { plotId } = req.params;
    const plot = await db.collection("plots").findOne({ id: plotId });
    if (!plot) throw new HttpError(404, "Plot not found");

    await loadOwnedColony(plot.colony_id, req.user);

    const body = req.body || {};
    const partyName = String(body.party_name || "").trim();
    if (!partyName) throw new HttpError(400, "New owner name is required");

    const partyPhone = String(body.party_phone || "").trim();
    const partyEmail = String(body.party_email || "").trim();
    const transactionType = body.transaction_type || "RESALE"; // INITIAL_SALE, RESALE, TRANSFER
    const effectiveFrom = body.effective_from || nowIso();
    const registryId = body.registry_id || null;

    // Fetch existing ownership lineage
    const history = await db
      .collection("property_ownership_history")
      .find({ plot_id: plotId })
      .sort({ created_at: 1 })
      .toArray();

    const previousRecord = history.find((h) => h.effective_to === null) || history[history.length - 1] || null;

    // Root validation: If no prior ownership exists, this must be ORIGINAL_BUYER
    let ownershipType = "RESELLER";
    if (!previousRecord) {
      ownershipType = "ORIGINAL_BUYER";
    }

    const now = nowIso();
    const newRecordId = new ObjectId();

    // Atomic / Sequential update: Close previous active owner record
    if (previousRecord) {
      await db.collection("property_ownership_history").updateOne(
        { _id: previousRecord._id },
        { $set: { effective_to: effectiveFrom, updated_at: now } }
      );
    }

    // Optional: Get registry version metadata if registryId attached
    let registryVersion = null;
    if (registryId) {
      const regDoc = await db.collection("registry").findOne({ id: registryId, plot_id: plotId });
      if (regDoc) {
        registryVersion = regDoc.version;
        // Associate registry document with ownership record
        await db.collection("registry").updateOne(
          { id: registryId },
          { $set: { ownership_id: String(newRecordId) } }
        );
      }
    }

    const newOwnershipDoc = {
      _id: newRecordId,
      plot_id: plotId,
      colony_id: plot.colony_id,
      ownership_type: ownershipType,
      transaction_type: transactionType,
      party_name: partyName,
      party_phone: partyPhone,
      party_email: partyEmail,
      previous_ownership_id: previousRecord ? String(previousRecord._id) : null,
      registry_id: registryId,
      registry_version: registryVersion,
      effective_from: effectiveFrom,
      effective_to: null, // Active owner
      created_by: req.user.id,
      created_by_name: req.user.name || "",
      created_at: now,
    };

    await db.collection("property_ownership_history").insertOne(newOwnershipDoc);

    // Update current owner summary reference on the plot document
    await db.collection("plots").updateOne(
      { id: plotId },
      {
        $set: {
          current_owner: {
            party_name: partyName,
            party_phone: partyPhone,
            party_email: partyEmail,
            ownership_type: ownershipType,
            effective_from: effectiveFrom,
          },
          updated_at: now,
        },
      }
    );

    const action = ownershipType === "ORIGINAL_BUYER" ? "OWNERSHIP_CREATED" : "OWNERSHIP_TRANSFERRED";
    await auditLog(req.user, action, "plot", plotId, {
      colonyId: plot.colony_id,
      metadata: {
        previous_owner: previousRecord ? previousRecord.party_name : null,
        new_owner: partyName,
        transaction_type: transactionType,
      },
      req,
    });

    res.status(201).json({
      success: true,
      ownership: {
        id: String(newRecordId),
        plot_id: plotId,
        colony_id: plot.colony_id,
        ownership_type: ownershipType,
        transaction_type: transactionType,
        party_name: partyName,
        party_phone: partyPhone,
        party_email: partyEmail,
        effective_from: effectiveFrom,
        effective_to: null,
        previous_ownership_id: previousRecord ? String(previousRecord._id) : null,
        created_at: now,
      },
    });
  })
);

// 3. GET /api/owner/inspection/plots/:plotId/ownership — Read-only Owner Governance Inspection of Lineage
router.get(
  "/owner/inspection/plots/:plotId/ownership",
  getCurrentUser,
  requireSuperAdmin,
  wrap(async (req, res) => {
    const db = dbHandle();
    const { plotId } = req.params;

    const plot = await db.collection("plots").findOne({ id: plotId });
    if (!plot) throw new HttpError(404, "Plot not found");

    // Strict parent chain validation
    const colony = await db.collection("colonies").findOne({ _id: new ObjectId(plot.colony_id) });
    if (!colony) throw new HttpError(404, "Plot not found");

    const history = await db
      .collection("property_ownership_history")
      .find({ plot_id: plotId })
      .sort({ created_at: 1 })
      .toArray();

    // Sanitize for Owner inspection (NO sensitive private notes or internal storage keys)
    const sanitizedLineage = history.map((h) => ({
      id: String(h._id),
      ownership_type: h.ownership_type,
      transaction_type: h.transaction_type,
      party_name: h.party_name,
      effective_from: h.effective_from,
      effective_to: h.effective_to,
      previous_ownership_id: h.previous_ownership_id || null,
      registry_version: h.registry_version || null,
      created_at: h.created_at,
    }));

    res.json({
      plot_id: plotId,
      colony: { id: String(colony._id), name: colony.name },
      history: sanitizedLineage,
    });
  })
);

export default router;
