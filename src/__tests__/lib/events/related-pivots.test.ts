import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type { RelatedPivotAnchor } from "@/lib/events/related-pivots";

const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockSearchEvents = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("@/lib/detection", () => ({
  searchEvents: mockSearchEvents,
}));

const SESSION: AuthSession = {
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
};

const ANCHOR: RelatedPivotAnchor = {
  time: "2026-04-22T10:00:00.000Z",
  kind: "HttpThreat",
  origAddr: "10.0.0.5",
  respAddr: "203.0.113.45",
};

beforeEach(() => {
  mockGetCurrentSession.mockReset();
  mockSearchEvents.mockReset();
  vi.resetModules();
});

describe("fetchRelatedPivotSummaries", () => {
  it("returns empty summaries when there is no session", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    const { fetchRelatedPivotSummaries } = await import(
      "@/lib/events/related-pivots"
    );

    const result = await fetchRelatedPivotSummaries(ANCHOR);
    expect(result).toEqual([
      { id: "same-source", count: "0", lastTime: null },
      { id: "same-destination", count: "0", lastTime: null },
      { id: "same-kind", count: "0", lastTime: null },
      { id: "same-session", count: "0", lastTime: null },
    ]);
    expect(mockSearchEvents).not.toHaveBeenCalled();
  });

  it("dispatches one filter per pivot with a window anchored on the event time", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockSearchEvents.mockImplementation(
      async (
        _session: AuthSession,
        filter: { input: Record<string, unknown> },
      ) => ({
        nodes: [
          {
            __typename: "HttpThreat",
            time: filter.input.start as string,
            sensor: "sensor-1",
            confidence: 0.8,
            level: "HIGH",
            triageScores: null,
            category: null,
          },
        ],
        edges: [],
        totalCount: "5",
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
      }),
    );

    const { fetchRelatedPivotSummaries } = await import(
      "@/lib/events/related-pivots"
    );

    const result = await fetchRelatedPivotSummaries(ANCHOR);

    expect(mockSearchEvents).toHaveBeenCalledTimes(4);
    const [, sameSourceFilter] = mockSearchEvents.mock.calls[0];
    expect(sameSourceFilter.mode).toBe("structured");
    expect(sameSourceFilter.input.source).toBe("10.0.0.5");
    expect(sameSourceFilter.input.end).toBe(ANCHOR.time);
    expect(new Date(sameSourceFilter.input.start).getTime()).toBe(
      new Date(ANCHOR.time).getTime() - 24 * 60 * 60 * 1000,
    );

    const sameKind = mockSearchEvents.mock.calls[2][1];
    expect(sameKind.input.kinds).toEqual(["HttpThreat"]);
    expect(new Date(sameKind.input.start).getTime()).toBe(
      new Date(ANCHOR.time).getTime() - 7 * 24 * 60 * 60 * 1000,
    );

    const sameSession = mockSearchEvents.mock.calls[3][1];
    expect(sameSession.input.source).toBe("10.0.0.5");
    expect(sameSession.input.destination).toBe("203.0.113.45");

    expect(result).toHaveLength(4);
    expect(result.every((r) => r.count === "5")).toBe(true);
    expect(result.every((r) => r.lastTime !== null)).toBe(true);
  });

  it("computes lastTime as the max time across returned nodes (no ordering reliance)", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    const unorderedPage = {
      nodes: [
        {
          __typename: "HttpThreat",
          time: "2026-04-22T01:00:00.000Z",
          sensor: "sensor-1",
          confidence: 0.8,
          level: "HIGH",
          triageScores: null,
          category: null,
        },
        {
          __typename: "HttpThreat",
          time: "2026-04-22T09:00:00.000Z",
          sensor: "sensor-1",
          confidence: 0.8,
          level: "HIGH",
          triageScores: null,
          category: null,
        },
        {
          __typename: "HttpThreat",
          time: "2026-04-22T03:00:00.000Z",
          sensor: "sensor-1",
          confidence: 0.8,
          level: "HIGH",
          triageScores: null,
          category: null,
        },
      ],
      edges: [],
      totalCount: "3",
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    };
    mockSearchEvents.mockResolvedValue(unorderedPage);

    const { fetchRelatedPivotSummaries } = await import(
      "@/lib/events/related-pivots"
    );

    const result = await fetchRelatedPivotSummaries(ANCHOR);
    expect(result.every((r) => r.lastTime === "2026-04-22T09:00:00.000Z")).toBe(
      true,
    );
  });

  it("requests a bounded sample (not last: 1) for the lastTime computation", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockSearchEvents.mockResolvedValue({
      nodes: [],
      edges: [],
      totalCount: "0",
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    });

    const { fetchRelatedPivotSummaries } = await import(
      "@/lib/events/related-pivots"
    );

    await fetchRelatedPivotSummaries(ANCHOR);
    for (const call of mockSearchEvents.mock.calls) {
      const pagination = call[2] as { first?: number; last?: number };
      expect(pagination.last).toBeUndefined();
      expect(pagination.first).toBeGreaterThan(1);
    }
  });

  it("falls back to a zero summary when a pivot lookup throws", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockSearchEvents
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        totalCount: "0",
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
      })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        totalCount: "0",
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
      })
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        totalCount: "0",
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
      });

    const { fetchRelatedPivotSummaries } = await import(
      "@/lib/events/related-pivots"
    );

    const result = await fetchRelatedPivotSummaries(ANCHOR);
    const failed = result.find((r) => r.id === "same-destination");
    expect(failed).toEqual({
      id: "same-destination",
      count: "0",
      lastTime: null,
    });
  });
});
