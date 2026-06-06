// Type declarations for `read-path-sql.mjs`. Authored as a sibling
// `.d.ts` so the production caller and tests get IDE / typecheck
// signal without forcing the runtime module through a transpile step.

export const MENU_CANDIDATES_PER_BUCKET: 500;
export const TRIAGE_ASSET_DETAIL_LIMIT: 50;
export const STORY_PROTECTED_PER_TENANT_LIMIT: 2_000;

export const SELECT_MENU_COHORT_SQL: string;
export const COUNT_OBSERVED_SQL: string;
export const COUNT_TRIAGED_SQL: string;
export const PER_ASSET_OBSERVED_COUNTS_SQL: string;
export const SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL: string;
export const SELECT_STORY_PROTECTED_COHORT_SQL: string;
export const COUNT_ELIGIBLE_BY_STOP_SQL: string;

/**
 * Per-window inputs the harness threads into every measured query. Each
 * `MEASURED_QUERIES` entry's `buildParams` is a pure function of this
 * shape, so adding a per-query parameter only requires extending this
 * interface.
 */
export interface HarnessContext {
  /** Inclusive lower bound for `event_time`, ISO-8601. */
  periodStartIso: string;
  /** Exclusive upper bound for `event_time`, ISO-8601. */
  periodEndIso: string;
  /**
   * `observedFromIso` — clamped lower bound for `observed_event_meta`
   * reads. Equals `max(periodStartIso, now() - retention)`.
   */
  observedFromIso: string;
  /**
   * Address sample fed to `perAssetObservedCounts` and
   * `selectAssetDetailEventsBatch`. Drawn from the cohort the menu
   * actually produces, not synthesized — see harness header.
   */
  addresses: ReadonlyArray<string>;
  /**
   * Strictness slider cutoff (#471). Optional; defaults to `0` (no
   * additional cutoff above the cadence threshold). The cutoff is
   * **not** threaded into the menu cohort SELECT — it is applied in
   * `composeMenu` (RFC §6 option (a)). Retained on the context so the
   * harness's address sampler can replay the production `composeMenu`
   * call with the same cutoff via `addressesFromCohortRows`, and so
   * `selectAssetDetailEventsBatch` (which DOES apply the cutoff in
   * SQL, since the detail-row path has no bucket aggregates to
   * preserve) sees the same value.
   */
  menuCutoff?: number;
  /**
   * Inclusive lower bound for the Story cadence member-scan range,
   * ISO-8601. `null` corresponds to first-tick semantics
   * (`memberScanStart === null` in `story/repository.ts`); slop-replay
   * binds `[previous_watermark − MAX_RULE_WINDOW_MS, new_horizon]`.
   * Issue #601.
   */
  memberScanStartIso: string | null;
  /**
   * Upper bound for the Story cadence member-scan range, ISO-8601.
   * Issue #601.
   */
  memberScanEndIso: string;
  /**
   * Phase-1 candidate-asset lists fetched by the harness's probe step
   * (before warm-up) so phase-2's `$N::inet[]` bind has a value at
   * `buildParams` time. Per-context because phase-1's scan range
   * differs between first-tick and slop-replay. Issue #601.
   */
  r3CandidateAssets?: {
    firstTick: ReadonlyArray<string>;
    slopReplay: ReadonlyArray<string>;
  };
  /**
   * Phase-1 candidate-victim lists for R4 (fan-in), fetched by the
   * harness probe so R4 phase-2's `$N::inet[]` bind has a value at
   * `buildParams` time. Issue #694.
   */
  r4CandidateVictims?: {
    firstTick: ReadonlyArray<string>;
    slopReplay: ReadonlyArray<string>;
  };
  /**
   * Phase-1 candidate-category lists for R5 (campaign), fetched by
   * the harness probe so R5 phase-2's `$N::text[]` bind has a value
   * at `buildParams` time. Issue #694.
   */
  r5CandidateCategories?: {
    firstTick: ReadonlyArray<string>;
    slopReplay: ReadonlyArray<string>;
  };
  /**
   * Phase-1 candidate-asset lists for R6 (persistent low-and-slow),
   * fetched by the harness probe so R6 phase-2's `$N::inet[]` bind has
   * a value at `buildParams` time. Issue #701.
   */
  r6CandidateAssets?: {
    firstTick: ReadonlyArray<string>;
    slopReplay: ReadonlyArray<string>;
  };
  /**
   * Phase-1 candidate-asset lists for R2 (multi-stage low-and-slow),
   * fetched by the harness probe so R2 phase-2's `$N::inet[]` bind has
   * a value at `buildParams` time. Issue #702.
   */
  r2CandidateAssets?: {
    firstTick: ReadonlyArray<string>;
    slopReplay: ReadonlyArray<string>;
  };
}

export interface MeasuredQuery {
  /**
   * Production function name in `src/lib/triage/server-actions.ts` or
   * `src/lib/triage/story/repository.ts`.
   */
  name: string;
  /**
   * Context label per `{ query, context, phase, sampleIndex, ... }`
   * sample-row schema (issue #601). `"default"` is the menu-tab
   * sentinel; cadence entries use `"first-tick"` or `"slop-replay"`.
   */
  context: "default" | "first-tick" | "slop-replay";
  /** SQL text. Shared verbatim with the production caller. */
  sql: string;
  /** Build the `$N` parameter array for `pool.query` from a context. */
  buildParams: (ctx: HarnessContext) => unknown[];
}

export const MEASURED_QUERIES: ReadonlyArray<MeasuredQuery>;
