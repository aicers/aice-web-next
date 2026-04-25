import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type { Filter } from "@/lib/detection";

const mockGetCurrentSession = vi.hoisted(() => vi.fn());

const mockCountByCategory = vi.hoisted(() => vi.fn());
const mockCountByLevel = vi.hoisted(() => vi.fn());
const mockCountByCountry = vi.hoisted(() => vi.fn());
const mockCountByKind = vi.hoisted(() => vi.fn());
const mockCountByOriginatorIp = vi.hoisted(() => vi.fn());
const mockCountByResponderIp = vi.hoisted(() => vi.fn());
const mockEventFrequencySeries = vi.hoisted(() => vi.fn());

class MockDetectionUnauthorizedError extends Error {}

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

// We re-export the real helpers (filter conversion + period heuristic
// + dimension vocabulary) and replace only the network-touching server
// actions, so the wrapper's routing + period derivation are exercised
// against the real implementations.
vi.mock("@/lib/detection", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/detection")>("@/lib/detection");
  return {
    ...actual,
    DetectionUnauthorizedError: MockDetectionUnauthorizedError,
    countEventsByCategory: mockCountByCategory,
    countEventsByLevel: mockCountByLevel,
    countEventsByCountry: mockCountByCountry,
    countEventsByKind: mockCountByKind,
    countEventsByOriginatorIpAddress: mockCountByOriginatorIp,
    countEventsByResponderIpAddress: mockCountByResponderIp,
    eventFrequencySeries: mockEventFrequencySeries,
  };
});

const SESSION = {
  accountId: "account-1",
  sessionId: "session-1",
  roles: ["Security Monitor"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: 0,
  exp: 0,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "test",
  sessionBrowserFingerprint: "test",
  needsReauth: false,
  sessionCreatedAt: new Date(0),
  sessionLastActiveAt: new Date(0),
} as AuthSession;

const STRUCTURED_FILTER: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-22T00:00:00Z",
    end: "2026-04-22T01:00:00Z",
  },
};

describe("runAnalyticsQuery", () => {
  beforeEach(() => {
    mockGetCurrentSession.mockReset();
    mockCountByCategory.mockReset();
    mockCountByLevel.mockReset();
    mockCountByCountry.mockReset();
    mockCountByKind.mockReset();
    mockCountByOriginatorIp.mockReset();
    mockCountByResponderIp.mockReset();
    mockEventFrequencySeries.mockReset();
  });

  it("rejects an unauthenticated caller without dispatching either query", async () => {
    mockGetCurrentSession.mockResolvedValue(null);

    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const result = await runAnalyticsQuery(STRUCTURED_FILTER, "srcIp", 10);
    expect(result).toEqual({ ok: false, code: "unauthenticated" });
    expect(mockCountByOriginatorIp).not.toHaveBeenCalled();
    expect(mockEventFrequencySeries).not.toHaveBeenCalled();
  });

  // Reviewer Round 1 (P2 server-side trust): the server action must
  // not pass crafted client payloads through to REview. The TypeScript
  // narrowing on the client only constrains the `select` widgets'
  // values — nothing stops a forged action POST from sending
  // `dimension: "totallyNot"` or `topN: 5_000`. The action must
  // reject anything outside the documented vocabulary before it
  // reaches the GraphQL layer.
  it("rejects an out-of-vocabulary dimension before authenticating or dispatching", async () => {
    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const result = await runAnalyticsQuery(
      STRUCTURED_FILTER,
      "totallyNotADimension" as unknown as "srcIp",
      10,
    );
    expect(result).toEqual({ ok: false, code: "invalid-input" });
    expect(mockGetCurrentSession).not.toHaveBeenCalled();
    expect(mockCountByOriginatorIp).not.toHaveBeenCalled();
    expect(mockEventFrequencySeries).not.toHaveBeenCalled();
  });

  it("rejects an out-of-vocabulary topN value before authenticating or dispatching", async () => {
    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const result = await runAnalyticsQuery(
      STRUCTURED_FILTER,
      "srcIp",
      5_000 as unknown as 10,
    );
    expect(result).toEqual({ ok: false, code: "invalid-input" });
    expect(mockGetCurrentSession).not.toHaveBeenCalled();
    expect(mockCountByOriginatorIp).not.toHaveBeenCalled();
    expect(mockEventFrequencySeries).not.toHaveBeenCalled();
  });

  describe.each([
    ["srcIp", "mockCountByOriginatorIp"],
    ["dstIp", "mockCountByResponderIp"],
    ["country", "mockCountByCountry"],
    ["category", "mockCountByCategory"],
    ["level", "mockCountByLevel"],
    ["kind", "mockCountByKind"],
  ] as const)("dispatches %s to the matching counter", (dim, mockName) => {
    it("forwards the filter, topN, and period derived from the filter", async () => {
      mockGetCurrentSession.mockResolvedValue(SESSION);
      mockCountByCategory.mockResolvedValue({ values: [1], counts: [1] });
      mockCountByLevel.mockResolvedValue({ values: [1], counts: [1] });
      mockCountByCountry.mockResolvedValue({ values: ["KR"], counts: [1] });
      mockCountByKind.mockResolvedValue({
        values: ["HttpThreat"],
        counts: [1],
      });
      mockCountByOriginatorIp.mockResolvedValue({
        values: ["10.0.0.1"],
        counts: [1],
      });
      mockCountByResponderIp.mockResolvedValue({
        values: ["10.0.0.2"],
        counts: [1],
      });
      mockEventFrequencySeries.mockResolvedValue([3, 5, 7]);

      const { runAnalyticsQuery } = await import(
        "@/app/[locale]/(dashboard)/detection/analytics-actions"
      );

      const result = await runAnalyticsQuery(STRUCTURED_FILTER, dim, 5);
      expect(result.ok).toBe(true);

      // Verify only the dimension-specific counter ran.
      const counters = {
        mockCountByOriginatorIp,
        mockCountByResponderIp,
        mockCountByCountry,
        mockCountByCategory,
        mockCountByLevel,
        mockCountByKind,
      };
      for (const [key, fn] of Object.entries(counters)) {
        if (key === mockName) {
          expect(fn).toHaveBeenCalledTimes(1);
          expect(fn).toHaveBeenCalledWith(SESSION, STRUCTURED_FILTER, 5);
        } else {
          expect(fn).not.toHaveBeenCalled();
        }
      }

      // 1h window → 60s buckets per the period heuristic.
      expect(mockEventFrequencySeries).toHaveBeenCalledTimes(1);
      expect(mockEventFrequencySeries).toHaveBeenCalledWith(
        SESSION,
        STRUCTURED_FILTER,
        60,
      );
    });
  });

  it("maps the resolved counter and series payloads onto the OK shape", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockCountByOriginatorIp.mockResolvedValue({
      values: ["10.0.0.1", "10.0.0.2"],
      counts: [9, 4],
    });
    mockEventFrequencySeries.mockResolvedValue([1, 2, 3]);

    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const result = await runAnalyticsQuery(STRUCTURED_FILTER, "srcIp", 10);
    expect(result).toEqual({
      ok: true,
      dimension: "srcIp",
      topN: { values: ["10.0.0.1", "10.0.0.2"], counts: [9, 4] },
      series: [1, 2, 3],
      periodSeconds: 60,
      rangeStart: "2026-04-22T00:00:00Z",
      rangeEnd: "2026-04-22T01:00:00Z",
    });
  });

  it("stringifies numeric values from level / category counters", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockCountByLevel.mockResolvedValue({
      values: [1, 2, 3],
      counts: [9, 4, 1],
    });
    mockEventFrequencySeries.mockResolvedValue([]);

    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const result = await runAnalyticsQuery(STRUCTURED_FILTER, "level", 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.topN.values).toEqual(["1", "2", "3"]);
      expect(result.topN.counts).toEqual([9, 4, 1]);
    }
  });

  it("falls back to the 60s floor for query-mode filters and reports null bounds", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockCountByOriginatorIp.mockResolvedValue({ values: [], counts: [] });
    mockEventFrequencySeries.mockResolvedValue([]);

    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const queryFilter: Filter = { mode: "query", text: "alpha" };
    const result = await runAnalyticsQuery(queryFilter, "srcIp", 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.periodSeconds).toBe(60);
      expect(result.rangeStart).toBeNull();
      expect(result.rangeEnd).toBeNull();
    }
    // Period derivation kicks in even when the filter has no time range:
    // we fall back to the smallest tier rather than skipping the call.
    expect(mockEventFrequencySeries).toHaveBeenCalledWith(
      SESSION,
      queryFilter,
      60,
    );
  });

  it("maps DetectionUnauthorizedError to `forbidden`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockCountByOriginatorIp.mockRejectedValue(
      new MockDetectionUnauthorizedError("nope"),
    );
    mockEventFrequencySeries.mockResolvedValue([]);

    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const result = await runAnalyticsQuery(STRUCTURED_FILTER, "srcIp", 10);
    expect(result).toEqual({ ok: false, code: "forbidden" });
  });

  it("maps any other error to `server-error`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockCountByOriginatorIp.mockResolvedValue({ values: [], counts: [] });
    mockEventFrequencySeries.mockRejectedValue(new Error("boom"));

    const { runAnalyticsQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/analytics-actions"
    );

    const result = await runAnalyticsQuery(STRUCTURED_FILTER, "srcIp", 10);
    expect(result).toEqual({ ok: false, code: "server-error" });
  });
});
