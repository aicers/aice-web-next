/**
 * Policy-run manual Send-to-aimer state helpers (RFC 0002 §6, sub-issue
 * #572).
 *
 * The Send is **manual-only / on-demand** — one operator click mints
 * `send_action_id` (UUIDv4), the browser loops `build-envelope` ↔
 * multipart POST until `has_more === false`, then calls `finalize` with
 * the full set of `batch_acks`. β tracking (`policy_triage_run.send_count`,
 * `last_sent_at`, `last_sent_by`) and the `triage.policy_run.send_to_aimer`
 * audit row are written **exactly once** per Send action in the finalize
 * transaction.
 *
 * Inflight rows live in `aimer_policy_run_send_inflight` — a separate
 * table from the streaming `aimer_push_inflight`. The lifecycles differ
 * (single discrete batch vs. continuous drain), the TTLs differ
 * ({@link POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS} = 600s vs. the streaming
 * 120s), and the columns differ (no cursor / queue_row_ids — instead a
 * `send_action_id` correlator and a `batch_index`).
 */

import "server-only";

import type pg from "pg";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";

// ── Tunables ───────────────────────────────────────────────────────

/**
 * TTL for `aimer_policy_run_send_inflight` rows. After this many seconds
 * since `minted_at`, the row is considered abandoned (operator switched
 * tabs, browser closed, network died mid-Send) and is opportunistically
 * removed on the next `build-envelope` call so the operator can re-click
 * Send to start a fresh `send_action_id`.
 *
 * 10 minutes — deliberately longer than the streaming
 * `PHASE2_INFLIGHT_TTL_SECONDS = 120` because a multi-batch Send may
 * pause between batches while the operator confirms results, switches
 * tabs, or waits on a slow network. Below this band a finalize call
 * landing during a brief network hiccup could find no inflight rows
 * (already pruned) and silently fail the set-equality check.
 */
export const POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS = 600;

// ── Inflight helpers ───────────────────────────────────────────────

export interface InsertPolicyRunSendInflightInput {
  contextJti: string;
  sendActionId: string;
  runId: string;
  actorAccountId: string;
  batchIndex: number;
  isTerminal: boolean;
  /** Exclusive upper bound (event_key) of this slice; null for empty terminal batch. */
  lastEventKey: string | null;
  /**
   * Exclusive lower bound (event_key) the build-envelope call was made
   * with — i.e., the `after_event_key` cursor input. Null on the first
   * batch of a Send.
   *
   * Persisted on the inflight row so the partial unique indexes on
   * `(send_action_id, after_event_key)` catch a sequential retry of the
   * same request body (same Send action, same cursor) and raise a
   * unique-violation that the route translates to 409. Without this,
   * the only duplicate defense is `(send_action_id, batch_index)`,
   * which only catches racing concurrent calls — a sequential retry
   * after the first call already committed would just be assigned the
   * next batch_index and silently mint a duplicate slice.
   */
  afterEventKey: string | null;
}

/**
 * Postgres unique-violation error class — used to translate a duplicate
 * `(send_action_id, batch_index)` INSERT into a 409 response at the
 * route layer rather than a generic 500. The constant lives here so the
 * route handler and these helpers agree on the code without depending
 * on `pg-protocol`'s constants module directly.
 */
export const PG_UNIQUE_VIOLATION = "23505" as const;

/**
 * Insert a freshly-minted inflight row.
 *
 * Two layers of duplicate-mint defense at the DB level:
 *
 *   1. `UNIQUE (send_action_id, batch_index)` — catches racing
 *      concurrent calls that both observe the same prior batch count.
 *   2. Partial unique indexes on `(send_action_id, after_event_key)` —
 *      catch a sequential retry of the same `{ send_action_id,
 *      after_event_key }` request body (e.g., browser retry after the
 *      first call already committed) which would otherwise rebuild the
 *      same slice with a fresh JTI and a higher `batch_index`.
 *
 * Both raise SQLSTATE 23505, which the route translates to
 * `409 duplicate_batch_for_send_action`.
 */
export async function insertPolicyRunSendInflight(
  customerId: number,
  input: InsertPolicyRunSendInflightInput,
  client?: pg.PoolClient,
): Promise<void> {
  const runner = client ?? (await getCustomerPool(customerId));
  await runner.query(
    `INSERT INTO aimer_policy_run_send_inflight
       (context_jti,
        send_action_id,
        run_id,
        actor_account_id,
        batch_index,
        is_terminal,
        last_event_key,
        after_event_key)
     VALUES ($1, $2::uuid, $3::bigint, $4::uuid, $5, $6, $7, $8)`,
    [
      input.contextJti,
      input.sendActionId,
      input.runId,
      input.actorAccountId,
      input.batchIndex,
      input.isTerminal,
      input.lastEventKey,
      input.afterEventKey,
    ],
  );
}

/**
 * Opportunistic TTL prune of `aimer_policy_run_send_inflight` rows for
 * Send actions presumed stalled. Called by each `build-envelope`
 * invocation at the start so an abandoned Send (browser closed,
 * instance churn) does not block the next operator's fresh
 * `send_action_id`.
 *
 * A Send is considered stalled — and all of its rows are removed — when
 * any of its inflight rows is older than
 * {@link POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS} seconds. The prune
 * therefore operates at the `send_action_id` granularity, not on
 * individual rows: a multi-batch Send that briefly pauses and then
 * resumes would otherwise see its earliest batch row aged out while
 * later rows survive, leaving a partial inflight set behind. If the
 * browser then reports only the surviving JTIs the `finalize` set-
 * equality check would pass and β / audit would commit for an
 * incomplete Send; conversely an honest browser reporting all JTIs
 * would see its Send fail after every batch already posted to
 * aimer-web. Both outcomes are silent corruption of the "all batches
 * delivered" invariant, so the prune deletes the whole `send_action_id`
 * once any one row crosses the TTL boundary — finalize then fails
 * fast and the operator can re-click Send.
 *
 * Independent from {@link pruneExpiredInflight} in `./state` — different
 * table, different TTL.
 */
export async function pruneExpiredPolicyRunSendInflight(
  customerId: number,
  client?: pg.PoolClient,
): Promise<number> {
  const runner = client ?? (await getCustomerPool(customerId));
  const result = await runner.query(
    `DELETE FROM aimer_policy_run_send_inflight
       WHERE send_action_id IN (
         SELECT send_action_id
           FROM aimer_policy_run_send_inflight
          WHERE minted_at < NOW() - make_interval(secs => $1)
       )`,
    [POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS],
  );
  return result.rowCount ?? 0;
}
