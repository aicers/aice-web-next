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
  nodes: { __typename?: string; time?: string; category?: string | null }[];
  hasNextPage: boolean;
  endCursor?: string | null;
}

function makePage({ nodes, hasNextPage, endCursor = null }: PageOpts) {
  return {
    eventList: {
      pageInfo: {
        hasPreviousPage: false,
        hasNextPage,
        startCursor: nodes.length ? "start" : null,
        endCursor: hasNextPage ? (endCursor ?? "cursor") : null,
      },
      edges: nodes.map((_, i) => ({ cursor: `c-${i}` })),
      nodes: nodes.map((n) => ({
        __typename: "NetworkThreat",
        time: "2026-05-09T12:00:00.000Z",
        sensor: "sensor-a",
        category: "COMMAND_AND_CONTROL",
        level: "MEDIUM",
        origAddr: "10.0.0.1",
        ...n,
      })),
    },
  };
}

const PERIOD = {
  startIso: "2026-05-08T12:00:00.000Z",
  endIso: "2026-05-09T12:00:00.000Z",
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

describe("loadTriagePeriod", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGraphqlRequest.mockReset();
  });

  it("rejects callers without triage:read before any GraphQL round-trip", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const { TriageUnauthorizedError } = await import("@/lib/triage");

    await expect(
      loadTriagePeriod(makeSession(), PERIOD),
    ).rejects.toBeInstanceOf(TriageUnauthorizedError);
    expect(mockResolveEffectiveCustomerIds).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("rejects a non-admin caller with an empty customer scope", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], permission: string) =>
        permission === "triage:read",
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const { TriageForbiddenError } = await import("@/lib/triage");

    await expect(
      loadTriagePeriod(makeSession(), PERIOD),
    ).rejects.toBeInstanceOf(TriageForbiddenError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("omits customer_ids from the JWT for System Administrator", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2, 3]);
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({ nodes: [], hasNextPage: false }),
    );

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");

    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );

    expect(mockGraphqlRequest).toHaveBeenCalledOnce();
    const [, variables, context] = mockGraphqlRequest.mock.calls[0];
    expect(variables.filter).toEqual({
      start: PERIOD.startIso,
      end: PERIOD.endIso,
    });
    expect(variables.after).toBeNull();
    expect(context).toEqual({
      role: "System Administrator",
      customerIds: undefined,
    });
    expect(result.funnel.detected).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("carries the materialized scope on the JWT for non-SysAdmin roles", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], permission: string) =>
        permission === "triage:read",
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([7]);
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({ nodes: [], hasNextPage: false }),
    );

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");

    await loadTriagePeriod(makeSession(), PERIOD);

    const [, , context] = mockGraphqlRequest.mock.calls[0];
    expect(context).toEqual({ role: "Security Monitor", customerIds: [7] });
  });

  it("walks cursor pages until hasNextPage is false", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest
      .mockResolvedValueOnce(
        makePage({
          nodes: Array.from({ length: 500 }, () => ({})),
          hasNextPage: true,
          endCursor: "page-1-end",
        }),
      )
      .mockResolvedValueOnce(
        makePage({
          nodes: Array.from({ length: 200 }, () => ({})),
          hasNextPage: false,
        }),
      );

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");

    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
    const secondCall = mockGraphqlRequest.mock.calls[1][1];
    expect(secondCall.after).toBe("page-1-end");
    expect(result.loadedEventCount).toBe(700);
    expect(result.truncated).toBe(false);
  });

  it("flags the slice as truncated only when the cap is hit AND more pages remain", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    // Ten full 500-event pages each reporting hasNextPage=true so the
    // cap (5,000) is reached with REview still claiming more rows.
    for (let i = 0; i < 10; i += 1) {
      mockGraphqlRequest.mockResolvedValueOnce(
        makePage({
          nodes: Array.from({ length: 500 }, () => ({})),
          hasNextPage: true,
          endCursor: `page-${i}-end`,
        }),
      );
    }

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const { TRIAGE_HARD_EVENT_CAP } = await import("@/lib/triage");

    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(10);
    expect(result.loadedEventCount).toBe(TRIAGE_HARD_EVENT_CAP);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncated when the final page exactly reaches the cap", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    // Same volume but the final page reports no further rows.
    for (let i = 0; i < 9; i += 1) {
      mockGraphqlRequest.mockResolvedValueOnce(
        makePage({
          nodes: Array.from({ length: 500 }, () => ({})),
          hasNextPage: true,
          endCursor: `page-${i}-end`,
        }),
      );
    }
    mockGraphqlRequest.mockResolvedValueOnce(
      makePage({
        nodes: Array.from({ length: 500 }, () => ({})),
        hasNextPage: false,
      }),
    );

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const { TRIAGE_HARD_EVENT_CAP } = await import("@/lib/triage");

    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );

    expect(result.loadedEventCount).toBe(TRIAGE_HARD_EVENT_CAP);
    expect(result.truncated).toBe(false);
  });

  it("forwards the AbortSignal to every GraphQL round-trip", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest
      .mockResolvedValueOnce(
        makePage({
          nodes: Array.from({ length: 500 }, () => ({})),
          hasNextPage: true,
          endCursor: "next",
        }),
      )
      .mockResolvedValueOnce(makePage({ nodes: [], hasNextPage: false }));

    const controller = new AbortController();
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");

    await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
      controller.signal,
    );

    for (const call of mockGraphqlRequest.mock.calls) {
      expect(call[3]).toBe(controller.signal);
    }
  });
});
