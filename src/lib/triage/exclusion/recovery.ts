import "server-only";

import type pg from "pg";

import { auditLog } from "@/lib/audit/logger";
import { withTransaction } from "@/lib/db/client";

import { MAX_ATTEMPTS } from "./fanout-worker";

/**
 * Recovery surface for failed exclusion fanout / drain cleanup
 * (#461 / 1B-7).
 *
 * Two failure classes share one queue:
 *
 *   1. Global ADD fanout `failed` rows — `triage_exclusion_fanout_job`
 *      rows that exhausted the worker's exponential backoff. Reset
 *      by mode `'global'` (one row) or `'global_all_failed'` (sweep
 *      one exclusion's failures).
 *   2. Customer-scoped ADD drain failure — the synchronous drain phase
 *      in `POST /api/triage/exclusions` failed after the INSERT + first
 *      DELETE batch committed. The drain-failure path inserts a
 *      sentinel row into the queue (status='failed', attempt_count=
 *      MAX_ATTEMPTS, key=`customer_only_exclusion_id`) so reset-in-place
 *      recovery has a target. Reset by mode `'customer'`.
 *
 * All resets are UPDATEs against existing rows so the admin UI's
 * "Re-trigger cleanup" affordance collapses after a successful retry
 * (a fresh `pending` row would leave the old `failed` row visible).
 * The fanout worker's next sweep picks the row up via the same
 * `FOR UPDATE SKIP LOCKED` claim path.
 */

export interface ResetCounts {
  reset: number;
}

/**
 * Reset a single global-exclusion fanout row keyed by
 * `(global_exclusion_id, customer_id)`. Returns the rowcount so the
 * caller can report `404` when the request named an exclusion + customer
 * pair that has no `failed` row (typo or already-recovered case).
 */
export async function resetGlobalFanoutJob(
  client: pg.PoolClient,
  globalExclusionId: string,
  customerId: number,
): Promise<number> {
  const result = await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'pending',
            attempt_count = 0,
            last_error = NULL,
            next_attempt_at = NOW(),
            claimed_at = NULL,
            updated_at = NOW()
      WHERE global_exclusion_id = $1
        AND customer_id = $2
        AND status = 'failed'`,
    [globalExclusionId, customerId],
  );
  return result.rowCount ?? 0;
}

/**
 * Operator sweep: reset every `failed` row for one global exclusion.
 * Used after a tenant-DB outage where many customers' fanout rows
 * exhausted retries.
 */
export async function resetAllGlobalFailedJobs(
  client: pg.PoolClient,
  globalExclusionId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'pending',
            attempt_count = 0,
            last_error = NULL,
            next_attempt_at = NOW(),
            claimed_at = NULL,
            updated_at = NOW()
      WHERE global_exclusion_id = $1
        AND status = 'failed'`,
    [globalExclusionId],
  );
  return result.rowCount ?? 0;
}

/**
 * Reset the customer-scoped drain-failure sentinel keyed by
 * `(customer_only_exclusion_id, customer_id)`. Returns the rowcount so
 * the caller can 404 on a missing sentinel.
 */
export async function resetCustomerDrainSentinel(
  client: pg.PoolClient,
  customerExclusionId: string,
  customerId: number,
): Promise<number> {
  const result = await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'pending',
            attempt_count = 0,
            last_error = NULL,
            next_attempt_at = NOW(),
            claimed_at = NULL,
            updated_at = NOW()
      WHERE customer_only_exclusion_id = $1
        AND customer_id = $2
        AND status = 'failed'`,
    [customerExclusionId, customerId],
  );
  return result.rowCount ?? 0;
}

/**
 * Insert (or upsert) the customer-scoped drain-failure sentinel.
 *
 * Called by `POST /api/triage/exclusions` when the synchronous drain
 * phase fails after the INSERT + first DELETE batch have committed.
 * Keyed by the unique partial index
 * `triage_exclusion_fanout_job_customer_dedupe`; a repeat drain
 * failure for the same exclusion replaces the prior sentinel's
 * `last_error` and resets the timestamps.
 *
 * `attempt_count = MAX_ATTEMPTS` so the sentinel is born in the same
 * "exhausted" state the global path enters after 5 retries — the
 * worker skips it under `next_attempt_at <= NOW()` because the row is
 * `failed`, and admin recovery is the only path that resets it.
 */
export async function insertCustomerDrainFailureSentinel(
  client: pg.PoolClient,
  customerExclusionId: string,
  customerId: number,
  errorMessage: string,
): Promise<void> {
  await client.query(
    `INSERT INTO triage_exclusion_fanout_job (
        global_exclusion_id,
        customer_only_exclusion_id,
        customer_id,
        status,
        attempt_count,
        next_attempt_at,
        claimed_at,
        last_error
     ) VALUES (NULL, $1, $2, 'failed', $3, NOW(), NULL, $4)
     ON CONFLICT (customer_only_exclusion_id, customer_id)
       WHERE customer_only_exclusion_id IS NOT NULL
       DO UPDATE SET
         status = 'failed',
         attempt_count = EXCLUDED.attempt_count,
         next_attempt_at = NOW(),
         claimed_at = NULL,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
    [customerExclusionId, customerId, MAX_ATTEMPTS, errorMessage],
  );
}

/**
 * Discriminated request shape for the internal recovery route. Each
 * variant carries the discriminator that targets a single failed row
 * (or the per-global sweep). The route validates the variant before
 * calling the matching helper.
 */
export type RecoverRequest =
  | { kind: "global"; exclusionId: string; customerId: number }
  | { kind: "global_all_failed"; exclusionId: string }
  | { kind: "customer"; exclusionId: string; customerId: number };

export interface RecoverOutcome {
  /** How many queue rows were reset. */
  reset: number;
  /** Recovery mode, echoed for log clarity. */
  kind: RecoverRequest["kind"];
}

/**
 * Apply a recovery request. Runs in one `withTransaction` so the
 * UPDATE is atomic against concurrent worker claims (which use
 * `FOR UPDATE SKIP LOCKED`).
 */
export async function applyRecover(
  request: RecoverRequest,
): Promise<RecoverOutcome> {
  return withTransaction(async (client) => {
    let reset = 0;
    if (request.kind === "global") {
      reset = await resetGlobalFanoutJob(
        client,
        request.exclusionId,
        request.customerId,
      );
    } else if (request.kind === "global_all_failed") {
      reset = await resetAllGlobalFailedJobs(client, request.exclusionId);
    } else {
      reset = await resetCustomerDrainSentinel(
        client,
        request.exclusionId,
        request.customerId,
      );
    }
    return { reset, kind: request.kind };
  });
}

/**
 * Emit the appropriate audit row for a recovery action. Routes pass
 * the session actor (or `'system'` for the internal-token route) and
 * any optional request metadata. Two distinct actions per the
 * customer-scope policy: `global_recover` is customer-agnostic so it
 * omits `customerId`; `customer_recover` is customer-scoped and
 * populates it from the request.
 */
export async function emitRecoverAudit(
  request: RecoverRequest,
  actor: string,
  resetCount: number,
  options: {
    ip?: string | null;
    sid?: string | null;
  } = {},
): Promise<void> {
  if (request.kind === "global" || request.kind === "global_all_failed") {
    await auditLog.record({
      actor,
      action: "triage_exclusion.global_recover",
      target: "triage_exclusion",
      targetId: request.exclusionId,
      ip: options.ip ?? undefined,
      sid: options.sid ?? undefined,
      details: {
        id: request.exclusionId,
        kind: request.kind,
        customerId: request.kind === "global" ? request.customerId : null,
        reset: resetCount,
      },
    });
    return;
  }
  await auditLog.record({
    actor,
    action: "triage_exclusion.customer_recover",
    target: "triage_exclusion",
    targetId: request.exclusionId,
    ip: options.ip ?? undefined,
    sid: options.sid ?? undefined,
    customerId: request.customerId,
    details: {
      id: request.exclusionId,
      kind: request.kind,
      reset: resetCount,
    },
  });
}

/**
 * Token guard for the internal recovery route. Reads
 * `TRIAGE_EXCLUSION_RECOVERY_INTERNAL_TOKEN`. Constant-time compare.
 */
export function verifyTriageExclusionRecoveryToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_EXCLUSION_RECOVERY_INTERNAL_TOKEN;
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
