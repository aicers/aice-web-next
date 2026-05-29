import { fetchAiAnalysisSummary } from "./summary-client";
import type { AiAnalysisSummary } from "./summary-types";

/**
 * Story-surface wrapper around the generic {@link fetchAiAnalysisSummary}
 * (#645, #653). Builds the story-scoped internal route path and delegates
 * the fetch + wire-shape parse to the generic client so the wire shape
 * lives in exactly one place. The Phase 2 report cards (#646) add their
 * own equally-thin wrappers over the same generic client.
 *
 * Returns `null` for every "render nothing" case (204, non-200, network
 * failure, malformed body) — see {@link fetchAiAnalysisSummary}.
 */
export async function fetchAiAnalysisStorySummary(args: {
  customerId: number;
  storyId: string;
  signal?: AbortSignal;
}): Promise<AiAnalysisSummary | null> {
  const path = `/api/aimer/analysis/story/${args.customerId}/${encodeURIComponent(args.storyId)}/summary`;
  return fetchAiAnalysisSummary({ path, signal: args.signal });
}

export type AiAnalysisStorySummaryFetcher = (args: {
  customerId: number;
  storyId: string;
  signal?: AbortSignal;
}) => Promise<AiAnalysisSummary | null>;
