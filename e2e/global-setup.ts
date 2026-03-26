import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { exportJWK, generateKeyPair } from "jose";

import {
  createTestAccount,
  createTestRole,
  resetAccountDefaults,
} from "./helpers/setup-db";

/**
 * Resolve DATA_DIR the same way the app does:
 * process.env → .env.local → default "./data".
 */
function getDataDir(): string {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);

  try {
    const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
    const match = envFile.match(/^DATA_DIR=(.+)$/m);
    if (match) return resolve(match[1].trim());
  } catch {
    // .env.local not found — use default
  }

  return resolve("data");
}

/**
 * Generate an ES256 JWT signing key if one doesn't already exist.
 * The dev server's `instrumentation.ts` calls `loadSigningKeys()` and
 * throws if the key file is absent, so we must create it before the
 * webServer starts.
 */
async function ensureJwtSigningKey(): Promise<void> {
  const dataDir = getDataDir();
  const keysDir = resolve(dataDir, "keys");
  const keyPath = resolve(keysDir, "jwt-signing.json");

  if (existsSync(keyPath)) return;

  console.log(`[e2e] Generating JWT signing key at ${keyPath}`);

  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });

  const kid = randomUUID();
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  privateJwk.kid = kid;
  publicJwk.kid = kid;

  mkdirSync(keysDir, { recursive: true });
  writeFileSync(
    keyPath,
    JSON.stringify(
      {
        kid,
        algorithm: "ES256",
        privateKey: privateJwk,
        publicKey: publicJwk,
      },
      null,
      2,
    ),
    "utf8",
  );
}

const WORKER_PASSWORD = "WorkerPass1234!";
const WORKER_ROLE = "E2E Test Admin";
const MAX_WORKERS = 8;

// All permissions — same as System Administrator, but with a different
// role name so worker accounts don't count toward the System Admin limit.
const ALL_PERMISSIONS = [
  "accounts:read",
  "accounts:write",
  "accounts:delete",
  "roles:read",
  "roles:write",
  "roles:delete",
  "customers:read",
  "customers:write",
  "customers:delete",
  "customers:access-all",
  "audit-logs:read",
  "system-settings:read",
  "system-settings:write",
  "dashboard:read",
  "dashboard:write",
];

async function ensureWorkerAccounts(): Promise<void> {
  await createTestRole(WORKER_ROLE, ALL_PERMISSIONS, "E2E worker role");
  for (let i = 0; i < MAX_WORKERS; i++) {
    const username = `e2e-worker-${i}`;
    await createTestAccount(username, WORKER_PASSWORD, WORKER_ROLE);
    await resetAccountDefaults(username);
  }
}

export default async function globalSetup(): Promise<void> {
  console.log("[e2e] Running global setup…");
  try {
    await ensureJwtSigningKey();
    await ensureWorkerAccounts();
    console.log("[e2e] Global setup complete.");
  } catch (error) {
    console.error("[e2e] Global setup failed:", error);
    throw error;
  }
}
