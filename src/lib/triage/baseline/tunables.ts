/**
 * Phase 1.B tunable parameters (RFC 0001 §9).
 *
 * Calibrated values from ops review on representative tenant data
 * (PR 2 / #513). The selector weights, saturation caps, tag thresholds,
 * and final-count tunables below are the values cadence writes against
 * `baseline_version = "phase1b-four-selector"`.
 *
 * Changing any value here changes the algorithm contract and must be
 * paired with a `baseline_version` bump (§10) so prior-version rows
 * keep their per-cohort `CUME_DIST` ranking instead of being silently
 * compared on the new scale.
 */

/**
 * Selector weights for the §3 additive score
 * (`raw_score = Σ w_S · s_S`).
 */
export const SELECTOR_WEIGHTS = {
  /** S1 within-kind percentile-rank confidence weight. */
  w_S1: 1.0,
  /** S2 severe-category weight. */
  w_S2: 1.5,
  /** S3 recurring asset-pair weight. */
  w_S3: 0.8,
  /** S4 correlated-categories weight. */
  w_S4: 0.8,
  /** UNLABELED_BONUS weight. */
  w_UNLABELED: 0.5,
} as const;

/**
 * Saturation caps for the recurring (S3) and correlated (S4) selectors.
 * S1 needs no cap (already a percentile rank in `[0, 1]`); S2 and
 * `UNLABELED_BONUS` are binary.
 */
export const SELECTOR_SATURATION = {
  /** S3 saturation cap — additional repeats past which s3 stays at 1.0. */
  R: 10,
  /** S4 saturation cap — additional categories past which s4 stays at 1.0. */
  C: 4,
} as const;

/**
 * Maximum distinct selector tags the cadence can emit. Denominator for
 * the §4 `normalized_top_confidence` average. The five Phase 1.B tags
 * are `S1-high`, `S2-severe`, `S3-recurring`, `S4-correlated`,
 * `unlabeled-cluster`. Adding a future tag bumps `MAX_TAGS` and forces a
 * `baseline_version` bump (§10).
 */
export const MAX_TAGS = 5;

/**
 * Per-event "fired meaningfully" thresholds (§9, RFC §12 OQ5). A selector
 * value above its threshold emits the corresponding tag; the tag set
 * feeds the read-time `normalized_top_confidence` denominator (§4) so
 * the thresholds are part of `baseline_version`.
 *
 * S2 and `unlabeled` are binary — they emit their tag whenever the
 * selector value is `1`, which is equivalent to a threshold of `0`.
 */
export const TAG_THRESHOLDS = {
  /** S1 tag emitted when the within-kind percentile rank exceeds this. */
  s1_high: 0.85,
  /** S3 tag emitted when the (orig, resp, kind) repeat ratio exceeds this. */
  s3_recurring: 0.5,
  /** S4 tag emitted when the (orig, kind) correlated ratio exceeds this. */
  s4_correlated: 0.5,
} as const;

/**
 * The five distinct selector-tag names the cadence emits. Order is
 * stable and matches `MAX_TAGS = 5`. Any addition here is a
 * `baseline_version`-bumping change (§10).
 */
export const SELECTOR_TAGS = {
  S1_HIGH: "S1-high",
  S2_SEVERE: "S2-severe",
  S3_RECURRING: "S3-recurring",
  S4_CORRELATED: "S4-correlated",
  UNLABELED_CLUSTER: "unlabeled-cluster",
} as const;

/**
 * Slot allocation tunables (§4).
 */
export const SLOT_ALLOCATION = {
  /** Floor share per bucket. */
  base_share: 0.02,
  /** Volume × signal-richness coefficient. */
  alpha: 1.0,
  /** Favored-kind constant bonus. */
  beta: 0.1,
} as const;

/**
 * Final-count curve tunables (§6). `default_N` is the cognitive-limit
 * cap; `MIN_NONZERO_FLOOR` is the fallback floor when post-exclusion > 0
 * but the assembly path produces zero rows.
 *
 * Invariant enforced at ops calibration:
 *   `MIN_NONZERO_FLOOR ≤ LOWER_FLOOR ≤ default_N`.
 */
export const FINAL_COUNT = {
  /** Minimum `default_N` for any non-empty corpus at the neutral dial. */
  LOWER_FLOOR: 20,
  /** log10 coefficient on post-exclusion volume. */
  scale: 30,
  /** Minimum `final_count` when post-exclusion > 0. */
  MIN_NONZERO_FLOOR: 1,
} as const;

/**
 * Statistics windows from §7. Per-selector value across the active
 * windows is combined via `max`; pre-activation windows contribute `0`.
 * Days are wall-clock; activation derives from elapsed time since the
 * cadence's first successful page commit
 * (`baseline_corpus_state.corpus_activated_at`), not the age of the
 * oldest event in the corpus — historical catch-up events would
 * otherwise activate windows whose corpus is still partial.
 */
export const STATISTICS_WINDOW_DAYS = [7, 14, 30] as const;
export type StatisticsWindowDays = (typeof STATISTICS_WINDOW_DAYS)[number];
