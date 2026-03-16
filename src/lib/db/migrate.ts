import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";

import { connectTo, query } from "@/lib/db/client";

const MIGRATIONS_TABLE = "_migrations";

interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
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

  return entries
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
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedVersions(client: pg.PoolClient): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return new Set(result.rows.map((r) => r.version));
}

async function applyMigrations(
  pool: pg.Pool,
  migrations: MigrationFile[],
): Promise<number> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);

    const pending = migrations.filter((m) => !applied.has(m.version));
    for (const migration of pending) {
      const sql = readFileSync(migration.filePath, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ($1, $2)`,
          [migration.version, migration.name],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    return pending.length;
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
  await migrateAuditDb();

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

export { scanMigrations as _scanMigrations };
