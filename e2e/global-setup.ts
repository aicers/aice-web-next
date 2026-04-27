import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { exportJWK, generateKeyPair } from "jose";

import {
  readManifest,
  runFixturePreflight,
} from "../src/test-harness/fixtures";
import { startMockServer } from "../src/test-harness/mock-server";
import { ensureTestCerts } from "../src/test-harness/test-certs";
import { resolveDataDir } from "./data-dir";
import {
  createTestAccount,
  createTestRole,
  resetAccountDefaults,
} from "./helpers/setup-db";
import { mockServerPort, setMockServer } from "./mock-server-state";

/**
 * Generate an ES256 JWT signing key if one doesn't already exist.
 * The dev server's `instrumentation.ts` calls `loadSigningKeys()` and
 * throws if the key file is absent, so we must create it before the
 * webServer starts.
 */
async function ensureJwtSigningKey(): Promise<void> {
  const dataDir = resolveDataDir();
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
  "detection:read",
  "nodes:read",
  "nodes:write",
  "nodes:delete",
  "services:read",
  "services:write",
];

async function ensureWorkerAccounts(): Promise<void> {
  await createTestRole(WORKER_ROLE, ALL_PERMISSIONS, "E2E worker role");
  for (let i = 0; i < MAX_WORKERS; i++) {
    const username = `e2e-worker-${i}`;
    await createTestAccount(username, WORKER_PASSWORD, WORKER_ROLE);
    await resetAccountDefaults(username);
  }
}

async function startMockReviewGraphql(): Promise<void> {
  const manifest = readManifest();
  const failures = runFixturePreflight(manifest);
  if (failures.length > 0) {
    throw new Error(
      "Fixture preflight failed (schema validation or manifest coverage):\n\n" +
        failures.join("\n\n"),
    );
  }
  console.log(
    `[e2e] Validated ${manifest.length} fixture(s) against schemas/review.graphql ` +
      "and confirmed manifest coverage of the fixtures tree",
  );

  // Generate (or reuse) short-lived test certs so the mock server can serve
  // over HTTPS + mTLS. `ensureTestCerts` is idempotent when the on-disk
  // chain is still within its validity window, and auto-regenerates if any
  // cert has expired — `playwright.config.ts` already calls it before
  // webServer starts; calling it again here just reads the existing PEMs.
  // Once this is set, the dev server reaches the mock via the production
  // mTLS path in `src/lib/mtls.ts` (no bypass needed).
  const certDir = resolve(resolveDataDir(), "certs");
  const certs = ensureTestCerts(certDir);
  console.log(`[e2e] Test mTLS material ready at ${certs.dir}`);

  const port = mockServerPort();
  const server = await startMockServer({
    port,
    tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.caCert },
  });
  setMockServer(server);
  console.log(`[e2e] Mock REview GraphQL listening at ${server.url}`);
}

export default async function globalSetup(): Promise<void> {
  console.log("[e2e] Running global setup…");
  try {
    await startMockReviewGraphql();
    await ensureJwtSigningKey();
    await ensureWorkerAccounts();
    console.log("[e2e] Global setup complete.");
  } catch (error) {
    console.error("[e2e] Global setup failed:", error);
    throw error;
  }
}
