import "server-only";

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";

import { connectTo, query } from "@/lib/db/client";

const MIGRATIONS_TABLE = "_migrations";
const LOCK_ID = 0xa1ce0001;

interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
}

function computeChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function hasNoTransactionMarker(sql: string): boolean {
  const firstLine = sql.split("\n", 1)[0];
  return firstLine.trimEnd() === "-- no-transaction";
}

function escapeIdentifier(str: string): string {
  return `"${str.replace(/"/g, '""')}"`;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Missing environment variable: DATABASE_URL");
  }
  return url;
}

function requireAuditDatabaseUrl(): string {
  const url = process.env.AUDIT_DATABASE_URL;
  if (!url) {
    throw new Error("Missing environment variable: AUDIT_DATABASE_URL");
  }
  return url;
}

function requireDatabaseAdminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error("Missing environment variable: DATABASE_ADMIN_URL");
  }
  return url;
}

function scanMigrations(directory: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const migrations = entries
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      const match = f.match(/^(\d+)_(.+)\.sql$/);
      if (!match) return null;
      return {
        version: match[1],
        name: match[2],
        filePath: path.join(directory, f),
      };
    })
    .filter((m): m is MigrationFile => m !== null);

  // Two files sharing the same numeric prefix both pass the
  // `!applied.has(version)` filter on a fresh DB and both enter `pending`,
  // so the second INSERT into `_migrations` collides on the version PK
  // and rolls back. In `provisionCustomerDb` that surfaces as a freshly
  // dropped tenant DB and 500s on every customer API call. Fail loud at
  // scan time so the collision is caught at PR review instead.
  const seen = new Map<string, string>();
  for (const m of migrations) {
    const prior = seen.get(m.version);
    if (prior !== undefined) {
      throw new Error(
        `Duplicate migration version "${m.version}" in ${directory}: ` +
          `${prior} and ${m.name}. Renumber one of them.`,
      );
    }
    seen.set(m.version, m.name);
  }

  return migrations;
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      checksum   TEXT NOT NULL
    )
  `);
}

interface AppliedMigration {
  version: string;
  checksum: string;
}

async function getAppliedMigrations(
  client: pg.PoolClient,
): Promise<Map<string, string>> {
  const result = await client.query<AppliedMigration>(
    `SELECT version, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return new Map(result.rows.map((r) => [r.version, r.checksum]));
}

function validateChecksums(
  applied: Map<string, string>,
  migrations: MigrationFile[],
): void {
  for (const migration of migrations) {
    const storedChecksum = applied.get(migration.version);
    // Pending (not-yet-applied) migrations have no stored checksum to
    // validate against.
    if (storedChecksum === undefined) continue;
    const sql = readFileSync(migration.filePath, "utf8");
    const currentChecksum = computeChecksum(sql);
    if (currentChecksum !== storedChecksum) {
      throw new Error(
        `Checksum mismatch for migration ${migration.version}_${migration.name}: ` +
          `expected ${storedChecksum}, got ${currentChecksum}`,
      );
    }
  }
}

async function applyMigrations(
  pool: pg.Pool,
  migrations: MigrationFile[],
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);

    try {
      await ensureMigrationsTable(client);
      const applied = await getAppliedMigrations(client);

      validateChecksums(applied, migrations);

      const pending = migrations.filter((m) => !applied.has(m.version));
      for (const migration of pending) {
        const sql = readFileSync(migration.filePath, "utf8");
        const checksum = computeChecksum(sql);

        if (hasNoTransactionMarker(sql)) {
          await client.query(sql);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
            [migration.version, migration.name, checksum],
          );
        } else {
          await client.query("BEGIN");
          try {
            await client.query(sql);
            await client.query(
              `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
              [migration.version, migration.name, checksum],
            );
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        }
      }

      return pending.length;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

function getMigrationsDir(subdir: string): string {
  return path.resolve(process.cwd(), "migrations", subdir);
}

async function runAdminQuery(sql: string): Promise<void> {
  const pool = connectTo(requireDatabaseAdminUrl());
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

function buildAuditAdminUrl(): string {
  const url = new URL(requireDatabaseAdminUrl());
  url.pathname = "/audit_db";
  return url.toString();
}

async function auditWriterRoleExists(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_writer') AS exists",
  );
  return result.rows[0]?.exists === true;
}

/**
 * Re-apply schema-level grants the audit migrations themselves depend on.
 * Run before `migrateAuditDb()` so a freshly-restored database (or one
 * where `audit_writer` has been inadvertently revoked) heals before the
 * migration runner connects as `audit_writer` and tries to CREATE TABLE.
 *
 * Short-circuits cleanly when the role does not exist (fresh cluster
 * before init-audit-db.sql has run, or non-Docker environments).
 */
export async function ensureAuditRolePermissionsPreflight(): Promise<void> {
  const pool = connectTo(buildAuditAdminUrl());
  try {
    if (!(await auditWriterRoleExists(pool))) return;
    await pool.query("GRANT CREATE, USAGE ON SCHEMA public TO audit_writer");
  } finally {
    await pool.end();
  }
}

/**
 * Re-apply table- and sequence-level grants. Run after `migrateAuditDb()`
 * because on a fresh cluster `audit_logs` does not exist until 0001
 * runs. Guarded with `to_regclass(...)` so the helper is also safe
 * to call before the table exists.
 */
export async function ensureAuditRolePermissionsPostflight(): Promise<void> {
  const pool = connectTo(buildAuditAdminUrl());
  try {
    if (!(await auditWriterRoleExists(pool))) return;

    const tableExists = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.audit_logs') IS NOT NULL AS exists",
    );
    if (tableExists.rows[0]?.exists !== true) return;

    await pool.query("GRANT INSERT, SELECT ON audit_logs TO audit_writer");
    await pool.query(
      "GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO audit_writer",
    );
  } finally {
    await pool.end();
  }
}

export async function migrateAuthDb(): Promise<number> {
  const migrations = scanMigrations(getMigrationsDir("auth"));
  if (migrations.length === 0) return 0;

  const pool = connectTo(requireDatabaseUrl());
  try {
    return await applyMigrations(pool, migrations);
  } finally {
    await pool.end();
  }
}

export async function migrateAuditDb(): Promise<number> {
  const migrations = scanMigrations(getMigrationsDir("audit"));
  if (migrations.length === 0) return 0;

  const pool = connectTo(requireAuditDatabaseUrl());
  try {
    return await applyMigrations(pool, migrations);
  } finally {
    await pool.end();
  }
}

export async function migrateCustomerDb(
  connectionString: string,
): Promise<number> {
  const migrations = scanMigrations(getMigrationsDir("customer"));
  if (migrations.length === 0) return 0;

  const pool = connectTo(connectionString);
  try {
    return await applyMigrations(pool, migrations);
  } finally {
    await pool.end();
  }
}

export async function provisionCustomerDb(dbName: string): Promise<void> {
  // CREATE DATABASE cannot run inside a transaction in PostgreSQL
  await runAdminQuery(`CREATE DATABASE ${escapeIdentifier(dbName)}`);

  const baseUrl = requireDatabaseUrl();
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const customerPool = connectTo(url.toString());

  try {
    const migrations = scanMigrations(getMigrationsDir("customer"));
    await applyMigrations(customerPool, migrations);
  } catch (err) {
    await runAdminQuery(`DROP DATABASE IF EXISTS ${escapeIdentifier(dbName)}`);
    throw err;
  } finally {
    await customerPool.end();
  }
}

export async function dropCustomerDb(dbName: string): Promise<void> {
  await runAdminQuery(`DROP DATABASE IF EXISTS ${escapeIdentifier(dbName)}`);
}

export async function runStartupMigrations(): Promise<void> {
  await migrateAuthDb();
  // Heal schema-level grants before the audit migration runner connects
  // as `audit_writer`. A drifted GRANT CREATE on `public` would surface
  // as `permission denied for schema public` from migrateAuditDb().
  await ensureAuditRolePermissionsPreflight();
  await migrateAuditDb();
  // Re-apply table/sequence grants on every boot. Idempotent; safe
  // against operator-induced privilege drift.
  await ensureAuditRolePermissionsPostflight();

  // Clean up stale provisioning rows (crashed mid-provision)
  const stale = await query<{ database_name: string }>(
    "SELECT database_name FROM customers WHERE status = 'provisioning'",
  );
  for (const row of stale.rows) {
    await runAdminQuery(
      `DROP DATABASE IF EXISTS ${escapeIdentifier(row.database_name)}`,
    );
  }
  if (stale.rows.length > 0) {
    await query("DELETE FROM customers WHERE status = 'provisioning'");
  }

  const result = await query<{ database_name: string }>(
    "SELECT database_name FROM customers WHERE status = 'active'",
  );

  const baseUrl = requireDatabaseUrl();
  for (const row of result.rows) {
    const url = new URL(baseUrl);
    url.pathname = `/${row.database_name}`;
    await migrateCustomerDb(url.toString());
  }
}

export {
  computeChecksum as _computeChecksum,
  hasNoTransactionMarker as _hasNoTransactionMarker,
  scanMigrations as _scanMigrations,
};
