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

    it("rejects a non-admin caller with an empty customer scope", async () => {
      // The caller holds `detection:read` but not
      // `customers:access-all`, so an empty assigned scope is the
      // legitimate "no Detection access at all" case.
      mockHasPermission.mockImplementation(
        async (_roles: string[], permission: string) =>
          permission === "detection:read",
      );
      mockResolveEffectiveCustomerIds.mockResolvedValue([]);

      // Reviewer Round 2: empty-scope sessions flow through the
      // customer-scope gate (`DetectionForbiddenError` →
      // `forbidden-customer-scope`), not the generic unauthorized
      // bucket. The caller does hold `detection:read`; the actionable
      // failure is "no customers in scope", same family as a crafted
      // filter referencing customers outside scope.
      const { searchEvents, DetectionForbiddenError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { start: null, end: null },
        }),
      ).rejects.toBeInstanceOf(DetectionForbiddenError);

      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it("omits `customer_ids` from the JWT for System Administrator (review's None-only-for-SysAdmin contract)", async () => {
      mockHasPermission.mockResolvedValue(true);
      // The materialized list still flows through the BFF for in-
      // process defense-in-depth checks (filter scope intersection),
      // but the Context JWT must omit `customer_ids` for the
      // SysAdmin role: review's `validate_context_jwt` accepts
      // `customer_ids = None` only for `Role::SystemAdministrator`,
      // so passing the materialized list is unnecessary and a fresh
      // install with an empty `customers` table would otherwise
      // ship `customer_ids: []` and 403 from review (#405 L1+L2).
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
        customerIds: undefined,
      });
    });

    it("carries the materialized access-all scope on the JWT for non-SysAdmin custom roles", async () => {
      // A custom role granting `customers:access-all` is not the
      // `Role::SystemAdministrator` that review's `validate_context_jwt`
      // recognises for the omit-customer_ids path, so the materialized
      // list must still ride the JWT verbatim.
      mockHasPermission.mockResolvedValue(true);
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

      await searchEvents(makeSession({ roles: ["Custom Auditor"] }), {
        mode: "structured",
        input: { start: null, end: null },
      });

      const [, , context] = mockGraphqlRequest.mock.calls[0];
      expect(context).toEqual({
        role: "Custom Auditor",
        customerIds: [1, 2, 3],
      });
    });

    it("does not block a System Administrator with an empty local `customers` table (#405 L1)", async () => {
      // Reproduction from the 2026-05-03 integration test: bootstrap
      // SysAdmin opens `/en/detection`, `auth_db.customers` is empty,
      // `resolveEffectiveCustomerIds` returns `[]`. The pre-#405
      // empty-scope gate threw before any review round-trip — but
      // review accepts `customer_ids = None` for SysAdmin, so the
      // BFF must let the dispatch through with the customer_ids
      // claim omitted.
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([]);
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
      const [, , context] = mockGraphqlRequest.mock.calls[0];
      expect(context).toEqual({
        role: "System Administrator",
        customerIds: undefined,
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
      // Non-admin caller: holds `detection:read` but not
      // `customers:access-all`. The intersection check is only the
      // authoritative gate for non-global-scope callers; admins
      // delegate filter validation to review (#405 P2 — see the
      // separate admin tests below).
      mockHasPermission.mockImplementation(
        async (_roles: string[], permission: string) =>
          permission !== "customers:access-all",
      );
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
      // Override the suite-level non-admin permission shape so the
      // global-scope path activates for this case.
      mockHasPermission.mockResolvedValue(true);
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

    it("dispatches a global-scope admin even when filter.customers is missing from the local list (#405 P2)", async () => {
      // The BFF's local `customers` table is a materialised view of
      // review's customer set used for non-admin scope enforcement.
      // An admin holds `customers:access-all`, which review reads as
      // `customer_ids = None` (all customers). On a fresh install the
      // local table can be sparser than review's — the bootstrap
      // admin must still be able to filter by a review customer ID
      // that hasn't been mirrored locally yet, otherwise the
      // pre-#405 P2 reproduction (admin opens `/en/detection?customers=1`
      // on an empty local table) re-emerges as an unrecoverable 403.
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([]);
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
        input: { customers: ["1"] },
      });

      expect(mockGraphqlRequest).toHaveBeenCalledOnce();
      const [, variables, context] = mockGraphqlRequest.mock.calls[0];
      // The filter passes through verbatim — admin scope delegation
      // means review is the authoritative customer-ID gate.
      expect(variables.filter.customers).toEqual(["1"]);
      // SysAdmin's JWT continues to omit `customer_ids` per the
      // `validate_context_jwt` contract.
      expect(context.customerIds).toBeUndefined();
    });

    it("rejects an empty-scope account before any REview dispatch", async () => {
      mockResolveEffectiveCustomerIds.mockResolvedValue([]);

      // Reviewer Round 2: empty-scope sessions surface as
      // `DetectionForbiddenError` (mapped to `forbidden-customer-
      // scope` at the route layer), the same authoritative customer-
      // scope gate as out-of-scope filter IDs. The important contract
      // remains that **no** REview dispatch occurs.
      const { searchEvents, DetectionForbiddenError } = await import(
        "@/lib/detection"
      );

      await expect(
        searchEvents(makeSession(), {
          mode: "structured",
          input: { customers: ["1"] },
        }),
      ).rejects.toBeInstanceOf(DetectionForbiddenError);

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

  // ── lookupIpLocation: typed review-error guardrail ─────────────
  //
  // #405 P1: `lookupIpLocation` is best-effort enrichment and used to
  // collapse every failure into `null`. That conflated "review denied
  // this query" with "no enrichment available", which the security
  // guardrails forbid. Typed review denials (Forbidden / argument
  // validation) must propagate so the caller can render an explicit
  // access-denied state; transient transport / unknown errors keep
  // the legacy null-fallback so a missing geo entry does not crash
  // the Investigation page.

  describe("lookupIpLocation — typed review errors", () => {
    beforeEach(() => {
      mockHasPermission.mockResolvedValue(true);
      mockResolveEffectiveCustomerIds.mockResolvedValue([7]);
    });

    it("re-throws ReviewForbiddenError instead of silently returning null", async () => {
      const { ReviewForbiddenError } = await import("@/lib/review/errors");
      mockGraphqlRequest.mockRejectedValue(
        new ReviewForbiddenError("Forbidden"),
      );

      const { lookupIpLocation } = await import("@/lib/detection");
      await expect(
        lookupIpLocation(makeSession(), "10.0.0.1"),
      ).rejects.toBeInstanceOf(ReviewForbiddenError);
    });

    it("re-throws ReviewInvalidArgumentError instead of silently returning null", async () => {
      const { ReviewInvalidArgumentError } = await import(
        "@/lib/review/errors"
      );
      mockGraphqlRequest.mockRejectedValue(
        new ReviewInvalidArgumentError("Invalid argument"),
      );

      const { lookupIpLocation } = await import("@/lib/detection");
      await expect(
        lookupIpLocation(makeSession(), "10.0.0.1"),
      ).rejects.toBeInstanceOf(ReviewInvalidArgumentError);
    });

    it("returns null for transient / unknown failures (best-effort decoration)", async () => {
      mockGraphqlRequest.mockRejectedValue(new Error("boom"));

      const { lookupIpLocation } = await import("@/lib/detection");
      const result = await lookupIpLocation(makeSession(), "10.0.0.1");
      expect(result).toBeNull();
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
