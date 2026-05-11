/**
 * Phase 1.B tunable parameters (RFC 0001 §9).
 *
 * All values below are the **provisional** starting points from the RFC.
 * Final calibration happens on a representative tenant DB with ops
 * review before PR 2 (`baseline_version = "phase1b-four-selector"`)
 * merges; tuning post-merge is via a `baseline_version` bump (§10).
 *
 * This module is intentionally **not yet referenced** by any code path
 * in PR 1 — the cadence still uses the Phase 1.A additive rule from
 * `src/lib/triage/scoring.ts`. PR 2 wires these constants into the
 * four-selector scoring (§3), slot allocator (§4), and final count
 * curve (§6).
 *
 * Why it ships as a skeleton in PR 1:
 *   * Adding the module ahead of PR 2 keeps the §9 audit trail co-located
 *     with `categories.ts` and the cadence module so reviewers see the
 *     algorithm shape before the wiring lands.
 *   * The names freeze the §9 vocabulary used by upcoming PRs; any later
 *     rename would require a `baseline_version` bump.
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
