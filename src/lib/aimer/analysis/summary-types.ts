/**
 * Wire-derived shape of an AI-analysis summary surfaced by the internal
 * analysis routes (`GET /api/aimer/analysis/.../summary`).
 *
 * The route only emits this body with a `200 OK` when the upstream tier
 * passes the surface threshold (`CRITICAL` or `HIGH`) and the upstream
 * `link` validated as a relative path. Every other "render nothing" case
 * (`204`) is mapped to `null` on the client helper side so badge
 * consumers can treat the value uniformly.
 *
 * `scoreKind` is data, not a branch: badge rendering is identical for
 * `leaf` and `aggregate`. The Phase 2 dashboard surface (#646) reuses the
 * same shape with `scoreKind: "aggregate"` rows — the type, the read
 * client, and the route-side composition are deliberately generic so the
 * report surfaces do not re-declare any of them (#653).
 */
export interface AiAnalysisSummary {
  tier: "CRITICAL" | "HIGH";
  /** Absolute aimer-web URL composed and validated server-side. */
  href: string;
  severityScore: number;
  likelihoodScore: number;
  scoreKind: "leaf" | "aggregate";
}
