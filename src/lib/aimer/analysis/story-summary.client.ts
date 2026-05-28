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
  const tier = candidate.tier;
  const href = candidate.href;
  const severityScore = candidate.severityScore;
  const likelihoodScore = candidate.likelihoodScore;
  const scoreKind = candidate.scoreKind;
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
