import type { AiAnalysisSummary } from "./summary-types";

/**
 * Browser-side helper for the AI-analysis summary routes (#645, #653).
 *
 * Generic over the internal endpoint `path` so every analysis summary
 * surface — the Stories deep-link badge and the Phase 2 dashboard cards
 * (#646: `/api/aimer/analysis/reports/live/{customerId}/summary`,
 * `/api/aimer/analysis/reports/daily/{customerId}/{date}/summary`) —
 * shares a single wire-shape parser. This module is the *only* place
 * that knows the wire shape; surface-specific clients (e.g.
 * `story-summary.client.ts`) are thin wrappers that build the path and
 * delegate here.
 *
 * Returns `null` for every "render nothing" case so the caller can drop
 * the result straight into the badge prop without extra branching:
 *
 * - `204 No Content` from the internal route — integration unconfigured,
 *   upstream missing / `exists: false`, tier `LOW` / `MEDIUM`, malformed
 *   `link`, upstream fetch error.
 * - `401` (session lapsed) or any other non-`200` status.
 * - Network failure / abort.
 * - Malformed `200` body (defensive — the server validates already).
 */
export async function fetchAiAnalysisSummary(args: {
  path: string;
  signal?: AbortSignal;
}): Promise<AiAnalysisSummary | null> {
  let response: Response;
  try {
    response = await fetch(args.path, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: args.signal,
    });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return parseAiAnalysisSummary(body);
}

/**
 * Remap the internal route's wire body — `{ exists, priority_tier,
 * severity_score, likelihood_score, score_kind, link }` (#645 "Internal
 * route response contract") — to the camelCase {@link AiAnalysisSummary}
 * prop shape. Returns `null` for any body that is not a renderable
 * positive hit.
 */
function parseAiAnalysisSummary(body: unknown): AiAnalysisSummary | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  if (candidate.exists !== true) return null;
  const tier = candidate.priority_tier;
  const href = candidate.link;
  const severityScore = candidate.severity_score;
  const likelihoodScore = candidate.likelihood_score;
  const scoreKind = candidate.score_kind;
  if (tier !== "CRITICAL" && tier !== "HIGH") return null;
  if (typeof href !== "string" || href.length === 0) return null;
  if (typeof severityScore !== "number" || !Number.isFinite(severityScore)) {
    return null;
  }
  if (
    typeof likelihoodScore !== "number" ||
    !Number.isFinite(likelihoodScore)
  ) {
    return null;
  }
  if (scoreKind !== "leaf" && scoreKind !== "aggregate") return null;
  return {
    tier,
    href,
    severityScore,
    likelihoodScore,
    scoreKind,
  };
}

/**
 * Generic fetcher seam. Surface-specific fetcher types (e.g.
 * `AiAnalysisStorySummaryFetcher`) narrow the argument shape but resolve
 * to the same {@link AiAnalysisSummary}.
 */
export type AiAnalysisSummaryFetcher = (args: {
  path: string;
  signal?: AbortSignal;
}) => Promise<AiAnalysisSummary | null>;
