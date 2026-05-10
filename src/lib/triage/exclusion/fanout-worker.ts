import "server-only";

import type pg from "pg";

import { auditLog } from "@/lib/audit/logger";
import { withTransaction } from "@/lib/db/client";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

import {
  acquireCustomerCadenceLock,
  type DeletedCounts,
  executeRetroactiveDelete,
} from "./retroactive-delete";

/**
 * Internal fanout worker (#457).
 *
 * Drains pending `triage_exclusion_fanout_job` rows, runs the
 * per-customer retroactive DELETE under the customer's cadence
 * advisory lock, and finalizes the row. Designed to be invoked by the
 * deployment scheduler at a minute-scale cadence so retry backoff has
 * effect.
 *
 * Phases per invocation:
 *
 *   1. **Stuck-job sweep.** Return `running` rows whose worker
 *      claimed > 10 minutes ago back to `pending`. Does NOT increment
 *      `attempt_count`: a stuck row is a process death, not a logical
 *      failure.
 *   2. **Claim phase.** Pick up to N rows where `status = 'pending'`
 *      AND `next_attempt_at <= NOW()` using `FOR UPDATE SKIP LOCKED`,
 *      transition to `running`, commit. The claim is its own
 *      transaction so a crash mid-run does not hold the row lock
 *      forever.
 *   3. **Run phase.** For each claimed row, run
 *      `executeRetroactiveDelete` against the tenant DB under the
 *      cadence advisory lock and finalize the row to `completed`. On
 *      error, increment `attempt_count`, set `next_attempt_at = NOW()
 *      + backoff(attempt_count)`, transition back to `pending` until
 *      `attempt_count > 5`, at which point the row transitions to
 *      `failed` and emits a `triage_exclusion.fanout_failed` audit row.
 *
 * Invocation is `SKIP LOCKED`-safe so concurrent calls cannot
 * double-process a single row.
 */

export const STUCK_JOB_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_CLAIM_BATCH = 25;
export const MAX_ATTEMPTS = 5;

const BACKOFF_MS: readonly number[] = [
  1 * 60 * 1000, // 1 minute
  5 * 60 * 1000, // 5 minutes
  25 * 60 * 1000, // 25 minutes
  2 * 60 * 60 * 1000, // 2 hours
  12 * 60 * 60 * 1000, // 12 hours
];

export function backoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return BACKOFF_MS[0];
  const idx = Math.min(attemptCount - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}

interface ClaimedJob {
  id: string;
  globalExclusionId: string;
  customerId: number;
  attemptCount: number;
}

interface GlobalExclusionData {
  id: string;
  kind: "ipAddress" | "hostname" | "uri" | "domain";
  value: string;
  domainSuffix: string | null;
}

export interface FanoutSweepResult {
  recovered: number;
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
}

async function sweepStuckJobs(client: pg.PoolClient): Promise<number> {
  const result = await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'pending',
            claimed_at = NULL,
            updated_at = NOW()
      WHERE status = 'running'
        AND claimed_at < NOW() - ($1 || ' milliseconds')::INTERVAL`,
    [String(STUCK_JOB_THRESHOLD_MS)],
  );
  return result.rowCount ?? 0;
}

async function claimPendingJobs(
  client: pg.PoolClient,
  limit: number,
): Promise<ClaimedJob[]> {
  const { rows } = await client.query<{
    id: string;
    global_exclusion_id: string;
    customer_id: number;
    attempt_count: number;
  }>(
    `SELECT id, global_exclusion_id, customer_id, attempt_count
       FROM triage_exclusion_fanout_job
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'running',
            claimed_at = NOW(),
            updated_at = NOW()
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map((r) => ({
    id: r.id,
    globalExclusionId: r.global_exclusion_id,
    customerId: r.customer_id,
    attemptCount: r.attempt_count,
  }));
}

async function loadGlobalExclusion(
  client: pg.PoolClient,
  id: string,
): Promise<GlobalExclusionData | null> {
  const { rows } = await client.query<{
    id: string;
    kind: string;
    value: string;
    domain_suffix: string | null;
  }>(
    `SELECT id, kind, value, domain_suffix
       FROM global_triage_exclusion
      WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    kind: r.kind as GlobalExclusionData["kind"],
    value: r.value,
    domainSuffix: r.domain_suffix,
  };
}

async function finalizeCompleted(
  client: pg.PoolClient,
  jobId: string,
): Promise<void> {
  await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'completed',
            claimed_at = NULL,
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [jobId],
  );
}

async function finalizeRetry(
  client: pg.PoolClient,
  jobId: string,
  attemptCount: number,
  errorMessage: string,
): Promise<void> {
  const backoff = backoffMs(attemptCount + 1);
  await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'pending',
            attempt_count = attempt_count + 1,
            next_attempt_at = NOW() + ($1 || ' milliseconds')::INTERVAL,
            claimed_at = NULL,
            last_error = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [String(backoff), errorMessage, jobId],
  );
}

async function finalizeFailed(
  client: pg.PoolClient,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  await client.query(
    `UPDATE triage_exclusion_fanout_job
        SET status = 'failed',
            attempt_count = attempt_count + 1,
            claimed_at = NULL,
            last_error = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [errorMessage, jobId],
  );
}

interface JobOutcome {
  outcome: "completed" | "retried" | "failed";
  error?: string;
  /**
   * The global exclusion row, if it was loaded successfully. Threaded
   * out so the caller can include `kind` / `value` / `id` in the
   * `triage_exclusion.fanout_failed` audit row when the job exhausts
   * its retry budget.
   */
  global?: GlobalExclusionData;
}

async function processJob(job: ClaimedJob): Promise<JobOutcome> {
  let global: GlobalExclusionData | null;
  try {
    global = await withTransaction((c) =>
      loadGlobalExclusion(c, job.globalExclusionId),
    );
  } catch (err) {
    return {
      outcome: "retried",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!global) {
    // The global row was deleted before fanout ran; the cascade has
    // already removed pending jobs for this id, but this row was
    // already claimed. Mark it completed (nothing to do).
    await withTransaction((c) => finalizeCompleted(c, job.id));
    return { outcome: "completed" };
  }

  const tenantPool = await getCustomerPool(job.customerId);
  const tenantClient = await tenantPool.connect();
  let counts: DeletedCounts;
  try {
    await tenantClient.query("BEGIN");
    await acquireCustomerCadenceLock(tenantClient, job.customerId);
    counts = await executeRetroactiveDelete(tenantClient, {
      kind: global.kind,
      value: global.value,
      domainSuffix: global.domainSuffix,
    });
    await tenantClient.query("COMMIT");
  } catch (err) {
    await tenantClient.query("ROLLBACK").catch(() => {});
    return {
      outcome: "retried",
      error: err instanceof Error ? err.message : String(err),
      global,
    };
  } finally {
    tenantClient.release();
  }

  await withTransaction((c) => finalizeCompleted(c, job.id));

  await auditLog.record({
    actor: "system",
    action: "triage_exclusion.customer_add",
    target: "triage_exclusion",
    targetId: global.id,
    customerId: job.customerId,
    details: {
      id: global.id,
      kind: global.kind,
      value: global.value,
      origin: "global_fanout",
      globalExclusionId: global.id,
      deletedCorpusRows: counts,
    },
  });

  return { outcome: "completed" };
}

/**
 * Run one sweep: stuck-job recovery → claim → process. Returns
 * counts so the route handler can include them in the response body
 * for observability.
 */
export async function runFanoutSweep(
  options: { batchSize?: number } = {},
): Promise<FanoutSweepResult> {
  const limit = options.batchSize ?? DEFAULT_CLAIM_BATCH;

  const recovered = await withTransaction(sweepStuckJobs);

  // Claim phase: SELECT FOR UPDATE SKIP LOCKED + UPDATE inside one
  // short transaction so a crash mid-run does not hold row locks
  // indefinitely.
  const claimed: ClaimedJob[] = await withTransaction((client) =>
    claimPendingJobs(client, limit),
  ).catch(() => [] as ClaimedJob[]);

  let completed = 0;
  let failed = 0;
  let retried = 0;
  for (const job of claimed) {
    try {
      const result = await processJob(job);
      if (result.outcome === "completed") {
        completed += 1;
        continue;
      }
      const errorMessage = result.error ?? "unknown error";
      if (job.attemptCount + 1 >= MAX_ATTEMPTS) {
        await withTransaction((c) => finalizeFailed(c, job.id, errorMessage));
        // Spec requires `id`, `kind`, `value` on every audit row in the
        // `triage_exclusion.*` family. If `processJob` could not load
        // the global row (e.g. an auth-DB error before the lookup
        // returned), those fields are unknown — emit them as the job's
        // `globalExclusionId` and a `null` placeholder rather than
        // omitting the keys, so downstream audit-log consumers see a
        // consistent shape.
        const globalRow =
          result.global ??
          (await withTransaction((c) =>
            loadGlobalExclusion(c, job.globalExclusionId),
          ).catch(() => null));
        await auditLog.record({
          actor: "system",
          action: "triage_exclusion.fanout_failed",
          target: "triage_exclusion",
          targetId: job.globalExclusionId,
          customerId: job.customerId,
          details: {
            id: job.globalExclusionId,
            kind: globalRow?.kind ?? null,
            value: globalRow?.value ?? null,
            globalExclusionId: job.globalExclusionId,
            attemptCount: job.attemptCount + 1,
            lastError: errorMessage,
          },
        });
        failed += 1;
      } else {
        await withTransaction((c) =>
          finalizeRetry(c, job.id, job.attemptCount, errorMessage),
        );
        retried += 1;
      }
    } catch (err) {
      // Defensive: if even finalize fails, increment retry counter so
      // the row gets picked up again via the stuck-job sweep.
      const message = err instanceof Error ? err.message : String(err);
      await withTransaction((c) =>
        finalizeRetry(c, job.id, job.attemptCount, message),
      ).catch(() => {});
      retried += 1;
    }
  }

  return {
    recovered,
    claimed: claimed.length,
    completed,
    failed,
    retried,
  };
}

/**
 * Internal-token guard for the fanout route handler. Reads the shared
 * secret from `TRIAGE_EXCLUSION_FANOUT_TOKEN`. Constant-time compare.
 */
export function verifyFanoutToken(provided: string | null): boolean {
  const expected = process.env.TRIAGE_EXCLUSION_FANOUT_TOKEN;
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

export const _testing = {
  STUCK_JOB_THRESHOLD_MS,
  BACKOFF_MS,
};
