import "server-only";

/**
 * Story force-rebuild (#565) — admin-only escape hatch that re-runs
 * the heuristic Story correlator over an already-finalized
 * `[from, to)` window.
 *
 * Closes the structural gap left by #473: that path rebuilds
 * `baseline_triaged_event` / `observed_event_meta` for a window but
 * explicitly disables the Story correlator
 * (`runStoryCorrelator: false` in `rebuild.ts`), so the
 * `event_group` rows that sit on top of the rebuilt corpus are stale
 * by design. This service is the dedicated Story side-channel that
 * closes the loop: DELETE the auto Stories whose `time_window_end`
 * falls inside `[from, to)`, re-run the correlator over the same
 * window using the current rule code, and INSERT replacements with
 * β-style submission tracking carried over from any matching
 * pre-rebuild row.
 *
 * Window semantics: `[from, to)` is interpreted as the finalization-
 * candidate range on `event_group.time_window_end`. Member-scan reads
 * cover `[from − MAX_RULE_WINDOW_MS, to)` so cross-window clusters
 * whose end falls just past `from` can still pick up earlier members.
 * No slop window is applied — the caller has already deemed the
 * range finalized.
 *
 * Transaction boundary: steps 2–5 (read snapshot → DELETE → correlate
 * → INSERT) run inside a single DB transaction on the lock-holding
 * pool client, so an intermediate failure leaves `event_group`
 * byte-identical to its pre-rebuild state. The advisory lock is
 * released in the `finally` block regardless of outcome.
 *
 * The Story watermark `story_finalized_through` is intentionally NOT
 * touched — it is cadence's marker for forward progress, and a
 * rebuild operates on an already-finalized region. The extraction of
 * `runStoryCorrelationForWindow` from `runStepF` guarantees this by
 * construction (the new core does not read or advance the
 * watermark).
 */

import { timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { LOCK_NAMESPACE } from "@/lib/triage/baseline/cadence";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

import { runStoryCorrelationForWindow, type StoryInsertFn } from "./correlator";
import {
  type AutoStoryBetaCarryOver,
  type InsertAutoStoryResult,
  insertAutoStory,
} from "./repository";
import { MAX_RULE_WINDOW_MS, type StoryDraft } from "./rules";

/**
 * The per-customer advisory lock — shared with cadence, exclusion-ADD,
 * and the baseline rebuild — is already held. Cadence holds it via
 * `pg_try_advisory_xact_lock` during each per-page transaction; the
 * Story rebuild holds it via session-level `pg_try_advisory_lock`
 * across its own transaction so the two writers cannot interleave.
 */
export class StoryRebuildBusyError extends Error {
  constructor() {
    super(
      "Per-customer cadence advisory lock is held; cadence, baseline rebuild, exclusion-ADD, or another Story rebuild is currently writing for this customer.",
    );
    this.name = "StoryRebuildBusyError";
  }
}

/**
 * The caller-supplied `[from, to)` is empty or inverted. A zero- or
 * negative-length range cannot contain any `time_window_end` so the
 * rebuild has no rows to delete or recompute; surface as a 400
 * instead of silently no-op'ing because the operator's intent is
 * unclear.
 */
export class StoryRebuildInvalidRangeError extends Error {
  constructor(fromIso: string, toIso: string) {
    super(`Invalid rebuild range: from=${fromIso}, to=${toIso}`);
    this.name = "StoryRebuildInvalidRangeError";
  }
}

export interface StoryRebuildInput {
  customerId: number;
  /** Inclusive ISO-8601 timestamp. */
  fromIso: string;
  /** Exclusive ISO-8601 timestamp; the range is half-open `[from, to)`. */
  toIso: string;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface StoryRebuildResult {
  /** Auto Stories DELETEd from the window (parent rows; member rows
   *  follow via `ON DELETE CASCADE`). */
  deletedAutoStories: number;
  /** Auto Stories INSERTed by the post-DELETE correlate pass. */
  insertedAutoStories: number;
  /** Curated Stories (`kind = 'analyst_curated'`) whose
   *  `time_window_end` fell inside the window and were left
   *  untouched — telemetry signal. */
  skippedCuratedStories: number;
  /** Newly-inserted auto Stories whose β columns were copied from
   *  a matching pre-rebuild row. */
  betaCarriedOver: number;
  /** End-to-end wall-clock duration of the rebuild call. */
  durationMs: number;
  /** Non-fatal warnings to surface in the response body. */
  warnings: string[];
}

interface OldAutoStoryRow {
  correlation_rule_id: string | null;
  primary_asset: string | null;
  time_window_start: Date;
  time_window_end: Date;
  last_sent_at: Date | null;
  send_count: number;
  last_sent_by: string | null;
}

/**
 * Natural key for the auto-Story partial unique index:
 * `(correlation_rule_id, primary_asset, time_window_start, time_window_end)`.
 * Used to join new drafts against the pre-rebuild snapshot so the
 * matching row's β columns are copied to the replacement.
 *
 * `primary_asset` is normalized via `host()` server-side on read so
 * the snapshot string matches the draft's `primaryAsset` (which is
 * also the string form returned by `host()` in
 * `readR1Candidates` / `readR3Candidates`). The
 * `time_window_start` / `time_window_end` Dates are normalized to
 * their epoch-millisecond representation so two equivalent `Date`
 * instances (e.g., reconstructed across the pg JSON boundary)
 * collide on the same key.
 */
function snapshotKey(
  ruleId: string | null,
  primaryAsset: string | null,
  start: Date,
  end: Date,
): string {
  return `${ruleId ?? ""}|${primaryAsset ?? ""}|${start.getTime()}|${end.getTime()}`;
}

function draftKey(draft: StoryDraft): string {
  return snapshotKey(
    draft.ruleId,
    draft.primaryAsset,
    draft.timeWindowStart,
    draft.timeWindowEnd,
  );
}

async function acquireSessionLock(
  client: pg.PoolClient,
  customerId: number,
): Promise<boolean> {
  const { rows } = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
    [`${LOCK_NAMESPACE}${customerId}`],
  );
  return rows[0]?.acquired === true;
}

async function releaseSessionLock(
  client: pg.PoolClient,
  customerId: number,
): Promise<void> {
  try {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
      `${LOCK_NAMESPACE}${customerId}`,
    ]);
  } catch {
    // Lock is also implicitly released on connection close; failing
    // to issue the explicit unlock is not a correctness issue.
  }
}

/**
 * Run a Story rebuild for one customer / `[from, to)` window. Throws
 * {@link StoryRebuildBusyError} when the advisory lock is held;
 * {@link StoryRebuildInvalidRangeError} when the range is empty or
 * inverted; any other failure propagates from inside the DB
 * transaction and rolls it back so the pre-rebuild `event_group`
 * rows remain visible.
 */
export async function runStoryRebuild(
  input: StoryRebuildInput,
): Promise<StoryRebuildResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const from = new Date(input.fromIso);
  const to = new Date(input.toIso);
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from.getTime() >= to.getTime()
  ) {
    throw new StoryRebuildInvalidRangeError(input.fromIso, input.toIso);
  }
  if (input.signal?.aborted) {
    throw new Error("Story rebuild aborted before start");
  }

  const pool = await getCustomerPool(input.customerId);
  const client = await pool.connect();
  let acquired = false;
  try {
    acquired = await acquireSessionLock(client, input.customerId);
    if (!acquired) {
      throw new StoryRebuildBusyError();
    }

    const txResult = await runRebuildTransaction(client, input, from, to);
    const durationMs = Date.now() - startedAt;
    return {
      ...txResult,
      durationMs,
      warnings,
    };
  } finally {
    if (acquired) {
      await releaseSessionLock(client, input.customerId);
    }
    client.release();
  }
}

async function runRebuildTransaction(
  client: pg.PoolClient,
  input: StoryRebuildInput,
  from: Date,
  to: Date,
): Promise<Omit<StoryRebuildResult, "durationMs" | "warnings">> {
  await client.query("BEGIN");
  try {
    // (1) Curated count: telemetry signal — these rows would have
    // been deleted if curated/auto had not been discriminated. The
    // partial unique index that scopes auto-Story dedup is keyed by
    // `kind = 'auto_correlated'` so the DELETE below leaves curated
    // rows untouched; the count is reported back to the caller.
    const curatedRes = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM event_group
        WHERE kind = 'analyst_curated'
          AND time_window_end >= $1 AND time_window_end < $2`,
      [from, to],
    );
    const skippedCuratedStories = curatedRes.rows[0]?.count ?? 0;

    // (2) Snapshot the pre-rebuild auto Stories so the post-INSERT
    // path can join on the natural key for β carry-over. The SELECT
    // runs inside the same transaction as the DELETE, so a competing
    // writer cannot land a new auto row between the snapshot and the
    // DELETE — even though the advisory lock alone already
    // serializes against cadence / exclusion-ADD / #473 / another
    // rebuild on this customer.
    const snapshotRes = await client.query<OldAutoStoryRow>(
      `SELECT correlation_rule_id,
              host(primary_asset)::text AS primary_asset,
              time_window_start,
              time_window_end,
              last_sent_at,
              send_count,
              last_sent_by::text          AS last_sent_by
         FROM event_group
        WHERE kind = 'auto_correlated'
          AND time_window_end >= $1 AND time_window_end < $2`,
      [from, to],
    );
    const carryOverMap = new Map<string, AutoStoryBetaCarryOver>();
    for (const row of snapshotRes.rows) {
      const key = snapshotKey(
        row.correlation_rule_id,
        row.primary_asset,
        row.time_window_start,
        row.time_window_end,
      );
      carryOverMap.set(key, {
        lastSentAt: row.last_sent_at,
        sendCount: Number(row.send_count ?? 0),
        lastSentBy: row.last_sent_by,
      });
    }

    // (3) DELETE auto Stories in the window. `event_group_member`
    // rows follow via `ON DELETE CASCADE`
    // (`migrations/customer/0008_event_group_story.sql`), so no
    // explicit member DELETE is needed.
    const deletedRes = await client.query<{ count: number }>(
      `WITH deleted AS (
         DELETE FROM event_group
          WHERE kind = 'auto_correlated'
            AND time_window_end >= $1 AND time_window_end < $2
         RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM deleted`,
      [from, to],
    );
    const deletedAutoStories = deletedRes.rows[0]?.count ?? 0;

    // (4 + 5) Re-run the correlator with a β-aware insert that
    // copies submission tracking from the snapshot when the natural
    // key matches. Member-scan covers `[from − MAX_RULE_WINDOW_MS,
    // to)` — note the half-open upper bound. Without `endExclusive`,
    // an event at exactly `to` could pull earlier events into a
    // cluster whose `time_window_end == to`; the rebuild's
    // `[from, to)` finalization predicate would then drop that
    // draft, and the pre-rebuild Story that ended just inside `to`
    // (already DELETEd) would not be reinserted — a silently-lost
    // Story inside the requested window.
    let betaCarriedOver = 0;
    const insertDraft: StoryInsertFn = async (
      txClient,
      draft,
    ): Promise<InsertAutoStoryResult> => {
      const co = carryOverMap.get(draftKey(draft));
      const result = await insertAutoStory(txClient, draft, co);
      if (result.groupId !== null && co !== undefined) {
        betaCarriedOver += 1;
      }
      return result;
    };
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const memberScanStart = new Date(fromMs - MAX_RULE_WINDOW_MS);
    const { storiesInserted: insertedAutoStories } =
      await runStoryCorrelationForWindow({
        client,
        memberScanStart,
        memberScanEnd: to,
        endExclusive: true,
        finalize: (end) => {
          const ms = end.getTime();
          return ms >= fromMs && ms < toMs;
        },
        insertDraft,
        signal: input.signal,
      });

    await client.query("COMMIT");
    return {
      deletedAutoStories,
      insertedAutoStories,
      skippedCuratedStories,
      betaCarriedOver,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * Constant-time bearer-token check for the rebuild route. Reads the
 * shared secret from `TRIAGE_STORY_REBUILD_INTERNAL_TOKEN`. Refuses
 * every request when the env var is unset, matching the convention
 * of the other internal-token routes.
 */
export function verifyTriageStoryRebuildToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_STORY_REBUILD_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const _testing = {
  acquireSessionLock,
  releaseSessionLock,
  snapshotKey,
  draftKey,
};
