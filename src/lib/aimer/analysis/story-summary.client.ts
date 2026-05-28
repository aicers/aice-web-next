import type { AiAnalysisStorySummary } from "./summary-types";

/**
 * Browser-side helper for the AI-analysis summary route
 * (#645). Returns `null` for every "render nothing" case so the
 * caller can drop the result straight into the badge prop without
 * extra branching:
 *
 * - `204 No Content` from the internal route — integration
 *   unconfigured, upstream missing / `exists: false`, tier `LOW` /
 *   `MEDIUM`, malformed `link`, upstream fetch error.
 * - `401` (session lapsed) or any other non-`200` status.
 * - Network failure / abort.
 * - Malformed `200` body (defensive — the server validates already).
 */
export async function fetchAiAnalysisStorySummary(args: {
  customerId: number;
  storyId: string;
  signal?: AbortSignal;
}): Promise<AiAnalysisStorySummary | null> {
  const url = `/api/aimer/analysis/story/${args.customerId}/${encodeURIComponent(args.storyId)}/summary`;
  let response: Response;
  try {
    response = await fetch(url, {
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
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  // Wire shape matches the issue's "Internal route response contract"
  // (#645): `{ exists, priority_tier, severity_score,
  // likelihood_score, score_kind, link }`. The badge component prop
  // shape uses camelCase, so we remap once here.
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

export type AiAnalysisStorySummaryFetcher = (args: {
  customerId: number;
  storyId: string;
  signal?: AbortSignal;
}) => Promise<AiAnalysisStorySummary | null>;
