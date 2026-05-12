import "server-only";

/**
 * Story correlator — cadence step (f) entry point (Story RFC §4).
 *
 * Called by the pager immediately after `insertBaselineTriagedEventBatch`
 * and before the per-page transaction commits, so a Story is never
 * persisted for events that did not land. The per-page transaction
 * discipline from #456 / #481 is preserved: a step (f) failure rolls
 * back the entire page's INSERTs, and the page's `last_event_cursor`
 * does not advance.
 *
 * Sliding-window correlation protocol:
 *
 *   - Each page commits its own corpus rows immediately (steps d/e).
 *   - Step (f) does NOT finalize Stories whose `time_window_end`
 *     falls within the last `SLOP_WINDOW_MS` of the page's
 *     `event_time` range. Those candidates are simply skipped.
 *   - On every successful step (f) the per-page transaction updates
 *     `baseline_corpus_state.story_finalized_through` to
 *     `(page_max_event_time − slop)`.
 *   - The next tick reads the previous watermark and runs step (f)
 *     against the two distinct ranges:
 *       * Finalization-candidate range (`time_window_end` allowed):
 *         `(previous_watermark, new_horizon]`.
 *       * Member-scan range (events read to populate predicates):
 *         `[previous_watermark − MAX_RULE_WINDOW_MS, new_horizon]`.
 *   - When `previous_watermark IS NULL` (fresh tenant), both ranges
 *     degenerate to `(-∞, new_horizon]` — no event-time lower bound
 *     is applied. `corpus_activated_at` is intentionally NOT used
 *     as an event-time floor (it is a wall-clock anchor for §7
 *     active-window age, not an event-time marker; using it here
 *     would mis-bound a historical catch-up). The page's own
 *     `event_time.min` is also not used as a floor, because a
 *     tenant that already has `baseline_triaged_event` rows when
 *     migration 0008 lands carries rows that sit before this
 *     page's min — those rows must be candidates on the first
 *     tick or they would never be considered for finalization
 *     again after the watermark advances past them.
 *   - Empty page (zero `baseline_triaged_event` survivors) is a
 *     no-op: `story_finalized_through` is NOT advanced. Advancing
 *     on an empty page would push the finalization horizon past
 *     events that arrive in the next page within the slop window,
 *     defeating the cross-page semantics.
 */

import type pg from "pg";
import {
  advanceStoryWatermark,
  insertAutoStory,
  readCandidateEventsInRange,
  readStoryWatermark,
} from "./repository";
import { detectAllStories, MAX_RULE_WINDOW_MS, SLOP_WINDOW_MS } from "./rules";

export interface RunStepFArgs {
  client: pg.PoolClient;
  /**
   * Event-time extents of the survivors this page just INSERTed into
   * `baseline_triaged_event`. `null` signals the page produced zero
   * survivors, in which case step (f) is a no-op (no watermark
   * advance, no rule evaluation).
   */
  pageEventTimeRange: { min: Date; max: Date } | null;
  signal?: AbortSignal;
}

export interface StepFResult {
  /** Number of `event_group` rows inserted this page. Idempotent
   *  re-evaluations of the same window dedup at the partial unique
   *  index and contribute 0 to this counter. */
  storiesInserted: number;
  /**
   * `(page_max_event_time − slop)` if the watermark advanced this
   * page, else `null`. Tests assert this directly; callers can
   * surface it in cadence telemetry.
   */
  newWatermark: Date | null;
}

/**
 * Run step (f) for the page. Writes happen in the caller's open
 * transaction, so a thrown error rolls the entire page back.
 */
export async function runStepF(args: RunStepFArgs): Promise<StepFResult> {
  const { client, pageEventTimeRange, signal } = args;
  if (signal?.aborted) {
    throw new Error("Story correlator aborted before evaluation");
  }
  // Empty-page no-op: the watermark is not advanced and no rules
  // run. The next non-empty page resumes from the previously-held
  // watermark — `last_event_cursor` continues to advance
  // independently (it tracks raw-page boundaries, not finalization).
  if (pageEventTimeRange === null) {
    return { storiesInserted: 0, newWatermark: null };
  }

  const previousWatermark = await readStoryWatermark(client);
  const newHorizon = new Date(
    pageEventTimeRange.max.getTime() - SLOP_WINDOW_MS,
  );

  // Member-scan range (Story RFC §4):
  //   - first tick (NULL watermark): degenerate (-∞, new_horizon].
  //     `corpus_activated_at` is intentionally NOT used as an
  //     event-time floor (wall-clock anchor, not event-time
  //     marker). Clamping to `pageEventTimeRange.min` would also
  //     mis-bound a tenant that already had `baseline_triaged_event`
  //     rows when migration 0008 landed: those rows sit before the
  //     current page, the watermark would advance past them on
  //     this commit, and they would never be considered for
  //     finalization again. Use `null` to mean "no lower bound".
  //   - second+ tick: `previous_watermark − MAX_RULE_WINDOW_MS` so
  //     cross-page clusters whose `time_window_end` falls just past
  //     the previous watermark can pick up earlier members.
  //
  // The scan upper bound is `new_horizon`, NOT
  // `pageEventTimeRange.max`. Events inside the slop window
  // `(new_horizon, page_max]` cannot finalize this tick anyway —
  // including them in the member scan would let them participate
  // in clustering and could defer an otherwise-eligible Story
  // whose other members all sit at-or-before `new_horizon`. They
  // become visible on the next tick via the lookback range.
  const memberScanStart =
    previousWatermark === null
      ? null
      : new Date(previousWatermark.getTime() - MAX_RULE_WINDOW_MS);

  const candidates = await readCandidateEventsInRange({
    client,
    memberScanStart,
    memberScanEnd: newHorizon,
  });

  const drafts = detectAllStories(candidates);

  // Finalization-candidate filter: only drafts whose
  // `time_window_end` falls strictly past the previous watermark
  // and at-or-before `new_horizon` are finalized this tick. Drafts
  // whose `time_window_end` falls within the last `SLOP_WINDOW_MS`
  // of the page's range (i.e., > `new_horizon`) are deferred.
  const newHorizonMs = newHorizon.getTime();
  const previousMs =
    previousWatermark === null ? -Infinity : previousWatermark.getTime();

  let storiesInserted = 0;
  for (const draft of drafts) {
    const endMs = draft.timeWindowEnd.getTime();
    if (endMs <= previousMs) continue; // already finalized on a prior tick
    if (endMs > newHorizonMs) continue; // in slop window; defer to next tick
    const result = await insertAutoStory(client, draft);
    if (result.groupId !== null) storiesInserted += 1;
  }

  await advanceStoryWatermark(client, newHorizon);

  return { storiesInserted, newWatermark: newHorizon };
}
