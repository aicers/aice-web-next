/**
 * Baseline scoring rule for the Triage menu and the cadence persistence
 * — Phase 1.A (discussion #447 §3.2, §3.4 and #481).
 *
 * The rule is intentionally narrow and additive so the menu-side asset
 * sorting and the cadence-side `baseline_triaged_event` INSERT path
 * share one source of truth. Divergence between the two would silently
 * produce different asset orderings for the same dataset.
 *
 *   1. Whitelist score: an event picks up `1.0` if its category is one
 *      of the operator-relevant kill-chain stages.
 *   2. Cluster bonus: an `HttpThreat` event whose `clusterId` is "none"
 *      / empty / a documented sentinel adds `0.5` — these are the rows
 *      REview emits when the upstream model has no cluster assignment,
 *      which often correlate with novel traffic worth surfacing first.
 *
 * Both scores are additive: an unlabeled `HttpThreat` with a
 * non-whitelisted category still passes with score `0.5` (the menu's
 * "unlabeled prioritizes" UX), a whitelisted-category event with a
 * labeled cluster scores `1.0`, and a whitelisted unlabeled
 * `HttpThreat` scores `1.5`. The pass condition is
 * `baselineScore(event) > 0`; `0` rows are dropped from both the menu
 * (sort-key zero collapses to "not triaged") and the cadence corpus.
 *
 * No exclusions, no policies, no persistence. The scoring lives
 * entirely in this file so the deprecatable seam (§6 of #447) keeps
 * the baseline subtree free of any imports from a future policy
 * module.
 */

import type { ThreatCategory } from "@/lib/detection";
import type { TriageEvent } from "./types";

export const TRIAGE_BASELINE_WHITELIST: ReadonlySet<ThreatCategory> = new Set([
  "COMMAND_AND_CONTROL",
  "EXFILTRATION",
  "IMPACT",
  "INITIAL_ACCESS",
  "CREDENTIAL_ACCESS",
]);

const HTTP_THREAT_TYPENAME = "HttpThreat";

/**
 * Phase 1.A whitelist contribution. The cadence's
 * `PHASE_1A_WHITELIST_SCORE` re-exports this same constant so the disk
 * and the in-memory scoring agree on the literal value.
 */
export const PHASE_1A_WHITELIST_SCORE = 1.0;

/**
 * Phase 1.A unlabeled-`HttpThreat` bonus. Re-exported as
 * `PHASE_1A_CLUSTER_NONE_BONUS` from the cadence module.
 */
export const PHASE_1A_CLUSTER_NONE_BONUS = 0.5;

/**
 * `HttpThreat` selector tag stamped on `baseline_triaged_event` rows
 * that picked up the cluster-none bonus. Optional, non-load-bearing
 * for 1B-8 — analysts can use it to filter unlabeled-only rows.
 */
export const PHASE_1A_UNLABELED_BONUS_TAG = "unlabeled-bonus";

/**
 * Heuristic for "the model emitted an HttpThreat with no cluster
 * assignment". REview returns `clusterId: ID!` (non-null) so the
 * sentinel is encoded as a value rather than as `null`. Treat the
 * empty string and the literal tokens `"none"` / `"null"` (the
 * two known upstream conventions) as the no-cluster signal.
 */
export function isClusterNone(clusterId: string | null | undefined): boolean {
  if (clusterId === null || clusterId === undefined) return true;
  const trimmed = clusterId.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  return lower === "none" || lower === "null";
}

/**
 * Compute the baseline score for one event. Returns the additive sum
 * of the whitelist contribution and the cluster-none bonus. The set of
 * possible non-zero values is `{0.5, 1.0, 1.5}`; `0` means the event
 * does not pass the baseline rule (and is dropped from both the menu
 * and the cadence corpus).
 */
export function baselineScore(event: TriageEvent): number {
  let score = 0;
  const category = event.category;
  if (category !== null && TRIAGE_BASELINE_WHITELIST.has(category)) {
    score += PHASE_1A_WHITELIST_SCORE;
  }
  if (
    event.__typename === HTTP_THREAT_TYPENAME &&
    isClusterNone(event.clusterId)
  ) {
    score += PHASE_1A_CLUSTER_NONE_BONUS;
  }
  return score;
}

/**
 * `true` when the event passes the baseline rule (i.e. its score is
 * non-zero). Used by the funnel denominator, the asset `triagedCount`
 * field, and the cadence's step (e) gate.
 */
export function passesBaseline(event: TriageEvent): boolean {
  return baselineScore(event) > 0;
}

/**
 * `true` when the event picked up the unlabeled-`HttpThreat` bonus.
 * Cadence appends `PHASE_1A_UNLABELED_BONUS_TAG` to `selector_tags`
 * for these rows so analysts can filter on the marker; the menu
 * uses the same predicate for the "unlabeled prioritizes" affordance.
 */
export function hasUnlabeledBonus(event: TriageEvent): boolean {
  return (
    event.__typename === HTTP_THREAT_TYPENAME && isClusterNone(event.clusterId)
  );
}
