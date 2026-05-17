/**
 * Phase 2 engagement tunables (RFC 0003 §9.3 / §12).
 *
 * Parallel to {@link ./tunables.ts}. The first-ship values below are
 * substrate-informed conservative defaults from RFC §12 — derived from
 * a 30-day / 200,000-row snapshot of the test-clumit
 * `customer_customer_a_8983d4` corpus (captured 2026-05-16), not from
 * observed engagement data. The calibration retune (RFC §11 / §13
 * Phase 2b) replaces them after #588 has run in production for ≥ 14
 * days across ≥ 2 tenants with human-analyst traffic.
 *
 * **Kill-switch.** `gamma = 0` means the engagement term in the slot-
 * share formula (RFC §4) multiplies to zero and §5.4's exploration
 * carve-out is skipped (gated on `γ > 0`). With these defaults menu
 * output is byte-identical to RFC 0001 — the implementation, snapshot,
 * and audit substrate exist in production but the menu does not
 * change. The bump to `γ > 0` is Phase 2b.
 *
 * **Drift guard.** {@link
 * src/__tests__/lib/triage/baseline/engagement-tunables-drift.test.ts}
 * asserts that every value here matches the inlined copy in
 * `compose.mjs` (the algorithm's actual source-of-truth) and the
 * `engagement_model_snapshot` row keyed on `engagementModelVersion`.
 */

import type {
  EngagementActionType,
  EngagementShownBy,
} from "../engagement/types";

export const ENGAGEMENT_TUNABLES = {
  /** RFC §4. Engagement-term coefficient. `0` = kill-switch off. */
  gamma: 0,
  /**
   * RFC §5.2. Minimum raw impression count per bucket before the
   * engagement term contributes to that bucket. The gate is against
   * `COUNT(*)`, NOT the EWMA-weighted denominator — a bucket with 200
   * raw impressions all 30+ days old has weighted_imp near zero but
   * is not statistically thin in the way `N_min` is meant to detect.
   */
  perBucketMinImpressions: 100,
  /**
   * RFC §5.3. Half-life as a fraction of the active window
   * (W * ratio). 0.5 keeps the effective sample size near half the
   * window.
   */
  ewmaHalfLifeWindowRatio: 0.5,
  /**
   * RFC §5.4. Fraction of `default_N` reserved for bottom-decile
   * engagement buckets. Inert while `gamma === 0` per the §5.4 gate:
   * exploration is gated on the engagement term being live, so the
   * `γ = 0` first ship preserves the full `default_N` budget for
   * `computeBucketQuotas`.
   */
  explorationShare: 0.1,
  /**
   * RFC §6. Tenant-level cold-start floor — minimum total raw
   * impressions (across all buckets, 30d) before the engagement term
   * activates for the tenant. Per RFC §6 the gate is against raw
   * `COUNT(*)`, not the EWMA-weighted sum.
   */
  tenantColdStartMinImpressions: 1000,
  /**
   * RFC §2.3. Impression `shown_by` values included in numerator and
   * denominator (symmetric exclusion keeps the rate definitionally
   * honest). v1 is the most-conservative filter.
   */
  includedShownBy: ["quota"] as ReadonlyArray<EngagementShownBy>,
  /**
   * RFC §2.1 + §10.1 decision (a). Action types that count as a
   * positive engagement signal. Per RFC §10.1, `story_pivot_click` is
   * counted equally with `pivot_click` for v1.
   */
  engagedActions: [
    "pivot_click",
    "story_pivot_click",
  ] as ReadonlyArray<EngagementActionType>,
  /** RFC §3. Concurrent active windows (days). */
  activeWindowsDays: [7, 14, 30] as ReadonlyArray<number>,
  /**
   * RFC §8.1. Bumped on any change to the formula (§4), guardrails
   * (§5), cold-start (§6), window-selection rule (§3), or aggregate
   * SQL shape (§7). Phase 2a stamps `'phase2-v1'` on every impression
   * for audit; no `baseline_version` bump accompanies this version
   * because the engagement term is inert (`gamma = 0`) per amended
   * RFC §8.1 / §13.
   */
  engagementModelVersion: "phase2-v1",
} as const;

export type EngagementTunables = typeof ENGAGEMENT_TUNABLES;
