/**
 * Baseline scoring rule for the Triage menu — Phase 1.A
 * (discussion #447 §3.2).
 *
 * The rule is intentionally narrow:
 *   1. Category whitelist: an event scores 1.0 only if its category
 *      is one of the operator-relevant kill-chain stages.
 *   2. Cluster bonus: an `HttpThreat` event whose `clusterId` is
 *      "none" / empty / a documented sentinel adds 0.5 — these are
 *      the rows REview emits when the upstream model has no cluster
 *      assignment, which often correlate with novel traffic worth
 *      surfacing first.
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
const CLUSTER_NONE_BONUS = 0.5;
const WHITELIST_SCORE = 1;

/**
 * Heuristic for "the model emitted an HttpThreat with no cluster
 * assignment". REview returns `clusterId: ID!` (non-null) so the
 * sentinel is encoded as a value rather than as `null`. Treat the
 * empty string and the literal tokens `"none"` / `"null"` (the
 * two known upstream conventions) as the no-cluster signal.
 */
function isClusterNone(clusterId: string | null | undefined): boolean {
  if (clusterId === null || clusterId === undefined) return true;
  const trimmed = clusterId.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  return lower === "none" || lower === "null";
}

/**
 * Compute the baseline score for one event. Returns `0` for events
 * that do not pass the category whitelist; the caller treats `0`
 * as "not triaged".
 */
export function baselineScore(event: TriageEvent): number {
  const category = event.category;
  if (category === null || !TRIAGE_BASELINE_WHITELIST.has(category)) {
    return 0;
  }
  let score = WHITELIST_SCORE;
  if (
    event.__typename === HTTP_THREAT_TYPENAME &&
    isClusterNone(event.clusterId)
  ) {
    score += CLUSTER_NONE_BONUS;
  }
  return score;
}

/**
 * `true` when the event passes the baseline whitelist (i.e. its
 * score is non-zero). Used by the funnel denominator and the asset
 * `triagedCount` field.
 */
export function passesBaseline(event: TriageEvent): boolean {
  return baselineScore(event) > 0;
}
