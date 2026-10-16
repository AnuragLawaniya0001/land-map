import { dbHandle } from "./mongo.js";

export async function createIndexes() {
  const D = dbHandle();
  await D.collection("users").createIndex({ email: 1 }, { unique: true });
  await D.collection("users").createIndex({ slug: 1 }, { unique: true, sparse: true });
  await D.collection("colonies").createIndex({ slug: 1 }, { unique: true, sparse: true });
  await D.collection("colonies").createIndex({ owner_id: 1 });
  await D.collection("plots").createIndex({ colony_id: 1, number: 1 });
  await D.collection("plots").createIndex({ colony_id: 1, status_id: 1 });
  await D.collection("plots").createIndex({ colony_id: 1, visibility: 1 });
  await D.collection("zones").createIndex({ colony_id: 1 });
  await D.collection("login_attempts").createIndex({ identifier: 1 }, { unique: true });
  await D.collection("property_shares").createIndex({ token_hash: 1 }, { unique: true });
  await D.collection("property_shares").createIndex({ plot_id: 1, colony_id: 1 });
  await D.collection("property_media").createIndex({ plot_id: 1, sort_order: 1 });
  await D.collection("property_media").createIndex({ plot_id: 1, is_primary: -1 });
  await D.collection("property_inquiries").createIndex({ colony_id: 1, status: 1 });
  await D.collection("property_inquiries").createIndex({ plot_id: 1 });
  await D.collection("gis_imports").createIndex({ colony_id: 1, status: 1 });
  await D.collection("gis_imports").createIndex({ owner_id: 1 });
  await D.collection("admin_portal_shares").createIndex({ token_hash: 1 }, { unique: true });
  await D.collection("admin_portal_shares").createIndex({ owner_id: 1 });
  await D.collection("public_link_sessions").createIndex({ session_token_hash: 1 }, { unique: true });
  await D.collection("public_link_sessions").createIndex({ share_id: 1 });
  await D.collection("property_ownership_history").createIndex({ plot_id: 1, is_current: 1 });
  await D.collection("property_ownership_history").createIndex({ colony_id: 1 });
  await D.collection("audit_logs").createIndex({ colony_id: 1, created_at: -1 });
  await D.collection("audit_logs").createIndex({ user_id: 1, created_at: -1 });
}


