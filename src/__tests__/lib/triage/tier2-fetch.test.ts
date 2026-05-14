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
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        __typename: "NetworkThreat",
        id: `evt-${i}`,
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
        customerId: 1,
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
      { ...PERIOD, dimension: "country", valueKey: "US", customerId: 1 },
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
      { ...PERIOD, dimension: "country", valueKey: "US", customerId: 1 },
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
      { ...PERIOD, dimension: "country", valueKey: "US", customerId: 1 },
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
      {
        ...PERIOD,
        dimension: "categories",
        valueKey: "not-a-number",
        customerId: 1,
      },
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
        customerId: 1,
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
        customerId: 1,
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
      {
        ...PERIOD,
        dimension: "externalIp",
        valueKey: "203.0.113.10",
        customerId: 1,
      },
    );

    const filter = mockGraphqlRequest.mock.calls[0][1].filter;
    expect(filter.endpoints[0].direction).toBeNull();
    expect(filter.endpoints[0].custom.hosts).toEqual(["203.0.113.10"]);
  });

  // ── sameSensor pivot — name → nodeId resolution (#502) ─────────

  function sensorListResponse(
    nodes: ReadonlyArray<{
      nodeId: string;
      hostFqdn: string;
      customerId: number;
    }>,
  ) {
    return { customerSensorList: { nodes } };
  }

  it("resolves (name, customerId) → nodeId before issuing the sameSensor fetch", async () => {
    // Two sensors share the name `edge-01` across two tenants. The
    // Tier 2 sensor pivot keys on `(name, customerId)` so the
    // dispatched `sensors: [ID!]` carries the asset's tenant's
    // sensor id — never the other tenant's.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);
    mockGraphqlRequest
      // listSensors() call goes first.
      .mockResolvedValueOnce(
        sensorListResponse([
          { nodeId: "node-A-42", hostFqdn: "edge-01", customerId: 42 },
          { nodeId: "node-A-99", hostFqdn: "edge-01", customerId: 99 },
        ]),
      )
      // Then the eventList call.
      .mockResolvedValueOnce(makePage({ nodeCount: 0, hasNextPage: false }));

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );
    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["Security Monitor"] }),
      {
        ...PERIOD,
        dimension: "sameSensor",
        valueKey: "edge-01",
        customerId: 42,
      },
    );

    expect(result.sensorFallback).toBeUndefined();
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
    // The second call is the actual fetch — the filter must carry
    // the resolved nodeId for customer 42, not the raw name.
    const filter = mockGraphqlRequest.mock.calls[1][1].filter;
    expect(filter.sensors).toEqual(["node-A-42"]);
  });

  it("returns a name-unresolved sensorFallback when no sensor matches the asset's customer scope", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    // No sensors named `edge-01` under customerId 42; only an
    // unrelated tenant's matches by name.
    mockGraphqlRequest.mockResolvedValueOnce(
      sensorListResponse([
        { nodeId: "node-other", hostFqdn: "edge-01", customerId: 99 },
      ]),
    );

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );
    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["Security Monitor"] }),
      {
        ...PERIOD,
        dimension: "sameSensor",
        valueKey: "edge-01",
        customerId: 42,
      },
    );

    expect(result.sensorFallback).toEqual({
      kind: "name-unresolved",
      sensorName: "edge-01",
    });
    // No eventList round-trip happens when the name doesn't resolve.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
  });

  it("maps a Forbidden response on the resolved nodeId to a scope-forbidden sensorFallback", async () => {
    const { ReviewForbiddenError } = await import("@/lib/review/errors");
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest
      .mockResolvedValueOnce(
        sensorListResponse([
          { nodeId: "node-A", hostFqdn: "edge-01", customerId: 42 },
        ]),
      )
      .mockRejectedValueOnce(new ReviewForbiddenError("Forbidden"));

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );
    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["Security Monitor"] }),
      {
        ...PERIOD,
        dimension: "sameSensor",
        valueKey: "edge-01",
        customerId: 42,
      },
    );

    expect(result.sensorFallback).toEqual({
      kind: "scope-forbidden",
      sensorName: "edge-01",
    });
  });

  it("surfaces the resolvedSensorId on the result so the hook can replay it on continuation", async () => {
    // The hook's modal-gated path needs the peek's resolved nodeId
    // so a Confirm-time continuation can pass it back as
    // `resolvedSensorId` and skip the lookup. The peek itself must
    // therefore return the id it just resolved against
    // `(name, customerId)`.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest
      .mockResolvedValueOnce(
        sensorListResponse([
          { nodeId: "node-A-42", hostFqdn: "edge-01", customerId: 42 },
        ]),
      )
      .mockResolvedValueOnce(
        makePage({
          nodeCount: 100,
          hasNextPage: true,
          endCursor: "page-1",
          totalCount: "25000",
        }),
      );

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );
    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["Security Monitor"] }),
      {
        ...PERIOD,
        dimension: "sameSensor",
        valueKey: "edge-01",
        customerId: 42,
        firstPageOnly: true,
      },
    );

    expect(result.resolvedSensorId).toBe("node-A-42");
    expect(result.endCursor).toBe("page-1");
  });

  it("reuses the supplied resolvedSensorId verbatim on continuation and does NOT re-run listSensors()", async () => {
    // Reviewer Round 11 repro at the impl boundary: the peek
    // resolved `edge-01` to `node-A-42`. Between peek and Confirm
    // the lookup result shifted — if the impl re-ran
    // `listSensors()` here it would land on the wrong sensor and
    // paginate against the peek's stale cursor. With
    // `resolvedSensorId` on the input, the lookup is skipped
    // entirely and the dispatched filter carries the peek's id.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    // Only one GraphQL call should land — the eventList
    // continuation. Stub a `listSensors()` response too so the
    // assertion below pins the *absence* of the lookup call rather
    // than a missing-mock crash.
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({
        nodeCount: 40,
        hasNextPage: false,
        totalCount: "25000",
      }),
    );

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );
    await fetchTier2DimensionWithSession(
      makeSession({ roles: ["Security Monitor"] }),
      {
        ...PERIOD,
        dimension: "sameSensor",
        valueKey: "edge-01",
        customerId: 42,
        afterCursor: "cursor-from-peek",
        alreadyFetched: 100,
        resolvedSensorId: "node-A-42",
      },
    );

    // Exactly one round-trip — the eventList continuation. No
    // lookup; without the bypass this would be two calls and the
    // first would be `customerSensorList`.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const variables = mockGraphqlRequest.mock.calls[0][1];
    expect(variables.filter.sensors).toEqual(["node-A-42"]);
    expect(variables.after).toBe("cursor-from-peek");
  });

  // ── Story-member corpus (#561) ─────────────────────────────

  function makeMemberPage(opts: {
    eventIds: string[];
    hasNextPage: boolean;
    endCursor?: string | null;
    totalCount?: string;
  }) {
    return {
      eventList: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: opts.hasNextPage,
          startCursor: opts.eventIds.length > 0 ? "start" : null,
          endCursor: opts.hasNextPage ? (opts.endCursor ?? "next") : null,
        },
        totalCount: opts.totalCount ?? String(opts.eventIds.length),
        edges: opts.eventIds.map((id) => ({ cursor: `c-${id}` })),
        nodes: opts.eventIds.map((id) => ({
          __typename: "NetworkThreat",
          id,
          time: "2026-05-09T12:00:00.000Z",
          sensor: "sensor-a",
          category: "COMMAND_AND_CONTROL",
          level: "MEDIUM",
          origAddr: "10.0.0.1",
        })),
      },
    };
  }

  it.each([
    { size: 1, label: "single-member" },
    { size: 25, label: "mid-range" },
    { size: 50, label: "STORY_MEMBER_CAP boundary" },
  ])("intersects REview's eventList against the Story member set ($label, size=$size)", async ({
    size,
  }) => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    // Member ids the Story carries — the resolver returns only the
    // events whose REview `Event.id` is in this set.
    const memberIds = Array.from({ length: size }, (_, i) => `evt-m-${i}`);
    // REview's universe for `kinds=NetworkThreat` includes the member
    // events plus a handful of unrelated rows. The intersection drops
    // the unrelated ones; `totalCount` reflects the cohort, not the
    // universe.
    mockGraphqlRequest.mockResolvedValueOnce(
      makeMemberPage({
        eventIds: [...memberIds, "noise-1", "noise-2", "noise-3"],
        hasNextPage: false,
        totalCount: "9999",
      }),
    );

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      {
        ...PERIOD,
        dimension: "kinds",
        valueKey: "NetworkThreat",
        customerId: 1,
        corpusSeed: {
          kind: "storyMembers",
          customerId: 1,
          storyId: "123",
          eventKeys: memberIds,
        },
      },
    );

    // Universe-wide totalCount is overridden by the cohort count.
    expect(result.totalCount).toBe(String(size));
    expect(result.events).toHaveLength(size);
    expect(result.events.map((e) => e.id).sort()).toEqual(
      [...memberIds].sort(),
    );
    // Member-keyed walks fit in a single result by construction;
    // the modal-gated continuation path is unreachable.
    expect(result.hasMore).toBe(false);
    expect(result.endCursor).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it("walks multiple REview pages until every member event-key is observed", async () => {
    // Two member events sit on different REview pages. A naive
    // post-filter on a single first-page eventList walk would miss
    // the late member; the cohort resolver must keep walking until
    // every member is accounted for (or REview reports no further
    // pages).
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockGraphqlRequest
      .mockResolvedValueOnce(
        makeMemberPage({
          eventIds: ["evt-m-0", "noise-a", "noise-b"],
          hasNextPage: true,
          endCursor: "page-1",
        }),
      )
      .mockResolvedValueOnce(
        makeMemberPage({
          eventIds: ["noise-c", "evt-m-1"],
          hasNextPage: false,
        }),
      );

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      {
        ...PERIOD,
        dimension: "kinds",
        valueKey: "NetworkThreat",
        customerId: 1,
        corpusSeed: {
          kind: "storyMembers",
          customerId: 1,
          storyId: "999",
          eventKeys: ["evt-m-0", "evt-m-1"],
        },
      },
    );

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
    expect(result.events.map((e) => e.id).sort()).toEqual([
      "evt-m-0",
      "evt-m-1",
    ]);
    expect(result.totalCount).toBe("2");
  });

  it("returns an empty cohort result without round-tripping when the seed is empty", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      {
        ...PERIOD,
        dimension: "kinds",
        valueKey: "NetworkThreat",
        customerId: 1,
        corpusSeed: {
          kind: "storyMembers",
          customerId: 1,
          storyId: "abc",
          eventKeys: [],
        },
      },
    );

    expect(result.events).toEqual([]);
    expect(result.totalCount).toBe("0");
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("flags `truncated=true` and omits unobserved members when the walk-cap fires before every member is seen", async () => {
    // Per #561 the cohort walk has a defensive ceiling
    // (TIER2_STORY_CORPUS_WALK_CAP = 50,000 universe rows) so a
    // misbehaving backend can't wedge the fetch in an unbounded
    // loop. If a member event sits on a REview page beyond the
    // ceiling, it is absent from the returned `events` and the
    // result carries `truncated=true` so the UI layer can surface
    // the partial result. This test pins that semantics so a
    // future refactor can't silently regress it (e.g. by widening
    // the cap without flipping the truncation flag, or by walking
    // forever).
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    // Every page is 100 nodes whose ids never match the cohort
    // member, with hasNextPage=true so the walk would continue
    // forever absent the cap. 500 pages × 100 nodes = 50,000 scanned
    // rows, which hits the walk-cap on the 501st iteration's check.
    let pageCounter = 0;
    mockGraphqlRequest.mockImplementation(async () => {
      const offset = pageCounter * 100;
      pageCounter += 1;
      return {
        eventList: {
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: true,
            startCursor: "start",
            endCursor: `cursor-${pageCounter}`,
          },
          totalCount: "9999999",
          edges: Array.from({ length: 100 }, (_, i) => ({
            cursor: `c-${offset + i}`,
          })),
          nodes: Array.from({ length: 100 }, (_, i) => ({
            __typename: "NetworkThreat",
            id: `noise-${offset + i}`,
            time: "2026-05-09T12:00:00.000Z",
            sensor: "sensor-a",
            category: "COMMAND_AND_CONTROL",
            level: "MEDIUM",
            origAddr: "10.0.0.1",
          })),
        },
      };
    });

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    const result = await fetchTier2DimensionWithSession(
      makeSession({ roles: ["System Administrator"] }),
      {
        ...PERIOD,
        dimension: "kinds",
        valueKey: "NetworkThreat",
        customerId: 1,
        corpusSeed: {
          kind: "storyMembers",
          customerId: 1,
          storyId: "deep",
          // Single member that the universe walk never surfaces —
          // it would live past the 50,000-row scan ceiling.
          eventKeys: ["evt-far-away"],
        },
      },
    );

    expect(result.truncated).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.totalCount).toBe("0");
    // The walk stops at the cap rather than running unbounded —
    // 500 universe pages × 100 nodes = 50,000 scanned rows.
    expect(mockGraphqlRequest.mock.calls.length).toBeLessThanOrEqual(501);
    expect(mockGraphqlRequest.mock.calls.length).toBeGreaterThanOrEqual(500);
  });

  it("propagates a lookup transport error rather than surfacing it as a sensorFallback", async () => {
    // Per #502: "If the lookup itself fails (e.g., transport error),
    // surface the standard error banner rather than the stale-hash
    // fallback — the analyst should know the resolution did not run,
    // not see a silent revert." A listSensors() rejection must
    // propagate so the hook layer's error path renders the generic
    // error banner; it must not be classified as `name-unresolved`.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest.mockRejectedValueOnce(new Error("transport boom"));

    const { fetchTier2DimensionWithSession } = await import(
      "@/lib/triage/tier2-fetch-impl"
    );

    await expect(
      fetchTier2DimensionWithSession(
        makeSession({ roles: ["Security Monitor"] }),
        {
          ...PERIOD,
          dimension: "sameSensor",
          valueKey: "edge-01",
          customerId: 42,
        },
      ),
    ).rejects.toThrow("transport boom");
    // No eventList round-trip is attempted when the lookup itself
    // fails — only the listSensors() call was issued.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
  });
});
