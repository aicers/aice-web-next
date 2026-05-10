import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));

interface PageOpts {
  nodeCount: number;
  hasNextPage: boolean;
  endCursor?: string | null;
  totalCount?: string;
}

function makePage({ nodeCount, hasNextPage, endCursor, totalCount }: PageOpts) {
  return {
    eventList: {
      pageInfo: {
        hasPreviousPage: false,
        hasNextPage,
        startCursor: nodeCount > 0 ? "start" : null,
        endCursor: hasNextPage ? (endCursor ?? "next") : null,
      },
      totalCount: totalCount ?? String(nodeCount),
      edges: Array.from({ length: nodeCount }, (_, i) => ({
        cursor: `c-${i}`,
      })),
      nodes: Array.from({ length: nodeCount }, () => ({
        __typename: "NetworkThreat",
        time: "2026-05-09T12:00:00.000Z",
        sensor: "sensor-a",
        category: "COMMAND_AND_CONTROL",
        level: "MEDIUM",
        origAddr: "10.0.0.1",
      })),
    },
  };
}

const PERIOD = {
  periodStartIso: "2026-05-08T12:00:00.000Z",
  periodEndIso: "2026-05-09T12:00:00.000Z",
};

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Security Monitor"],
    tokenVersion: 1,
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
    ...overrides,
  } as AuthSession;
}

describe("fetchTier2DimensionWithSession", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGraphqlRequest.mockReset();
  });

  it("rejects callers without triage:read before any GraphQL round-trip", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );
    const { TriageUnauthorizedError } = await import("@/lib/triage");

    await expect(
      fetchTier2DimensionWithSession(makeSession(), {
        ...PERIOD,
        dimension: "country",
        valueKey: "US",
      }),
    ).rejects.toBeInstanceOf(TriageUnauthorizedError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("does NOT require detection:read for the Tier 2 sensor pivot", async () => {
    // Caller has triage:read but lacks detection:read; the Tier 2
    // fetch must still succeed.
    mockHasPermission.mockImplementation(
      async (_roles: string[], permission: string) =>
        permission === "triage:read" || permission === "customers:access-all",
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({ nodeCount: 0, hasNextPage: false }),
    );

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      { ...PERIOD, dimension: "country", valueKey: "US" },
    );

    expect(result.events).toEqual([]);
    expect(mockHasPermission).not.toHaveBeenCalledWith(
      expect.anything(),
      "detection:read",
    );
  });

  it("paginates per-dimension at REVIEW_MAX_PAGE_SIZE", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest
      .mockResolvedValueOnce(
        makePage({
          nodeCount: 100,
          hasNextPage: true,
          endCursor: "page-1",
          totalCount: "240",
        }),
      )
      .mockResolvedValueOnce(
        makePage({
          nodeCount: 100,
          hasNextPage: true,
          endCursor: "page-2",
          totalCount: "240",
        }),
      )
      .mockResolvedValueOnce(
        makePage({
          nodeCount: 40,
          hasNextPage: false,
          totalCount: "240",
        }),
      );

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      { ...PERIOD, dimension: "country", valueKey: "US" },
    );

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(3);
    const firstVars = mockGraphqlRequest.mock.calls[0][1];
    expect(firstVars.first).toBe(100);
    expect(result.events).toHaveLength(240);
    expect(result.totalCount).toBe("240");
    expect(result.truncated).toBe(false);
  });

  it("flags truncated when the per-dimension cap is hit AND more pages remain", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    // Fill 50 pages of 100 events to hit the 5,000-event cap with
    // hasNextPage=true so REview still claims more rows.
    for (let i = 0; i < 50; i += 1) {
      mockGraphqlRequest.mockResolvedValueOnce(
        makePage({
          nodeCount: 100,
          hasNextPage: true,
          endCursor: `page-${i}`,
          totalCount: "10000",
        }),
      );
    }
    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );
    const { TIER2_PER_DIMENSION_CAP } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      { ...PERIOD, dimension: "country", valueKey: "US" },
    );

    expect(result.events).toHaveLength(TIER2_PER_DIMENSION_CAP);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty result without round-tripping when the filter is invalid", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      { ...PERIOD, dimension: "categories", valueKey: "not-a-number" },
    );

    expect(result.events).toEqual([]);
    expect(result.totalCount).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(false);
    expect(result.endCursor).toBeNull();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("limits to a single page and reports hasMore when firstPageOnly is true", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({
        nodeCount: 100,
        hasNextPage: true,
        endCursor: "page-1",
        totalCount: "10000",
      }),
    );
    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      {
        ...PERIOD,
        dimension: "country",
        valueKey: "US",
        firstPageOnly: true,
      },
    );

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(100);
    expect(result.totalCount).toBe("10000");
    expect(result.hasMore).toBe(true);
    expect(result.endCursor).toBe("page-1");
  });

  it("resumes pagination from afterCursor without redoing the first page", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({
        nodeCount: 50,
        hasNextPage: false,
        totalCount: "150",
      }),
    );
    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      {
        ...PERIOD,
        dimension: "country",
        valueKey: "US",
        afterCursor: "cursor-from-peek",
      },
    );

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const variables = mockGraphqlRequest.mock.calls[0][1];
    expect(variables.after).toBe("cursor-from-peek");
    expect(result.events).toHaveLength(50);
    expect(result.hasMore).toBe(false);
  });

  it("packs an external IP into a side-agnostic endpoint filter", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({ nodeCount: 0, hasNextPage: false }),
    );
    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      { ...PERIOD, dimension: "externalIp", valueKey: "203.0.113.10" },
    );

    const filter = mockGraphqlRequest.mock.calls[0][1].filter;
    expect(filter.endpoints[0].direction).toBeNull();
    expect(filter.endpoints[0].custom.hosts).toEqual(["203.0.113.10"]);
  });
});
