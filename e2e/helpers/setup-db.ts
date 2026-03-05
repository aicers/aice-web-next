import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

/**
 * Load DATABASE_URL: prefer process.env, then parse .env.local.
 */
function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    const envFile = readFileSync(
      resolve(__dirname, "../../.env.local"),
      "utf8",
    );
    const match = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // .env.local not found — use default
  }

  return "postgres://postgres:postgres@localhost:5432/auth_db";
}

const DATABASE_URL = getDatabaseUrl();

/**
 * Clear `must_change_password` so the E2E admin account redirects to
 * "/" instead of the non-existent "/change-password".
 */
export async function clearMustChangePassword(username: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "UPDATE accounts SET must_change_password = false WHERE username = $1",
      [username],
    );
  } finally {
    await client.end();
  }
}

/**
 * Revoke all sessions so subsequent sign-in tests start clean.
 */
export async function revokeAllSessions(username: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE sessions SET revoked = true
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
      [username],
    );
  } finally {
    await client.end();
  }
}

/**
 * Set `failed_sign_in_count` to a specific value.
 */
export async function setFailedSignInCount(
  username: string,
  count: number,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "UPDATE accounts SET failed_sign_in_count = $2 WHERE username = $1",
      [username, count],
    );
  } finally {
    await client.end();
  }
}

/**
 * Set account status and optionally `locked_until`.
 */
export async function setAccountStatus(
  username: string,
  status: string,
  lockedUntil?: Date | null,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE accounts
       SET status = $2, locked_until = $3
       WHERE username = $1`,
      [username, status, lockedUntil ?? null],
    );
  } finally {
    await client.end();
  }
}

/**
 * Create fake (non-revoked) sessions for a user.
 */
export async function createFakeSessions(
  username: string,
  count: number,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO sessions (sid, account_id, ip_address, user_agent)
       SELECT gen_random_uuid(),
              (SELECT id FROM accounts WHERE username = $1),
              '127.0.0.1',
              'e2e-fake-session'
       FROM generate_series(1, $2)`,
      [username, count],
    );
  } finally {
    await client.end();
  }
}

/**
 * Set `max_sessions` for an account (null to remove the limit).
 */
export async function setMaxSessions(
  username: string,
  limit: number | null,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "UPDATE accounts SET max_sessions = $2 WHERE username = $1",
      [username, limit],
    );
  } finally {
    await client.end();
  }
}

/**
 * Set `must_change_password` flag on an account.
 */
export async function setMustChangePassword(
  username: string,
  value: boolean,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "UPDATE accounts SET must_change_password = $2 WHERE username = $1",
      [username, value],
    );
  } finally {
    await client.end();
  }
}

/**
 * Reset an account to clean defaults: active, no lockout, no
 * must-change-password, no max-sessions, and revoke all sessions.
 */
export async function resetAccountDefaults(username: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE accounts
       SET status = 'active',
           failed_sign_in_count = 0,
           locked_until = NULL,
           must_change_password = false,
           max_sessions = NULL
       WHERE username = $1`,
      [username],
    );
    await client.query(
      `DELETE FROM sessions
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
      [username],
    );
  } finally {
    await client.end();
  }
}
