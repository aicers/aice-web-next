import "server-only";

/**
 * ApplyAttempt cleanup surface (Phase Node-9a, #359).
 *
 * Owns three cooperating sweeps that share the same row-level
 * predicates as the lifecycle module so concurrent activity does not
 * race with cleanup:
 *
 *   1. **Stale-lock recovery** — flips an `executing` row whose
 *      `claim_started_at` has aged past `APPLY_EXECUTING_STALE_MS`
 *      into `failed_terminal`, cascading the in_flight + remaining
 *      queued dispatches to `failed_terminal` with the abandonment
 *      `lastError`. Always runs FIRST so a recovered row's TTL is
 *      processed by the same pass.
 *
 *   2. **TTL terminalisation** — `pending → expired` and
 *      `failed_retryable → failed_terminal` for rows past
 *      `expires_at`. Guarded `WHERE executing_lock IS NULL AND
 *      status = $source` so a row claimed by an executor between the
 *      WHERE and the UPDATE is left alone.
 *
 *   3. **Retention deletion** — hard-deletes terminal rows past
 *      their retention deadline so JSONB plan payloads do not
 *      accumulate indefinitely.
 *
 * ## Cleanup entrypoint
 *
 * The chosen entrypoint is the `POST /api/internal/apply-attempts/cleanup`
 * route handler (the *preferred* path from the umbrella). It wraps
 * `runApplyAttemptCleanup()` behind an internal-token guard so the
 * deployment scheduler / cron can drive cleanup on a fixed cadence
 * regardless of request volume — non-clustered fallbacks (startup
 * sweep + inline pre-create sweep) silently skip cleanup when the
 * Next.js process is idle, which is unsafe on multi-instance
 * deployments where one instance is idle and another is creating
 * attempts. The route handler runs as a system actor and never
 * reaches manager / external GraphQL; verified by the recorder
 * acceptance test.
 *
 * ## What `runApplyAttemptCleanup()` MUST NOT do
 *
 *   - Read or write the manager DB.
 *   - Dispatch to Giganto / Tivan / any external service.
 *   - Open a session token or trust caller-supplied scope.
 *
 * It is exclusively a row-level state machine over the
 * `apply_attempts` table.
 */

import type pg from "pg";

import { auditLog } from "@/lib/audit/logger";
import { query, withTransaction } from "@/lib/db/client";

import {
  ABANDONMENT_LAST_ERROR,
  type ApplyAttemptRow,
  type ApplyAttemptStatus,
  getAttemptRetentionMs,
  getExecutingStaleMs,
  type PlannedDispatch,
} from "./apply-attempt-types";

/**
 * Cleanup pass result — exposed by both the helper and the route
 * handler so operators can monitor sweep depth on the deployment
 * scheduler.
 */
export interface ApplyAttemptCleanupResult {
  /** Stale-lock rows recovered to `failed_terminal`. */
  recovered: number;
  /** Rows TTL-terminalised (`pending → expired` or `failed_retryable → failed_terminal`). */
  expired: number;
  /** Terminal rows hard-deleted past their retention deadline. */
  purged: number;
  /**
   * `succeeded` rows whose `node.apply` audit was driven to durable
   * by the recovery pass, across two windows:
   *
   *   - **Slot-claimed-but-not-completed.** A wrapper claimed the
   *     audit slot but the audit DB write or `completed_at` marker
   *     never landed (audit-DB transient or process death after
   *     claim).
   *   - **Slot-never-claimed (round 6).** The lifecycle committed
   *     `status = 'succeeded'` but the wrapper crashed before
   *     reaching `claimNodeApplyAuditSlot`, leaving both audit
   *     columns NULL.
   *
   * On success the recovery pass emits the audit (claiming the slot
   * itself if needed) and marks `completed_at`; on a transient audit-
   * DB failure during recovery it deliberately leaves the slot
   * CLAIMED so the next sweep re-picks the same row. See
   * `recoverPendingNodeApplyAudits` for the full contract.
   */
  auditsRecovered: number;
}

interface RawAttemptRow {
  attempt_id: string;
  node_id: string;
  draft_fingerprint: Buffer;
  planned_dispatches: PlannedDispatch[];
  created_by: string | null;
  created_at: Date;
  expires_at: Date;
  executing_lock: string | null;
  claim_started_at: Date | null;
  status: ApplyAttemptStatus;
  customer_id: number | null;
}

function rowFromDb(raw: RawAttemptRow): ApplyAttemptRow {
  return {
    attemptId: raw.attempt_id,
    nodeId: raw.node_id,
    draftFingerprint: raw.draft_fingerprint,
    plannedDispatches: raw.planned_dispatches,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    executingLock: raw.executing_lock,
    claimStartedAt: raw.claim_started_at,
    status: raw.status,
    customerId: raw.customer_id,
  };
}

/**
 * Shared TTL terminalisation helper. Used by:
 *
 *   - `runApplyAttemptCleanup()` for the regular sweep.
 *   - The lifecycle module's step-2a / step-4 same-call gap branch
 *     (a confirm whose row crossed `expires_at` between step 2a and
 *     the atomic claim is terminalised in the same call without
 *     waiting for the next cleanup pass).
 *
 * Behaviour by source status (umbrella spec):
 *   - `pending` → `expired` (queued dispatches left untouched —
 *     a `pending` row never started any dispatch).
 *   - `failed_retryable` → `failed_terminal` (the `failed_retryable`
 *     dispatch and every remaining `queued` cascade to
 *     `failed_terminal`).
 *
 * Always sets `expires_at = now() + APPLY_ATTEMPT_RETENTION_MS`,
 * rewriting the row's deadline to the retention horizon for the
 * upcoming hard-delete sweep.
 *
 * Guarded `WHERE executing_lock IS NULL AND status = $source AND
 * NOW() > expires_at`. The expiry predicate is evaluated by SQL
 * against PostgreSQL's clock — not the Node app clock — so a confirm
 * whose host clock is ahead of Postgres cannot terminate a row early,
 * and a confirm whose host clock is behind cannot miss an already-
 * expired row (the lifecycle module re-runs this helper from
 * `resolveLostClaim()` to recover that case). A concurrent claim (or
 * another cleanup writer) racing this UPDATE sees zero affected rows;
 * the caller treats 0 as "row was already claimed / terminalised /
 * deleted / not yet expired in SQL" and does NOT retry. Returns the
 * affected row count.
 */
export async function terminaliseExpiredAttempt(
  client: pg.PoolClient | undefined,
  row: { attemptId: string; status: ApplyAttemptStatus },
): Promise<number> {
  if (row.status !== "pending" && row.status !== "failed_retryable") {
    return 0;
  }
  const targetStatus: ApplyAttemptStatus =
    row.status === "pending" ? "expired" : "failed_terminal";
  const cascadePerDispatch = row.status === "failed_retryable";

  const retentionMs = getAttemptRetentionMs();

  // For `failed_retryable`, cascade per-dispatch state to
  // `failed_terminal` for any `failed_retryable` or `queued` entries.
  // For `pending`, leave per-dispatch state alone (every dispatch is
  // still `queued` and there is no in-flight work to abandon — the
  // umbrella treats `pending → expired` as a no-op on the JSONB).
  let sql: string;
  let params: unknown[];
  if (cascadePerDispatch) {
    sql = `
      UPDATE apply_attempts
      SET status = $2,
          planned_dispatches = (
            SELECT jsonb_agg(
              CASE
                WHEN d->>'state' IN ('failed_retryable', 'queued')
                  THEN jsonb_set(
                         jsonb_set(d, '{state}', to_jsonb('failed_terminal'::text)),
                         '{lastError}',
                         to_jsonb(COALESCE(d->>'lastError', $4::text))
                       )
                ELSE d
              END
            )
            FROM jsonb_array_elements(planned_dispatches) AS d
          ),
          expires_at = NOW() + ($3 || ' milliseconds')::interval
      WHERE attempt_id = $1
        AND executing_lock IS NULL
        AND status = $5
        AND NOW() > expires_at
    `;
    params = [
      row.attemptId,
      targetStatus,
      String(retentionMs),
      ABANDONMENT_LAST_ERROR,
      row.status,
    ];
  } else {
    sql = `
      UPDATE apply_attempts
      SET status = $2,
          expires_at = NOW() + ($3 || ' milliseconds')::interval
      WHERE attempt_id = $1
        AND executing_lock IS NULL
        AND status = $4
        AND NOW() > expires_at
    `;
    params = [row.attemptId, targetStatus, String(retentionMs), row.status];
  }

  const result = client
    ? await client.query(sql, params)
    : await query(sql, params);
  return result.rowCount ?? 0;
}

/**
 * Stale-lock recovery sweep. Disjoint WHERE from the regular cleanup:
 *   `executing_lock IS NOT NULL AND now() - claim_started_at > threshold`
 *
 * A row that crosses the threshold is flipped to `failed_terminal`
 * with `executing_lock` and `claim_started_at` cleared. Every
 * `in_flight` and `queued` dispatch in `planned_dispatches` is also
 * flipped to `failed_terminal` with the abandonment lastError —
 * guaranteeing that no `queued` dispatch survives a recovery.
 *
 * `expires_at` is rewritten to `now() + retentionMs` so the row is
 * eligible for the retention sweep on its normal deadline schedule.
 */
async function recoverStaleLocks(client: pg.PoolClient): Promise<number> {
  const staleMs = getExecutingStaleMs();
  const retentionMs = getAttemptRetentionMs();

  const sql = `
    UPDATE apply_attempts
    SET status = 'failed_terminal',
        planned_dispatches = (
          SELECT jsonb_agg(
            CASE
              WHEN d->>'state' IN ('in_flight', 'queued', 'failed_retryable')
                THEN jsonb_set(
                       jsonb_set(d, '{state}', to_jsonb('failed_terminal'::text)),
                       '{lastError}',
                       to_jsonb(COALESCE(d->>'lastError', $1::text))
                     )
              ELSE d
            END
          )
          FROM jsonb_array_elements(planned_dispatches) AS d
        ),
        executing_lock = NULL,
        claim_started_at = NULL,
        expires_at = NOW() + ($2 || ' milliseconds')::interval
    WHERE executing_lock IS NOT NULL
      AND claim_started_at IS NOT NULL
      AND NOW() - claim_started_at > ($3 || ' milliseconds')::interval
  `;
  const result = await client.query(sql, [
    ABANDONMENT_LAST_ERROR,
    String(retentionMs),
    String(staleMs),
  ]);
  return result.rowCount ?? 0;
}

/**
 * TTL terminalisation sweep. Operates on rows past `expires_at` that
 * are NOT actively executing. Two row-level transitions:
 *   - `pending → expired`
 *   - `failed_retryable → failed_terminal`
 *
 * Per-dispatch cascade only runs on `failed_retryable` (the umbrella
 * spec — `pending` rows have no in-flight or failed dispatches, so
 * there is nothing to cascade).
 */
async function terminaliseExpired(client: pg.PoolClient): Promise<number> {
  const retentionMs = getAttemptRetentionMs();

  // pending → expired (no dispatch cascade)
  const expiredResult = await client.query(
    `
    UPDATE apply_attempts
    SET status = 'expired',
        expires_at = NOW() + ($1 || ' milliseconds')::interval
    WHERE executing_lock IS NULL
      AND status = 'pending'
      AND NOW() > expires_at
    `,
    [String(retentionMs)],
  );

  // failed_retryable → failed_terminal (cascade queued + failed_retryable
  // entries to failed_terminal with abandonment lastError)
  const terminalResult = await client.query(
    `
    UPDATE apply_attempts
    SET status = 'failed_terminal',
        planned_dispatches = (
          SELECT jsonb_agg(
            CASE
              WHEN d->>'state' IN ('failed_retryable', 'queued')
                THEN jsonb_set(
                       jsonb_set(d, '{state}', to_jsonb('failed_terminal'::text)),
                       '{lastError}',
                       to_jsonb(COALESCE(d->>'lastError', $1::text))
                     )
              ELSE d
            END
          )
          FROM jsonb_array_elements(planned_dispatches) AS d
        ),
        expires_at = NOW() + ($2 || ' milliseconds')::interval
    WHERE executing_lock IS NULL
      AND status = 'failed_retryable'
      AND NOW() > expires_at
    `,
    [ABANDONMENT_LAST_ERROR, String(retentionMs)],
  );

  return (expiredResult.rowCount ?? 0) + (terminalResult.rowCount ?? 0);
}

/**
 * Retention sweep. Hard-deletes terminal rows past their retention
 * deadline. Service config payloads in `planned_dispatches` are
 * removed when the row is purged (the JSONB column goes with the row).
 *
 * Terminal status set: `succeeded`, `failed_terminal`, `stale`,
 * `expired` (the four states whose `expires_at` is the retention
 * deadline rather than the execution deadline).
 *
 * **Audit-completion exemption (round 6)**: a `succeeded` row whose
 * `succeeded_audit_completed_at` is still NULL is NOT purged, even if
 * its `expires_at` has elapsed. The retention deadline is rewritten to
 * `NOW() + retentionMs` at the same UPDATE that flips `status` to
 * `succeeded`, so a prolonged audit-DB outage that runs longer than
 * the configured retention window would otherwise let the row become
 * eligible for hard-delete before the audit safety net could finish.
 * Once the row is purged, recovery is impossible — the audit is lost.
 * Exempting audit-incomplete `succeeded` rows from this DELETE keeps
 * `recoverPendingNodeApplyAudits()` viable across an outage of any
 * length; the row is purged on a later sweep, after recovery has set
 * `succeeded_audit_completed_at`. Round 6 also reorders
 * `runApplyAttemptCleanup()` so audit recovery runs *before* purge,
 * making the common case (audit DB healthy) a single-cycle recovery
 * instead of a deferred one. The exemption is the load-bearing fix;
 * the reorder is a latency optimisation on top.
 */
async function purgeRetained(client: pg.PoolClient): Promise<number> {
  const result = await client.query(
    `
    DELETE FROM apply_attempts
    WHERE status IN ('succeeded', 'failed_terminal', 'stale', 'expired')
      AND NOW() > expires_at
      AND (status <> 'succeeded' OR succeeded_audit_completed_at IS NOT NULL)
    `,
  );
  return result.rowCount ?? 0;
}

/**
 * Drive every cleanup sweep. The pass order (round 6):
 *
 *   1. Stale-lock recovery (txn 1) — flips `executing` rows whose
 *      claim aged past the staleness threshold to `failed_terminal`,
 *      cascading per-dispatch state. Always first so a recovered row's
 *      TTL is processed in the same pass.
 *   2. TTL terminalisation (txn 1) — `pending → expired`,
 *      `failed_retryable → failed_terminal` for rows past
 *      `expires_at`.
 *   3. **Audit recovery** (audit DB + apply DB, no transaction) — runs
 *      *before* the retention sweep so a `succeeded` row whose audit
 *      slot is still pending gets a chance to land its `node.apply`
 *      and flip `succeeded_audit_completed_at` before the next step
 *      considers it for hard-delete. The audit-completion exemption
 *      in `purgeRetained` is the load-bearing safety net for the
 *      audit-DB-down case; this ordering makes the audit-DB-healthy
 *      case a single-cycle recovery.
 *   4. Retention deletion (txn 2) — hard-deletes terminal rows past
 *      retention, *exempt* `succeeded` rows whose
 *      `succeeded_audit_completed_at IS NULL` (see `purgeRetained`).
 *
 * The row-state sweeps (steps 1, 2) run inside a single transaction
 * so a recovered row's TTL terminalisation lands atomically with the
 * recovery. Step 3 is OUTSIDE the row-state transaction because the
 * audit DB is a *different* database (`AUDIT_DATABASE_URL`) and the
 * per-row `completed_at` marker is a tiny, autonomous UPDATE on the
 * main DB; wrapping audit IO inside the row-state transaction would
 * extend it around remote IO with no benefit. Step 4 runs in its own
 * transaction so the purge SQL is still serialisable against
 * concurrent inserts/updates without needing to wait for audit IO.
 *
 * Runs as a system actor: no manager / external GraphQL is invoked.
 * The recorder acceptance test asserts zero outbound calls during a
 * cleanup pass.
 */
export async function runApplyAttemptCleanup(): Promise<ApplyAttemptCleanupResult> {
  const { recovered, expired } = await withTransaction(async (client) => {
    const recovered = await recoverStaleLocks(client);
    const expired = await terminaliseExpired(client);
    return { recovered, expired };
  });
  // Round-6 ordering: audit recovery BEFORE purge. Combined with
  // `purgeRetained`'s `succeeded_audit_completed_at` exemption, this
  // closes the "purge raced ahead of the audit safety net" hole the
  // round-6 reviewer flagged.
  const auditsRecovered = await recoverPendingNodeApplyAudits();
  const purged = await withTransaction(async (client) => {
    return await purgeRetained(client);
  });
  return { recovered, expired, purged, auditsRecovered };
}

// ── Internal helpers exposed for the lifecycle module ────────────

/**
 * Read a single row by id. Returns `null` if the row is missing.
 * Used by both the cleanup helper (defense-in-depth) and the
 * lifecycle module's step-1 read.
 */
export async function readApplyAttempt(
  attemptId: string,
  client?: pg.PoolClient,
): Promise<ApplyAttemptRow | null> {
  const sql = `
    SELECT
      attempt_id,
      node_id,
      draft_fingerprint,
      planned_dispatches,
      created_by,
      created_at,
      expires_at,
      executing_lock,
      claim_started_at,
      status,
      customer_id
    FROM apply_attempts
    WHERE attempt_id = $1
  `;
  const result = client
    ? await client.query<RawAttemptRow>(sql, [attemptId])
    : await query<RawAttemptRow>(sql, [attemptId]);
  if (result.rows.length === 0) return null;
  return rowFromDb(result.rows[0]);
}

/**
 * Atomic test-and-set of the `succeeded_audit_emitted_at` slot for a
 * single attempt. Returns `true` iff this caller transitioned the
 * column from NULL → NOW() (i.e. is responsible for emitting the
 * `node.apply` audit), `false` if the row is missing, not in
 * `succeeded`, or another caller has already claimed the slot.
 *
 * The slot is the FIRST half of the two-step emission protocol added
 * in round 2 of #361's review:
 *
 *   - `claimNodeApplyAuditSlot` flips `emitted_at` NULL → NOW().
 *   - The wrapper writes the audit row.
 *   - `markNodeApplyAuditCompleted` flips `completed_at` NULL → NOW()
 *     under a guarded UPDATE, recording that the audit DB write
 *     succeeded.
 *   - `releaseNodeApplyAuditSlot` flips `emitted_at` back to NULL on
 *     a non-duplicate synchronous failure inside the wrapper (audit
 *     DB rejected the insert), so a user-driven follow-up
 *     confirm/retry can re-claim. Guarded by `completed_at IS NULL`
 *     so a release racing a successful completion is a no-op.
 *     Release is reserved for the wrapper path: the cleanup sweep
 *     deliberately does NOT release on a recovery-time failure,
 *     because the candidate SELECT requires `emitted_at IS NOT NULL`
 *     and a released slot would be invisible to every future sweep.
 *
 * The cleanup sweep's `recoverPendingNodeApplyAudits` finds two
 * recovery windows: rows whose `emitted_at` is set but `completed_at`
 * is still NULL (process death between claim and write), and rows
 * whose status flipped to `succeeded` but whose `emitted_at` is still
 * NULL (round 6: process death between status commit and the
 * wrapper's claim). On a recovery-time failure it leaves the slot
 * CLAIMED so the next sweep re-picks the same row. Together with the
 * schema-level partial unique index on `audit_logs(correlation_id)
 * WHERE action = 'node.apply'` (round 3), this is what makes the
 * contract "exactly once" instead of "at most once".
 *
 * Used by `confirmApplyAttempt` / `retryDispatch` (Phase Node-9c, #361)
 * to satisfy the umbrella's "exactly once per attempt that reaches
 * succeeded" audit contract, even when two concurrent calls on the
 * same `attemptId` both observe a non-`succeeded` row before the
 * lifecycle's atomic claim serialises them — only one wins this
 * UPDATE because of the `succeeded_audit_emitted_at IS NULL` guard.
 */
export async function claimNodeApplyAuditSlot(
  attemptId: string,
  client?: pg.PoolClient,
): Promise<boolean> {
  const sql = `
    UPDATE apply_attempts
    SET succeeded_audit_emitted_at = NOW()
    WHERE attempt_id = $1
      AND status = 'succeeded'
      AND succeeded_audit_emitted_at IS NULL
    RETURNING attempt_id
  `;
  const result = client
    ? await client.query(sql, [attemptId])
    : await query(sql, [attemptId]);
  return (result.rowCount ?? 0) === 1;
}

/**
 * Mark the `node.apply` audit-emission slot as completed (the audit
 * row was successfully written to the audit DB). Atomic; idempotent;
 * guarded so a marker racing a release lands first wins.
 *
 * Invariant: `markNodeApplyAuditCompleted` may only be called by the
 * caller that previously won `claimNodeApplyAuditSlot` for the same
 * `attemptId`. The wrapper enforces this by running the sequence
 * synchronously inside a single try/catch.
 *
 * Returns `true` iff the column was flipped from NULL → NOW() by this
 * call. A second call (idempotent re-confirm racing the cleanup
 * sweep) is a no-op and returns `false`.
 */
export async function markNodeApplyAuditCompleted(
  attemptId: string,
  client?: pg.PoolClient,
): Promise<boolean> {
  const sql = `
    UPDATE apply_attempts
    SET succeeded_audit_completed_at = NOW()
    WHERE attempt_id = $1
      AND succeeded_audit_emitted_at IS NOT NULL
      AND succeeded_audit_completed_at IS NULL
    RETURNING attempt_id
  `;
  const result = client
    ? await client.query(sql, [attemptId])
    : await query(sql, [attemptId]);
  return (result.rowCount ?? 0) === 1;
}

/**
 * Release a previously-claimed audit-emission slot so a user-driven
 * follow-up confirm/retry can re-claim it. Used by the wrapper's
 * synchronous catch path when `auditLog.record` throws — without
 * this, the synchronous failure would leave the slot permanently
 * non-NULL and the wrapper's user-driven retry path would observe a
 * "claim still held by some other call" and skip emission.
 *
 * Caller restriction: the cleanup sweep's recovery path deliberately
 * does NOT call this on a recovery-time failure. The cleanup sweep
 * recovers two windows (round 6): the slot-claimed-but-not-completed
 * window (predicate: `emitted_at IS NOT NULL`), and the
 * slot-never-claimed window (predicate: `emitted_at IS NULL` plus a
 * derived `succeeded_at` staleness check). A wrapper release moves a
 * row OUT of the slot-claimed branch and INTO the slot-never-claimed
 * branch (after the staleness window elapses), so a released slot
 * remains recoverable — only the predicate changes. The cleanup sweep
 * still leaves the slot CLAIMED on its OWN recovery-time failures,
 * because flipping it back to NULL during recovery would NOT change
 * which branch picks it up — both branches use the same staleness
 * gate after the slot's age — but it WOULD lose the timestamp the
 * slot-claimed branch uses to gauge staleness, deferring recovery by
 * up to one staleness window for no benefit. Round 4 fixed that
 * asymmetry; round 6 widened the recovery surface to include the
 * slot-never-claimed window.
 *
 * Guarded by `succeeded_audit_completed_at IS NULL` so a release
 * that races a competing successful completion is a no-op (returning
 * `false`). This makes "audit emitted" durable across retries: once
 * `completed_at` is set, the slot can never be released.
 *
 * Returns `true` iff this call cleared the slot.
 */
export async function releaseNodeApplyAuditSlot(
  attemptId: string,
  client?: pg.PoolClient,
): Promise<boolean> {
  const sql = `
    UPDATE apply_attempts
    SET succeeded_audit_emitted_at = NULL
    WHERE attempt_id = $1
      AND succeeded_audit_emitted_at IS NOT NULL
      AND succeeded_audit_completed_at IS NULL
    RETURNING attempt_id
  `;
  const result = client
    ? await client.query(sql, [attemptId])
    : await query(sql, [attemptId]);
  return (result.rowCount ?? 0) === 1;
}

interface PendingAuditRecoveryRow {
  attempt_id: string;
  node_id: string;
  audit_actor: string;
  planned_dispatches: PlannedDispatch[];
  slot_claimed: boolean;
  customer_id: number | null;
}

/**
 * Recovery sweep for the audit-emission slot. Finds two windows where
 * the wrapper-driven `node.apply` emission failed to complete and
 * drives them forward to a durable audit:
 *
 *   - **Slot claimed, completion never landed.** The wrapper claimed
 *     `succeeded_audit_emitted_at` but the audit insert / completion
 *     marker never landed (audit-DB transient, or process death
 *     between the slot UPDATE and the audit insert).
 *   - **Slot never claimed (round 6).** The lifecycle committed
 *     `status = 'succeeded'` but the wrapper crashed before reaching
 *     `claimNodeApplyAuditSlot`, leaving both audit columns NULL.
 *     Without this branch the row would sit `succeeded` forever with
 *     no `node.apply` audit; only a manual re-confirm could rescue
 *     it. The umbrella's contract is "exactly once per attempt that
 *     reaches `succeeded`", not "exactly once per attempt the
 *     wrapper successfully drove to `succeeded`", so the cleanup
 *     sweep MUST close this window.
 *
 * **Staleness gate.** Both branches use `APPLY_EXECUTING_STALE_MS` as
 * the wait threshold (the same window the lifecycle uses for
 * `executing_lock` recovery). The slot-claimed branch measures
 * staleness via `succeeded_audit_emitted_at`. The slot-never-claimed
 * branch derives the row's `succeeded_at` from `expires_at -
 * retentionMs` — at success commit the lifecycle rewrites
 * `expires_at` to `NOW() + retentionMs`, so this expression is the
 * persisted approximation of the success timestamp. The retention ms
 * is read at sweep time via `getAttemptRetentionMs()`; if the env was
 * resized between the success commit and the sweep, the threshold
 * shifts by that delta — a benign latency drift, not a correctness
 * issue (the schema-level partial unique index on `audit_logs` makes
 * a duplicate emission physically impossible regardless of timing).
 *
 * **Per-row sequence.**
 *
 *   1. If the slot is unclaimed (`emitted_at IS NULL` at SELECT
 *      time), call `claimNodeApplyAuditSlot` first. The atomic UPDATE
 *      flips `emitted_at` NULL → NOW() under `status = 'succeeded'
 *      AND emitted_at IS NULL`. If a wrapper just claimed it
 *      concurrently the rowCount comes back 0 — skip; the wrapper is
 *      driving the row and the next sweep will recheck.
 *   2. Emit `node.apply` via `auditLog.record` using the row's
 *      persisted metadata (`audit_actor` → actor, planned dispatches →
 *      `appliedServices`, `node_id` → `targetId`, `attempt_id` →
 *      `correlationId`). The actor field reads from `audit_actor`, a
 *      non-cascading snapshot of the creator's id (round 8) — the
 *      live `created_by` may have been NULLed by the FK SET NULL
 *      action if the creator was deleted between the success commit
 *      and audit completion, but the snapshot survives so recovery
 *      keeps a real account id on the emitted audit.
 *   3. On success, mark `completed_at` and count the row.
 *
 * **Failure handling.** On a non-23505 audit-DB error the slot is
 * left CLAIMED (no release) so the candidate SELECT re-picks the same
 * row on the next sweep through the same predicate. On a 23505
 * `unique_violation` the audit row is already durable from a previous
 * pass — `markNodeApplyAuditCompleted` is the only thing missing; the
 * sweep flips it and counts the row. On a `markNodeApplyAuditCompleted`
 * failure after a successful insert, the audit is durable in the
 * audit DB; the slot stays claimed and the next sweep recovers via
 * the duplicate-violation path.
 *
 * Returns the count of rows whose `completed_at` was flipped to NOW()
 * inside this pass. Rows whose recovery failed (audit-DB still down,
 * race lost, etc.) are NOT counted; they remain claimable on the next
 * sweep.
 *
 * Cleanup invariants honoured: this pass writes only to the audit DB
 * and to `apply_attempts` (no manager DB / external service / session
 * token reads). The `node.apply` it emits carries the row's persisted
 * actor — not the system actor — because the umbrella's audit
 * contract is "this account confirmed this apply", not "the cleanup
 * sweep noticed it".
 */
export async function recoverPendingNodeApplyAudits(): Promise<number> {
  const staleMs = getExecutingStaleMs();
  const retentionMs = getAttemptRetentionMs();
  // Two-window candidate SELECT. The compound boolean covers both
  // failure modes: slot-claimed-but-not-completed (wrapper crashed
  // post-claim) and slot-never-claimed (wrapper crashed pre-claim).
  // `succeeded_at ≈ expires_at - retentionMs` because the success
  // commit in `commitDispatchSuccessAndAdvance` rewrites `expires_at`
  // to `NOW() + retentionMs` in the same UPDATE that flips the row to
  // `succeeded`. The slot-never-claimed branch only fires after the
  // row has been `succeeded` for longer than `staleMs`, so a healthy
  // wrapper running on a normal latency budget will have claimed the
  // slot well before the sweep considers the row.
  const candidates = await query<PendingAuditRecoveryRow>(
    `
    SELECT
      attempt_id,
      node_id,
      audit_actor,
      planned_dispatches,
      (succeeded_audit_emitted_at IS NOT NULL) AS slot_claimed,
      customer_id
    FROM apply_attempts
    WHERE status = 'succeeded'
      AND succeeded_audit_completed_at IS NULL
      AND (
        (
          succeeded_audit_emitted_at IS NOT NULL
          AND NOW() - succeeded_audit_emitted_at > ($1 || ' milliseconds')::interval
        )
        OR
        (
          succeeded_audit_emitted_at IS NULL
          AND NOW() > expires_at - ($2 || ' milliseconds')::interval + ($1 || ' milliseconds')::interval
        )
      )
    `,
    [String(staleMs), String(retentionMs)],
  );

  let recovered = 0;
  for (const row of candidates.rows) {
    if (!row.slot_claimed) {
      // Slot was unclaimed at SELECT time — try to claim it now. The
      // atomic UPDATE serialises against any wrapper that claimed
      // between SELECT and here. If we lose the race, the wrapper is
      // driving this row and we should not interfere.
      const claimed = await claimNodeApplyAuditSlot(row.attempt_id);
      if (!claimed) continue;
    }
    const appliedServices = row.planned_dispatches
      .filter(
        (d) =>
          d.kind !== "MANAGER_DB" &&
          d.kind !== "MANAGER_NOTIFY" &&
          d.state === "succeeded",
      )
      .map((d) => d.kind);
    try {
      await auditLog.record({
        actor: row.audit_actor,
        action: "node.apply",
        target: "node",
        targetId: row.node_id,
        details: { appliedServices },
        // Pulled from `apply_attempts.customer_id`, snapshotted at
        // attempt creation. NULL is permitted and intentional for nodes
        // that carry no `customerId` (only globally-scoped callers
        // reach those — there is no owning customer to scope against).
        ...(row.customer_id !== null && { customerId: row.customer_id }),
        correlationId: row.attempt_id,
      });
    } catch (err) {
      if (isAuditDuplicateError(err)) {
        // The schema-level partial unique index on
        // `audit_logs(correlation_id) WHERE action = 'node.apply'`
        // (round 3 fix) rejected the insert because the audit row is
        // already durable from an earlier wrapper call that crashed
        // between INSERT and `markNodeApplyAuditCompleted`. The audit
        // contract is satisfied — flip the completion marker so this
        // row stops appearing in the candidate SELECT, and count it as
        // recovered (the marker landed inside this pass).
        const marked = await markNodeApplyAuditCompleted(row.attempt_id).catch(
          () => false,
        );
        if (marked) recovered += 1;
        continue;
      }
      // Audit DB rejecting for a non-duplicate reason. DO NOT release
      // the slot — releasing would clear `succeeded_audit_emitted_at`
      // back to NULL, which removes the row from this SELECT (the
      // candidate predicate requires `emitted_at IS NOT NULL`) and
      // would permanently disable automatic recovery on the next sweep.
      // Leave the slot claimed; the staleness predicate still matches
      // (emitted_at is only older now), and `completed_at` is still
      // NULL, so the next sweep re-picks the row.
      continue;
    }
    // Audit insert succeeded; flip the completion marker. If THIS
    // step fails, the audit row is already durable in the audit DB.
    // Do NOT release the slot — the next sweep will hit the schema-
    // level `unique_violation` on its re-INSERT attempt and mark
    // `completed_at` via the duplicate-violation branch above.
    try {
      const marked = await markNodeApplyAuditCompleted(row.attempt_id);
      if (marked) recovered += 1;
    } catch {
      // Swallow: the audit is durable; the next sweep will recover
      // the marker via the duplicate-violation path. The candidate
      // SELECT still matches because `emitted_at IS NOT NULL` and
      // `completed_at IS NULL`.
    }
  }
  return recovered;
}

/**
 * Detect a Postgres `unique_violation` (SQLSTATE 23505) on the audit
 * DB INSERT. Mirrors the same helper in `apply-actions.ts`; duplicated
 * here to keep the cleanup module free of a wrapper-layer import cycle
 * (cleanup is imported by the wrapper, not the other way round).
 */
function isAuditDuplicateError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}

export const _testing = { rowFromDb };

/**
 * Internal-token guard for the cleanup route handler. Reads the
 * shared secret from `APPLY_INTERNAL_CLEANUP_TOKEN`. Compares with
 * `crypto.timingSafeEqual` when both lengths match to avoid a timing
 * oracle on the token. Returns `true` iff the request supplied the
 * matching token.
 */
export function verifyInternalCleanupToken(provided: string | null): boolean {
  const expected = process.env.APPLY_INTERNAL_CLEANUP_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  // Use a constant-time comparison via Buffer comparison (the lengths
  // are equal at this point so the buffers will be too).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
