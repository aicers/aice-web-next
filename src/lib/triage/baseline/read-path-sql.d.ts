// Type declarations for `read-path-sql.mjs`. Authored as a sibling
// `.d.ts` so the production caller and tests get IDE / typecheck
// signal without forcing the runtime module through a transpile step.

export const MENU_CANDIDATES_PER_BUCKET: 500;
export const TRIAGE_ASSET_DETAIL_LIMIT: 50;

export const SELECT_MENU_COHORT_SQL: string;
export const COUNT_OBSERVED_SQL: string;
export const COUNT_TRIAGED_SQL: string;
export const PER_ASSET_OBSERVED_COUNTS_SQL: string;
export const SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL: string;

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
   * Strictness slider cutoff fed to the menu cohort SELECT (#471).
   * Optional so existing harness callers default to the pre-slider
   * behavior (`0`, no additional cutoff above the cadence threshold).
   */
  menuCutoff?: number;
}

export interface MeasuredQuery {
  /** Production function name in `src/lib/triage/server-actions.ts`. */
  name: string;
  /** SQL text. Shared verbatim with the production caller. */
  sql: string;
  /** Build the `$N` parameter array for `pool.query` from a context. */
  buildParams: (ctx: HarnessContext) => unknown[];
}

export const MEASURED_QUERIES: ReadonlyArray<MeasuredQuery>;
