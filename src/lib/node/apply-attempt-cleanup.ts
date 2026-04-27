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
}

interface RawAttemptRow {
  attempt_id: string;
  node_id: string;
  draft_fingerprint: Buffer;
  planned_dispatches: PlannedDispatch[];
  created_by: string;
  created_at: Date;
  expires_at: Date;
  executing_lock: string | null;
  claim_started_at: Date | null;
  status: ApplyAttemptStatus;
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
 * Guarded `WHERE executing_lock IS NULL AND status = $source`. A
 * concurrent claim (or another cleanup writer) racing this UPDATE
 * sees zero affected rows; the caller treats 0 as "row was already
 * claimed / terminalised / deleted" and does NOT retry. Returns the
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
 */
async function purgeRetained(client: pg.PoolClient): Promise<number> {
  const result = await client.query(
    `
    DELETE FROM apply_attempts
    WHERE status IN ('succeeded', 'failed_terminal', 'stale', 'expired')
      AND NOW() > expires_at
    `,
  );
  return result.rowCount ?? 0;
}

/**
 * Drive every cleanup sweep in a single transaction. Recovery first
 * (so a recovered row's TTL is processed in the same pass), then TTL
 * terminalisation, then retention deletion.
 *
 * Runs as a system actor: no manager / external GraphQL is invoked.
 * The recorder acceptance test asserts zero outbound calls during a
 * cleanup pass.
 */
export async function runApplyAttemptCleanup(): Promise<ApplyAttemptCleanupResult> {
  return withTransaction(async (client) => {
    const recovered = await recoverStaleLocks(client);
    const expired = await terminaliseExpired(client);
    const purged = await purgeRetained(client);
    return { recovered, expired, purged };
  });
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
      status
    FROM apply_attempts
    WHERE attempt_id = $1
  `;
  const result = client
    ? await client.query<RawAttemptRow>(sql, [attemptId])
    : await query<RawAttemptRow>(sql, [attemptId]);
  if (result.rows.length === 0) return null;
  return rowFromDb(result.rows[0]);
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
