import "server-only";

import type pg from "pg";

import { query } from "@/lib/db/client";

import { getCustomerPool } from "../policy/customer-db";
import type { StoredExclusionKind } from "./storage-input";

/**
 * Storage repository for global + customer-scoped triage exclusions
 * (#457).
 *
 * Two tables share the same column shape so the in-memory matcher and
 * the retroactive-DELETE planner do not branch by scope. The only
 * structural difference is `created_by`: the global table has an FK
 * to `auth_db.accounts(id)` ON DELETE RESTRICT, while the per-tenant
 * table carries a plain UUID with application-level existence
 * enforcement (no cross-database FKs).
 */

const PG_UNIQUE_VIOLATION = "23505";

export class StoredExclusionConflictError extends Error {
  readonly kind: string;
  readonly value: string;

  constructor(kind: string, value: string) {
    super(`Exclusion (${kind}, ${JSON.stringify(value)}) already exists`);
    this.name = "StoredExclusionConflictError";
    this.kind = kind;
    this.value = value;
  }
}

export interface StoredExclusionRow {
  id: string;
  kind: StoredExclusionKind;
  value: string;
  domainSuffix: string | null;
  note: string | null;
  createdBy: string;
  createdByDisplayName: string | null;
  createdAt: string;
}

interface RawStoredExclusionRow {
  id: string;
  kind: string;
  value: string;
  domain_suffix: string | null;
  note: string | null;
  created_by: string;
  created_by_display_name: string | null;
  created_at: Date;
}

function toRow(raw: RawStoredExclusionRow): StoredExclusionRow {
  return {
    id: raw.id,
    kind: raw.kind as StoredExclusionKind,
    value: raw.value,
    domainSuffix: raw.domain_suffix,
    note: raw.note,
    createdBy: raw.created_by,
    createdByDisplayName: raw.created_by_display_name,
    createdAt: raw.created_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === PG_UNIQUE_VIOLATION
  );
}

// ── Global exclusions (auth_db) ──────────────────────────────────

const GLOBAL_LIST_SQL = `
  SELECT g.id, g.kind, g.value, g.domain_suffix, g.note, g.created_by,
         a.display_name AS created_by_display_name, g.created_at
    FROM global_triage_exclusion g
    LEFT JOIN accounts a ON a.id = g.created_by
ORDER BY g.created_at DESC, g.id`;

export async function listGlobalExclusions(): Promise<StoredExclusionRow[]> {
  const { rows } = await query<RawStoredExclusionRow>(GLOBAL_LIST_SQL);
  return rows.map(toRow);
}

export interface CreateGlobalExclusionInput {
  kind: StoredExclusionKind;
  value: string;
  domainSuffix: string | null;
  note: string | null;
  createdBy: string;
}

const GLOBAL_INSERT_SQL = `
  INSERT INTO global_triage_exclusion (kind, value, domain_suffix, note, created_by)
       VALUES ($1, $2, $3, $4, $5)
    RETURNING id, kind, value, domain_suffix, note, created_by, created_at`;

export interface CreatedGlobalExclusion {
  id: string;
  kind: StoredExclusionKind;
  value: string;
  domainSuffix: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

/**
 * Create a global exclusion row inside the caller's `auth_db`
 * transaction. Caller is responsible for validating + normalizing
 * `value` and computing `domainSuffix` (via
 * `parseStoredExclusionInput`).
 */
export async function createGlobalExclusion(
  client: pg.PoolClient,
  input: CreateGlobalExclusionInput,
): Promise<CreatedGlobalExclusion> {
  try {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      value: string;
      domain_suffix: string | null;
      note: string | null;
      created_by: string;
      created_at: Date;
    }>(GLOBAL_INSERT_SQL, [
      input.kind,
      input.value,
      input.domainSuffix,
      input.note,
      input.createdBy,
    ]);
    const row = rows[0];
    return {
      id: row.id,
      kind: row.kind as StoredExclusionKind,
      value: row.value,
      domainSuffix: row.domain_suffix,
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new StoredExclusionConflictError(input.kind, input.value);
    }
    throw err;
  }
}

export async function getGlobalExclusionById(
  id: string,
): Promise<StoredExclusionRow | null> {
  const { rows } = await query<RawStoredExclusionRow>(
    `${GLOBAL_LIST_SQL.replace("ORDER BY g.created_at DESC, g.id", "WHERE g.id = $1")}`,
    [id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteGlobalExclusion(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM global_triage_exclusion WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Customer-scoped exclusions (tenant DB) ───────────────────────

const CUSTOMER_LIST_SQL = `
  SELECT id, kind, value, domain_suffix, note, created_by,
         NULL::text AS created_by_display_name, created_at
    FROM triage_exclusion
ORDER BY created_at DESC, id`;

/**
 * List exclusions for one customer. The `created_by_display_name`
 * column is resolved separately (against `auth_db.accounts`) because
 * cross-database joins are not supported.
 */
export async function listCustomerExclusions(
  customerId: number,
): Promise<StoredExclusionRow[]> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<RawStoredExclusionRow>(CUSTOMER_LIST_SQL);
  if (rows.length === 0) return [];
  const ids = Array.from(new Set(rows.map((r) => r.created_by)));
  const namesById = await resolveAccountDisplayNames(ids);
  return rows.map((r) =>
    toRow({
      ...r,
      created_by_display_name: namesById.get(r.created_by) ?? null,
    }),
  );
}

async function resolveAccountDisplayNames(
  accountIds: string[],
): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const { rows } = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM accounts WHERE id = ANY($1::uuid[])`,
    [accountIds],
  );
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.id, row.display_name);
  return map;
}

export interface CreateCustomerExclusionInput {
  kind: StoredExclusionKind;
  value: string;
  domainSuffix: string | null;
  note: string | null;
  createdBy: string;
}

const CUSTOMER_INSERT_SQL = `
  INSERT INTO triage_exclusion (kind, value, domain_suffix, note, created_by)
       VALUES ($1, $2, $3, $4, $5)
    RETURNING id, kind, value, domain_suffix, note, created_by, created_at`;

export async function createCustomerExclusion(
  _customerId: number,
  input: CreateCustomerExclusionInput,
  client: pg.PoolClient,
): Promise<StoredExclusionRow> {
  try {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      value: string;
      domain_suffix: string | null;
      note: string | null;
      created_by: string;
      created_at: Date;
    }>(CUSTOMER_INSERT_SQL, [
      input.kind,
      input.value,
      input.domainSuffix,
      input.note,
      input.createdBy,
    ]);
    const row = rows[0];
    return {
      id: row.id,
      kind: row.kind as StoredExclusionKind,
      value: row.value,
      domainSuffix: row.domain_suffix,
      note: row.note,
      createdBy: row.created_by,
      createdByDisplayName: null,
      createdAt: row.created_at.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new StoredExclusionConflictError(input.kind, input.value);
    }
    throw err;
  }
}

/**
 * Acquire a `pg.PoolClient` against the customer's tenant DB. Used by
 * the customer-scoped ADD path so the INSERT and the first DELETE
 * batch can share a transaction.
 */
export async function connectCustomerClient(
  customerId: number,
): Promise<pg.PoolClient> {
  const pool = await getCustomerPool(customerId);
  return pool.connect();
}

export async function deleteCustomerExclusion(
  customerId: number,
  id: string,
): Promise<boolean> {
  const pool = await getCustomerPool(customerId);
  const result = await pool.query(
    `DELETE FROM triage_exclusion WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Active set (union of global + customer-scoped) ──────────────

export interface ActiveExclusionStorageRow {
  scope: "global" | "customer";
  kind: StoredExclusionKind;
  value: string;
  domainSuffix: string | null;
}

/**
 * Read the active union (global + customer-scoped) for `customerId`.
 * Returns the raw stored rows; the in-memory matcher is built from
 * these via `compileActiveExclusionSet`.
 *
 * Two reads per call is acceptable: the global table is ops-managed
 * (O(10²)) and the tenant table is per-customer (O(10²)–O(10³)).
 */
export async function loadActiveExclusionRows(
  customerId: number,
): Promise<ActiveExclusionStorageRow[]> {
  const pool = await getCustomerPool(customerId);
  const [globalResult, customerResult] = await Promise.all([
    query<{
      kind: string;
      value: string;
      domain_suffix: string | null;
    }>(`SELECT kind, value, domain_suffix FROM global_triage_exclusion`),
    pool.query<{
      kind: string;
      value: string;
      domain_suffix: string | null;
    }>(`SELECT kind, value, domain_suffix FROM triage_exclusion`),
  ]);
  const out: ActiveExclusionStorageRow[] = [];
  for (const r of globalResult.rows) {
    out.push({
      scope: "global",
      kind: r.kind as StoredExclusionKind,
      value: r.value,
      domainSuffix: r.domain_suffix,
    });
  }
  for (const r of customerResult.rows) {
    out.push({
      scope: "customer",
      kind: r.kind as StoredExclusionKind,
      value: r.value,
      domainSuffix: r.domain_suffix,
    });
  }
  return out;
}

// ── Fanout queue (auth_db) ───────────────────────────────────────

export interface FanoutJobRow {
  id: string;
  globalExclusionId: string;
  customerId: number;
  status: "pending" | "running" | "completed" | "failed";
  attemptCount: number;
  nextAttemptAt: string;
  claimedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawFanoutJobRow {
  id: string;
  global_exclusion_id: string;
  customer_id: number;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toFanoutRow(raw: RawFanoutJobRow): FanoutJobRow {
  return {
    id: raw.id,
    globalExclusionId: raw.global_exclusion_id,
    customerId: raw.customer_id,
    status: raw.status as FanoutJobRow["status"],
    attemptCount: raw.attempt_count,
    nextAttemptAt: raw.next_attempt_at.toISOString(),
    claimedAt: raw.claimed_at ? raw.claimed_at.toISOString() : null,
    lastError: raw.last_error,
    createdAt: raw.created_at.toISOString(),
    updatedAt: raw.updated_at.toISOString(),
  };
}

/**
 * Bulk-insert one fanout job per active customer in the same auth_db
 * transaction as the global INSERT. The caller passes a connected
 * client so the global INSERT and the fanout INSERTs share a
 * transaction; the SELECT of active customers happens inside this
 * helper to keep the query co-located with its consumer.
 */
export async function enqueueGlobalExclusionFanout(
  client: pg.PoolClient,
  globalExclusionId: string,
): Promise<{ enqueued: number }> {
  const result = await client.query(
    `INSERT INTO triage_exclusion_fanout_job (global_exclusion_id, customer_id)
       SELECT $1, c.id FROM customers c WHERE c.status = 'active'`,
    [globalExclusionId],
  );
  return { enqueued: result.rowCount ?? 0 };
}

export async function listFanoutJobs(): Promise<FanoutJobRow[]> {
  const { rows } = await query<RawFanoutJobRow>(
    `SELECT id, global_exclusion_id, customer_id, status, attempt_count,
            next_attempt_at, claimed_at, last_error, created_at, updated_at
       FROM triage_exclusion_fanout_job
   ORDER BY created_at DESC`,
  );
  return rows.map(toFanoutRow);
}
