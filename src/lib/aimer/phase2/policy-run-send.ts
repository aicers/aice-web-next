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
 * The `aimer_policy_run_send_inflight.UNIQUE (send_action_id, batch_index)`
 * constraint guarantees that a duplicate `build-envelope` call with the
 * same `{ send_action_id, after_event_key }` (e.g. browser retry between
 * minting and the multipart POST) cannot double-mint inflight rows. The
 * route translates the unique violation to `409 duplicate_batch_for_send_action`.
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
        last_event_key)
     VALUES ($1, $2::uuid, $3::bigint, $4::uuid, $5, $6, $7)`,
    [
      input.contextJti,
      input.sendActionId,
      input.runId,
      input.actorAccountId,
      input.batchIndex,
      input.isTerminal,
      input.lastEventKey,
    ],
  );
}

/**
 * Opportunistic TTL prune of `aimer_policy_run_send_inflight` rows
 * whose `minted_at` is older than {@link POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS}
 * ago. Called by each `build-envelope` invocation at the start so an
 * abandoned Send (browser closed, instance churn) does not block the
 * next operator's fresh `send_action_id`.
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
       WHERE minted_at < NOW() - make_interval(secs => $1)`,
    [POLICY_RUN_SEND_INFLIGHT_TTL_SECONDS],
  );
  return result.rowCount ?? 0;
}
