import "server-only";

/**
 * Persistent low-and-slow Story sweep runner (issue #701).
 *
 * A periodic sweep, decoupled from per-page cadence step (f), that
 * detects dispersed ("암약") activity over a 24-hour window on a single
 * source asset and ships rule R6. It mirrors the cadence dispatch path
 * but runs hourly and reads only the already-ingested local corpus —
 * no REview fetch, no pager. Per-page `MAX_RULE_WINDOW_MS` stays 1h
 * and R1/R3/R4/R5 are untouched.
 *
 * ## Horizon, ranges, watermark (Story RFC §4 low-and-slow addendum)
 *
 * The corpus is filled by cadence in `event_time` order with a 30-min
 * slop; cadence publishes how far it has settled Stories via
 * `baseline_corpus_state.story_finalized_through` (`H`). The sweep must
 * not finalize past a region cadence may still be filling, so:
 *
 *   - **Horizon** `H = story_finalized_through`. The sweep never
 *     advances past cadence's settled point, inheriting cadence's slop
 *     guarantee. `H IS NULL` ⇒ no-op (cadence has not settled once).
 *   - **Skip when cadence has not progressed:** if
 *     `H ≤ lowslow_finalized_through`, early-return before the
 *     member-scan — the finalization range is empty and the `GREATEST`
 *     advance is already a no-op. Stops the hourly cron from
 *     re-reading the same 24h range while cadence is idle.
 *   - **Member-scan range:** `[wm − LOWSLOW_WINDOW_MS, H]` (lookback a
 *     full window so a cluster ending just past the watermark still
 *     sees its earlier members).
 *   - **Finalization range:** `(wm, H]`.
 *   - **First run (`wm IS NULL`):** clamp BOTH ranges to the most
 *     recent window — member-scan `[H − LOWSLOW_WINDOW_MS, H]` and
 *     finalize `(H − LOWSLOW_WINDOW_MS, H]` — no full 180d backfill.
 *     This intentionally differs from cadence's first-tick rule
 *     (which degenerates both ranges to `(-∞, H]`).
 *   - **Watermark advance:** `lowslow_finalized_through =
 *     GREATEST(lowslow_finalized_through, H)`, even on 0-Story runs.
 *
 * ## Concurrency
 *
 * A per-customer transaction-scoped advisory lock gives sweep-vs-sweep
 * mutual exclusion:
 *
 *   `pg_try_advisory_xact_lock(hashtext('triage_lowslow_sweep:' || customer_id))`
 *
 * Correctness does not require sharing cadence's writer lock because
 * `H` is bounded by cadence's published, monotonic watermark. If the
 * lock is unavailable the sweep exits cleanly (`status: 'skipped'`);
 * the next hourly tick picks up via the watermark. Lock release is
 * automatic on commit/rollback.
 *
 * ## Rebuild interaction
 *
 * R6 is re-derived by NEITHER baseline force-rebuild (which re-derives
 * no Stories) NOR Story force-rebuild (`story/rebuild.ts`, which
 * re-derives the cadence-path rules R1/R3/R4/R5). The sweep and
 * `lowslow_finalized_through` are intentionally not wired into either
 * rebuild path — consistent with the no-retroactive-backfill contract.
 */

import { timingSafeEqual } from "node:crypto";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";
import {
  advanceLowslowWatermark,
  insertAutoStory,
  readLowslowWatermark,
  readR6Candidates,
  readStoryWatermark,
} from "@/lib/triage/story/repository";
import { detectR6, LOWSLOW_WINDOW_MS } from "@/lib/triage/story/rules";

export type LowslowSweepStatus = "ok" | "skipped" | "failed";

export interface LowslowSweepResult {
  /** Customer the sweep targeted. */
  customerId: number;
  /**
   * Outcome marker:
   *   - `ok`: the sweep committed (possibly a no-op when `H IS NULL`
   *     or `H ≤ wm`, or a 0-Story progress advance).
   *   - `skipped`: the per-customer advisory lock was unavailable;
   *     this tick is a no-op.
   *   - `failed`: the sweep transaction rolled back; `error` carries
   *     the message.
   */
  status: LowslowSweepStatus;
  /** Number of `event_group` (R6) rows inserted this sweep. */
  storiesInserted: number;
  /**
   * The horizon `H` the watermark advanced to this tick, or `null`
   * when the sweep was a no-op (lock skip, `H IS NULL`, or
   * `H ≤ wm`). Tests assert this directly.
   */
  newWatermark: Date | null;
  /** Error message, populated only when `status === 'failed'`. */
  error?: string;
}

/**
 * Per-customer advisory-lock namespace for the low-and-slow sweep.
 * Distinct from the cadence namespace (`triage_baseline_cadence:`) so
 * a sweep and a cadence pass for the same customer do not serialize —
 * the sweep's `H` is bounded by cadence's published watermark, so they
 * are correct to run concurrently.
 */
export const LOWSLOW_LOCK_NAMESPACE = "triage_lowslow_sweep:";

function buildLockKeyParam(customerId: number): string {
  return `${LOWSLOW_LOCK_NAMESPACE}${customerId}`;
}

/**
 * Run one low-and-slow sweep for a single customer. The whole sweep
 * commits as one transaction (the corpus is local — there is no
 * paging), so a failure rolls back without advancing the watermark.
 */
export async function runLowslowSweep(
  customerId: number,
  options: { signal?: AbortSignal },
): Promise<LowslowSweepResult> {
  const { signal } = options;

  // Lets `CustomerNotFoundError` propagate so the route handler / the
  // dispatcher can surface it appropriately.
  const pool = await getCustomerPool(customerId);
  const client = await pool.connect();
  let txOpen = false;
  try {
    if (signal?.aborted) {
      return {
        customerId,
        status: "skipped",
        storiesInserted: 0,
        newWatermark: null,
      };
    }

    await client.query("BEGIN");
    txOpen = true;

    const lockResult = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
      [buildLockKeyParam(customerId)],
    );
    if (lockResult.rows[0]?.acquired !== true) {
      await client.query("ROLLBACK");
      txOpen = false;
      return {
        customerId,
        status: "skipped",
        storiesInserted: 0,
        newWatermark: null,
      };
    }

    const horizon = await readStoryWatermark(client);
    const watermark = await readLowslowWatermark(client);

    // `H IS NULL`: cadence has not settled any Stories yet — nothing to
    // sweep. The degenerate case of the `H ≤ wm` guard below.
    if (horizon === null) {
      await client.query("COMMIT");
      txOpen = false;
      return {
        customerId,
        status: "ok",
        storiesInserted: 0,
        newWatermark: null,
      };
    }

    // Cost guard: cadence has not progressed past where the sweep
    // already finalized, so the finalization range `(wm, H]` is empty.
    // Early-return before the 24h member-scan; the `GREATEST` advance
    // would be a no-op anyway.
    if (watermark !== null && horizon.getTime() <= watermark.getTime()) {
      await client.query("COMMIT");
      txOpen = false;
      return {
        customerId,
        status: "ok",
        storiesInserted: 0,
        newWatermark: null,
      };
    }

    const horizonMs = horizon.getTime();
    // First run (`wm IS NULL`) clamps the lower bound to `H − 24h` for
    // BOTH the member-scan and the finalization predicate — no 180d
    // backfill. Otherwise the member-scan looks back a full window from
    // the watermark and the finalization range opens at the watermark.
    const finalizeLowerMs =
      watermark === null ? horizonMs - LOWSLOW_WINDOW_MS : watermark.getTime();
    const memberScanStart = new Date(
      (watermark === null ? horizonMs : watermark.getTime()) -
        LOWSLOW_WINDOW_MS,
    );

    const candidates = await readR6Candidates({
      client,
      memberScanStart,
      memberScanEnd: horizon,
      // Cadence's `<=`-inclusive horizon semantics: a draft ending at
      // exactly `H` is eligible this tick.
      endExclusive: false,
    });

    if (signal?.aborted) {
      throw new Error("Low-and-slow sweep aborted after candidate scan");
    }

    const drafts = detectR6(candidates);
    let storiesInserted = 0;
    for (const draft of drafts) {
      if (signal?.aborted) {
        throw new Error("Low-and-slow sweep aborted between drafts");
      }
      const endMs = draft.timeWindowEnd.getTime();
      // Finalization range `(wm, H]` (first run: `(H − 24h, H]`).
      if (endMs <= finalizeLowerMs || endMs > horizonMs) continue;
      const result = await insertAutoStory(client, draft);
      if (result.groupId !== null) storiesInserted += 1;
    }

    // Advance the watermark to `H` even on a 0-Story run — it is a
    // progress watermark, not a Stories-produced one. `GREATEST` keeps
    // it monotonic.
    await advanceLowslowWatermark(client, horizon);
    await client.query("COMMIT");
    txOpen = false;

    return {
      customerId,
      status: "ok",
      storiesInserted,
      newWatermark: horizon,
    };
  } catch (err) {
    if (txOpen) {
      await client.query("ROLLBACK").catch(() => {
        // Already rolled back or connection broken; nothing to do.
      });
    }
    const message =
      err instanceof Error ? err.message : "Low-and-slow sweep failed";
    return {
      customerId,
      status: "failed",
      storiesInserted: 0,
      newWatermark: null,
      error: message,
    };
  } finally {
    client.release();
  }
}

/**
 * Internal-token guard for the low-and-slow sweep route handler. Reads
 * the shared secret from `TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN` — a
 * per-surface token isolated from the cadence token, like the
 * retention tokens. Constant-time comparison via `timingSafeEqual`
 * after a length precheck so unequal-length probes do not leak through
 * the early return.
 */
export function verifyTriageLowslowSweepToken(
  provided: string | null,
): boolean {
  const expected = process.env.TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const _testing = {
  buildLockKeyParam,
};
