/**
 * Wire shape returned by the internal AI-analysis summary route
 * (`GET /api/aimer/analysis/story/[customerId]/[storyId]/summary`).
 *
 * The route only emits this body with a `200 OK` when the upstream
 * tier passes the surface threshold (`CRITICAL` or `HIGH`) and the
 * upstream `link` validated as a relative path. Every other
 * "render nothing" case (`204`) is mapped to `null` on the client
 * helper side so badge consumers can treat the value uniformly.
 *
 * `scoreKind` is data, not a branch: badge rendering is identical
 * for `leaf` and `aggregate`. The #646 dashboard surface reuses the
 * same shape with `scoreKind: "aggregate"` rows.
 */
export interface AiAnalysisStorySummary {
  tier: "CRITICAL" | "HIGH";
  /** Absolute aimer-web URL composed and validated server-side. */
  href: string;
  severityScore: number;
  likelihoodScore: number;
  scoreKind: "leaf" | "aggregate";
}
