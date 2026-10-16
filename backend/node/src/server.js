import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "./app.js";
import { config } from "./config/index.js";
import { connectDb } from "./db/mongo.js";
import { createIndexes } from "./db/indexes.js";
import { seed, backfillEntrances } from "./db/seeds.js";
import { initStorage } from "./storage/index.js";

export { app };

export async function start() {
  await connectDb();
  await createIndexes();
  try {
    await initStorage();
    console.log("[livemap] storage initialized");
  } catch (e) {
    console.warn(`[livemap] storage init deferred: ${e.message}`);
  }
  await seed();
  backfillEntrances().catch((e) => console.error("[livemap] entrance backfill failed", e));
  const server = app.listen(config.port, config.host, () => {
    console.log(`[livemap] API listening on http://${config.host}:${config.port}`);
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
