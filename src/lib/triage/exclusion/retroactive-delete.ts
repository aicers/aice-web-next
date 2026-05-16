import "server-only";

import type pg from "pg";

import { enqueueNotice } from "@/lib/aimer/phase2/state";
import { LOCK_NAMESPACE as CADENCE_LOCK_NAMESPACE } from "@/lib/triage/baseline/cadence";

import type { StoredExclusionKind } from "./storage-input";
import {
  type DomainSuffixSubset,
  reduceDomainPatternToSuffix,
} from "./suffix-reducer";

/**
 * Retroactive-DELETE planner (#457).
 *
 * When a customer-scoped or global exclusion is added, matching rows
 * already on the corpus tables are deleted so cadence-time and
 * retroactive paths agree on the same final corpus.
 *
 * The planner targets the indexed normalized columns from #456:
 *   - `orig_addr` / `resp_addr` for `ipAddress` (CIDR membership via
 *     PostgreSQL `inet` `>>=` operator)
 *   - `host`       for `hostname` exact + the suffix-reducible subset
 *     of `domain`
 *   - `dns_query`  for the suffix-reducible subset of `domain` on DNS
 *     events
 *   - `uri`        for `uri` exact
 *
 * NTLM carve-out: NTLM rows have `host` / `dns_query` / `uri` NULL, so
 * they only match `ipAddress` exclusions retroactively. The carve-out
 * is enforced at INSERT time by the cadence runner — the planner does
 * not need to special-case NTLM here because the `host IS NULL` /
 * `dns_query IS NULL` / `uri IS NULL` filter naturally skips those
 * rows.
 *
 * `policy_triaged_event` (introduced by #460) is treated conditionally:
 * the planner queries `to_regclass('policy_triaged_event')` once per
 * ADD; if the table exists the symmetric DELETE is emitted, otherwise
 * the branch is skipped silently. Pre-#460 deployments simply have no
 * corpus B to clean up.
 *
 * Large DELETEs run in batches of `DEFAULT_DELETE_BATCH_SIZE` rows per
 * statement to bound lock duration and WAL pressure. The first batch
 * shares a transaction with the ADD's INSERT (so a crashed runner
 * cannot leave a row inserted with no DELETE applied); subsequent
 * batches run in their own transactions.
 */

export const DEFAULT_DELETE_BATCH_SIZE = 10_000;

// Re-export the cadence runner's lock namespace so the byte-identical
// key reaches `hashtext()` from both sides — cadence
// (`pg_try_advisory_xact_lock`) and ADD (`pg_advisory_xact_lock`).
// Drifting these two strings would silently break the contention
// guarantee from issue #457.
export const PER_CUSTOMER_ADVISORY_LOCK_NAMESPACE = CADENCE_LOCK_NAMESPACE;

const CORPUS_A_TABLES = [
  "baseline_triaged_event",
  "observed_event_meta",
] as const;
const CONDITIONAL_CORPUS_B_TABLE = "policy_triaged_event";

export interface PlanInput {
  kind: StoredExclusionKind;
  value: string;
  domainSuffix: string | null;
}

export interface DeletedCounts {
  baselineTriagedEvent: number;
  observedEventMeta: number;
  policyTriagedEvent: number | null;
}

/**
 * Phase 2 withdraw-notice discriminator carried per DELETE statement.
 *
 *   - `"withdraw_baseline_event"` — `baseline_triaged_event` rows are
 *     mirrored on aimer-web; deletes produce a withdraw notice keyed
 *     by `(baseline_version, [event_key, ...])` per #573.
 *   - `"withdraw_policy_event"` — `policy_triaged_event` rows are
 *     mirrored on aimer-web; deletes produce a withdraw notice keyed
 *     by `(run_id, [event_key, ...])`.
 *   - `null` — table is not mirrored on aimer-web
 *     (`observed_event_meta`). Statement carries no `RETURNING` and
 *     emits no withdraw notice.
 */
export type RetroactiveWithdrawKind =
  | "withdraw_baseline_event"
  | "withdraw_policy_event"
  | null;

interface DeleteStatement {
  sql: string;
  params: unknown[];
  /**
   * Phase 2 withdraw discriminator. When set to a non-null value the
   * SQL carries a `RETURNING` clause whose columns are decoded by
   * {@link enqueueWithdrawForBatchRows} into a queue notice on the
   * same connection that ran the DELETE. Defaults to `null` (no
   * enqueue) when omitted, matching `observed_event_meta` semantics.
   */
  withdrawKind?: RetroactiveWithdrawKind;
}

async function policyTriagedEventTableExists(
  client: pg.PoolClient,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.${CONDITIONAL_CORPUS_B_TABLE}') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

/**
 * Acquire the per-customer advisory lock with the **blocking** variant
 * (the cadence runner uses `pg_try_advisory_xact_lock` and exits if
 * we hold the key — losing an ADD's retroactive DELETE would leave
 * stale corpus rows, so ADD blocks on cadence rather than skipping).
 *
 * MUST be called inside a transaction; the lock is released on
 * COMMIT/ROLLBACK.
 */
export async function acquireCustomerCadenceLock(
  client: pg.PoolClient,
  customerId: number,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `${PER_CUSTOMER_ADVISORY_LOCK_NAMESPACE}${customerId}`,
  ]);
}

/**
 * Build the DELETE statements for one stored exclusion against one
 * corpus table. Returns 0..N statements; some kinds (e.g. an
 * unreducible `domain`) emit zero against an indexed column.
 */
function buildStatementsForTable(
  table: string,
  input: PlanInput,
  batchSize: number,
): DeleteStatement[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid batchSize: ${batchSize}`);
  }
  const statements: DeleteStatement[] = [];
  // Per #573: `baseline_triaged_event` and `policy_triaged_event` are
  // mirrored on aimer-web and need a withdraw notice per drain txn;
  // `observed_event_meta` is local event-observation metadata and has
  // no `baseline_version` column, so its DELETE keeps `rowCount`-only
  // tracking with no `RETURNING` and no enqueue.
  let returningClause = "";
  let withdrawKind: RetroactiveWithdrawKind = null;
  if (table === "baseline_triaged_event") {
    withdrawKind = "withdraw_baseline_event";
    returningClause =
      " RETURNING baseline_version, event_key::text AS event_key";
  } else if (table === "policy_triaged_event") {
    withdrawKind = "withdraw_policy_event";
    returningClause =
      " RETURNING run_id::text AS run_id, event_key::text AS event_key";
  }
  const buildLimited = (
    predicate: string,
    params: unknown[],
  ): DeleteStatement => ({
    sql: `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${predicate} LIMIT ${batchSize})${returningClause}`,
    params,
    withdrawKind,
  });

  switch (input.kind) {
    case "ipAddress": {
      // CIDR / single-IP; the value is already canonical CIDR.
      // `inet >>= inet` is "contains or equals" — supported by GiST.
      statements.push(buildLimited(`orig_addr <<= $1::inet`, [input.value]));
      statements.push(buildLimited(`resp_addr <<= $1::inet`, [input.value]));
      break;
    }
    case "hostname": {
      statements.push(buildLimited(`host = $1`, [input.value]));
      break;
    }
    case "uri": {
      statements.push(buildLimited(`uri = $1`, [input.value]));
      break;
    }
    case "domain": {
      // Only the suffix-reducible subset is retroactive. Re-derive the
      // subset shape from the regex `value` so the SQL predicate
      // matches the regex's exact match set — `domain_suffix` alone
      // does not distinguish `'suffix'` (bare host excluded) from
      // `'exactOrSuffix'` (bare host included), and over-deleting
      // would permanently remove rows the regex never matched.
      if (input.domainSuffix === null) break;
      const reduction = reduceDomainPatternToSuffix(input.value);
      if (reduction === null) break;
      const subset: DomainSuffixSubset = reduction.subset;
      // Trust the reducer's `value` rather than the stored
      // `domain_suffix`: they are computed from the same input, but
      // re-deriving keeps SQL generation purely a function of `value`
      // (and avoids any drift if a row was inserted with stale
      // `domain_suffix`).
      const reducedValue = reduction.value;
      switch (subset) {
        case "exact": {
          statements.push(buildLimited(`host = $1`, [reducedValue]));
          statements.push(buildLimited(`dns_query = $1`, [reducedValue]));
          break;
        }
        case "suffix": {
          // `reducedValue` carries the leading dot; the LIKE pattern
          // `'%.example.com'` matches `*.example.com` only — the
          // literal dot rules out the bare host.
          statements.push(
            buildLimited(`host IS NOT NULL AND host LIKE $1`, [
              `%${reducedValue}`,
            ]),
          );
          statements.push(
            buildLimited(`dns_query IS NOT NULL AND dns_query LIKE $1`, [
              `%${reducedValue}`,
            ]),
          );
          break;
        }
        case "exactOrSuffix": {
          // `([a-z0-9-]+\.)*<host>`: matches both bare and any depth
          // of label prefixes. SQL emits both predicates; planner
          // unions the two.
          const exact = reducedValue.startsWith(".")
            ? reducedValue.slice(1)
            : reducedValue;
          statements.push(
            buildLimited(`host IS NOT NULL AND (host = $1 OR host LIKE $2)`, [
              exact,
              `%${reducedValue}`,
            ]),
          );
          statements.push(
            buildLimited(
              `dns_query IS NOT NULL AND (dns_query = $1 OR dns_query LIKE $2)`,
              [exact, `%${reducedValue}`],
            ),
          );
          break;
        }
      }
      break;
    }
  }
  return statements;
}

interface BatchReturnedRows {
  baseline_version?: string;
  run_id?: string;
  event_key: string;
}

/**
 * Coalesce DELETE `RETURNING` rows produced inside one drain
 * transaction into Phase 2 withdraw notices and enqueue them on the
 * same connection. Per acceptance criteria:
 *
 *   - `withdraw_baseline_event` → one notice per distinct
 *     `baseline_version`, payload `{ baseline_version, event_keys[] }`.
 *   - `withdraw_policy_event`   → one notice per distinct `run_id`,
 *     payload `{ run_id, event_keys[] }`.
 *
 * Enqueuing on the caller's `client` means a rollback of this drain
 * batch's transaction drops the enqueue with it — the per-batch
 * atomicity guarantee in #573 Trigger 1.
 */
async function enqueueWithdrawForBatchRows(
  client: pg.PoolClient,
  customerId: number,
  withdrawKind: Exclude<RetroactiveWithdrawKind, null>,
  returnedRows: readonly BatchReturnedRows[],
): Promise<void> {
  if (returnedRows.length === 0) return;
  if (withdrawKind === "withdraw_baseline_event") {
    const byVersion = new Map<string, string[]>();
    for (const row of returnedRows) {
      if (!row.baseline_version || !row.event_key) continue;
      const list = byVersion.get(row.baseline_version);
      if (list) list.push(row.event_key);
      else byVersion.set(row.baseline_version, [row.event_key]);
    }
    for (const [version, eventKeys] of byVersion) {
      if (eventKeys.length === 0) continue;
      await enqueueNotice(
        customerId,
        "withdraw_baseline_event",
        { baseline_version: version, event_keys: eventKeys },
        client,
      );
    }
  } else {
    const byRun = new Map<string, string[]>();
    for (const row of returnedRows) {
      if (!row.run_id || !row.event_key) continue;
      const list = byRun.get(row.run_id);
      if (list) list.push(row.event_key);
      else byRun.set(row.run_id, [row.event_key]);
    }
    for (const [runId, eventKeys] of byRun) {
      if (eventKeys.length === 0) continue;
      await enqueueNotice(
        customerId,
        "withdraw_policy_event",
        { run_id: runId, event_keys: eventKeys },
        client,
      );
    }
  }
}

/**
 * Run the **first** batch of every DELETE statement against the
 * caller's already-open transaction. Records any statement whose first
 * batch was full (rowCount === batchSize) as `pending` so the drain
 * phase can finish it in fresh transactions.
 *
 * When `customerId` is provided, returned rows from withdraw-eligible
 * predicates are coalesced and enqueued via {@link enqueueNotice} on
 * the same client — so the withdraw notice shares the ADD's
 * transaction and a rollback drops it with the INSERT (#573 Trigger 1
 * "first batch in the ADD txn").
 *
 * Returns the rows deleted in this transaction plus the pending list.
 */
async function runFirstBatchPerStatement(
  client: pg.PoolClient,
  table: string,
  input: PlanInput,
  batchSize: number,
  customerId: number | undefined,
): Promise<{ deleted: number; pending: DeleteStatement[] }> {
  const statements = buildStatementsForTable(table, input, batchSize);
  let deleted = 0;
  const pending: DeleteStatement[] = [];
  // Coalesce returned rows across every statement in this first batch
  // so a single ADD transaction emits one queue row per
  // (target_kind, baseline_version) / (target_kind, run_id), per #573.
  const baselineRows: BatchReturnedRows[] = [];
  const policyRows: BatchReturnedRows[] = [];
  for (const stmt of statements) {
    const result = await client.query<BatchReturnedRows>(stmt.sql, stmt.params);
    const n = result.rowCount ?? 0;
    deleted += n;
    if (stmt.withdrawKind === "withdraw_baseline_event") {
      baselineRows.push(...result.rows);
    } else if (stmt.withdrawKind === "withdraw_policy_event") {
      policyRows.push(...result.rows);
    }
    // A full batch means there may be more matching rows; mark for
    // drain. A partial batch means the predicate is exhausted.
    if (n >= batchSize) pending.push(stmt);
  }
  if (customerId !== undefined) {
    await enqueueWithdrawForBatchRows(
      client,
      customerId,
      "withdraw_baseline_event",
      baselineRows,
    );
    await enqueueWithdrawForBatchRows(
      client,
      customerId,
      "withdraw_policy_event",
      policyRows,
    );
  }
  return { deleted, pending };
}

/**
 * Drain a single DELETE predicate to completion using fresh
 * transactions, one per batch. Each batch acquires its own connection
 * via `withTx`, which MUST begin and commit a transaction.
 *
 * `shouldContinue` is consulted before each batch so the caller can
 * cancel mid-drain — e.g. the global-fanout worker re-checks that the
 * source `global_triage_exclusion` row still exists, since the active
 * set must be the source of truth for retroactive cleanup. Returning
 * `false` aborts the predicate early without deleting more rows.
 *
 * When `customerId` is provided, the rows returned by each batch are
 * coalesced and enqueued via {@link enqueueNotice} on the **same
 * connection** that just ran the DELETE — so a rollback of that
 * batch's transaction drops the enqueue with it. Earlier batches'
 * enqueues stay intact because each lives in its own transaction
 * (#573 Trigger 1 "subsequent-batch enqueue inside each fresh drain
 * txn").
 */
async function drainPendingStatements(
  withTx: TxRunner,
  pending: DeleteStatement[],
  batchSize: number,
  shouldContinue?: () => Promise<boolean>,
  customerId?: number,
): Promise<number> {
  let deleted = 0;
  for (const stmt of pending) {
    while (true) {
      if (shouldContinue && !(await shouldContinue())) return deleted;
      const n = await withTx(async (client) => {
        const result = await client.query<BatchReturnedRows>(
          stmt.sql,
          stmt.params,
        );
        const rowCount = result.rowCount ?? 0;
        const withdrawKind = stmt.withdrawKind ?? null;
        if (
          customerId !== undefined &&
          withdrawKind !== null &&
          result.rows.length > 0
        ) {
          await enqueueWithdrawForBatchRows(
            client,
            customerId,
            withdrawKind,
            result.rows,
          );
        }
        return rowCount;
      });
      deleted += n;
      if (n < batchSize) break;
    }
  }
  return deleted;
}

/**
 * Run a database operation inside a fresh transaction. Implementations
 * MUST begin a transaction, invoke `fn`, and commit on success /
 * rollback on error.
 */
export type TxRunner = <T>(
  fn: (client: pg.PoolClient) => Promise<T>,
) => Promise<T>;

/**
 * Run the **first** batch of every DELETE predicate inside the
 * caller's transaction (the same one that holds the exclusion INSERT
 * and the per-customer cadence advisory lock). The caller MUST have
 * already acquired `acquireCustomerCadenceLock` and is expected to
 * COMMIT after this function returns so the cadence lock releases
 * promptly.
 *
 * Returns a plan continuation that the caller drains via
 * `drainRemainingRetroactiveDeletes` from a fresh-transaction runner —
 * subsequent batches run in their own transactions to bound lock
 * duration and WAL pressure (#457). A concurrent cadence tick that
 * sees a partially-cleaned corpus is benign because the new exclusion
 * row is already visible and cadence step (c) applies it forward from
 * that point.
 *
 * Sharing the first batch with the INSERT keeps the crash-safety
 * invariant: a runner that dies before the COMMIT leaves no row
 * inserted; a runner that dies after the COMMIT but before the drain
 * finishes leaves the row visible and the corpus partially cleaned —
 * the next forward pass enforces the rest.
 */
export async function executeFirstRetroactiveDeleteBatch(
  firstBatchClient: pg.PoolClient,
  input: PlanInput,
  options: { batchSize?: number; customerId?: number } = {},
): Promise<{ counts: DeletedCounts; pending: PendingDrain[] }> {
  const policyTableExists =
    await policyTriagedEventTableExists(firstBatchClient);
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;

  const tablesToProcess: { key: keyof DeletedCounts; table: string }[] = [
    { key: "baselineTriagedEvent", table: "baseline_triaged_event" },
    { key: "observedEventMeta", table: "observed_event_meta" },
  ];
  if (policyTableExists) {
    tablesToProcess.push({
      key: "policyTriagedEvent",
      table: CONDITIONAL_CORPUS_B_TABLE,
    });
  }

  const counts: DeletedCounts = {
    baselineTriagedEvent: 0,
    observedEventMeta: 0,
    policyTriagedEvent: policyTableExists ? 0 : null,
  };
  const pending: PendingDrain[] = [];
  for (const { key, table } of tablesToProcess) {
    const result = await runFirstBatchPerStatement(
      firstBatchClient,
      table,
      input,
      batchSize,
      options.customerId,
    );
    if (key === "policyTriagedEvent") {
      counts.policyTriagedEvent = result.deleted;
    } else {
      counts[key] = result.deleted;
    }
    if (result.pending.length > 0) {
      pending.push({ tableKey: key, statements: result.pending });
    }
  }

  return { counts, pending };
}

/**
 * Drain the remainder of a retroactive DELETE plan in fresh
 * transactions, one batch per transaction. Returns the additional
 * rows deleted per table; the caller should add these to the
 * first-batch counts for the audit row.
 *
 * `withTx` MUST begin and commit a transaction per invocation.
 */
export async function drainRemainingRetroactiveDeletes(
  withTx: TxRunner,
  pending: PendingDrain[],
  options: {
    batchSize?: number;
    shouldContinue?: () => Promise<boolean>;
    customerId?: number;
  } = {},
): Promise<DeletedCounts> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const out: DeletedCounts = {
    baselineTriagedEvent: 0,
    observedEventMeta: 0,
    policyTriagedEvent: null,
  };
  for (const entry of pending) {
    if (options.shouldContinue && !(await options.shouldContinue())) {
      return out;
    }
    const drained = await drainPendingStatements(
      withTx,
      entry.statements,
      batchSize,
      options.shouldContinue,
      options.customerId,
    );
    if (entry.tableKey === "policyTriagedEvent") {
      out.policyTriagedEvent = (out.policyTriagedEvent ?? 0) + drained;
    } else {
      out[entry.tableKey] += drained;
    }
  }
  return out;
}

/**
 * Convenience composition for tests and the legacy single-transaction
 * path: runs the first batch on `firstBatchClient`, then drains the
 * remainder via `withTx`. Returns combined counts.
 *
 * Production callers should prefer the two-step API
 * (`executeFirstRetroactiveDeleteBatch` + COMMIT +
 * `drainRemainingRetroactiveDeletes`) so the cadence advisory lock
 * releases between the first batch and the drain.
 */
export async function executeRetroactiveDelete(
  firstBatchClient: pg.PoolClient,
  input: PlanInput,
  options: {
    batchSize?: number;
    drainTx?: TxRunner;
    customerId?: number;
  } = {},
): Promise<DeletedCounts> {
  const { counts, pending } = await executeFirstRetroactiveDeleteBatch(
    firstBatchClient,
    input,
    { batchSize: options.batchSize, customerId: options.customerId },
  );
  if (pending.length === 0) return counts;
  // No drainTx provided: drain through the same client (legacy
  // behavior, preserved so existing tests against a single mock
  // client still exercise the full DELETE loop).
  const withTx: TxRunner =
    options.drainTx ?? (async (fn) => fn(firstBatchClient));
  const drained = await drainRemainingRetroactiveDeletes(withTx, pending, {
    batchSize: options.batchSize,
    customerId: options.customerId,
  });
  return {
    baselineTriagedEvent:
      counts.baselineTriagedEvent + drained.baselineTriagedEvent,
    observedEventMeta: counts.observedEventMeta + drained.observedEventMeta,
    policyTriagedEvent:
      counts.policyTriagedEvent === null
        ? null
        : counts.policyTriagedEvent + (drained.policyTriagedEvent ?? 0),
  };
}

/**
 * One predicate's outstanding work after the first batch. The drain
 * phase consumes this list and runs each statement in its own
 * fresh-transaction loop until the batch returns fewer than
 * `batchSize` rows.
 */
export interface PendingDrain {
  tableKey: keyof DeletedCounts;
  statements: DeleteStatement[];
}

export const _testing = {
  buildStatementsForTable,
  CORPUS_A_TABLES,
  CONDITIONAL_CORPUS_B_TABLE,
};
