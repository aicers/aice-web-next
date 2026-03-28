import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import argon2 from "argon2";
import pg from "pg";

/**
 * Load an environment variable: prefer process.env, then parse .env.local.
 */
function getEnvVar(key: string, fallback: string): string {
  if (process.env[key]) return process.env[key];

  try {
    const envFile = readFileSync(
      resolve(__dirname, "../../../.env.local"),
      "utf8",
    );
    const match = envFile.match(new RegExp(`^${key}=(.+)$`, "m"));
    if (match) return match[1].trim();
  } catch {
    // .env.local not found
  }

  return fallback;
}

const DATABASE_URL = getEnvVar(
  "DATABASE_URL",
  "postgres://postgres:postgres@localhost:5432/auth_db",
);

const AUDIT_DATABASE_URL = getEnvVar(
  "AUDIT_DATABASE_URL",
  "postgres://audit_writer:changeme@localhost:5432/audit_db",
);

// ── Helper to run a query against auth_db ──────────────────────────

async function withAuthDb<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withAuditDb<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: AUDIT_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ── Account helpers ────────────────────────────────────────────────

export async function clearMustChangePassword(username: string): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      "UPDATE accounts SET must_change_password = false WHERE username = $1",
      [username],
    ),
  );
}

export async function revokeAllSessions(username: string): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      `UPDATE sessions SET revoked = true
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
      [username],
    ),
  );
}

export async function setFailedSignInCount(
  username: string,
  count: number,
): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      "UPDATE accounts SET failed_sign_in_count = $2 WHERE username = $1",
      [username, count],
    ),
  );
}

export async function setLockoutCount(
  username: string,
  count: number,
): Promise<void> {
  await withAuthDb((c) =>
    c.query("UPDATE accounts SET lockout_count = $2 WHERE username = $1", [
      username,
      count,
    ]),
  );
}

export async function setAccountStatus(
  username: string,
  status: string,
  lockedUntil?: Date | null,
): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      `UPDATE accounts
       SET status = $2, locked_until = $3
       WHERE username = $1`,
      [username, status, lockedUntil ?? null],
    ),
  );
}

export async function setMustChangePassword(
  username: string,
  value: boolean,
): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      "UPDATE accounts SET must_change_password = $2 WHERE username = $1",
      [username, value],
    ),
  );
}

export async function resetAccountDefaults(username: string): Promise<void> {
  await withAuthDb(async (c) => {
    await c.query(
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
    await c.query(
      `DELETE FROM sessions
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
      [username],
    );
  });
}

export async function createFakeSessions(
  username: string,
  count: number,
): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      `INSERT INTO sessions (sid, account_id, ip_address, user_agent)
       SELECT gen_random_uuid(),
              (SELECT id FROM accounts WHERE username = $1),
              '127.0.0.1',
              'integration-fake-session'
       FROM generate_series(1, $2)`,
      [username, count],
    ),
  );
}

export async function setMaxSessions(
  username: string,
  limit: number | null,
): Promise<void> {
  await withAuthDb((c) =>
    c.query("UPDATE accounts SET max_sessions = $2 WHERE username = $1", [
      username,
      limit,
    ]),
  );
}

export async function expireSessionIdle(
  username: string,
  minutesAgo: number,
): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      `UPDATE sessions
       SET last_active_at = NOW() - INTERVAL '${minutesAgo} minutes'
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         AND revoked = false`,
      [username],
    ),
  );
}

export async function flagSessionReauth(username: string): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      `UPDATE sessions
       SET needs_reauth = true
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         AND revoked = false`,
      [username],
    ),
  );
}

export async function changeSessionFingerprint(
  username: string,
  newFingerprint: string,
): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      `UPDATE sessions
       SET browser_fingerprint = $2
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)
         AND revoked = false`,
      [username, newFingerprint],
    ),
  );
}

export async function createTestAccount(
  username: string,
  password: string,
  roleName: string,
): Promise<void> {
  await withAuthDb(async (c) => {
    const { rows: roleRows } = await c.query<{ id: number }>(
      "SELECT id FROM roles WHERE name = $1",
      [roleName],
    );
    if (roleRows.length === 0) {
      throw new Error(`Role "${roleName}" not found`);
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await c.query(
      `INSERT INTO accounts (username, display_name, password_hash, role_id, must_change_password)
       VALUES ($1, $1, $2, $3, false)
       ON CONFLICT (username) DO NOTHING`,
      [username, passwordHash, roleRows[0].id],
    );
  });
}

export async function deleteTestAccount(username: string): Promise<void> {
  await withAuthDb(async (c) => {
    await c.query(
      `DELETE FROM sessions
       WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
      [username],
    );
    await c.query(
      "DELETE FROM account_customer WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    );
    await c.query(
      "DELETE FROM password_history WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    );
    await c.query("DELETE FROM accounts WHERE username = $1", [username]);
  });
}

export async function setPassword(
  username: string,
  password: string,
): Promise<void> {
  await withAuthDb(async (c) => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await c.query(
      "UPDATE accounts SET password_hash = $2 WHERE username = $1",
      [username, passwordHash],
    );
  });
}

export async function addPasswordHistory(
  username: string,
  password: string,
): Promise<void> {
  await withAuthDb(async (c) => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await c.query(
      `INSERT INTO password_history (account_id, password_hash)
       VALUES ((SELECT id FROM accounts WHERE username = $1), $2)`,
      [username, passwordHash],
    );
  });
}

export async function clearPasswordHistory(username: string): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      "DELETE FROM password_history WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    ),
  );
}

export async function getAccountId(username: string): Promise<string> {
  return withAuthDb(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT id FROM accounts WHERE username = $1",
      [username],
    );
    if (rows.length === 0) throw new Error(`Account "${username}" not found`);
    return rows[0].id;
  });
}

export async function deleteCustomersByPrefix(prefix: string): Promise<void> {
  await withAuthDb(async (c) => {
    const { rows } = await c.query<{ id: number; database_name: string }>(
      "SELECT id, database_name FROM customers WHERE name LIKE $1",
      [`${prefix}%`],
    );
    for (const row of rows) {
      await c.query("DELETE FROM account_customer WHERE customer_id = $1", [
        row.id,
      ]);
      await c.query(
        `DROP DATABASE IF EXISTS ${escapeIdentifier(row.database_name)}`,
      );
    }
    if (rows.length > 0) {
      await c.query("DELETE FROM customers WHERE name LIKE $1", [`${prefix}%`]);
    }
  });
}

export async function assignCustomerToAccount(
  accountId: string,
  customerId: number,
): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      "INSERT INTO account_customer (account_id, customer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [accountId, customerId],
    ),
  );
}

export async function removeAccountCustomerAssignments(
  accountId: string,
): Promise<void> {
  await withAuthDb((c) =>
    c.query("DELETE FROM account_customer WHERE account_id = $1", [accountId]),
  );
}

export async function getCustomerIdByName(
  name: string,
): Promise<number | null> {
  return withAuthDb(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      "SELECT id FROM customers WHERE name = $1",
      [name],
    );
    return rows.length > 0 ? rows[0].id : null;
  });
}

export async function resetAccountPreferences(username: string): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      "UPDATE accounts SET locale = NULL, timezone = NULL WHERE username = $1",
      [username],
    ),
  );
}

export async function createTestRole(
  name: string,
  permissions: string[],
  description?: string,
): Promise<number> {
  return withAuthDb(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO roles (name, description, is_builtin)
       VALUES ($1, $2, false)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name, description ?? null],
    );
    const roleId = rows[0].id;

    await c.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    for (const perm of permissions) {
      await c.query(
        "INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)",
        [roleId, perm],
      );
    }

    return roleId;
  });
}

export async function deleteTestRole(name: string): Promise<void> {
  await withAuthDb(async (c) => {
    await c.query(
      "DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = $1)",
      [name],
    );
    await c.query("DELETE FROM roles WHERE name = $1 AND is_builtin = false", [
      name,
    ]);
  });
}

export async function deleteRolesByPrefix(prefix: string): Promise<void> {
  await withAuthDb(async (c) => {
    await c.query(
      `DELETE FROM role_permissions
       WHERE role_id IN (
         SELECT id FROM roles WHERE name LIKE $1 AND is_builtin = false
       )`,
      [`${prefix}%`],
    );
    await c.query(
      "DELETE FROM roles WHERE name LIKE $1 AND is_builtin = false",
      [`${prefix}%`],
    );
  });
}

// ── Audit database helpers ────────────────────────────────────────

export async function insertAuditLog(opts: {
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  ipAddress?: string;
  details?: Record<string, unknown>;
}): Promise<string> {
  return withAuditDb(async (c) => {
    const { rows } = await c.query<{ id: string }>(
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
  });
}

export async function deleteAuditLogById(id: string): Promise<void> {
  await withAuditDb((c) =>
    c.query("DELETE FROM audit_logs WHERE id = $1", [id]),
  );
}

export async function getSessionStatus(username: string): Promise<{
  needsReauth: boolean;
  revoked: boolean;
  browserFingerprint: string;
} | null> {
  return withAuthDb(async (c) => {
    const result = await c.query(
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
  });
}

// ── TOTP helpers ──────────────────────────────────────────────────

export async function deleteTotpCredential(username: string): Promise<void> {
  await withAuthDb((c) =>
    c.query(
      "DELETE FROM totp_credentials WHERE account_id = (SELECT id FROM accounts WHERE username = $1)",
      [username],
    ),
  );
}

export async function setMfaPolicyAllowedMethods(
  methods: string[],
): Promise<void> {
  await withAuthDb((c) =>
    c.query(`UPDATE system_settings SET value = $1 WHERE key = 'mfa_policy'`, [
      JSON.stringify({ allowed_methods: methods }),
    ]),
  );
}

export async function resetMfaPolicy(): Promise<void> {
  await setMfaPolicyAllowedMethods(["webauthn", "totp"]);
}

function escapeIdentifier(str: string): string {
  return `"${str.replace(/"/g, '""')}"`;
}
