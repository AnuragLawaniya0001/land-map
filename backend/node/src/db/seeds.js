import config from "../config/index.js";
import { dbHandle, ObjectId } from "./mongo.js";
import { hashPassword, nowIso } from "../middleware/auth.js";
import * as layout from "../gis/layout.js";
import { entranceFields } from "../gis/roads.js";

export const DEFAULT_WHATSAPP = "+91 90000 00000";

const STATUSES = [
  { id: "available", name: "Available", color: "#28c98b", description: "Ready for sale", sort_order: 1 },
  { id: "hold", name: "Hold", color: "#f2b84b", description: "Temporarily held", sort_order: 2 },
  { id: "reserved", name: "Reserved", color: "#55a8ff", description: "Reserved for buyer", sort_order: 3 },
  { id: "sold", name: "Sold", color: "#f06b5f", description: "Sale completed", sort_order: 4 },
  { id: "blocked", name: "Blocked", color: "#9aa6a3", description: "Not for sale", sort_order: 5 },
];

export async function seed() {
  const db = dbHandle();

  if ((await db.collection("statuses").countDocuments({})) === 0) {
    await db.collection("statuses").insertMany(STATUSES.map((s) => ({ ...s })));
  }

  const saEmail = config.seed.superAdminEmail;
  let sa = await db.collection("users").findOne({ email: saEmail });
  if (!sa) {
    await db.collection("users").insertOne({
      name: "LiveMap Super Admin",
      email: saEmail,
      phone: "",
      password_hash: hashPassword(config.seed.superAdminPassword),
      role: "super_admin",
      slug: "livemap",
      active: true,
      created_at: nowIso(),
    });
  }

  const admEmail = config.seed.adminEmail;
  let adm = await db.collection("users").findOne({ email: admEmail });
  if (!adm) {
    const res = await db.collection("users").insertOne({
      name: "Durga Realty",
      email: admEmail,
      phone: "+91 90000 00000",
      password_hash: hashPassword(config.seed.adminPassword),
      role: "admin",
      slug: "durga-realty",
      active: true,
      created_at: nowIso(),
    });
    adm = { _id: res.insertedId };
  }
  const admId = String(adm._id);

  let colony = await db.collection("colonies").findOne({ slug: "durga-enclave" });
  if (!colony) {
    const res = await db.collection("colonies").insertOne({
      name: "Durga Enclave",
      slug: "durga-enclave",
      owner_id: admId,
      location: "Darapura, Padra Taluka, Vadodara, Gujarat",
      description:
        "A gated residential enclave on open farmland beside the Darapura village road, with four zones, 60 plots, internal 9 m and 7.5 m roads, a central park, a children's garden and a lake-side green.",
      public_enabled: true,
      whatsapp_number: DEFAULT_WHATSAPP,
      created_at: nowIso(),
    });
    colony = await db.collection("colonies").findOne({ _id: res.insertedId });
  }

  if (colony.layout_version !== layout.LAYOUT_VERSION) {
    const cid = String(colony._id);
    const { colonyFields, zoneDocs, plotDocs } = layout.seedDocuments(cid, nowIso());
    await db.collection("zones").deleteMany({ colony_id: cid });
    await db.collection("plots").deleteMany({ colony_id: cid });
    await db.collection("registry").deleteMany({ colony_id: cid });
    await db.collection("zones").insertMany(zoneDocs);
    await db.collection("plots").insertMany(plotDocs);
    if (colonyFields.whatsapp_number === undefined) {
      colonyFields.whatsapp_number = colony.whatsapp_number ?? DEFAULT_WHATSAPP;
    }
    colonyFields.location = "Darapura, Padra Taluka, Vadodara, Gujarat";
    await db.collection("colonies").updateOne(
      { _id: colony._id },
      { $set: colonyFields, $unset: { garden: "" } },
    );
  }
}

export async function backfillEntrances() {
  const db = dbHandle();
  const cursor = db.collection("colonies").find({ layout_version: "imported", entry_checked: { $ne: true } });
  for await (const c of cursor) {
    let fields = {};
    try {
      const plots = await db.collection("plots").find(
        { colony_id: String(c._id) },
        { projection: { geometry: 1 } },
      ).toArray();
      fields = await entranceFields(c.boundary, plots.map((p) => p.geometry));
    } catch {
      fields = {};
    }
    fields.entry_checked = true;
    await db.collection("colonies").updateOne({ _id: c._id }, { $set: fields });
  }
}
