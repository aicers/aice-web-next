import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import argon2 from "argon2";
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
 * Set `lockout_count` to a specific value.
 */
export async function setLockoutCount(
  username: string,
  count: number,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "UPDATE accounts SET lockout_count = $2 WHERE username = $1",
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
           lockout_count = 0,
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

/**
 * Set `last_active_at` to a time in the past to simulate idle timeout.
 * Only affects non-revoked sessions.
 */
export async function expireSessionIdle(
  username: string,
  minutesAgo: number,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE sessions
       SET last_active_at = NOW() - INTERVAL '${minutesAgo} minutes'
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         AND revoked = false`,
      [username],
    );
  } finally {
    await client.end();
  }
}

/**
 * Flag a session as requiring re-authentication.
 * Only affects non-revoked sessions.
 */
export async function flagSessionReauth(username: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE sessions
       SET needs_reauth = true
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         AND revoked = false`,
      [username],
    );
  } finally {
    await client.end();
  }
}

/**
 * Change the stored browser fingerprint on a session to simulate a
 * UA change detection scenario.
 */
export async function changeSessionFingerprint(
  username: string,
  newFingerprint: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE sessions
       SET browser_fingerprint = $2
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         AND revoked = false`,
      [username, newFingerprint],
    );
  } finally {
    await client.end();
  }
}

/**
 * Create a test account with the given role.
 * Skips if an account with the username already exists.
 */
export async function createTestAccount(
  username: string,
  password: string,
  roleName: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows: roleRows } = await client.query<{ id: number }>(
      "SELECT id FROM roles WHERE name = $1",
      [roleName],
    );
    if (roleRows.length === 0) {
      throw new Error(`Role "${roleName}" not found`);
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await client.query(
      `INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $1, $2, $3, false)
       ON CONFLICT (username) DO NOTHING`,
      [username, passwordHash, roleRows[0].id],
    );
  } finally {
    await client.end();
  }
}

/**
 * Delete a test account and its sessions.
 */
export async function deleteTestAccount(username: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM sessions
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
      [username],
    );
    await client.query(
      "DELETE FROM account_customer WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    );
    await client.query(
      "DELETE FROM password_history WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    );
    await client.query("DELETE FROM accounts WHERE username = $1", [username]);
  } finally {
    await client.end();
  }
}

/**
 * Set the password for an existing account (bypasses policy checks).
 */
export async function setPassword(
  username: string,
  password: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await client.query(
      "UPDATE accounts SET password_hash = $2 WHERE username = $1",
      [username, passwordHash],
    );
  } finally {
    await client.end();
  }
}

/**
 * Add a password to the history for an account (for reuse-ban testing).
 */
export async function addPasswordHistory(
  username: string,
  password: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await client.query(
      `INSERT INTO password_history (account_id, password_hash)
       VALUES ((SELECT id FROM accounts WHERE username = $1), $2)`,
      [username, passwordHash],
    );
  } finally {
    await client.end();
  }
}

/**
 * Clear password history for an account (for test setup).
 */
export async function clearPasswordHistory(username: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "DELETE FROM password_history WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    );
  } finally {
    await client.end();
  }
}

/**
 * Get the UUID of an account by username.
 */
export async function getAccountId(username: string): Promise<string> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE username = $1",
      [username],
    );
    if (rows.length === 0) throw new Error(`Account "${username}" not found`);
    return rows[0].id;
  } finally {
    await client.end();
  }
}

/**
 * Delete all customers whose name starts with a given prefix.
 * Also drops the associated databases.
 */
export async function deleteCustomersByPrefix(prefix: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: number;
      database_name: string;
    }>("SELECT id, database_name FROM customers WHERE name LIKE $1", [
      `${prefix}%`,
    ]);
    for (const row of rows) {
      // Remove account_customer links first (ON DELETE RESTRICT)
      await client.query(
        "DELETE FROM account_customer WHERE customer_id = $1",
        [row.id],
      );
      await client.query(
        `DROP DATABASE IF EXISTS ${escapeIdentifier(row.database_name)}`,
      );
    }
    if (rows.length > 0) {
      await client.query("DELETE FROM customers WHERE name LIKE $1", [
        `${prefix}%`,
      ]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Assign a customer to an account via direct DB insert.
 */
export async function assignCustomerToAccount(
  accountId: string,
  customerId: number,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO account_customer (account_id, customer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [accountId, customerId],
    );
  } finally {
    await client.end();
  }
}

/**
 * Remove all customer assignments for an account.
 */
export async function removeAccountCustomerAssignments(
  accountId: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("DELETE FROM account_customer WHERE account_id = $1", [
      accountId,
    ]);
  } finally {
    await client.end();
  }
}

/**
 * Get customer ID by name.
 */
export async function getCustomerIdByName(
  name: string,
): Promise<number | null> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: number }>(
      "SELECT id FROM customers WHERE name = $1",
      [name],
    );
    return rows.length > 0 ? rows[0].id : null;
  } finally {
    await client.end();
  }
}

/**
 * Reset locale and timezone preferences for an account.
 */
export async function resetAccountPreferences(username: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "UPDATE accounts SET locale = NULL, timezone = NULL WHERE username = $1",
      [username],
    );
  } finally {
    await client.end();
  }
}

/**
 * Create a custom role with the given permissions.
 * Skips if a role with the name already exists.
 * Returns the role ID.
 */
export async function createTestRole(
  name: string,
  permissions: string[],
  description?: string,
): Promise<number> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO roles (name, description, is_builtin)
       VALUES ($1, $2, false)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name, description ?? null],
    );
    const roleId = rows[0].id;

    // Replace permissions
    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [
      roleId,
    ]);
    for (const perm of permissions) {
      await client.query(
        "INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)",
        [roleId, perm],
      );
    }

    return roleId;
  } finally {
    await client.end();
  }
}

/**
 * Delete a custom role by name. Silently ignores if not found.
 */
export async function deleteTestRole(name: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = $1)",
      [name],
    );
    await client.query(
      "DELETE FROM roles WHERE name = $1 AND is_builtin = false",
      [name],
    );
  } finally {
    await client.end();
  }
}

/**
 * Delete all custom roles whose name starts with a given prefix.
 */
export async function deleteRolesByPrefix(prefix: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM role_permissions
       WHERE role_id IN (
         SELECT id FROM roles WHERE name LIKE $1 AND is_builtin = false
       )`,
      [`${prefix}%`],
    );
    await client.query(
      "DELETE FROM roles WHERE name LIKE $1 AND is_builtin = false",
      [`${prefix}%`],
    );
  } finally {
    await client.end();
  }
}

function escapeIdentifier(str: string): string {
  return `"${str.replace(/"/g, '""')}"`;
}

// ── Audit database helpers ────────────────────────────────────────

function getAuditDatabaseUrl(): string {
  if (process.env.AUDIT_DATABASE_URL) return process.env.AUDIT_DATABASE_URL;

  try {
    const envFile = readFileSync(
      resolve(__dirname, "../../.env.local"),
      "utf8",
    );
    const match = envFile.match(/^AUDIT_DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // .env.local not found — use default
  }

  return "postgres://postgres:postgres@localhost:5432/audit_db";
}

const AUDIT_DATABASE_URL = getAuditDatabaseUrl();

/**
 * Insert a fake audit log entry into the audit database.
 * Useful for seeding suspicious-activity detection rules in E2E tests.
 */
export async function insertAuditLog(opts: {
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  ipAddress?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const client = new pg.Client({ connectionString: AUDIT_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO audit_logs
         (actor_id, action, target_type, target_id, ip_address, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        opts.actorId,
        opts.action,
        opts.targetType,
        opts.targetId ?? null,
        opts.ipAddress ?? "127.0.0.1",
        opts.details ? JSON.stringify(opts.details) : null,
      ],
    );
  } finally {
    await client.end();
  }
}

/**
 * Delete audit log entries matching a given action.
 * For cleanup after E2E tests that seed fake audit data.
 */
export async function deleteAuditLogsByAction(action: string): Promise<void> {
  const client = new pg.Client({ connectionString: AUDIT_DATABASE_URL });
  await client.connect();
  try {
    await client.query("DELETE FROM audit_logs WHERE action = $1", [action]);
  } finally {
    await client.end();
  }
}

/**
 * Get session status for diagnostic/assertion purposes.
 */
export async function getSessionStatus(username: string): Promise<{
  needsReauth: boolean;
  revoked: boolean;
  browserFingerprint: string;
} | null> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT needs_reauth, revoked, browser_fingerprint
       FROM sessions
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         AND revoked = false
       ORDER BY created_at DESC
       LIMIT 1`,
      [username],
    );
    if (result.rows.length === 0) return null;
    return {
      needsReauth: result.rows[0].needs_reauth,
      revoked: result.rows[0].revoked,
      browserFingerprint: result.rows[0].browser_fingerprint,
    };
  } finally {
    await client.end();
  }
}
