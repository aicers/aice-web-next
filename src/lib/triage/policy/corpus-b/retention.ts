import "server-only";

import type pg from "pg";

import { query as authDbQuery } from "@/lib/db/client";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * Policy corpus B retention + zombie-runner recovery (#461 / 1B-7).
 *
 * Three sweeps against `policy_triage_run` per tenant DB. Each row's
 * `policy_triaged_event` rows cascade with the run (`ON DELETE CASCADE`
 * in the tenant schema), so pruning a run also prunes its events in
 * the same transaction.
 *
 * Sweep order is important: the zombie reaper runs *first* so a
 * timed-out `computing` row flips to `failed` and is then eligible for
 * the failed-row 1-day retention path on the same sweep. The orphan
 * sweep runs last so a row whose `owner_account_id` no longer resolves
 * is cleaned regardless of status — typically operator account deletes
 * happen rarely and the orphan accumulation rate is low.
 *
 * Lives under `corpus-b/` so removing the policy mode also removes its
 * cleanup (deprecatability seam, §6 of discussion #447).
 */

export const DEFAULT_DELETE_BATCH_SIZE = 1_000;

/**
 * Time a `computing` row is allowed to sit before the reaper considers
 * the runner crashed. The reverse-direction race (a slow runner
 * completing after the reaper flipped the row to `failed`) is closed
 * on the runner side by `markRunReadyOnClient`'s `AND status =
 * 'computing'` guard, so the reaper does not need additional
 * coordination.
 */
export const ZOMBIE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export const READY_RETENTION_DAYS = 30; // active ready rows
export const SUPERSEDED_RETENTION_DAYS = 7; // superseded rows
export const FAILED_RETENTION_DAYS = 1; // failed rows

export interface PolicyRetentionCounts {
  zombiesReaped: number;
  readyPruned: number;
  supersededPruned: number;
  failedPruned: number;
  orphanedPruned: number;
}

export interface PolicyRetentionCustomerResult {
  customerId: number;
  status: "ok" | "failed";
  counts: PolicyRetentionCounts;
  error?: string;
}

export interface PolicyRetentionResult {
  overall: "ok" | "partial" | "failed";
  perCustomer: PolicyRetentionCustomerResult[];
}

function emptyCounts(): PolicyRetentionCounts {
  return {
    zombiesReaped: 0,
    readyPruned: 0,
    supersededPruned: 0,
    failedPruned: 0,
    orphanedPruned: 0,
  };
}

/**
 * Flip stuck-`computing` rows to `failed` with the documented marker.
 * Returns the count for observability. Driven by `created_at` so the
 * threshold is independent of `finalized_at` (which is NULL for
 * `computing` rows).
 */
async function reapZombies(pool: pg.Pool, timeoutMs: number): Promise<number> {
  const result = await pool.query(
    `UPDATE policy_triage_run
        SET status = 'failed',
            finalized_at = NOW(),
            last_error = 'timeout: runner did not finalize'
      WHERE status = 'computing'
        AND created_at < NOW() - ($1 || ' milliseconds')::INTERVAL`,
    [String(timeoutMs)],
  );
  return result.rowCount ?? 0;
}

/**
 * Delete rows matching a predicate in batches. Returns the total rows
 * removed. Each batch is a single-statement transaction (auto-commit).
 */
async function batchDelete(
  pool: pg.Pool,
  predicate: string,
  params: unknown[],
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const result = await pool.query(
      `DELETE FROM policy_triage_run
        WHERE id IN (
          SELECT id FROM policy_triage_run
           WHERE ${predicate}
           LIMIT ${batchSize}
        )`,
      params,
    );
    const n = result.rowCount ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}

/**
 * Load every `owner_account_id` referenced by the customer's
 * `policy_triage_run` rows, then probe `auth_db.accounts(id)` once for
 * the unresolved set. Returns the list of `owner_account_id` values
 * whose referenced account row no longer exists. Cross-DB FKs are not
 * supported, so this is the application-layer existence check.
 */
async function findOrphanedOwners(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ owner_account_id: string }>(
    `SELECT DISTINCT owner_account_id FROM policy_triage_run`,
  );
  if (rows.length === 0) return [];
  const owners = rows.map((r) => r.owner_account_id);
  const { rows: resolved } = await authDbQuery<{ id: string }>(
    `SELECT id FROM accounts WHERE id = ANY($1::uuid[])`,
    [owners],
  );
  const resolvedSet = new Set(resolved.map((r) => r.id));
  return owners.filter((id) => !resolvedSet.has(id));
}

/**
 * Run all three sweeps for one customer. The caller's fan-out reports
 * status per customer; this function lets errors bubble so the
 * dispatcher can record `status: 'failed'` without aborting the rest.
 */
export async function runPolicyRetentionForCustomer(
  customerId: number,
  options: {
    batchSize?: number;
    zombieTimeoutMs?: number;
  } = {},
): Promise<PolicyRetentionCounts> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const zombieTimeoutMs = options.zombieTimeoutMs ?? ZOMBIE_TIMEOUT_MS;
  const pool = await getCustomerPool(customerId);
  const counts = emptyCounts();

  // 1) Zombie reaper — `computing` rows older than the timeout become
  //    `failed`, which then makes them eligible for the failed-row
  //    retention path on this same sweep tick.
  counts.zombiesReaped = await reapZombies(pool, zombieTimeoutMs);

  // 2) Differential retention. Each predicate uses the table's
  //    `policy_triage_run_status_created_idx` for status filtering plus
  //    `created_at` / `finalized_at` for the age cut.
  //
  //    The `ready` path additionally consults the Phase 2 protection
  //    hook so an in-flight LLM SendBatch keyed off a ready run is not
  //    pruned out from under the batch. Only `ready` is gated:
  //    `superseded` rows have already been replaced, `failed` rows are
  //    terminal, and `computing` zombies are flipped to `failed` by the
  //    reaper above — none of those statuses can have a meaningful
  //    SendBatch in flight.
  counts.readyPruned = await pruneReadyWithProtection(
    pool,
    READY_RETENTION_DAYS,
    batchSize,
  );
  counts.supersededPruned = await batchDelete(
    pool,
    `status = 'superseded'
       AND finalized_at IS NOT NULL
       AND finalized_at < NOW() - ($1 || ' days')::INTERVAL`,
    [String(SUPERSEDED_RETENTION_DAYS)],
    batchSize,
  );
  counts.failedPruned = await batchDelete(
    pool,
    `status = 'failed' AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [String(FAILED_RETENTION_DAYS)],
    batchSize,
  );

  // 3) Orphan owners. Rare and unbounded by status; collapse to a
  //    single DELETE against a set of (typically tiny) owner ids.
  const orphanOwners = await findOrphanedOwners(pool);
  if (orphanOwners.length > 0) {
    const result = await pool.query(
      `DELETE FROM policy_triage_run WHERE owner_account_id = ANY($1::uuid[])`,
      [orphanOwners],
    );
    counts.orphanedPruned = result.rowCount ?? 0;
  }
  return counts;
}

async function defaultListActiveCustomers(): Promise<number[]> {
  const result = await authDbQuery<{ id: number }>(
    "SELECT id FROM customers WHERE status = 'active' ORDER BY id",
  );
  return result.rows.map((r) => Number(r.id));
}

export interface PolicyRetentionOptions {
  batchSize?: number;
  zombieTimeoutMs?: number;
  listActiveCustomers?: () => Promise<number[]>;
  runForCustomer?: (
    customerId: number,
    options: { batchSize?: number; zombieTimeoutMs?: number },
  ) => Promise<PolicyRetentionCounts>;
}

export async function runPolicyRetentionDispatch(
  options: PolicyRetentionOptions = {},
): Promise<PolicyRetentionResult> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const zombieTimeoutMs = options.zombieTimeoutMs ?? ZOMBIE_TIMEOUT_MS;
  const listActiveCustomers =
    options.listActiveCustomers ?? defaultListActiveCustomers;
  const runForCustomer =
    options.runForCustomer ?? runPolicyRetentionForCustomer;

  const customerIds = await listActiveCustomers();
  const perCustomer: PolicyRetentionCustomerResult[] = [];
  for (const customerId of customerIds) {
    try {
      const counts = await runForCustomer(customerId, {
        batchSize,
        zombieTimeoutMs,
      });
      perCustomer.push({ customerId, status: "ok", counts });
    } catch (err) {
      perCustomer.push({
        customerId,
        status: "failed",
        counts: emptyCounts(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const overall: PolicyRetentionResult["overall"] = perCustomer.some(
    (e) => e.status === "failed",
  )
    ? "partial"
    : "ok";
  return { overall, perCustomer };
}

/**
 * Internal-token guard for the policy retention route. Reads
 * `TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN`. Constant-time compare.
 */
export function verifyTriagePolicyRetentionToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_POLICY_RETENTION_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Phase 2 LLM-batch protection extension hook (#461).
 *
 * Invoked by `pruneReadyWithProtection` once per candidate `ready`
 * run. Returning `true` keeps the run alive for this retention tick.
 * The default predicate returns `false` so retention runs
 * unconditionally today; Phase 2 swaps `current` for a real
 * SendBatch-in-flight check without modifying retention.ts.
 *
 * Only the `ready` path consults the hook — `superseded` / `failed` /
 * `computing` runs cannot have a meaningful in-flight SendBatch.
 */
export type RunProtectionPredicate = (runId: string) => Promise<boolean>;
export const _protectionExtensionHook: { current: RunProtectionPredicate } = {
  current: async () => false,
};

/**
 * Delete `ready` rows past the retention window in batches, skipping
 * any row the Phase 2 protection hook claims. The hook is consulted
 * row-by-row so a long-running predicate (e.g. a remote SendBatch
 * status check) doesn't block the entire sweep on one call.
 *
 * Protected ids accumulate in a Set so the next SELECT excludes them
 * — without this, an all-protected batch would loop forever on the
 * same set of rows.
 */
async function pruneReadyWithProtection(
  pool: pg.Pool,
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  let total = 0;
  const protectedIds = new Set<string>();
  while (true) {
    const protectedArr = Array.from(protectedIds);
    const { rows } =
      protectedArr.length === 0
        ? await pool.query<{ id: string }>(
            `SELECT id FROM policy_triage_run
              WHERE status = 'ready'
                AND created_at < NOW() - ($1 || ' days')::INTERVAL
              LIMIT ${batchSize}`,
            [String(retentionDays)],
          )
        : await pool.query<{ id: string }>(
            `SELECT id FROM policy_triage_run
              WHERE status = 'ready'
                AND created_at < NOW() - ($1 || ' days')::INTERVAL
                AND id <> ALL($2::bigint[])
              LIMIT ${batchSize}`,
            [String(retentionDays), protectedArr],
          );
    if (rows.length === 0) break;
    const toDelete: string[] = [];
    for (const r of rows) {
      if (await _protectionExtensionHook.current(r.id)) {
        protectedIds.add(r.id);
      } else {
        toDelete.push(r.id);
      }
    }
    if (toDelete.length > 0) {
      const result = await pool.query(
        `DELETE FROM policy_triage_run WHERE id = ANY($1::bigint[])`,
        [toDelete],
      );
      total += result.rowCount ?? 0;
    }
    // Loop until a batch comes back short — at which point either the
    // table is drained or every remaining row is protected.
    if (rows.length < batchSize) break;
  }
  return total;
}
