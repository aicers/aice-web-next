import { fetchAiAnalysisSummary } from "./summary-client";
import type { AiAnalysisSummary } from "./summary-types";

/**
 * Phase 2 report-surface wrappers around the generic
 * {@link fetchAiAnalysisSummary} (#646, #653). Build the LIVE / DAILY
 * internal route paths and delegate the fetch + wire-shape parse to the
 * generic client so the wire shape lives in exactly one place — the
 * same thin-wrapper shape as `story-summary.client.ts`.
 *
 * Both return `null` for every "render nothing" case (204, non-200,
 * network failure, malformed body) — see {@link fetchAiAnalysisSummary}.
 * The dashboard cards drop a `null` straight into "no card".
 */

/**
 * Fetch the LIVE (latest digest) summary for a customer. The internal
 * route pins the upstream bucket to the `1970-01-01` sentinel, so the
 * client carries no date.
 */
export async function fetchAiAnalysisLiveSummary(args: {
  customerId: number;
  signal?: AbortSignal;
}): Promise<AiAnalysisSummary | null> {
  const path = `/api/aimer/analysis/reports/live/${args.customerId}/summary`;
  return fetchAiAnalysisSummary({ path, signal: args.signal });
}

/**
 * Fetch the DAILY (today's report) summary for a customer on a given
 * calendar `date` (`YYYY-MM-DD`, derived from the viewer's timezone).
 * The route re-validates the date with a strict calendar check before
 * any upstream call, so a malformed value resolves to `null` here via
 * the route's local `400`.
 */
export async function fetchAiAnalysisDailySummary(args: {
  customerId: number;
  date: string;
  signal?: AbortSignal;
}): Promise<AiAnalysisSummary | null> {
  const path = `/api/aimer/analysis/reports/daily/${args.customerId}/${encodeURIComponent(args.date)}/summary`;
  return fetchAiAnalysisSummary({ path, signal: args.signal });
}

export type AiAnalysisLiveSummaryFetcher = (args: {
  customerId: number;
  signal?: AbortSignal;
}) => Promise<AiAnalysisSummary | null>;

export type AiAnalysisDailySummaryFetcher = (args: {
  customerId: number;
  date: string;
  signal?: AbortSignal;
}) => Promise<AiAnalysisSummary | null>;
