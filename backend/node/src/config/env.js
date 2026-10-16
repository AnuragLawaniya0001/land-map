import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  await import("dotenv/config");
} catch {
  // Environment variables supplied via CLI, system, or Node.js native --env-file
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bool = (v, def) => (v === undefined || v === "" ? def : String(v).toLowerCase() === "true");

const nodeEnv = process.env.NODE_ENV || "development";
const port = Number(process.env.PORT || 8001);
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL || "mongodb://127.0.0.1:27017";
const mongoDb = process.env.MONGODB_DB || process.env.DB_NAME || "spacer_land";
const jwtSecret = process.env.JWT_SECRET || "livemap-dev-secret-change-in-prod";

const internalGisSecret = process.env.INTERNAL_GIS_SECRET || "dev-internal-secret-key-change-in-prod";
const enablePythonFallback = bool(process.env.ENABLE_PYTHON_GIS_FALLBACK, true);

const ownerEmail = (process.env.OWNER_EMAIL || process.env.SUPER_ADMIN_EMAIL || "superadmin@livemap.local").toLowerCase().trim();
const ownerPassword = process.env.OWNER_PASSWORD || process.env.SUPER_ADMIN_PASSWORD || "SuperAdmin@2026";

// Startup validation for production
if (nodeEnv === "production") {
  const missing = [];
  if (!process.env.PORT && !port) missing.push("PORT");
  if (!process.env.MONGODB_URI && !process.env.MONGO_URL) missing.push("MONGODB_URI");
  if (!process.env.MONGODB_DB && !process.env.DB_NAME) missing.push("MONGODB_DB");
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");

  if (enablePythonFallback) {
    if (!process.env.INTERNAL_GIS_SECRET) {
      missing.push("INTERNAL_GIS_SECRET");
    }
  }

  if (missing.length > 0) {
    throw new Error(`Production startup aborted: Missing required environment variables: ${missing.join(", ")}`);
  }

  const insecureSecrets = [
    "CHANGE_ME_TO_A_LONG_RANDOM_SECRET",
    "livemap-dev-secret-change-in-prod",
    "secret",
    "password",
  ];
  if (insecureSecrets.includes(jwtSecret)) {
    throw new Error("Production startup aborted: Insecure JWT_SECRET detected. Please configure a strong, random secret.");
  }

  if (enablePythonFallback) {
    const insecureInternalSecrets = [
      "CHANGE_ME_TO_A_SECURE_RANDOM_SECRET",
      "dev-internal-secret-key-change-in-prod",
      "secret",
      "password",
    ];
    if (insecureInternalSecrets.includes(internalGisSecret) || !internalGisSecret.trim()) {
      throw new Error("Production startup aborted: Insecure or missing INTERNAL_GIS_SECRET detected. Please configure a strong, random internal secret.");
    }
  }
}


export const config = {
  nodeEnv,
  port,
  host: process.env.HOST || "0.0.0.0",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",

  mongodb: {
    uri: mongoUri,
    database: mongoDb,
  },
  // Backward compatibility aliases
  mongoUrl: mongoUri,
  dbName: mongoDb,

  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    cookieName: process.env.JWT_COOKIE_NAME || "access_token",
  },
  jwtSecret,
  jwtAlg: "HS256",
  tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS || 86400),

  cookie: {
    secure: bool(process.env.COOKIE_SECURE, nodeEnv === "production"),
    sameSite: process.env.COOKIE_SAME_SITE || process.env.COOKIE_SAMESITE || (nodeEnv === "production" ? "none" : "lax"),
  },
  cookieSecure: bool(process.env.COOKIE_SECURE, nodeEnv === "production"),
  cookieSameSite: process.env.COOKIE_SAME_SITE || process.env.COOKIE_SAMESITE || (nodeEnv === "production" ? "none" : "lax"),

  storage: {
    driver: (process.env.STORAGE_DRIVER || "local").toLowerCase(),
    localPath: process.env.LOCAL_STORAGE_PATH || process.env.STORAGE_DIR || "./storage",
    dir: process.env.STORAGE_DIR || (process.env.LOCAL_STORAGE_PATH ? path.resolve(__dirname, "..", "..", process.env.LOCAL_STORAGE_PATH) : path.join(__dirname, "..", "..", "storage")),
    maxUploadSizeMb: Number(process.env.MAX_UPLOAD_SIZE_MB || 50),
    s3: {
      bucket: process.env.S3_BUCKET || "",
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || "",
    },
  },
  maxRegistryVersions: 3,
  maxPdfBytes: Number(process.env.MAX_PDF_SIZE_MB || 50) * 1024 * 1024,
  maxLayoutBytes: Number(process.env.MAX_UPLOAD_SIZE_MB || 200) * 1024 * 1024,

  gis: {
    overpassUrl: process.env.OVERPASS_API_URL || "https://overpass-api.de/api/interpreter",
    internalSecret: internalGisSecret,
    pythonGisUrl: process.env.PYTHON_GIS_URL || "http://127.0.0.1:8000",
    enablePythonFallback: enablePythonFallback,
    pythonFallback: {
      enabled: enablePythonFallback,
      url: process.env.PYTHON_GIS_URL || "http://127.0.0.1:8000",
      internalSecret: internalGisSecret,
    },
  },


  owner: {
    email: ownerEmail,
    password: ownerPassword,
  },

  seed: {
    superAdminEmail: ownerEmail,
    superAdminPassword: ownerPassword,
    adminEmail: process.env.ADMIN_EMAIL || "admin@livemap.local",
    adminPassword: process.env.ADMIN_PASSWORD || "Admin@2026",
  },

  serveFrontend: bool(process.env.SERVE_FRONTEND, true),
  frontendDist: process.env.FRONTEND_DIST || path.join(__dirname, "..", "..", "..", "frontend", "dist"),
};

export default config;
