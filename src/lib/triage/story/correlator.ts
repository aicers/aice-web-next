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
  type InsertAutoStoryResult,
  insertAutoStory,
  readR1Candidates,
  readR3Candidates,
  readStoryWatermark,
} from "./repository";
import {
  detectR1,
  detectR3,
  MAX_RULE_WINDOW_MS,
  SLOP_WINDOW_MS,
  type StoryDraft,
} from "./rules";

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
 * Pluggable insert path used by {@link runStoryCorrelationForWindow}.
 * The cadence call site uses the default ({@link insertAutoStory})
 * which writes β columns at their DEFAULT (NULL / 0 / NULL); the
 * rebuild path (#565) swaps in a β-aware variant that joins the new
 * row against the pre-rebuild snapshot on the natural key and copies
 * `last_sent_at` / `send_count` / `last_sent_by` when matched.
 */
export type StoryInsertFn = (
  client: pg.PoolClient,
  draft: StoryDraft,
) => Promise<InsertAutoStoryResult>;

export interface RunStoryCorrelationForWindowArgs {
  client: pg.PoolClient;
  /**
   * Inclusive lower bound on `event_time` for the member scan, or
   * `null` for no lower bound. Cadence passes
   * `previous_watermark − MAX_RULE_WINDOW_MS` (or `null` on the first
   * tick); the rebuild path passes `from − MAX_RULE_WINDOW_MS` so
   * cross-window clusters whose end falls just past `from` can pick
   * up earlier members.
   */
  memberScanStart: Date | null;
  /** Inclusive upper bound on `event_time` for the member scan. */
  memberScanEnd: Date;
  /**
   * Predicate over a draft's `time_window_end` indicating whether
   * it should be finalized in this call. Cadence passes
   * `endMs > previousWatermark && endMs <= newHorizon` (open-closed
   * `(prev, horizon]`); rebuild passes
   * `endMs >= from && endMs < to` (half-open `[from, to)`).
   */
  finalize: (timeWindowEnd: Date) => boolean;
  /**
   * Optional override for the per-draft insert. Defaults to
   * {@link insertAutoStory}.
   */
  insertDraft?: StoryInsertFn;
  signal?: AbortSignal;
}

export interface StoryCorrelationResult {
  /** Number of `event_group` rows inserted by this call. */
  storiesInserted: number;
}

/**
 * Pure "candidate scan + detect + insert" core extracted from
 * {@link runStepF}. Does NOT read or advance
 * `baseline_corpus_state.story_finalized_through` — the watermark is
 * cadence's concern. Re-usable from the rebuild path (#565), which
 * supplies its own `[from, to)` finalization predicate, its own
 * `memberScanStart = from − MAX_RULE_WINDOW_MS`, and a β-aware
 * `insertDraft` that copies submission tracking from the matching
 * pre-rebuild row when the natural key matches.
 */
export async function runStoryCorrelationForWindow(
  args: RunStoryCorrelationForWindowArgs,
): Promise<StoryCorrelationResult> {
  const {
    client,
    memberScanStart,
    memberScanEnd,
    finalize,
    insertDraft,
    signal,
  } = args;
  if (signal?.aborted) {
    throw new Error("Story correlator aborted before evaluation");
  }

  // Per-rule SQL push-down (Story RFC §3, §5). R1 reads its
  // candidate set with `category = ANY(...)` as a single SELECT.
  // R3 is two-phase: phase 1 pre-aggregates candidate assets
  // (`GROUP BY orig_addr HAVING COUNT(*) >= 3` over
  // `selector_tags && ...`), phase 2 reads per-asset rows via
  // `orig_addr = ANY($::inet[])`. Final sliding-window clustering
  // stays in the rule layer.
  const [r1Candidates, r3Candidates] = await Promise.all([
    readR1Candidates({ client, memberScanStart, memberScanEnd }),
    readR3Candidates({ client, memberScanStart, memberScanEnd }),
  ]);

  const drafts: StoryDraft[] = [
    ...detectR1(r1Candidates),
    ...detectR3(r3Candidates),
  ];

  const insertFn = insertDraft ?? insertAutoStory;
  let storiesInserted = 0;
  for (const draft of drafts) {
    if (signal?.aborted) {
      throw new Error("Story correlator aborted between drafts");
    }
    if (!finalize(draft.timeWindowEnd)) continue;
    const result = await insertFn(client, draft);
    if (result.groupId !== null) storiesInserted += 1;
  }

  return { storiesInserted };
}

/**
 * Run step (f) for the page. Writes happen in the caller's open
 * transaction, so a thrown error rolls the entire page back.
 *
 * Thin wrapper around {@link runStoryCorrelationForWindow}: reads the
 * previous watermark, derives the finalization range
 * `(prev, page_max − slop]` and member-scan range
 * `[prev − MAX_RULE_WINDOW_MS, page_max − slop]`, runs the core, and
 * advances the watermark.
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

  // Finalization-candidate filter: only drafts whose
  // `time_window_end` falls strictly past the previous watermark
  // and at-or-before `new_horizon` are finalized this tick. Drafts
  // whose `time_window_end` falls within the last `SLOP_WINDOW_MS`
  // of the page's range (i.e., > `new_horizon`) are deferred.
  const newHorizonMs = newHorizon.getTime();
  const previousMs =
    previousWatermark === null ? -Infinity : previousWatermark.getTime();
  const { storiesInserted } = await runStoryCorrelationForWindow({
    client,
    memberScanStart,
    memberScanEnd: newHorizon,
    finalize: (end) => {
      const endMs = end.getTime();
      return endMs > previousMs && endMs <= newHorizonMs;
    },
    signal,
  });

  await advanceStoryWatermark(client, newHorizon);

  return { storiesInserted, newWatermark: newHorizon };
}
