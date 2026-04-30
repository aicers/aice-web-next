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

  // ── BFF intersection check (#384) ──────────────────────────────
  //
  // Every Detection server action must reject before any REview
  // dispatch when `filter.input.customers` references IDs outside
  // the caller's effective scope. The check sits at the dispatch
  // choke point (`buildDispatchContext`), so a single test on
  // `searchEvents` covers every entry path (URL param, saved
  // filter load, recommended filter activation, pivot click).

  describe("BFF intersection check", () => {
    beforeEach(() => {
      mockHasPermission.mockResolvedValue(true);
    });

    it("dispatches when the filter narrows to a subset of allowed scope", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
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
        input: { customers: ["1"] },
      });

      expect(mockGraphqlRequest).toHaveBeenCalledOnce();
      const [, variables] = mockGraphqlRequest.mock.calls[0];
      expect(variables.filter.customers).toEqual(["1"]);
    });

    it("rejects a fully-out-of-scope `customers` list with DetectionForbiddenError, no REview dispatch", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);

      const { searchEvents, DetectionForbiddenError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { customers: ["3"] },
        }),
      ).rejects.toBeInstanceOf(DetectionForbiddenError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("rejects a mixed legal/illegal `customers` list — never silently narrows", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);

      const { searchEvents, DetectionForbiddenError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { customers: ["1", "3"] },
        }),
      ).rejects.toBeInstanceOf(DetectionForbiddenError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("dispatches an admin selecting any subset of registered customers", async () => {
      // Admin scope is materialised upstream — every registered
      // customer ID — and `searchEvents` does not branch on role.
      mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2, 3, 4, 5]);
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
        input: { customers: ["2", "4"] },
      });

      expect(mockGraphqlRequest).toHaveBeenCalledOnce();
      const [, variables] = mockGraphqlRequest.mock.calls[0];
      expect(variables.filter.customers).toEqual(["2", "4"]);
    });

    it("rejects an admin selecting an unknown customer ID (not present in `customers`)", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2, 3]);

      const { searchEvents, DetectionForbiddenError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession({ roles: ["System Administrator"] }), {
          mode: "structured",
          input: { customers: ["999999"] },
        }),
      ).rejects.toBeInstanceOf(DetectionForbiddenError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("rejects an empty-scope account before any REview dispatch", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([]);

      // Note: the empty-scope rejection surfaces as
      // `DetectionUnauthorizedError`, not `DetectionForbiddenError`
      // — the caller has no Detection access at all, distinct from
      // "has access but referenced a forbidden customer". The
      // important contract is that **no** REview dispatch occurs.
      const { searchEvents, DetectionUnauthorizedError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { customers: ["1"] },
        }),
      ).rejects.toBeInstanceOf(DetectionUnauthorizedError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("rejects malformed wire entries (non-integer / negative)", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);

      const { searchEvents, DetectionForbiddenError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { customers: ["abc"] },
        }),
      ).rejects.toBeInstanceOf(DetectionForbiddenError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("propagates rejection through every counter entry point", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([1]);

      const mod = await import("@/lib/detection");
      const { DetectionForbiddenError } = mod;
      const counters: Array<keyof typeof mod> = [
        "countEventsByCategory",
        "countEventsByLevel",
        "countEventsByCountry",
        "countEventsByKind",
        "countEventsByIpAddress",
        "countEventsByOriginatorIpAddress",
        "countEventsByResponderIpAddress",
        "eventFrequencySeries",
      ];
      for (const fnName of counters) {
        const fn = mod[fnName] as (
          s: import("@/lib/auth/jwt").AuthSession,
          f: import("@/lib/detection").Filter,
          arg: number,
        ) => Promise<unknown>;
        await expect(
          fn(
            makeSession(),
            {
              mode: "structured",
              input: { customers: ["999"] },
            },
            10,
          ),
        ).rejects.toBeInstanceOf(DetectionForbiddenError);
      }

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
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

  // ── Tail-drift correction ──────────────────────────────────────
  //
  // Reviewer Round 3 #1: `searchArgsForAnchor({ kind: "tail" }, ...)`
  // uses the caller's cached `totalCount` to narrow the partial-final-
  // page request. If the real total drifted between navigations,
  // REview returns a straddling window and the UI label lies.
  // `searchEventsAtAnchor` re-queries with the freshly returned total
  // so the rows match the labeled page under drift.

  describe("searchEventsAtAnchor — tail-drift correction", () => {
    beforeEach(() => {
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    });

    /** Build an `eventList` payload with the requested totalCount. */
    function buildEventList(totalCount: string) {
      return {
        eventList: {
          pageInfo: {
            hasPreviousPage: true,
            hasNextPage: false,
            startCursor: "s",
            endCursor: "e",
          },
          edges: [],
          nodes: [],
          totalCount,
        },
      };
    }

    it("issues one request when a non-tail anchor would never drift", async () => {
      mockGraphqlRequest.mockResolvedValueOnce(buildEventList("1453"));

      const { searchEventsAtAnchor } = await import("@/lib/detection");
      await searchEventsAtAnchor(
        makeSession(),
        { mode: "structured", input: { start: null, end: null } },
        { kind: "head" },
        100,
        "9999",
      );

      expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
      const [, variables] = mockGraphqlRequest.mock.calls[0];
      expect(variables.first).toBe(100);
      expect(variables.last).toBeNull();
    });

    it("skips the re-query when the fresh remainder matches what was asked for", async () => {
      // Caller cached totalCount="1453" at 100/page → asks for last:53.
      // Real total drifted to 1553 but the remainder 1553 % 100 = 53
      // still matches. The rows REview returned are the real last
      // page; no re-query needed. The UI re-derives the label (15→16)
      // via `committedPageForAnchor`.
      mockGraphqlRequest.mockResolvedValueOnce(buildEventList("1553"));

      const { searchEventsAtAnchor } = await import("@/lib/detection");
      const result = await searchEventsAtAnchor(
        makeSession(),
        { mode: "structured", input: { start: null, end: null } },
        { kind: "tail" },
        100,
        "1453",
      );

      expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
      expect(mockGraphqlRequest.mock.calls[0][1].last).toBe(53);
      expect(result.totalCount).toBe("1553");
    });

    it("re-queries once when the fresh total implies a different partial size", async () => {
      // Caller cached totalCount="1453" at 100/page → asks for last:53.
      // Real total is 1500 (remainder 0 → the last page is a full
      // 100 rows). The helper must re-query with last:100 so the
      // returned rows are rows 1,401–1,500, not rows 1,448–1,500.
      mockGraphqlRequest
        .mockResolvedValueOnce(buildEventList("1500"))
        .mockResolvedValueOnce(buildEventList("1500"));

      const { searchEventsAtAnchor } = await import("@/lib/detection");
      await searchEventsAtAnchor(
        makeSession(),
        { mode: "structured", input: { start: null, end: null } },
        { kind: "tail" },
        100,
        "1453",
      );

      expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
      const firstArgs = mockGraphqlRequest.mock.calls[0][1];
      const secondArgs = mockGraphqlRequest.mock.calls[1][1];
      expect(firstArgs.last).toBe(53);
      expect(secondArgs.last).toBe(100);
    });

    it("performs the cold-SSR two-step when the caller has no cached total", async () => {
      // Cold deep link for `?last=1&pageSize=100` on a 1,453-row total:
      // first query uses `last: 100` (no partial knowledge), second
      // query narrows to `last: 53` once the total is known.
      mockGraphqlRequest
        .mockResolvedValueOnce(buildEventList("1453"))
        .mockResolvedValueOnce(buildEventList("1453"));

      const { searchEventsAtAnchor } = await import("@/lib/detection");
      await searchEventsAtAnchor(
        makeSession(),
        { mode: "structured", input: { start: null, end: null } },
        { kind: "tail" },
        100,
        null,
      );

      expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
      expect(mockGraphqlRequest.mock.calls[0][1].last).toBe(100);
      expect(mockGraphqlRequest.mock.calls[1][1].last).toBe(53);
    });

    it("stops correcting after two re-queries under pathological drift", async () => {
      // Each response moves the remainder, so every corrective query
      // would re-trigger. The cap keeps worst-case traffic bounded —
      // we accept the rows from the last attempt and trust the UI's
      // `committedPageForAnchor` to re-derive the page label.
      mockGraphqlRequest
        .mockResolvedValueOnce(buildEventList("1453")) // last=100 → correct→53
        .mockResolvedValueOnce(buildEventList("1500")) // last=53 → correct→100
        .mockResolvedValueOnce(buildEventList("1453")); // last=100 → correct→53; capped

      const { searchEventsAtAnchor } = await import("@/lib/detection");
      await searchEventsAtAnchor(
        makeSession(),
        { mode: "structured", input: { start: null, end: null } },
        { kind: "tail" },
        100,
        null,
      );

      expect(mockGraphqlRequest).toHaveBeenCalledTimes(3);
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
