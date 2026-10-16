import { MongoClient, ObjectId } from "mongodb";
import config from "../config/index.js";

let client;
let db;

export async function connectDb() {
  if (db) return db;
  client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(config.dbName);
  return db;
}

export function dbHandle() {
  if (!db) throw new Error("Database not connected — call connectDb() first");
  return db;
}

export function getDb() {
  return dbHandle();
}

export async function closeDb() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

export { ObjectId };
