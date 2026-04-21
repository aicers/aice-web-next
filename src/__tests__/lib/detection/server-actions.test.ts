import type { DocumentNode } from "graphql";
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

/** Build a minimally-populated AuthSession for the unit under test. */
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

describe("detection server actions", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGraphqlRequest.mockReset();
  });

  // ── Authorization ──────────────────────────────────────────────

  describe("authorization", () => {
    it("rejects a caller without detection:read before dispatching", async () => {
      mockHasPermission.mockResolvedValue(false);

      const { searchEvents, DetectionUnauthorizedError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { start: null, end: null },
        }),
      ).rejects.toBeInstanceOf(DetectionUnauthorizedError);

      expect(mockResolveEffectiveCustomerIds).not.toHaveBeenCalled();
      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("rejects a caller with an empty customer scope", async () => {
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([]);

      const { searchEvents, DetectionUnauthorizedError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { start: null, end: null },
        }),
      ).rejects.toBeInstanceOf(DetectionUnauthorizedError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("carries the materialized access-all scope on the JWT context", async () => {
      mockHasPermission.mockResolvedValue(true);
      // Access-all callers are resolved upstream to the explicit list
      // of every registered customer ID. The BFF forwards that list
      // on the Context JWT verbatim — REview does not re-derive scope
      // from role text, so the list must be present.
      mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2, 3]);
      mockGraphqlRequest.mockResolvedValue({
        eventList: {
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: false,
            startCursor: null,
            endCursor: null,
          },
          edges: [],
          nodes: [],
          totalCount: "0",
        },
      });

      const { searchEvents } = await import("@/lib/detection");

      await searchEvents(makeSession({ roles: ["System Administrator"] }), {
        mode: "structured",
        input: { start: null, end: null },
      });

      expect(mockGraphqlRequest).toHaveBeenCalledOnce();
      const [, variables, context] = mockGraphqlRequest.mock.calls[0];
      // Caller supplied no `customers` filter — the BFF must not
      // inject one. Scope travels in the Context JWT below.
      expect(variables.filter.customers).toBeUndefined();
      expect(context).toEqual({
        role: "System Administrator",
        customerIds: [1, 2, 3],
      });
    });

    it('rejects mode: "query" with DetectionNotImplementedError', async () => {
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([42]);

      const { searchEvents, DetectionNotImplementedError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), { mode: "query", text: "ip:1.1.1.1" }),
      ).rejects.toBeInstanceOf(DetectionNotImplementedError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });
  });

  // ── Dispatch / scope injection ─────────────────────────────────

  describe("searchEvents", () => {
    beforeEach(() => {
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);
    });

    it("passes the filter through and carries scope on the JWT context", async () => {
      mockGraphqlRequest.mockResolvedValue({
        eventList: {
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: true,
            startCursor: "a",
            endCursor: "b",
          },
          edges: [],
          nodes: [],
          totalCount: "9999999999999999",
        },
      });

      const { searchEvents } = await import("@/lib/detection");
      const result = await searchEvents(
        makeSession(),
        {
          mode: "structured",
          input: {
            start: "2026-04-01T00:00:00Z",
            end: "2026-04-02T00:00:00Z",
            // The caller narrows to a subset of their allowed scope.
            // The BFF must NOT broaden this to the full scope —
            // `filter.customers` is a query dimension; authorization
            // lives on the Context JWT (`context.customerIds`).
            customers: ["42"],
          },
        },
        { first: 50, after: "cursor-1" },
      );

      const [document, variables, context] = mockGraphqlRequest.mock.calls[0];
      expect((document as DocumentNode).kind).toBe("Document");
      expect(variables.filter).toEqual({
        start: "2026-04-01T00:00:00Z",
        end: "2026-04-02T00:00:00Z",
        customers: ["42"],
      });
      expect(variables.first).toBe(50);
      expect(variables.after).toBe("cursor-1");
      expect(variables.last).toBeNull();
      expect(variables.before).toBeNull();
      expect(context).toEqual({
        role: "Security Monitor",
        customerIds: [42, 99],
      });

      // totalCount flows through as a string — never cast to number.
      expect(result.totalCount).toBe("9999999999999999");
      expect(typeof result.totalCount).toBe("string");
    });

    it("leaves filter.customers undefined when the caller did not supply one", async () => {
      mockGraphqlRequest.mockResolvedValue({
        eventList: {
          pageInfo: {
            hasPreviousPage: false,
            hasNextPage: false,
            startCursor: null,
            endCursor: null,
          },
          edges: [],
          nodes: [],
          totalCount: "0",
        },
      });

      const { searchEvents } = await import("@/lib/detection");
      await searchEvents(makeSession(), {
        mode: "structured",
        input: { start: null, end: null },
      });

      const [, variables, context] = mockGraphqlRequest.mock.calls[0];
      expect(variables.filter).toEqual({ start: null, end: null });
      expect(variables.filter.customers).toBeUndefined();
      // Scope still reaches REview — via the Context JWT.
      expect(context.customerIds).toEqual([42, 99]);
    });
  });

  // ── Per-counter wiring ─────────────────────────────────────────

  describe.each([
    ["countEventsByCategory", "eventCountsByCategory"],
    ["countEventsByLevel", "eventCountsByLevel"],
    ["countEventsByCountry", "eventCountsByCountry"],
    ["countEventsByKind", "eventCountsByKind"],
    ["countEventsByIpAddress", "eventCountsByIpAddress"],
    ["countEventsByOriginatorIpAddress", "eventCountsByOriginatorIpAddress"],
    ["countEventsByResponderIpAddress", "eventCountsByResponderIpAddress"],
  ] as const)("%s", (fnName, resultKey) => {
    beforeEach(() => {
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([7]);
    });

    it(`passes \`first\` through and unwraps \`${resultKey}\``, async () => {
      const payload = { values: ["X"], counts: [3] };
      mockGraphqlRequest.mockResolvedValue({ [resultKey]: payload });

      const mod = await import("@/lib/detection");
      const fn = mod[fnName] as (
        s: AuthSession,
        f: import("@/lib/detection").Filter,
        first: number,
      ) => Promise<unknown>;

      const result = await fn(
        makeSession(),
        {
          mode: "structured",
          input: { start: null, end: null },
        },
        10,
      );

      expect(result).toBe(payload);
      const [, variables, context] = mockGraphqlRequest.mock.calls[0];
      // Filter is passed through — the BFF does not inject customers.
      expect(variables.filter.customers).toBeUndefined();
      expect(variables.first).toBe(10);
      // Scope still reaches REview via the Context JWT.
      expect(context.customerIds).toEqual([7]);
    });
  });

  // ── Time series ────────────────────────────────────────────────

  describe("eventFrequencySeries", () => {
    beforeEach(() => {
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([7]);
    });

    it("passes the period through and returns the bucket array", async () => {
      mockGraphqlRequest.mockResolvedValue({
        eventFrequencySeries: [1, 2, 3, 4],
      });

      const { eventFrequencySeries } = await import("@/lib/detection");
      const result = await eventFrequencySeries(
        makeSession(),
        {
          mode: "structured",
          input: {
            start: "2026-04-01T00:00:00Z",
            end: "2026-04-02T00:00:00Z",
          },
        },
        3600,
      );

      expect(result).toEqual([1, 2, 3, 4]);
      const [, variables, context] = mockGraphqlRequest.mock.calls[0];
      expect(variables.period).toBe(3600);
      expect(variables.filter.start).toBe("2026-04-01T00:00:00Z");
      // Filter is passed through — customer scope travels on the JWT.
      expect(variables.filter.customers).toBeUndefined();
      expect(context.customerIds).toEqual([7]);
    });
  });
});
