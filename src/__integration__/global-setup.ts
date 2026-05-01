import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { exportJWK, generateKeyPair } from "jose";
import pg from "pg";

import { readManifest, runFixturePreflight } from "../test-harness/fixtures";
import {
  type RunningMockServer,
  startMockServer,
} from "../test-harness/mock-server";
import { ensureTestCerts } from "../test-harness/test-certs";

const DATA_DIR = process.env.DATA_DIR || resolve("data-integration");
const SERVER_URL =
  process.env.INTEGRATION_SERVER_URL || "http://localhost:3001";
const PORT = new URL(SERVER_URL).port || "3001";
const MOCK_GRAPHQL_PORT = Number(
  process.env.MOCK_REVIEW_GRAPHQL_PORT || "4011",
);

/**
 * Resolve an env var: prefer process.env, then parse .env.local.
 */
function getEnvVar(key: string, fallback: string): string {
  if (process.env[key]) return process.env[key];

  try {
    const envFile = readFileSync(resolve(".env.local"), "utf8");
    const match = envFile.match(new RegExp(`^${key}=(.+)$`, "m"));
    if (match) return match[1].trim();
  } catch {
    // .env.local not found
  }

  return fallback;
}

async function ensureJwtSigningKey(): Promise<void> {
  const keysDir = resolve(DATA_DIR, "keys");
  const keyPath = resolve(keysDir, "jwt-signing.json");

  if (existsSync(keyPath)) return;

  console.log(`[integration] Generating JWT signing key at ${keyPath}`);

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
      { kid, algorithm: "ES256", privateKey: privateJwk, publicKey: publicJwk },
      null,
      2,
    ),
    "utf8",
  );
}

async function cleanupOrphanedCustomerRows(env: Record<string, string>) {
  const authClient = new pg.Client({ connectionString: env.DATABASE_URL });
  const adminClient = new pg.Client({
    connectionString: env.DATABASE_ADMIN_URL,
  });

  await authClient.connect();
  await adminClient.connect();

  try {
    const customerTable = await authClient.query<{ oid: string | null }>(
      "SELECT to_regclass('public.customers') AS oid",
    );
    if (!customerTable.rows[0]?.oid) {
      console.log(
        "[integration] Skipping orphaned customer cleanup because auth_db is not initialized yet",
      );
      return;
    }

    const { rows } = await authClient.query<{
      id: number;
      database_name: string;
      status: string;
    }>(
      `SELECT id, database_name, status
         FROM customers
        WHERE status IN ('active', 'provisioning')`,
    );

    for (const row of rows) {
      const exists = await adminClient.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        [row.database_name],
      );
      if (exists.rows[0]?.exists) continue;

      await authClient.query(
        "DELETE FROM account_customer WHERE customer_id = $1",
        [row.id],
      );
      await authClient.query("DELETE FROM customers WHERE id = $1", [row.id]);
      console.log(
        `[integration] Removed orphaned customer row ${row.id} (${row.database_name}) with missing backing DB`,
      );
    }
  } finally {
    await authClient.end();
    await adminClient.end();
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  // Probe an API route, not `/`. The integration suite drives `/api/...`
  // handlers, none of which import the locale layout. The locale layout
  // pulls in `next/font/google` and turbopack tries to fetch Google
  // fonts during compilation; when CI's network to fonts.gstatic.com
  // is flaky the layout compile fails and `GET /` returns 500 even
  // though every API route is still serving fine. Probing an API route
  // decouples readiness from font availability.
  const probe = new URL("/api/auth/me", url).toString();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(probe, { redirect: "manual" });
      // 401 (unauthenticated) is the expected response — anything
      // < 500 means the route compiled and the server is processing
      // requests.
      if (res.status < 500) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

let serverProcess: ChildProcess | undefined;
let mockServer: RunningMockServer | undefined;

function preflightFixtures(): void {
  const manifest = readManifest();
  const failures = runFixturePreflight(manifest);
  if (failures.length > 0) {
    throw new Error(
      "Fixture preflight failed (schema validation or manifest coverage):\n\n" +
        failures.join("\n\n"),
    );
  }
  console.log(
    `[integration] Validated ${manifest.length} fixture(s) against ` +
      "schemas/review.graphql and confirmed manifest coverage of the " +
      "fixtures tree",
  );
}

export async function setup(): Promise<() => Promise<void>> {
  console.log("[integration] Running global setup…");

  preflightFixtures();

  // Generate (or reuse) short-lived test certs. Both the mock server and
  // the dev server use them: the mock presents the server cert + requires
  // mTLS, and the dev server's mtls module reads the client cert/key via
  // the MTLS_* env vars we set below. This exercises the production mTLS
  // code path end to end in CI (no bypass needed).
  const certDir = resolve(DATA_DIR, "certs");
  const certs = ensureTestCerts(certDir);
  process.env.MTLS_CA_PATH = certs.paths.caPath;
  process.env.MTLS_CERT_PATH = certs.paths.clientCertPath;
  process.env.MTLS_KEY_PATH = certs.paths.clientKeyPath;
  console.log(`[integration] Test mTLS material ready at ${certs.dir}`);

  console.log(
    `[integration] Starting mock REview GraphQL server on port ${MOCK_GRAPHQL_PORT}…`,
  );
  mockServer = await startMockServer({
    port: MOCK_GRAPHQL_PORT,
    tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.caCert },
  });
  process.env.REVIEW_GRAPHQL_ENDPOINT = mockServer.url;
  console.log(`[integration] Mock REview GraphQL ready at ${mockServer.url}`);

  await ensureJwtSigningKey();

  // Build environment for the dev server
  const env: Record<string, string> = {
    PORT,
    DATA_DIR,
    DATABASE_URL: getEnvVar(
      "DATABASE_URL",
      "postgres://postgres:postgres@localhost:5432/auth_db",
    ),
    DATABASE_ADMIN_URL: getEnvVar(
      "DATABASE_ADMIN_URL",
      "postgres://postgres:postgres@localhost:5432/postgres",
    ),
    AUDIT_DATABASE_URL: getEnvVar(
      "AUDIT_DATABASE_URL",
      "postgres://audit_writer:changeme@localhost:5432/audit_db",
    ),
    CSRF_SECRET: getEnvVar(
      "CSRF_SECRET",
      "integration-test-csrf-secret-at-least-32-chars!!",
    ),
    INIT_ADMIN_USERNAME: getEnvVar("INIT_ADMIN_USERNAME", "admin"),
    INIT_ADMIN_PASSWORD: getEnvVar("INIT_ADMIN_PASSWORD", "Admin1234!"),
    DEFAULT_LOCALE: getEnvVar("DEFAULT_LOCALE", "en"),
    REVIEW_GRAPHQL_ENDPOINT: mockServer.url,
    MTLS_CA_PATH: certs.paths.caPath,
    MTLS_CERT_PATH: certs.paths.clientCertPath,
    MTLS_KEY_PATH: certs.paths.clientKeyPath,
  };

  // The spawned dev server receives the integration env via `spawn()`,
  // but some integration tests also execute DB-backed code in-process.
  // Mirror the same values into the Vitest worker so helpers that call
  // `lib/db/client.ts` or `lib/audit/client.ts` see the test DSNs too.
  Object.assign(process.env, env);

  // Never reuse an existing server. A process already bound to SERVER_URL
  // has its own env and will not have received the harness-controlled
  // REVIEW_GRAPHQL_ENDPOINT / MTLS_* vars set above, so REview-backed tests
  // could silently talk to the wrong backend while the smoke still passes.
  // Fail fast instead, and make the developer stop any stray `pnpm dev` on
  // ${SERVER_URL} before re-running.
  try {
    const res = await fetch(SERVER_URL, { redirect: "manual" });
    if (res.status < 500) {
      await mockServer.close();
      throw new Error(
        `[integration] Port ${PORT} is already in use by another process ` +
          `(responded at ${SERVER_URL}). The integration harness owns the ` +
          "app process so REVIEW_GRAPHQL_ENDPOINT / MTLS_* reach it " +
          "correctly. Stop the stray server and re-run, or set " +
          "INTEGRATION_SERVER_URL to a different port.",
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[integration] Port")) {
      throw err;
    }
    // Port is free — start our own dev server below.
  }

  await cleanupOrphanedCustomerRows(env);

  // Save tsconfig.json before starting the dev server — Next.js rewrites
  // it on startup, which dirties the worktree.
  const tsconfigPath = resolve("tsconfig.json");
  const tsconfigBackup = readFileSync(tsconfigPath, "utf8");

  const killServerProcess = (): void => {
    if (!serverProcess?.pid) return;
    try {
      // Kill the detached process group so webpack workers die too.
      process.kill(-serverProcess.pid, "SIGTERM");
    } catch {
      serverProcess.kill("SIGTERM");
    }
  };

  try {
    console.log(`[integration] Starting dev server on port ${PORT}…`);
    const proc = spawn("pnpm", ["dev", "--port", PORT], {
      env: { ...process.env, ...env },
      stdio: "pipe",
      detached: true,
    });
    serverProcess = proc;

    // Unref so the child doesn't keep this process alive
    proc.unref();
    proc.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[dev] ${line}`);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[dev:err] ${line}`);
    });

    await waitForServer(SERVER_URL, 120_000);
    console.log("[integration] Dev server is ready.");
  } catch (err) {
    // The dev server is spawned with `detached: true` + `unref()` so it
    // survives this process by design. That is correct for the happy path
    // (teardown re-attaches via `serverProcess.pid`), but it means any
    // failure between `spawn()` and `waitForServer()` succeeding would
    // orphan the child — and the next local rerun would trip the
    // port-in-use guard we just added above. Clean up explicitly before
    // rethrowing so setup failures are recoverable without manual
    // `lsof | kill` intervention.
    console.error(
      "[integration] Dev-server startup failed; tearing down partial state.",
    );
    killServerProcess();
    serverProcess = undefined;
    if (mockServer) {
      try {
        await mockServer.close();
      } catch {
        // best-effort: we're already unwinding a setup failure
      }
      mockServer = undefined;
    }
    try {
      writeFileSync(tsconfigPath, tsconfigBackup, "utf8");
    } catch {
      // best-effort: same reason
    }
    throw err;
  }

  return async () => {
    if (serverProcess?.pid) {
      console.log("[integration] Stopping dev server…");
      killServerProcess();
    }

    if (mockServer) {
      console.log("[integration] Stopping mock REview GraphQL server…");
      await mockServer.close();
    }

    // Restore tsconfig.json to its pre-test state
    writeFileSync(tsconfigPath, tsconfigBackup, "utf8");
  };
}
