/**
 * Tests for `src/lib/aimer/analysis/report-summary.client.ts` — the LIVE
 * / DAILY thin path-building wrappers over the generic
 * `fetchAiAnalysisSummary` (#646). The wire-shape parse is covered by
 * `summary-client.test.ts`; here we pin only the internal route paths
 * each wrapper builds (and the DAILY date encoding).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAiAnalysisDailySummary,
  fetchAiAnalysisLiveSummary,
} from "@/lib/aimer/analysis/report-summary.client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const VALID_BODY = {
  exists: true,
  priority_tier: "CRITICAL",
  severity_score: 0.9,
  likelihood_score: 0.4,
  score_kind: "aggregate",
  link: "https://aimer.example.com/customers/acme/analysis/reports/LIVE/1970-01-01",
} as const;

describe("report summary clients", () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchAiAnalysisLiveSummary targets the LIVE internal route", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(VALID_BODY));
    const result = await fetchAiAnalysisLiveSummary({ customerId: 42 });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/aimer/analysis/reports/live/42/summary");
    expect(result?.scoreKind).toBe("aggregate");
  });

  it("fetchAiAnalysisDailySummary targets the DAILY internal route with the date segment", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(VALID_BODY));
    await fetchAiAnalysisDailySummary({ customerId: 7, date: "2026-05-30" });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/aimer/analysis/reports/daily/7/2026-05-30/summary");
  });

  it("forwards the abort signal", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(VALID_BODY));
    const signal = new AbortController().signal;
    await fetchAiAnalysisLiveSummary({ customerId: 1, signal });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).signal).toBe(signal);
  });

  it("maps a 204 to null (no card)", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    expect(
      await fetchAiAnalysisDailySummary({ customerId: 1, date: "2026-05-30" }),
    ).toBeNull();
  });
});
