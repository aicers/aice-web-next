import "server-only";

import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { connectTo, query } from "@/lib/db/client";

import { hashPassword } from "./password";

const SYSTEM_ADMIN_ROLE_NAME = "System Administrator";

/** Hardcoded upper bound for System Administrator accounts (Discussion #32 §4.5). */
export const MAX_SYSTEM_ADMINISTRATORS = 5;

const SECRET_USERNAME_PATH = "/run/secrets/init_admin_username";
const SECRET_PASSWORD_PATH = "/run/secrets/init_admin_password";
const CONSUMED_MARKER_FILENAME = ".init_admin_consumed";

function getDataDir(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  return path.resolve(dir);
}

function isConsumedMarkerPresent(): boolean {
  try {
    accessSync(
      path.join(getDataDir(), CONSUMED_MARKER_FILENAME),
      constants.F_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function readSecretFiles(): { username: string; password: string } | null {
  if (isConsumedMarkerPresent()) {
    return null;
  }

  try {
    const username = readFileSync(SECRET_USERNAME_PATH, "utf8").trim();
    const password = readFileSync(SECRET_PASSWORD_PATH, "utf8").trim();

    if (!username || !password) {
      return null;
    }

    return { username, password };
  } catch {
    return null;
  }
}

function readEnvCredentials(): { username: string; password: string } | null {
  const username = process.env.INIT_ADMIN_USERNAME?.trim();
  const password = process.env.INIT_ADMIN_PASSWORD?.trim();

  if (!username || !password) {
    return null;
  }

  return { username, password };
}

function resolveCredentials(): {
  username: string;
  password: string;
  source: "secret_file" | "env_var";
} | null {
  const fromFile = readSecretFiles();
  if (fromFile) {
    return { ...fromFile, source: "secret_file" };
  }

  const fromEnv = readEnvCredentials();
  if (fromEnv) {
    return { ...fromEnv, source: "env_var" };
  }

  return null;
}

function consumeSecretFiles(): void {
  let deletionFailed = false;

  for (const filePath of [SECRET_USERNAME_PATH, SECRET_PASSWORD_PATH]) {
    try {
      unlinkSync(filePath);
    } catch {
      deletionFailed = true;
    }
  }

  if (deletionFailed) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, CONSUMED_MARKER_FILENAME),
      new Date().toISOString(),
      "utf8",
    );
  }
}

async function writeBootstrapAuditLog(
  accountId: string,
  username: string,
): Promise<void> {
  const auditUrl = process.env.AUDIT_DATABASE_URL;
  if (!auditUrl) {
    console.warn(
      "AUDIT_DATABASE_URL not set; skipping bootstrap audit log entry",
    );
    return;
  }

  const auditPool = connectTo(auditUrl);
  try {
    await auditPool.query(
      `INSERT INTO audit_logs
        (actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "system",
        "account.create",
        "account",
        accountId,
        JSON.stringify({
          username,
          role: SYSTEM_ADMIN_ROLE_NAME,
          source: "bootstrap",
        }),
      ],
    );
  } finally {
    await auditPool.end();
  }
}

/**
 * Bootstrap the initial System Administrator account on first startup.
 *
 * Reads credentials from Docker secret files or environment variables,
 * hashes the password with Argon2id, and inserts a single admin account
 * only if the accounts table is empty. Concurrent instances are handled
 * atomically via INSERT ... WHERE NOT EXISTS.
 */
export async function bootstrapAdminAccount(): Promise<void> {
  // Step 1: Check if accounts already exist
  const { rows: countRows } = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM accounts",
  );
  const accountCount = Number.parseInt(countRows[0].count, 10);

  if (accountCount > 0) {
    return;
  }

  // Step 2: Resolve credentials
  const credentials = resolveCredentials();
  if (!credentials) {
    return;
  }

  const { username, password, source } = credentials;

  // Step 3: Look up System Administrator role ID
  const { rows: roleRows } = await query<{ id: number }>(
    "SELECT id FROM roles WHERE name = $1",
    [SYSTEM_ADMIN_ROLE_NAME],
  );

  if (roleRows.length === 0) {
    throw new Error(
      `Role "${SYSTEM_ADMIN_ROLE_NAME}" not found. Ensure migrations have run.`,
    );
  }

  const roleId = roleRows[0].id;

  // Step 4: Hash password
  const passwordHash = await hashPassword(password);

  // Step 5: Insert account with atomic race-condition guard
  const { rows: insertedRows } = await query<{ id: string }>(
    `INSERT INTO accounts
       (username, display_name, password_hash, role_id, must_change_password)
     SELECT $1, $2, $3, $4, true
     WHERE NOT EXISTS (SELECT 1 FROM accounts)
     RETURNING id`,
    [username, username, passwordHash, roleId],
  );

  if (insertedRows.length === 0) {
    return;
  }

  const accountId = insertedRows[0].id;

  // Step 6: Insert initial password history entry
  await query(
    "INSERT INTO password_history (account_id, password_hash) VALUES ($1, $2)",
    [accountId, passwordHash],
  );

  // Step 7: Write audit log
  await writeBootstrapAuditLog(accountId, username);

  // Step 8: Consume secret files if source was secret_file
  if (source === "secret_file") {
    consumeSecretFiles();
  }
}
