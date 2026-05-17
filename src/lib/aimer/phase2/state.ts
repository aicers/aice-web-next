/**
 * Phase 2 push state helpers (RFC 0002 §7 / sub-issue #592).
 *
 * Server-only utilities that operate on the three foundational tables
 * created by migration `customer/0012_aimer_push_state_and_queue.sql`:
 *
 *   - `aimer_push_state`   — per-kind cursor + pause toggle for the
 *                            streaming kinds (`baseline_event`, `story`)
 *   - `aimer_push_queue`   — durable withdraw/refresh/backfill notices
 *   - `aimer_push_inflight` — in-flight ack tracker keyed on `context_jti`
 *
 * Drain routes (`<kind>/next-batch`) and mutation hooks (the upstream
 * callers of {@link enqueueNotice}) share this module so the same
 * SQL is only written once.
 *
 * All helpers operate on a single customer's per-tenant DB. The
 * helpers resolve the pool internally via {@link getCustomerPool} so
 * callers only pass the numeric `customerId`.
 */

import "server-only";

import type pg from "pg";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";

// ── Re-exports ─────────────────────────────────────────────────────

import { SYSTEM_ACTOR_ACCOUNT_ID } from "./orchestrate";

export { SYSTEM_ACTOR_ACCOUNT_ID } from "./orchestrate";

// ── Discriminator types ────────────────────────────────────────────

/**
 * Kinds that own a row in `aimer_push_state`. These are the streaming
 * kinds whose drain advances a `(event_time, event_key)` cursor.
 */
export type Phase2StreamingKind = "baseline_event" | "story";

/**
 * Kinds tracked by `aimer_push_inflight`. Includes the streaming kinds
 * plus `policy_event` (queue-only — no cursor).
 */
export type Phase2InflightKind = Phase2StreamingKind | "policy_event";

/**
 * Discriminator of {@link aimer_push_queue.kind}. Each value maps 1:1
 * to one aimer-web endpoint + one wire `schema_version`.
 */
export type Phase2QueueKind =
  | "withdraw_baseline_event"
  | "withdraw_story"
  | "withdraw_policy_event"
  | "refresh_baseline_window"
  | "refresh_story_window"
  | "backfill_baseline_window"
  | "backfill_story_window";

/** Drain owner. Each drain claims a fixed subset of queue kinds. */
export type Phase2DrainKind = "baseline_event" | "story" | "policy_event";

/**
 * Queue-kind subsets claimed by each drain (RFC 0002 §7
 * "Drain ownership by kind"). A baseline drain must never pick up a
 * story / policy notice, etc.
 */
export const PHASE2_QUEUE_KINDS_BY_DRAIN = {
  baseline_event: [
    "withdraw_baseline_event",
    "refresh_baseline_window",
    "backfill_baseline_window",
  ],
  story: ["withdraw_story", "refresh_story_window", "backfill_story_window"],
  policy_event: ["withdraw_policy_event"],
} as const satisfies Record<Phase2DrainKind, readonly Phase2QueueKind[]>;

// ── Tunables ───────────────────────────────────────────────────────

/**
 * TTL for `aimer_push_inflight` rows. After this many seconds since
 * `minted_at`, the row is considered abandoned (browser closed, network
 * died, instance churn) and is opportunistically removed on the next
 * `next-batch` call so the underlying queue rows / cursor become
 * eligible again.
 */
export const PHASE2_INFLIGHT_TTL_SECONDS = 120;

/**
 * Thresholds for the {@link estimateBacklog} bucket label per #570
 * "Backlog estimation". The thresholds are intentionally coarse —
 * exact counts are expensive on large tables and not actionable to
 * operators.
 *
 *   - synced     — `cursor_lag_seconds < 5 min` AND `pending_notice_count < 10`
 *   - behind     — `cursor_lag_seconds < 1 hour` OR `pending_notice_count ≥ 10`
 *   - way_behind — `cursor_lag_seconds ≥ 1 hour` OR `pending_notice_count ≥ 100`
 */
const BACKLOG_BUCKET_BEHIND_SECONDS = 5 * 60; // 5 minutes
const BACKLOG_BUCKET_WAY_BEHIND_SECONDS = 60 * 60; // 1 hour
const BACKLOG_PENDING_BEHIND_THRESHOLD = 10;
const BACKLOG_PENDING_WAY_BEHIND_THRESHOLD = 100;

/**
 * Upper bound for the fast-path `approximate_count` query. Limiting at
 * 1001 lets the helper distinguish "≥1000 unsent rows" from an exact
 * smaller count while keeping the COUNT(*) cost bounded.
 */
export const BACKLOG_APPROXIMATE_COUNT_LIMIT = 1001;

// ── Row shapes ─────────────────────────────────────────────────────

export interface AimerPushStateRow {
  kind: Phase2StreamingKind;
  last_pushed_event_time: Date | null;
  last_pushed_event_key: string | null;
  last_synced_at: Date | null;
  last_error: string | null;
  opportunistic_enabled: boolean;
  paused_at: Date | null;
  paused_by: string | null;
}

export interface AimerPushQueueRow {
  id: string; // BIGSERIAL — returned as string to avoid JS bigint truncation
  enqueued_at: Date;
  kind: Phase2QueueKind;
  payload: unknown;
  attempts: number;
  last_attempt_at: Date | null;
  last_error: string | null;
  acked_at: Date | null;
  acked_context_jti: string | null;
}

export interface BacklogEstimate {
  bucket: "synced" | "behind" | "way_behind" | "paused";
  /**
   * Approximate row count behind the cursor (saturated at
   * `BACKLOG_APPROXIMATE_COUNT_LIMIT - 1` — values at the cap mean
   * "≥1000"), or `null` when no cursor / no source-table query for this
   * kind. The Settings indicator treats `null` as "no count, just
   * bucket".
   */
  approximate_count: number | null;
  /**
   * Seconds between `last_pushed_event_time` and `NOW()`, or `null`
   * when no cursor has been recorded.
   */
  cursor_lag_seconds: number | null;
  /**
   * `event_time` of the newest row past the cursor, or `null` when no
   * source-table query for this kind / no unsent rows.
   */
  newest_unsent_event_time: string | null;
  /** Count of `aimer_push_queue` rows with `acked_at IS NULL`. */
  pending_notice_count: number;
}

// ── State helpers ──────────────────────────────────────────────────

/**
 * Read the `aimer_push_state` row for a streaming kind. Returns `null`
 * when no row exists (only possible on a freshly-migrated DB before the
 * seed has run, or in tests).
 */
export async function getAimerPushState(
  customerId: number,
  kind: Phase2StreamingKind,
): Promise<AimerPushStateRow | null> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<AimerPushStateRow>(
    `SELECT kind,
            last_pushed_event_time,
            last_pushed_event_key,
            last_synced_at,
            last_error,
            opportunistic_enabled,
            paused_at,
            paused_by
       FROM aimer_push_state
      WHERE kind = $1`,
    [kind],
  );
  return rows[0] ?? null;
}

/**
 * Advance the cursor for a streaming kind. Monotonic: the new
 * `(event_time, event_key)` must compare strictly greater than the
 * current value. Concurrent advancers are serialized via `FOR UPDATE`.
 *
 * Also bumps `last_synced_at = NOW()` and clears `last_error`.
 *
 * The `last_pushed_event_key` column is `TEXT` but holds the decimal
 * string representation of `NUMERIC(39, 0)` row keys (the source-table
 * `event_key` columns for both `baseline_triaged_event` and the story
 * read path). The monotonic guard casts both sides to `NUMERIC` so that
 * a same-timestamp advance from `"9"` to `"10"` is accepted — text
 * ordering would say `"9" > "10"` and leave the cursor stuck.
 */
export async function advanceCursor(
  customerId: number,
  kind: Phase2StreamingKind,
  eventTime: Date,
  eventKey: string,
  client?: pg.PoolClient,
): Promise<void> {
  const runner = client ?? (await getCustomerPool(customerId));
  // The `FOR UPDATE` locks the row inside the implicit transaction
  // (single-statement transactions auto-commit) so the inner UPDATE
  // observes a consistent prior cursor; concurrent callers thus serialize.
  await runner.query(
    `WITH locked AS (
       SELECT last_pushed_event_time, last_pushed_event_key
         FROM aimer_push_state
        WHERE kind = $1
        FOR UPDATE
     )
     UPDATE aimer_push_state s
        SET last_pushed_event_time = $2,
            last_pushed_event_key  = $3,
            last_synced_at         = NOW(),
            last_error             = NULL
       FROM locked l
      WHERE s.kind = $1
        AND (l.last_pushed_event_time IS NULL
             OR (l.last_pushed_event_time, l.last_pushed_event_key::numeric)
                  < ($2::timestamptz, $3::numeric))`,
    [kind, eventTime, eventKey],
  );
}

/**
 * Record a sync error on `aimer_push_state` for a streaming kind. Does
 * not touch the cursor. Intended for the streaming drain routes
 * (#571 baseline, #493 story) — the queue-only `policy_event` drain
 * has no `aimer_push_state` row and must not call this helper.
 */
export async function recordSyncError(
  customerId: number,
  kind: Phase2StreamingKind,
  errorMessage: string,
  client?: pg.PoolClient,
): Promise<void> {
  const runner = client ?? (await getCustomerPool(customerId));
  await runner.query(
    `UPDATE aimer_push_state
        SET last_error = $2
      WHERE kind = $1`,
    [kind, errorMessage],
  );
}

/** Clear a previously recorded `last_error` on the state row. */
export async function clearSyncError(
  customerId: number,
  kind: Phase2StreamingKind,
): Promise<void> {
  const pool = await getCustomerPool(customerId);
  await pool.query(
    `UPDATE aimer_push_state
        SET last_error = NULL
      WHERE kind = $1`,
    [kind],
  );
}

// ── Pause toggle helpers ───────────────────────────────────────────

/**
 * Flip the pause toggle for a streaming kind. When `enabled = false`,
 * also records `paused_at = NOW()` and `paused_by = accountId` for
 * audit traceability. When flipping back to `true`, those columns are
 * cleared.
 */
export async function setOpportunisticEnabled(
  customerId: number,
  kind: Phase2StreamingKind,
  enabled: boolean,
  accountId: string,
): Promise<void> {
  const pool = await getCustomerPool(customerId);
  if (enabled) {
    await pool.query(
      `UPDATE aimer_push_state
          SET opportunistic_enabled = TRUE,
              paused_at             = NULL,
              paused_by             = NULL
        WHERE kind = $1`,
      [kind],
    );
  } else {
    await pool.query(
      `UPDATE aimer_push_state
          SET opportunistic_enabled = FALSE,
              paused_at             = NOW(),
              paused_by             = $2
        WHERE kind = $1`,
      [kind, accountId],
    );
  }
}

/**
 * Return whether opportunistic push is enabled for the given streaming
 * kind. Defaults to `true` when no row exists (matches the migration
 * seed default). The queue-only `policy_event` kind has no state row;
 * it has no pause semantics and this helper does not apply to it.
 */
export async function isOpportunisticEnabled(
  customerId: number,
  kind: Phase2StreamingKind,
): Promise<boolean> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<{ opportunistic_enabled: boolean }>(
    `SELECT opportunistic_enabled
       FROM aimer_push_state
      WHERE kind = $1`,
    [kind],
  );
  return rows[0]?.opportunistic_enabled ?? true;
}

// ── Queue helpers ──────────────────────────────────────────────────

/**
 * Enqueue a withdraw / refresh / backfill notice. Returns the inserted
 * row id (as a string to avoid JS bigint truncation).
 *
 * When `client` is provided the INSERT runs on that connection and
 * therefore joins the caller's open transaction — a rollback on the
 * caller drops the enqueue as part of the same atomic unit. When
 * `client` is omitted, the INSERT runs in its own implicit transaction
 * on a freshly-resolved pool connection.
 */
export async function enqueueNotice(
  customerId: number,
  kind: Phase2QueueKind,
  payload: unknown,
  client?: pg.PoolClient,
): Promise<string> {
  const runner = client ?? (await getCustomerPool(customerId));
  const { rows } = await runner.query<{ id: string }>(
    `INSERT INTO aimer_push_queue (kind, payload)
     VALUES ($1, $2::jsonb)
     RETURNING id::text AS id`,
    [kind, JSON.stringify(payload)],
  );
  return rows[0].id;
}

interface ClaimPendingNoticesOptions {
  /** Max rows to return. */
  limit: number;
  /**
   * Restrict the claim to a specific subset of queue kinds. The subset
   * MUST be contained in the drain's allowed set from
   * {@link PHASE2_QUEUE_KINDS_BY_DRAIN} — any kind outside that set is
   * rejected with a thrown `RangeError` so a baseline drain cannot
   * accidentally claim a story notice via the filter (and vice versa).
   *
   * The story drain (#493) uses this to honor the "one queue kind per
   * `next-batch` response" + `withdraw → refresh → backfill` priority
   * order: it calls this helper once per kind, in that order, and
   * stops at the first non-empty result.
   */
  kinds?: readonly Phase2QueueKind[];
}

/**
 * Claim pending queue rows owned by the given drain.
 *
 * Filters `aimer_push_queue.kind` by the drain kind's set
 * ({@link PHASE2_QUEUE_KINDS_BY_DRAIN}) so a baseline drain never picks
 * up a story / policy notice. Returns rows in `id` ascending order so
 * older notices drain first.
 *
 * Pass {@link ClaimPendingNoticesOptions.kinds} to narrow further to a
 * specific subset (must be contained in the drain's allowed set). This
 * is what lets the story drain enforce "one queue kind per response":
 * the route calls this helper for each kind in
 * `withdraw → refresh → backfill` priority order and stops at the
 * first non-empty result.
 *
 * Claim is non-exclusive (no `FOR UPDATE SKIP LOCKED`): when two
 * concurrent browser tabs both activate, both will read the same
 * pending rows. aimer-web's natural-key idempotency
 * (`ON CONFLICT DO NOTHING`) absorbs the duplicate delivery — this is
 * acceptable for the queue, where double-send is harmless but missed
 * delivery is not.
 */
export async function claimPendingNotices(
  customerId: number,
  drainKind: Phase2DrainKind,
  options: ClaimPendingNoticesOptions,
): Promise<AimerPushQueueRow[]> {
  const allowedKinds = PHASE2_QUEUE_KINDS_BY_DRAIN[drainKind];
  let effectiveKinds: readonly Phase2QueueKind[] = allowedKinds;
  if (options.kinds !== undefined) {
    for (const k of options.kinds) {
      if (!(allowedKinds as readonly Phase2QueueKind[]).includes(k)) {
        throw new RangeError(
          `claimPendingNotices: kind '${k}' is not owned by drain '${drainKind}'`,
        );
      }
    }
    effectiveKinds = options.kinds;
  }
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<AimerPushQueueRow>(
    `SELECT id::text AS id,
            enqueued_at,
            kind,
            payload,
            attempts,
            last_attempt_at,
            last_error,
            acked_at,
            acked_context_jti
       FROM aimer_push_queue
      WHERE acked_at IS NULL
        AND kind = ANY($1::text[])
      ORDER BY id
      LIMIT $2`,
    [effectiveKinds as unknown as string[], options.limit],
  );
  return rows;
}

/**
 * Mark a set of queue rows as ack'd. Sets `acked_at = NOW()` and
 * `acked_context_jti = jti`, and clears any stale `last_error` left by
 * a prior failed attempt (per #570: a successful ack clears
 * `last_error` so the 30-day audit / Settings status surface does not
 * show an old failure on a row that ultimately succeeded). Idempotent:
 * a row already ack'd is left untouched, preserving the canonical
 * first-success record.
 */
export async function markAcked(
  customerId: number,
  rowIds: readonly string[],
  contextJti: string,
  client?: pg.PoolClient,
): Promise<void> {
  if (rowIds.length === 0) return;
  const runner = client ?? (await getCustomerPool(customerId));
  await runner.query(
    `UPDATE aimer_push_queue
        SET acked_at          = NOW(),
            acked_context_jti = $2,
            last_error        = NULL
      WHERE id = ANY($1::bigint[])
        AND acked_at IS NULL`,
    [rowIds, contextJti],
  );
}

/**
 * Record an error on queue rows. Increments `attempts`, writes
 * `last_error`, and stamps `last_attempt_at = NOW()`. Used by drain
 * routes when aimer-web returns a non-2xx for the batch these rows
 * carried.
 *
 * Skips rows where `acked_at IS NOT NULL` so a concurrent duplicate
 * drain (the claim is intentionally non-exclusive — two activations
 * may include the same queue row in different inflight rows) cannot
 * resurrect `last_error` after a sibling delivery already succeeded
 * and cleared it via {@link markAcked}. Without this guard a
 * success-then-duplicate-failure ordering would leave an acked,
 * audit-retained row showing a stale failure string and break the
 * #570 "cleared on ack" observability contract.
 */
export async function recordNoticeError(
  customerId: number,
  rowIds: readonly string[],
  errorMessage: string,
  client?: pg.PoolClient,
): Promise<void> {
  if (rowIds.length === 0) return;
  const runner = client ?? (await getCustomerPool(customerId));
  await runner.query(
    `UPDATE aimer_push_queue
        SET attempts        = attempts + 1,
            last_error      = $2,
            last_attempt_at = NOW()
      WHERE id = ANY($1::bigint[])
        AND acked_at IS NULL`,
    [rowIds, errorMessage],
  );
}

// ── Inflight helpers ───────────────────────────────────────────────

/**
 * Tail notice to enqueue on the next successful ack of this inflight
 * batch. Used by drain routes that subdivide a queue payload at push
 * time (e.g. the baseline-event refresh/backfill enrichment path when
 * post-enrichment size exceeds the shared byte cap). Recording the
 * tail here keeps it out of `aimer_push_queue` until ack-time, so a
 * failed POST drops it cleanly with the inflight row.
 */
export interface PendingTailNotice {
  kind: Phase2QueueKind;
  payload: unknown;
}

export interface InsertInflightInput {
  contextJti: string;
  kind: Phase2InflightKind;
  /** Streaming kinds only — `null` for `policy_event`. */
  cursorAdvanceToEventTime?: Date | null;
  cursorAdvanceToEventKey?: string | null;
  /** Queue row ids included in this batch (may be empty for cursor-only batches). */
  queueRowIds: readonly string[];
  /**
   * Tail notices to enqueue ATOMICALLY with the head batch ack. Empty
   * for batches that did not subdivide at push time. On `recordOnFail`
   * these are dropped with the inflight row so the next retry of the
   * head can redo the subdivision freshly without leaving duplicates
   * in the queue. See {@link PendingTailNotice}.
   */
  pendingTailNotices?: readonly PendingTailNotice[];
}

/**
 * Insert a pending advancement record keyed on `context_jti`. Called by
 * each `next-batch` route immediately after minting the envelope, so
 * the next call's ack can locate the cursor advance / queue ack scope.
 */
export async function insertInflight(
  customerId: number,
  input: InsertInflightInput,
  client?: pg.PoolClient,
): Promise<void> {
  const runner = client ?? (await getCustomerPool(customerId));
  await runner.query(
    `INSERT INTO aimer_push_inflight
       (context_jti,
        kind,
        cursor_advance_to_event_time,
        cursor_advance_to_event_key,
        queue_row_ids,
        pending_tail_notices)
     VALUES ($1, $2, $3, $4, $5::bigint[], $6::jsonb)`,
    [
      input.contextJti,
      input.kind,
      input.cursorAdvanceToEventTime ?? null,
      input.cursorAdvanceToEventKey ?? null,
      input.queueRowIds as unknown as string[],
      JSON.stringify(input.pendingTailNotices ?? []),
    ],
  );
}

interface InflightRow {
  context_jti: string;
  kind: Phase2InflightKind;
  cursor_advance_to_event_time: Date | null;
  cursor_advance_to_event_key: string | null;
  queue_row_ids: string[];
  pending_tail_notices: PendingTailNotice[];
}

/**
 * Per-Story β-tracking row data returned by {@link commitOnAck} when
 * the prior batch was a `story` streaming batch. The drain route uses
 * this list to emit one `triage.story.send` audit row per Story
 * **after** the tenant-DB commit succeeds — the audit DB lives in a
 * separate database and cannot be co-committed with the tenant
 * transaction, so audit emission is best-effort outside the
 * transaction (#493 "Manual mint ledger" rationale).
 */
export interface CommitOnAckStoryBetaRow {
  storyId: string;
  storyVersion: string;
}

export interface CommitOnAckResult {
  /**
   * `event_group` rows whose β columns this commit bumped. Empty for
   * baseline / policy / queue-notice acks. The caller is responsible
   * for emitting one `triage.story.send` audit row per element with
   * `trigger: "opportunistic"`, `actorAccountId: SYSTEM_ACTOR_ACCOUNT_ID`.
   */
  storyBetaRows: readonly CommitOnAckStoryBetaRow[];
}

/**
 * Commit-on-ack for a previously-minted batch. Unknown jtis are a
 * no-op (idempotent on duplicate / stale acks).
 *
 * The `expectedKind` argument scopes the inflight-row lookup to the
 * drain that owns the JTI. A queue-only `policy_event` drain passes
 * `"policy_event"` so a `context_jti` minted by the streaming
 * baseline/story drains becomes a no-op rather than accidentally
 * advancing `aimer_push_state` from a cross-route caller. Drain routes
 * pass their own kind for the same reason.
 *
 *  - Streaming kinds: advance the cursor on `aimer_push_state`, mark
 *    the queue rows ack'd, delete the inflight row.
 *  - Queue-only kind (`policy_event`): mark queue rows ack'd, delete
 *    the inflight row. No state update.
 *
 * When `expectedKind === "story"` AND the inflight row carries a
 * cursor advance (new-row Story batch — not a queue notice), the same
 * transaction also bumps `event_group.last_sent_at = NOW()`,
 * `last_sent_by = SYSTEM_ACTOR_ACCOUNT_ID`, `send_count += 1` for
 * every `event_group.id` in the half-open range
 * `(prev_cursor, new_cursor]` (recomputed from
 * `aimer_push_state.last_pushed_event_*` read with `FOR UPDATE`
 * before {@link advanceCursor} runs). The returned
 * {@link CommitOnAckResult.storyBetaRows} lets the caller emit one
 * `triage.story.send` audit row per affected Story after this
 * transaction commits — audit emission is best-effort outside the
 * tenant transaction (#493).
 */
export async function commitOnAck(
  customerId: number,
  contextJti: string,
  expectedKind: Phase2InflightKind,
): Promise<CommitOnAckResult> {
  const pool = await getCustomerPool(customerId);
  const client = await pool.connect();
  let storyBetaRows: CommitOnAckStoryBetaRow[] = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<InflightRow>(
      `SELECT context_jti,
              kind,
              cursor_advance_to_event_time,
              cursor_advance_to_event_key,
              queue_row_ids::text[] AS queue_row_ids,
              pending_tail_notices
         FROM aimer_push_inflight
        WHERE context_jti = $1
          AND kind = $2
        FOR UPDATE`,
      [contextJti, expectedKind],
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return { storyBetaRows: [] };
    }
    const row = rows[0];

    if (row.kind === "baseline_event" || row.kind === "story") {
      if (
        row.cursor_advance_to_event_time !== null &&
        row.cursor_advance_to_event_key !== null
      ) {
        // For the story streaming branch the β-bump must atomically
        // commit with the cursor advance, so read the prior cursor
        // value inside this transaction *before* advancing. The same
        // FOR UPDATE that {@link advanceCursor} performs internally
        // would race here (we'd read the post-advance value), so do
        // an explicit read first; advanceCursor then re-locks the row
        // and applies the monotonic advance.
        let prevCursorTime: Date | null = null;
        let prevCursorKey: string | null = null;
        if (row.kind === "story") {
          const { rows: prev } = await client.query<{
            last_pushed_event_time: Date | null;
            last_pushed_event_key: string | null;
          }>(
            `SELECT last_pushed_event_time, last_pushed_event_key
               FROM aimer_push_state
              WHERE kind = 'story'
              FOR UPDATE`,
          );
          prevCursorTime = prev[0]?.last_pushed_event_time ?? null;
          prevCursorKey = prev[0]?.last_pushed_event_key ?? null;
        }

        await advanceCursor(
          customerId,
          row.kind,
          row.cursor_advance_to_event_time,
          row.cursor_advance_to_event_key,
          client,
        );

        if (row.kind === "story") {
          // Recompute the `event_group.id` set in the half-open range
          // (prev_cursor, new_cursor] so the β-bump and the audit
          // emission share the same identity. NULL prev cursor means
          // "first advance" — the range degenerates to
          // `(time_window_end, id) <= (new_cursor)`. The cursor key
          // is the stringified `id` (NUMERIC(39, 0)) per the story
          // drain's mapping in #493.
          const { rows: affected } = await client.query<{
            id: string;
            story_version: string;
          }>(
            `SELECT id::text          AS id,
                    story_version
               FROM event_group
              WHERE kind = 'auto_correlated'
                AND (time_window_end, id::numeric)
                      <= ($1::timestamptz, $2::numeric)
                AND ($3::timestamptz IS NULL
                     OR (time_window_end, id::numeric)
                          > ($3::timestamptz, $4::numeric))`,
            [
              row.cursor_advance_to_event_time,
              row.cursor_advance_to_event_key,
              prevCursorTime,
              prevCursorKey,
            ],
          );
          if (affected.length > 0) {
            await client.query(
              `UPDATE event_group
                  SET last_sent_at = NOW(),
                      last_sent_by = $2::uuid,
                      send_count   = send_count + 1
                WHERE id = ANY($1::bigint[])`,
              [affected.map((r) => r.id), SYSTEM_ACTOR_ACCOUNT_ID],
            );
            storyBetaRows = affected.map((r) => ({
              storyId: r.id,
              storyVersion: r.story_version,
            }));
          }
        }
      } else {
        // No cursor advance but the drain still wants to record
        // liveness — bump last_synced_at without touching the cursor.
        await client.query(
          `UPDATE aimer_push_state
              SET last_synced_at = NOW(),
                  last_error     = NULL
            WHERE kind = $1`,
          [row.kind],
        );
      }
    }

    await markAcked(customerId, row.queue_row_ids, contextJti, client);

    // Enqueue any tail notices recorded with this inflight (e.g. the
    // refresh/backfill sub-payloads produced by post-enrichment
    // subdivision in the baseline-event drain). Coupling the enqueue
    // to head-batch ack means a failed POST drops these tails with
    // {@link recordOnFail} so the next retry can redo the subdivision
    // freshly without leaving duplicates in the queue.
    const tail = row.pending_tail_notices ?? [];
    for (const notice of tail) {
      await enqueueNotice(customerId, notice.kind, notice.payload, client);
    }

    await client.query(
      "DELETE FROM aimer_push_inflight WHERE context_jti = $1",
      [contextJti],
    );

    await client.query("COMMIT");
    return { storyBetaRows };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record-on-fail for a previously-minted batch. Unknown jtis are a
 * no-op.
 *
 * The `expectedKind` argument scopes the inflight-row lookup to the
 * drain that owns the JTI, mirroring {@link commitOnAck}. A queue-only
 * `policy_event` drain passing a streaming JTI is a no-op so a
 * cross-route failure report cannot write `aimer_push_state.last_error`
 * on a kind whose drain it does not own.
 *
 *  - Streaming kinds: write `aimer_push_state.last_error` via
 *    {@link recordSyncError} (cursor is left at the prior value so the
 *    next activation re-sends the same slice).
 *  - Queue-only kind: skip state (no row exists).
 *  - All kinds: increment `attempts` + write `last_error` on the queue
 *    rows referenced by the inflight row, then DELETE the inflight.
 */
export async function recordOnFail(
  customerId: number,
  contextJti: string,
  failureReason: string,
  expectedKind: Phase2InflightKind,
): Promise<void> {
  const pool = await getCustomerPool(customerId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<InflightRow>(
      `SELECT context_jti,
              kind,
              cursor_advance_to_event_time,
              cursor_advance_to_event_key,
              queue_row_ids::text[] AS queue_row_ids
         FROM aimer_push_inflight
        WHERE context_jti = $1
          AND kind = $2
        FOR UPDATE`,
      [contextJti, expectedKind],
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return;
    }
    const row = rows[0];

    if (row.kind === "baseline_event" || row.kind === "story") {
      await recordSyncError(customerId, row.kind, failureReason, client);
    }
    await recordNoticeError(
      customerId,
      row.queue_row_ids,
      failureReason,
      client,
    );

    await client.query(
      "DELETE FROM aimer_push_inflight WHERE context_jti = $1",
      [contextJti],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Opportunistic TTL prune of `aimer_push_inflight` rows whose
 * `minted_at` is older than {@link PHASE2_INFLIGHT_TTL_SECONDS} ago.
 * Called by each `next-batch` route at the start of every call so an
 * abandoned record (browser closed, instance churn) does not block
 * the next slice indefinitely. Returns the count of rows deleted.
 */
export async function pruneExpiredInflight(
  customerId: number,
  client?: pg.PoolClient,
): Promise<number> {
  const runner = client ?? (await getCustomerPool(customerId));
  const result = await runner.query(
    `DELETE FROM aimer_push_inflight
      WHERE minted_at < NOW() - make_interval(secs => $1)`,
    [PHASE2_INFLIGHT_TTL_SECONDS],
  );
  return result.rowCount ?? 0;
}

// ── Backlog estimation ─────────────────────────────────────────────

/**
 * Coarse backlog estimate for the Settings indicator per #570
 * "Backlog estimation". Bucket thresholds:
 *
 *   - `paused`     — `opportunistic_enabled = FALSE`
 *   - `synced`     — cursor lag `< 5 min` AND fewer than 10 pending notices
 *   - `behind`     — cursor lag `< 1 hour` OR `≥ 10` pending notices
 *   - `way_behind` — cursor lag `≥ 1 hour` OR `≥ 100` pending notices
 *
 * `approximate_count` is a fast-path count of source rows past the
 * cursor, capped at {@link BACKLOG_APPROXIMATE_COUNT_LIMIT} − 1 (values
 * at the cap mean "≥1000"). Implemented for `baseline_event`
 * (source: `baseline_triaged_event`); `story` keeps it `null` for now
 * because the story drain route in #493 owns the source-table cursor
 * mapping. `policy_event` is queue-only — no cursor, no source table.
 */
export async function estimateBacklog(
  customerId: number,
  kind: Phase2DrainKind,
): Promise<BacklogEstimate> {
  const pool = await getCustomerPool(customerId);
  const queueKinds = PHASE2_QUEUE_KINDS_BY_DRAIN[kind];
  const { rows: pending } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM aimer_push_queue
      WHERE acked_at IS NULL
        AND kind = ANY($1::text[])`,
    [queueKinds as unknown as string[]],
  );
  const pendingNoticeCount = Number(pending[0]?.count ?? "0");

  if (kind === "policy_event") {
    return {
      // Queue-only: no cursor, no pause, no source table. The bucket
      // label reflects pending-notice depth alone.
      bucket: bucketForPolicyEvent(pendingNoticeCount),
      approximate_count: null,
      cursor_lag_seconds: null,
      newest_unsent_event_time: null,
      pending_notice_count: pendingNoticeCount,
    };
  }

  const state = await getAimerPushState(customerId, kind);
  if (state && !state.opportunistic_enabled) {
    return {
      bucket: "paused",
      approximate_count: null,
      cursor_lag_seconds: null,
      newest_unsent_event_time: null,
      pending_notice_count: pendingNoticeCount,
    };
  }

  const lagSeconds = computeCursorLag(state?.last_pushed_event_time ?? null);

  let approximateCount: number | null = null;
  let newestUnsentEventTime: string | null = null;
  if (kind === "baseline_event") {
    const fastPath = await fastPathBaselineBacklog(
      pool,
      state?.last_pushed_event_time ?? null,
      state?.last_pushed_event_key ?? null,
    );
    approximateCount = fastPath.approximateCount;
    newestUnsentEventTime = fastPath.newestUnsentEventTime;
  }

  const bucket = bucketForBacklog(
    lagSeconds,
    pendingNoticeCount,
    approximateCount,
  );

  return {
    bucket,
    approximate_count: approximateCount,
    cursor_lag_seconds: lagSeconds,
    newest_unsent_event_time: newestUnsentEventTime,
    pending_notice_count: pendingNoticeCount,
  };
}

function computeCursorLag(lastPushedEventTime: Date | null): number | null {
  if (lastPushedEventTime === null) return null;
  const now = Date.now();
  const cursorMs = lastPushedEventTime.getTime();
  return Math.max(0, Math.floor((now - cursorMs) / 1000));
}

function bucketForPolicyEvent(
  pendingNoticeCount: number,
): "synced" | "behind" | "way_behind" {
  if (pendingNoticeCount >= BACKLOG_PENDING_WAY_BEHIND_THRESHOLD) {
    return "way_behind";
  }
  if (pendingNoticeCount >= BACKLOG_PENDING_BEHIND_THRESHOLD) return "behind";
  return "synced";
}

function bucketForBacklog(
  lagSeconds: number | null,
  pendingNoticeCount: number,
  approximateCount: number | null,
): "synced" | "behind" | "way_behind" {
  const lagWayBehind =
    lagSeconds !== null && lagSeconds >= BACKLOG_BUCKET_WAY_BEHIND_SECONDS;
  const pendingWayBehind =
    pendingNoticeCount >= BACKLOG_PENDING_WAY_BEHIND_THRESHOLD;
  // A saturated source-row count (≥ 1000 unsent rows) escalates to
  // way_behind even when the cursor lag has not yet crossed the 1-hour
  // line — large backlogs ship faster than wall-clock would suggest.
  const sourceWayBehind =
    approximateCount !== null &&
    approximateCount >= BACKLOG_APPROXIMATE_COUNT_LIMIT - 1;
  if (lagWayBehind || pendingWayBehind || sourceWayBehind) return "way_behind";

  const lagBehind =
    lagSeconds !== null && lagSeconds >= BACKLOG_BUCKET_BEHIND_SECONDS;
  const pendingBehind = pendingNoticeCount >= BACKLOG_PENDING_BEHIND_THRESHOLD;
  if (lagBehind || pendingBehind) return "behind";

  return "synced";
}

/**
 * Fast-path approximate-count + newest-unsent timestamp for the
 * baseline drain, per #570 "Backlog estimation": LIMIT at
 * {@link BACKLOG_APPROXIMATE_COUNT_LIMIT} so a saturated table answers
 * in bounded work. When no cursor has been recorded yet the helper
 * returns `(null, null)` so the bucket logic falls back to pure
 * pending-notice depth.
 */
async function fastPathBaselineBacklog(
  pool: pg.Pool,
  cursorEventTime: Date | null,
  cursorEventKey: string | null,
): Promise<{
  approximateCount: number | null;
  newestUnsentEventTime: string | null;
}> {
  if (cursorEventTime === null || cursorEventKey === null) {
    return { approximateCount: null, newestUnsentEventTime: null };
  }
  try {
    const { rows } = await pool.query<{
      count: string;
      newest_unsent_event_time: string | null;
    }>(
      `WITH slice AS (
         SELECT event_time
           FROM baseline_triaged_event
          WHERE (event_time, event_key) > ($1::timestamptz, $2::numeric)
          ORDER BY event_time, event_key
          LIMIT $3
       )
       SELECT COUNT(*)::text                          AS count,
              MAX(event_time)::text                   AS newest_unsent_event_time
         FROM slice`,
      [cursorEventTime, cursorEventKey, BACKLOG_APPROXIMATE_COUNT_LIMIT],
    );
    const row = rows[0];
    if (!row) {
      return { approximateCount: 0, newestUnsentEventTime: null };
    }
    const raw = Number(row.count ?? "0");
    return {
      approximateCount: roundApproximate(raw),
      newestUnsentEventTime: row.newest_unsent_event_time ?? null,
    };
  } catch {
    // Fast path is best-effort. A missing table during early bring-up,
    // or a planner timeout, should not break the bucket label that the
    // Settings indicator depends on.
    return { approximateCount: null, newestUnsentEventTime: null };
  }
}

/**
 * Coarse-round the approximate count per #570 "Backlog estimation"
 * (rounded to nearest 100 / 1000 / 10000 depending on magnitude).
 * Values at or above the LIMIT cap saturate at `LIMIT - 1` so the
 * caller can treat the cap as "≥1000".
 */
function roundApproximate(raw: number): number {
  if (raw <= 0) return 0;
  if (raw >= BACKLOG_APPROXIMATE_COUNT_LIMIT) {
    return BACKLOG_APPROXIMATE_COUNT_LIMIT - 1;
  }
  if (raw < 100) return Math.round(raw / 10) * 10;
  if (raw < 1000) return Math.round(raw / 100) * 100;
  return Math.round(raw / 1000) * 1000;
}
