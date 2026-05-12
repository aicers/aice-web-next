import "server-only";

import type pg from "pg";

import { getCustomerPool } from "../customer-db";
import type {
  PolicyTriagedEventRow,
  PolicyTriageRunRow,
  PolicyTriageRunStatus,
} from "./types";

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Raised when the partial unique index
 * `policy_triage_run_active_fingerprint` rejects an INSERT/UPDATE for
 * a fingerprint that another transaction has already claimed.
 *
 * Caller is expected to re-query the active slot and either return the
 * existing run (cache hit) or report the race to the user.
 */
export class PolicyTriageRunActiveSlotConflict extends Error {
  constructor() {
    super("Active fingerprint slot is already occupied");
    this.name = "PolicyTriageRunActiveSlotConflict";
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === PG_UNIQUE_VIOLATION
  );
}

interface RunDbRow {
  id: string;
  owner_account_id: string;
  period_start: Date;
  period_end: Date;
  policies_fingerprint: string;
  exclusions_fingerprint: string;
  baseline_version: string;
  status: PolicyTriageRunStatus;
  replaces: string | null;
  superseded_by: string | null;
  refresh_reason: string | null;
  computation_duration_ms: string | null;
  last_error: string | null;
  created_at: Date;
  finalized_at: Date | null;
}

function rowToRun(row: RunDbRow): PolicyTriageRunRow {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    periodStartIso: row.period_start.toISOString(),
    periodEndIso: row.period_end.toISOString(),
    policiesFingerprint: row.policies_fingerprint,
    exclusionsFingerprint: row.exclusions_fingerprint,
    baselineVersion: row.baseline_version,
    status: row.status,
    replaces: row.replaces,
    supersededBy: row.superseded_by,
    refreshReason: row.refresh_reason,
    computationDurationMs:
      row.computation_duration_ms === null
        ? null
        : Number(row.computation_duration_ms),
    lastError: row.last_error,
    createdAtIso: row.created_at.toISOString(),
    finalizedAtIso: row.finalized_at?.toISOString() ?? null,
  };
}

const RUN_COLUMNS = `
  id::text                                 AS id,
  owner_account_id                         AS owner_account_id,
  period_start, period_end,
  policies_fingerprint, exclusions_fingerprint, baseline_version,
  status,
  replaces::text                           AS replaces,
  superseded_by::text                      AS superseded_by,
  refresh_reason,
  computation_duration_ms::text            AS computation_duration_ms,
  last_error,
  created_at,
  finalized_at
`;

export interface ActiveRunLookupInput {
  ownerAccountId: string;
  periodStartIso: string;
  periodEndIso: string;
  policiesFingerprint: string;
  exclusionsFingerprint: string;
  baselineVersion: string;
}

/**
 * Look up the active (`computing` or `ready`) run for the given
 * fingerprint, or `null` if no row occupies the slot. Reading directly
 * from the partial-unique index slot — at most one row matches.
 */
export async function findActiveRun(
  customerId: number,
  input: ActiveRunLookupInput,
): Promise<PolicyTriageRunRow | null> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS}
       FROM policy_triage_run
      WHERE owner_account_id = $1
        AND period_start = $2
        AND period_end = $3
        AND policies_fingerprint = $4
        AND exclusions_fingerprint = $5
        AND baseline_version = $6
        AND status IN ('computing', 'ready')`,
    [
      input.ownerAccountId,
      input.periodStartIso,
      input.periodEndIso,
      input.policiesFingerprint,
      input.exclusionsFingerprint,
      input.baselineVersion,
    ],
  );
  return rows.length === 0 ? null : rowToRun(rows[0]);
}

/**
 * Fetch one run by id (any status), or `null` if not found.
 */
export async function getRunById(
  customerId: number,
  runId: string,
): Promise<PolicyTriageRunRow | null> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS} FROM policy_triage_run WHERE id = $1`,
    [runId],
  );
  return rows.length === 0 ? null : rowToRun(rows[0]);
}

export interface NewRunInput extends ActiveRunLookupInput {
  refreshReason: string | null;
}

/**
 * Insert a fresh `computing` run for the given fingerprint. Throws
 * {@link PolicyTriageRunActiveSlotConflict} when the partial-unique
 * index rejects the INSERT — caller re-queries the active slot.
 */
export async function insertComputingRun(
  customerId: number,
  input: NewRunInput,
): Promise<PolicyTriageRunRow> {
  const pool = await getCustomerPool(customerId);
  try {
    const { rows } = await pool.query<RunDbRow>(
      `INSERT INTO policy_triage_run (
          owner_account_id, period_start, period_end,
          policies_fingerprint, exclusions_fingerprint, baseline_version,
          status, refresh_reason
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'computing', $7)
       RETURNING ${RUN_COLUMNS}`,
      [
        input.ownerAccountId,
        input.periodStartIso,
        input.periodEndIso,
        input.policiesFingerprint,
        input.exclusionsFingerprint,
        input.baselineVersion,
        input.refreshReason,
      ],
    );
    return rowToRun(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new PolicyTriageRunActiveSlotConflict();
    throw err;
  }
}

export interface RecomputeInput extends NewRunInput {
  /** The existing `ready` run being replaced. */
  oldRunId: string;
}

/**
 * Recompute transaction: supersede the existing `ready` row and
 * INSERT a fresh `computing` row in one transaction so the partial
 * unique slot is never double-occupied (§3.5 "Recompute transaction
 * model").
 *
 * Returns the new run row on success. Throws
 * {@link PolicyTriageRunActiveSlotConflict} when:
 *
 *   - the existing row's status changed (already superseded / reaped),
 *     in which case the caller re-queries the active slot, or
 *   - the INSERT trips the partial unique index (a concurrent
 *     recompute won the race).
 */
export async function recomputeRun(
  customerId: number,
  input: RecomputeInput,
): Promise<PolicyTriageRunRow> {
  const pool = await getCustomerPool(customerId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: pre-allocate the new id so step 2's UPDATE can set
    // `superseded_by`.
    const idResult = await client.query<{ new_id: string }>(
      `SELECT nextval('policy_triage_run_id_seq')::text AS new_id`,
    );
    const newId = idResult.rows[0].new_id;

    // Step 2: supersede the old row, but only if it's still `ready`.
    // Rowcount = 0 means another transaction got there first.
    const upd = await client.query(
      `UPDATE policy_triage_run
          SET status = 'superseded', superseded_by = $1, finalized_at = NOW()
        WHERE id = $2 AND status = 'ready'`,
      [newId, input.oldRunId],
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      throw new PolicyTriageRunActiveSlotConflict();
    }

    // Step 3: INSERT the new computing row with the pre-allocated id.
    let inserted: RunDbRow;
    try {
      const { rows } = await client.query<RunDbRow>(
        `INSERT INTO policy_triage_run (
            id, owner_account_id, period_start, period_end,
            policies_fingerprint, exclusions_fingerprint, baseline_version,
            status, refresh_reason, replaces
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'computing', $8, $9)
         RETURNING ${RUN_COLUMNS}`,
        [
          newId,
          input.ownerAccountId,
          input.periodStartIso,
          input.periodEndIso,
          input.policiesFingerprint,
          input.exclusionsFingerprint,
          input.baselineVersion,
          input.refreshReason,
          input.oldRunId,
        ],
      );
      inserted = rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(err)) throw new PolicyTriageRunActiveSlotConflict();
      throw err;
    }
    await client.query("COMMIT");
    return rowToRun(inserted);
  } finally {
    client.release();
  }
}

/**
 * Mark a `computing` run `ready` after its events have been inserted.
 * The caller is expected to have already populated
 * `policy_triaged_event` rows; this UPDATE only flips the status flag
 * and records duration. `created_at` from the row is read to compute
 * the elapsed duration if not provided.
 */
export async function markRunReady(
  customerId: number,
  runId: string,
  computationDurationMs: number,
): Promise<void> {
  const pool = await getCustomerPool(customerId);
  await pool.query(
    `UPDATE policy_triage_run
        SET status = 'ready',
            computation_duration_ms = $2,
            finalized_at = NOW(),
            last_error = NULL
      WHERE id = $1`,
    [runId, computationDurationMs],
  );
}

/**
 * Mark a `computing` run `failed` with the supplied error message.
 * Idempotent against repeated calls so the runner's catch path can
 * surface the failure even when the in-flight transaction has already
 * rolled back.
 */
export async function markRunFailed(
  customerId: number,
  runId: string,
  lastError: string,
): Promise<void> {
  const pool = await getCustomerPool(customerId);
  await pool.query(
    `UPDATE policy_triage_run
        SET status = 'failed',
            last_error = $2,
            finalized_at = COALESCE(finalized_at, NOW())
      WHERE id = $1 AND status = 'computing'`,
    [runId, lastError],
  );
}

interface TriagedEventDbRow {
  run_id: string;
  event_key: string;
  event_time: Date;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  orig_port: number | null;
  resp_addr: string | null;
  resp_port: number | null;
  proto: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: string | null;
  policy_triage_snapshot: PolicyTriagedEventRow["snapshot"];
}

function rowToTriagedEvent(row: TriagedEventDbRow): PolicyTriagedEventRow {
  return {
    runId: row.run_id,
    eventKey: row.event_key,
    eventTimeIso: row.event_time.toISOString(),
    kind: row.kind,
    sensor: row.sensor,
    origAddr: row.orig_addr,
    origPort: row.orig_port,
    respAddr: row.resp_addr,
    respPort: row.resp_port,
    proto: row.proto,
    host: row.host,
    dnsQuery: row.dns_query,
    uri: row.uri,
    category: row.category,
    snapshot: row.policy_triage_snapshot,
  };
}

/**
 * Insert a batch of `policy_triaged_event` rows. Returns the inserted
 * row count. `ON CONFLICT DO NOTHING` is intentional: a re-run of the
 * same page on the same run should be idempotent. The runner inserts
 * inside its own transaction so a final failure can roll back the
 * page-level work without leaving partial results behind.
 */
export async function insertTriagedEventsBatch(
  client: pg.PoolClient,
  runId: string,
  rows: ReadonlyArray<Omit<PolicyTriagedEventRow, "runId">>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const row of rows) {
    const base = params.length;
    const ph: string[] = [];
    for (let i = 1; i <= 15; i += 1) ph.push(`$${base + i}`);
    placeholders.push(`(${ph.join(", ")})`);
    params.push(
      runId,
      row.eventKey,
      row.eventTimeIso,
      row.kind,
      row.sensor,
      row.origAddr,
      row.origPort,
      row.respAddr,
      row.respPort,
      row.proto,
      row.host,
      row.dnsQuery,
      row.uri,
      row.category,
      JSON.stringify(row.snapshot),
    );
  }
  const result = await client.query(
    `INSERT INTO policy_triaged_event (
        run_id, event_key, event_time, kind, sensor,
        orig_addr, orig_port, resp_addr, resp_port, proto,
        host, dns_query, uri, category, policy_triage_snapshot
      ) VALUES ${placeholders.join(", ")}
      ON CONFLICT (run_id, event_key) DO NOTHING`,
    params,
  );
  return result.rowCount ?? 0;
}

/**
 * Read the events attached to one run. Used by the menu's "With my
 * policies" view and by tests.
 */
export async function listTriagedEvents(
  customerId: number,
  runId: string,
): Promise<PolicyTriagedEventRow[]> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<TriagedEventDbRow>(
    `SELECT run_id::text                AS run_id,
            event_key::text             AS event_key,
            event_time,
            kind,
            sensor,
            orig_addr::text             AS orig_addr,
            orig_port,
            resp_addr::text             AS resp_addr,
            resp_port,
            proto,
            host, dns_query, uri,
            category,
            policy_triage_snapshot
       FROM policy_triaged_event
      WHERE run_id = $1
      ORDER BY event_time DESC, event_key DESC`,
    [runId],
  );
  return rows.map(rowToTriagedEvent);
}

export const _testing = {
  rowToRun,
  rowToTriagedEvent,
};
