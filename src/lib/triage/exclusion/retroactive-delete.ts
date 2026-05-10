import "server-only";

import type pg from "pg";

import { LOCK_NAMESPACE as CADENCE_LOCK_NAMESPACE } from "@/lib/triage/baseline/cadence";

import type { StoredExclusionKind } from "./storage-input";

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

interface ExecutionContext {
  client: pg.PoolClient;
  policyTableExists: boolean;
  batchSize: number;
}

interface DeleteStatement {
  sql: string;
  params: unknown[];
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
  const buildLimited = (
    predicate: string,
    params: unknown[],
  ): DeleteStatement => ({
    sql: `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${predicate} LIMIT ${batchSize})`,
    params,
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
      // Only the suffix-reducible subset is retroactive.
      if (input.domainSuffix !== null) {
        // `.example.com` matches both `example.com` and any
        // `*.example.com`; an exact-only reduction stores the bare
        // hostname (no leading dot).
        if (input.domainSuffix.startsWith(".")) {
          const exact = input.domainSuffix.slice(1);
          const suffix = input.domainSuffix;
          // host: exact OR ends-with .suffix
          statements.push(
            buildLimited(`host IS NOT NULL AND (host = $1 OR host LIKE $2)`, [
              exact,
              `%${suffix}`,
            ]),
          );
          statements.push(
            buildLimited(
              `dns_query IS NOT NULL AND (dns_query = $1 OR dns_query LIKE $2)`,
              [exact, `%${suffix}`],
            ),
          );
        } else {
          statements.push(buildLimited(`host = $1`, [input.domainSuffix]));
          statements.push(buildLimited(`dns_query = $1`, [input.domainSuffix]));
        }
      }
      break;
    }
  }
  return statements;
}

async function runBatchedDelete(
  ctx: ExecutionContext,
  table: string,
  input: PlanInput,
): Promise<number> {
  const statements = buildStatementsForTable(table, input, ctx.batchSize);
  if (statements.length === 0) return 0;
  let total = 0;
  for (const stmt of statements) {
    // Each predicate is its own batched loop — drain until a batch
    // returns fewer than `batchSize` rows.
    while (true) {
      const result = await ctx.client.query(stmt.sql, stmt.params);
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < ctx.batchSize) break;
    }
  }
  return total;
}

/**
 * Execute the retroactive DELETE plan against the tenant DB inside the
 * caller's transaction. The caller MUST have already acquired
 * `acquireCustomerCadenceLock`.
 *
 * Returns the per-table deleted-row counts. `policyTriagedEvent` is
 * `null` when the table is not present at runtime (pre-#460
 * deployments).
 */
export async function executeRetroactiveDelete(
  client: pg.PoolClient,
  input: PlanInput,
  options: { batchSize?: number } = {},
): Promise<DeletedCounts> {
  const policyTableExists = await policyTriagedEventTableExists(client);
  const ctx: ExecutionContext = {
    client,
    policyTableExists,
    batchSize: options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE,
  };

  const baselineTriagedEvent = await runBatchedDelete(
    ctx,
    "baseline_triaged_event",
    input,
  );
  const observedEventMeta = await runBatchedDelete(
    ctx,
    "observed_event_meta",
    input,
  );
  const policyTriagedEvent = policyTableExists
    ? await runBatchedDelete(ctx, CONDITIONAL_CORPUS_B_TABLE, input)
    : null;

  return {
    baselineTriagedEvent,
    observedEventMeta,
    policyTriagedEvent,
  };
}

export const _testing = {
  buildStatementsForTable,
  CORPUS_A_TABLES,
  CONDITIONAL_CORPUS_B_TABLE,
};
