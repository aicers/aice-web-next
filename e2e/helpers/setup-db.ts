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

const pool = new pg.Pool({ connectionString: getDatabaseUrl(), max: 10 });
const auditPool = new pg.Pool({
  connectionString: getAuditDatabaseUrl(),
  max: 5,
});

/**
 * Shut down both connection pools. Call from global teardown.
 */
export async function closePools(): Promise<void> {
  await pool.end();
  await auditPool.end();
}

// ── Account helpers ───────────────────────────────────────────────

/**
 * Clear `must_change_password` so the E2E admin account redirects to
 * "/" instead of the non-existent "/change-password".
 */
export async function clearMustChangePassword(username: string): Promise<void> {
  await pool.query(
    "UPDATE accounts SET must_change_password = false WHERE username = $1",
    [username],
  );
}

/**
 * Revoke all sessions so subsequent sign-in tests start clean.
 */
export async function revokeAllSessions(username: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked = true
     WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
    [username],
  );
}

/**
 * Set `failed_sign_in_count` to a specific value.
 */
export async function setFailedSignInCount(
  username: string,
  count: number,
): Promise<void> {
  await pool.query(
    "UPDATE accounts SET failed_sign_in_count = $2 WHERE username = $1",
    [username, count],
  );
}

/**
 * Set `lockout_count` to a specific value.
 */
export async function setLockoutCount(
  username: string,
  count: number,
): Promise<void> {
  await pool.query(
    "UPDATE accounts SET lockout_count = $2 WHERE username = $1",
    [username, count],
  );
}

/**
 * Set account status and optionally `locked_until`.
 */
export async function setAccountStatus(
  username: string,
  status: string,
  lockedUntil?: Date | null,
): Promise<void> {
  await pool.query(
    `UPDATE accounts
     SET status = $2, locked_until = $3
     WHERE username = $1`,
    [username, status, lockedUntil ?? null],
  );
}

/**
 * Create fake (non-revoked) sessions for a user.
 */
export async function createFakeSessions(
  username: string,
  count: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (sid, account_id, ip_address, user_agent)
     SELECT gen_random_uuid(),
            (SELECT id FROM accounts WHERE username = $1),
            '127.0.0.1',
            'e2e-fake-session'
     FROM generate_series(1, $2)`,
    [username, count],
  );
}

/**
 * Set `max_sessions` for an account (null to remove the limit).
 */
export async function setMaxSessions(
  username: string,
  limit: number | null,
): Promise<void> {
  await pool.query(
    "UPDATE accounts SET max_sessions = $2 WHERE username = $1",
    [username, limit],
  );
}

/**
 * Set `must_change_password` flag on an account.
 */
export async function setMustChangePassword(
  username: string,
  value: boolean,
): Promise<void> {
  await pool.query(
    "UPDATE accounts SET must_change_password = $2 WHERE username = $1",
    [username, value],
  );
}

/**
 * Reset an account to clean defaults: active, no lockout, no
 * must-change-password, no max-sessions, and delete all sessions.
 */
export async function resetAccountDefaults(username: string): Promise<void> {
  const client = await pool.connect();
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
    client.release();
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
  await pool.query(
    `UPDATE sessions
     SET last_active_at = NOW() - INTERVAL '${minutesAgo} minutes'
     WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
       AND revoked = false`,
    [username],
  );
}

/**
 * Flag a session as requiring re-authentication.
 * Only affects non-revoked sessions.
 */
export async function flagSessionReauth(username: string): Promise<void> {
  await pool.query(
    `UPDATE sessions
     SET needs_reauth = true
     WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
       AND revoked = false`,
    [username],
  );
}

/**
 * Change the stored browser fingerprint on a session to simulate a
 * UA change detection scenario.
 */
export async function changeSessionFingerprint(
  username: string,
  newFingerprint: string,
): Promise<void> {
  await pool.query(
    `UPDATE sessions
     SET browser_fingerprint = $2
     WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
       AND revoked = false`,
    [username, newFingerprint],
  );
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
  const client = await pool.connect();
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
       ON CONFLICT (username) DO UPDATE SET role_id = EXCLUDED.role_id`,
      [username, passwordHash, roleRows[0].id],
    );
  } finally {
    client.release();
  }
}

/**
 * Delete a test account and its sessions.
 */
export async function deleteTestAccount(username: string): Promise<void> {
  const client = await pool.connect();
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
    client.release();
  }
}

/**
 * Set the password for an existing account (bypasses policy checks).
 */
export async function setPassword(
  username: string,
  password: string,
): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await pool.query(
    "UPDATE accounts SET password_hash = $2 WHERE username = $1",
    [username, passwordHash],
  );
}

/**
 * Add a password to the history for an account (for reuse-ban testing).
 */
export async function addPasswordHistory(
  username: string,
  password: string,
): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO password_history (account_id, password_hash)
     VALUES ((SELECT id FROM accounts WHERE username = $1), $2)`,
    [username, passwordHash],
  );
}

/**
 * Clear password history for an account (for test setup).
 */
export async function clearPasswordHistory(username: string): Promise<void> {
  await pool.query(
    "DELETE FROM password_history WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
    [username],
  );
}

/**
 * Get the UUID of an account by username.
 */
export async function getAccountId(username: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM accounts WHERE username = $1",
    [username],
  );
  if (rows.length === 0) throw new Error(`Account "${username}" not found`);
  return rows[0].id;
}

// ── Customer helpers ──────────────────────────────────────────────

/**
 * Delete all customers whose name starts with a given prefix.
 * Also drops the associated databases.
 */
export async function deleteCustomersByPrefix(prefix: string): Promise<void> {
  const client = await pool.connect();
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
    client.release();
  }
}

/**
 * Assign a customer to an account via direct DB insert.
 */
export async function assignCustomerToAccount(
  accountId: string,
  customerId: number,
): Promise<void> {
  await pool.query(
    "INSERT INTO account_customer (account_id, customer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [accountId, customerId],
  );
}

/**
 * Remove all customer assignments for an account.
 */
export async function removeAccountCustomerAssignments(
  accountId: string,
): Promise<void> {
  await pool.query("DELETE FROM account_customer WHERE account_id = $1", [
    accountId,
  ]);
}

/**
 * Get customer ID by name.
 */
export async function getCustomerIdByName(
  name: string,
): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    "SELECT id FROM customers WHERE name = $1",
    [name],
  );
  return rows.length > 0 ? rows[0].id : null;
}

// ── Preferences helpers ───────────────────────────────────────────

/**
 * Reset locale and timezone preferences for an account.
 */
export async function resetAccountPreferences(username: string): Promise<void> {
  await pool.query(
    "UPDATE accounts SET locale = NULL, timezone = NULL WHERE username = $1",
    [username],
  );
}

/**
 * Set locale for an account.
 */
export async function setAccountLocale(
  username: string,
  locale: string,
): Promise<void> {
  await pool.query("UPDATE accounts SET locale = $2 WHERE username = $1", [
    username,
    locale,
  ]);
}

/**
 * Set timezone for an account.
 */
export async function setAccountTimezone(
  username: string,
  timezone: string,
): Promise<void> {
  await pool.query("UPDATE accounts SET timezone = $2 WHERE username = $1", [
    username,
    timezone,
  ]);
}

// ── Role helpers ──────────────────────────────────────────────────

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
  const client = await pool.connect();
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
    client.release();
  }
}

/**
 * Delete a custom role by name. Silently ignores if not found.
 */
export async function deleteTestRole(name: string): Promise<void> {
  const client = await pool.connect();
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
    client.release();
  }
}

/**
 * Delete all custom roles whose name starts with a given prefix.
 */
export async function deleteRolesByPrefix(prefix: string): Promise<void> {
  const client = await pool.connect();
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
    client.release();
  }
}

function escapeIdentifier(str: string): string {
  return `"${str.replace(/"/g, '""')}"`;
}

// ── TOTP / MFA helpers ───────────────────────────────────────────

/**
 * Enroll a verified TOTP credential directly in the DB.
 * Returns the base32 secret for generating codes in tests.
 */
export async function enrollAndVerifyTotp(username: string): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  // Manual base32 encoding of 20 random bytes
  const raw = randomBytes(20);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let secret = "";
  let bits = 0;
  let buffer = 0;
  for (const byte of raw) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      secret += alphabet[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    secret += alphabet[(buffer << (5 - bits)) & 0x1f];
  }

  await pool.query(
    `INSERT INTO totp_credentials (account_id, secret, verified)
     VALUES ((SELECT id FROM accounts WHERE username = $1), $2, true)
     ON CONFLICT (account_id)
     DO UPDATE SET secret = $2, verified = true`,
    [username, secret],
  );
  return secret;
}

/**
 * Delete all TOTP credentials for a user.
 */
export async function deleteTotpCredential(username: string): Promise<void> {
  await pool.query(
    "DELETE FROM totp_credentials WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
    [username],
  );
}

/**
 * Delete all MFA challenge nonces for a user.
 */
export async function deleteMfaChallenges(username: string): Promise<void> {
  await pool.query(
    "DELETE FROM mfa_challenges WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
    [username],
  );
}

/**
 * Update MFA policy allowed methods directly in DB.
 */
export async function setMfaPolicyAllowedMethods(
  methods: string[],
): Promise<void> {
  await pool.query(
    `UPDATE system_settings SET value = $1 WHERE key = 'mfa_policy'`,
    [JSON.stringify({ allowed_methods: methods })],
  );
}

/**
 * Reset MFA policy to default (allow both webauthn and totp).
 */
export async function resetMfaPolicy(): Promise<void> {
  await setMfaPolicyAllowedMethods(["webauthn", "totp"]);
}

// ── WebAuthn helpers ─────────────────────────────────────────────

/**
 * Delete all WebAuthn credentials for a user.
 */
export async function deleteWebAuthnCredentials(
  username: string,
): Promise<void> {
  await pool.query(
    "DELETE FROM webauthn_credentials WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
    [username],
  );
}

/**
 * Delete all WebAuthn registration and authentication challenges for a user.
 */
export async function deleteWebAuthnChallenges(
  username: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "DELETE FROM webauthn_registration_challenges WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    );
    await client.query(
      "DELETE FROM webauthn_authentication_challenges WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    );
  } finally {
    client.release();
  }
}

/**
 * Insert a fake WebAuthn credential directly in the DB for testing.
 * Returns the credential UUID (primary key).
 */
export async function insertWebAuthnCredential(
  username: string,
  opts?: { displayName?: string },
): Promise<string> {
  const credentialId = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const publicKey = Buffer.from(crypto.getRandomValues(new Uint8Array(65)));
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webauthn_credentials
       (account_id, credential_id, public_key, counter, display_name)
     VALUES (
       (SELECT id FROM accounts WHERE username = $1),
       $2, $3, 0, $4
     )
     RETURNING id`,
    [username, credentialId, publicKey, opts?.displayName ?? null],
  );
  return rows[0].id;
}

/**
 * Alias for insertWebAuthnCredential — used in sign-in tests to
 * pre-enroll a (fake) WebAuthn credential so the server presents the
 * WebAuthn MFA step. Returns the credential UUID.
 */
export async function enrollWebAuthnCredential(
  username: string,
  displayName = "Test Passkey",
): Promise<string> {
  return insertWebAuthnCredential(username, { displayName });
}

// ── Audit database helpers ────────────────────────────────────────

/**
 * Insert a fake audit log entry into the audit database.
 * Returns the inserted row ID for targeted cleanup.
 */
export async function insertAuditLog(opts: {
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  ipAddress?: string;
  details?: Record<string, unknown>;
}): Promise<string> {
  const { rows } = await auditPool.query<{ id: string }>(
    `INSERT INTO audit_logs
       (actor_id, action, target_type, target_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      opts.actorId,
      opts.action,
      opts.targetType,
      opts.targetId ?? null,
      opts.ipAddress ?? "127.0.0.1",
      opts.details ? JSON.stringify(opts.details) : null,
    ],
  );
  return rows[0].id;
}

/**
 * Delete a specific audit log entry by ID.
 * Only removes the exact row that was seeded, leaving other data intact.
 */
export async function deleteAuditLogById(id: string): Promise<void> {
  await auditPool.query("DELETE FROM audit_logs WHERE id = $1", [id]);
}

// ── Session status helpers ────────────────────────────────────────

/**
 * Get session status for diagnostic/assertion purposes.
 */
export async function getSessionStatus(username: string): Promise<{
  needsReauth: boolean;
  revoked: boolean;
  browserFingerprint: string;
} | null> {
  const result = await pool.query(
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
}
