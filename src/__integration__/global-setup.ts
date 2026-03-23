import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { exportJWK, generateKeyPair } from "jose";

const DATA_DIR = process.env.DATA_DIR || resolve("data-integration");
const SERVER_URL =
  process.env.INTEGRATION_SERVER_URL || "http://localhost:3001";
const PORT = new URL(SERVER_URL).port || "3001";

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

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

let serverProcess: ChildProcess | undefined;

export async function setup(): Promise<() => Promise<void>> {
  console.log("[integration] Running global setup…");

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
  };

  // Check if a server is already running on this port
  try {
    const res = await fetch(SERVER_URL, { redirect: "manual" });
    if (res.status < 500) {
      console.log(`[integration] Reusing existing server at ${SERVER_URL}`);
      return async () => {};
    }
  } catch {
    // No server running — start one
  }

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

  return async () => {
    if (serverProcess?.pid) {
      console.log("[integration] Stopping dev server…");
      try {
        // Kill the detached process group
        process.kill(-serverProcess.pid, "SIGTERM");
      } catch {
        serverProcess.kill("SIGTERM");
      }
    }
  };
}
