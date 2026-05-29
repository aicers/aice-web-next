/**
 * Tests for `src/lib/aimer/analysis/summary-client.ts` — the generic
 * browser-side fetcher that is the single place knowing the internal
 * route's wire shape (#653 item 3). The story client and the Phase 2
 * report clients (#646) are thin path-building wrappers over it, so the
 * wire-shape parse + camelCase remap is exercised here once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAiAnalysisSummary } from "@/lib/aimer/analysis/summary-client";

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
  score_kind: "leaf",
  link: "https://aimer.example.com/analysis/story/42/summary",
} as const;

describe("fetchAiAnalysisSummary", () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("remaps a valid 200 body to the camelCase prop shape", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(VALID_BODY));
    const result = await fetchAiAnalysisSummary({ path: "/api/whatever" });
    expect(result).toEqual({
      tier: "CRITICAL",
      href: "https://aimer.example.com/analysis/story/42/summary",
      severityScore: 0.9,
      likelihoodScore: 0.4,
      scoreKind: "leaf",
    });
  });

  it("forwards the caller-supplied path and abort signal to fetch", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(VALID_BODY));
    const signal = new AbortController().signal;
    await fetchAiAnalysisSummary({ path: "/api/analysis/x", signal });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/analysis/x");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      signal,
    });
  });

  it("accepts the aggregate score_kind (Phase 2 report rows, #646)", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ ...VALID_BODY, score_kind: "aggregate" }),
    );
    const result = await fetchAiAnalysisSummary({ path: "/api/whatever" });
    expect(result?.scoreKind).toBe("aggregate");
  });

  it("accepts the HIGH surface tier", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ ...VALID_BODY, priority_tier: "HIGH" }),
    );
    const result = await fetchAiAnalysisSummary({ path: "/api/whatever" });
    expect(result?.tier).toBe("HIGH");
  });

  it("returns null for a 204 No Content", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await fetchAiAnalysisSummary({ path: "/api/whatever" })).toBeNull();
  });

  it("returns null for a non-200 status (e.g. 401 session lapse)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(VALID_BODY, { status: 401 }));
    expect(await fetchAiAnalysisSummary({ path: "/api/whatever" })).toBeNull();
  });

  it("returns null when fetch rejects (network failure / abort)", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    expect(await fetchAiAnalysisSummary({ path: "/api/whatever" })).toBeNull();
  });

  it("returns null for a 200 with an unparseable JSON body", async () => {
    fetchSpy.mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await fetchAiAnalysisSummary({ path: "/api/whatever" })).toBeNull();
  });

  it("returns null for a non-object body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(42));
    expect(await fetchAiAnalysisSummary({ path: "/api/whatever" })).toBeNull();
  });

  it.each([
    ["exists is not true", { exists: false }],
    ["tier below the surface threshold", { priority_tier: "MEDIUM" }],
    ["unknown tier", { priority_tier: "UNKNOWN" }],
    ["empty link", { link: "" }],
    ["non-string link", { link: 123 }],
    ["non-number severity_score", { severity_score: "0.9" }],
    ["non-finite severity_score", { severity_score: Number.POSITIVE_INFINITY }],
    ["non-number likelihood_score", { likelihood_score: null }],
    ["unknown score_kind", { score_kind: "rollup" }],
  ])("returns null when %s", async (_label, overrides) => {
    fetchSpy.mockResolvedValue(jsonResponse({ ...VALID_BODY, ...overrides }));
    expect(await fetchAiAnalysisSummary({ path: "/api/whatever" })).toBeNull();
  });
});
