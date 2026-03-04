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
