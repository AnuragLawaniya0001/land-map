/**
 * Local development bootstrap: runs an in-process MongoDB (mongodb-memory-server)
 * with a persistent data directory, then starts the API. No system MongoDB needed.
 *
 *   node dev.js
 *
 * Set MONGO_URL (or put it in .env) to use a real MongoDB instead.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startEmbeddedMongo() {
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const dbPath = path.join(__dirname, ".mongo-data");
  fs.mkdirSync(dbPath, { recursive: true });
  const mongod = await MongoMemoryServer.create({
    instance: {
      port: Number(process.env.MONGO_PORT || 27017),
      dbName: process.env.DB_NAME || "livemap",
      dbPath,
      storageEngine: "wiredTiger",
    },
  });
  console.log(`[livemap] embedded MongoDB ready at ${mongod.getUri()} (data kept in backend-node/.mongo-data)`);
  return mongod;
}

if (!process.env.MONGO_URL) {
  const mongod = await startEmbeddedMongo();
  process.env.MONGO_URL = mongod.getUri();
  const shutdown = async () => {
    await mongod.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const { start } = await import("./src/server.js");
await start();
