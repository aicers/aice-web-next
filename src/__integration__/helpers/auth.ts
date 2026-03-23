import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { importJWK, SignJWT } from "jose";
import pg from "pg";

import { SERVER_ORIGIN } from "../setup";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "Admin1234!";

/**
 * User-Agent string shared between session creation and HTTP requests.
 * Must match so that withAuth's IP/UA risk assessment does not flag
 * the session for re-authentication.
 */
const INTEGRATION_USER_AGENT = "IntegrationTest/1.0";

/**
 * Authenticated HTTP session for integration tests.
 * Manages JWT cookie and CSRF token.
 */
export interface AuthSession {
  /** Cookie header value to send with requests. */
  cookie: string;
  /** CSRF token to send as X-CSRF-Token header on mutating requests. */
  csrfToken: string;
}

// ── Internal: load signing key from disk ──────────────────────────

function getDataDir(): string {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);

  try {
    const envFile = readFileSync(resolve(".env.local"), "utf8");
    const match = envFile.match(/^DATA_DIR=(.+)$/m);
    if (match) return resolve(match[1].trim());
  } catch {
    // .env.local not found
  }

  return resolve("data-integration");
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    const envFile = readFileSync(resolve(".env.local"), "utf8");
    const match = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // .env.local not found
  }

  return "postgres://postgres:postgres@localhost:5432/auth_db";
}

function getCsrfSecret(): string {
  if (process.env.CSRF_SECRET) return process.env.CSRF_SECRET;

  try {
    const envFile = readFileSync(resolve(".env.local"), "utf8");
    const match = envFile.match(/^CSRF_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // .env.local not found
  }

  return "integration-test-csrf-secret-at-least-32-chars!!";
}

const DATABASE_URL = getDatabaseUrl();

interface KeyFile {
  kid: string;
  algorithm: string;
  privateKey: Record<string, unknown>;
}

let cachedKey: {
  kid: string;
  algorithm: string;
  privateKey: CryptoKey;
} | null = null;

async function getSigningKey() {
  if (cachedKey) return cachedKey;

  const keyPath = resolve(getDataDir(), "keys", "jwt-signing.json");
  const keyFile: KeyFile = JSON.parse(readFileSync(keyPath, "utf8"));
  const privateKey = await importJWK(keyFile.privateKey, keyFile.algorithm);

  cachedKey = {
    kid: keyFile.kid,
    algorithm: keyFile.algorithm,
    privateKey: privateKey as CryptoKey,
  };
  return cachedKey;
}

// ── Sign-in: create session + issue tokens directly ──────────────

/**
 * Create a real DB session and issue JWT + CSRF tokens for an account.
 *
 * This bypasses the HTTP sign-in endpoint (which uses `cookies()` from
 * `next/headers` and fails with plain `fetch()`). Instead it:
 * 1. Looks up the account in the DB
 * 2. Creates a session row
 * 3. Issues a JWT with the same structure as the app
 * 4. Generates a CSRF token with the same HMAC scheme
 */
export async function signIn(
  username: string,
  _password?: string,
): Promise<AuthSession> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // Look up account
    const { rows: accountRows } = await client.query<{
      id: string;
      token_version: number;
      role_name: string;
    }>(
      `SELECT a.id, a.token_version, r.name AS role_name
       FROM accounts a JOIN roles r ON a.role_id = r.id
       WHERE a.username = $1`,
      [username],
    );
    if (accountRows.length === 0) {
      throw new Error(`Account "${username}" not found`);
    }
    const account = accountRows[0];

    // Create session — metadata must match the User-Agent header sent
    // by the HTTP helpers so withAuth's IP/UA check passes.
    const { rows: sessionRows } = await client.query<{ sid: string }>(
      `INSERT INTO sessions (sid, account_id, ip_address, user_agent, browser_fingerprint)
       VALUES (gen_random_uuid(), $1, '127.0.0.1', $2, $2)
       RETURNING sid`,
      [account.id, INTEGRATION_USER_AGENT],
    );
    const sid = sessionRows[0].sid;

    // Issue JWT (same structure as src/lib/auth/jwt.ts issueAccessToken)
    const key = await getSigningKey();
    const maxAgeMinutes = 15; // default JWT policy
    const jwt = await new SignJWT({
      sid,
      roles: [account.role_name],
      token_version: account.token_version,
      kid: key.kid,
    })
      .setProtectedHeader({ alg: key.algorithm, kid: key.kid })
      .setIssuer("aice-web-next")
      .setSubject(account.id)
      .setAudience("aice-web-next")
      .setIssuedAt()
      .setExpirationTime(`${maxAgeMinutes}m`)
      .sign(key.privateKey);

    // Generate CSRF token (same scheme as src/lib/auth/csrf.ts)
    const csrfSecret = getCsrfSecret();
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", csrfSecret)
      .update(`${sid}${nonce}${issuedAt}`)
      .digest("hex");
    const csrfToken = `${nonce}.${issuedAt}.${signature}`;

    // Build cookie header
    const maxAge = maxAgeMinutes * 60;
    const tokenExp = Math.floor(Date.now() / 1000) + maxAge;
    const cookie = [
      `at=${jwt}`,
      `csrf=${csrfToken}`,
      `token_exp=${tokenExp}`,
      `token_ttl=${maxAge}`,
    ].join("; ");

    return { cookie, csrfToken };
  } finally {
    await client.end();
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────

/**
 * Make an authenticated GET request.
 */
export async function authGet(
  session: AuthSession,
  path: string,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}${path}`, {
    headers: {
      Cookie: session.cookie,
      "User-Agent": INTEGRATION_USER_AGENT,
    },
  });
}

/**
 * Make an authenticated POST request with JSON body.
 */
export async function authPost(
  session: AuthSession,
  path: string,
  data?: unknown,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      "User-Agent": INTEGRATION_USER_AGENT,
      Origin: SERVER_ORIGIN,
    },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
}

/**
 * Make an authenticated PATCH request with JSON body.
 */
export async function authPatch(
  session: AuthSession,
  path: string,
  data: unknown,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      "User-Agent": INTEGRATION_USER_AGENT,
      Origin: SERVER_ORIGIN,
    },
    body: JSON.stringify(data),
  });
}

/**
 * Make an authenticated DELETE request.
 */
export async function authDelete(
  session: AuthSession,
  path: string,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}${path}`, {
    method: "DELETE",
    headers: {
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      "User-Agent": INTEGRATION_USER_AGENT,
      Origin: SERVER_ORIGIN,
    },
  });
}

/**
 * Reset the in-memory rate limiter via the test-only API endpoint.
 */
export async function resetRateLimits(): Promise<void> {
  const res = await fetch(`${SERVER_ORIGIN}/api/e2e/reset-rate-limits`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`reset-rate-limits failed: ${res.status}`);
}
