import "server-only";

import type pg from "pg";

import { connectTo, type QueryResult } from "@/lib/db/client";

// ── Pool management ─────────────────────────────────────────────

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.AUDIT_DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing environment variable: AUDIT_DATABASE_URL");
  }

  pool = connectTo(connectionString);
  return pool;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Execute a read query against the audit database.
 *
 * Uses a separate connection pool from the write pool in `logger.ts`
 * so that read and write concerns remain isolated.
 */
export async function queryAudit<
  T extends pg.QueryResultRow = pg.QueryResultRow,
>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  const result = await getPool().query<T>(text, params);
  return { rows: result.rows, rowCount: result.rowCount };
}

/** Gracefully close the audit read pool. */
export async function endAuditReadPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Reset pool reference without ending connections. For tests only. */
export function resetAuditReadPool(): void {
  pool = null;
}
