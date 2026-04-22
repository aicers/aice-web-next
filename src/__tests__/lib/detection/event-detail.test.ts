import { print } from "graphql";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import { EVENT_DETAIL_QUERY } from "@/lib/detection/queries";
import type { EventLocator } from "@/lib/events/event-locator";

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

function extractFragmentBody(printed: string, typename: string): string {
  const idx = printed.indexOf(`... on ${typename}`);
  if (idx < 0) return "";
  const braceStart = printed.indexOf("{", idx);
  if (braceStart < 0) return "";
  let depth = 0;
  for (let i = braceStart; i < printed.length; i += 1) {
    const ch = printed[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return printed.slice(braceStart, i + 1);
    }
  }
  return "";
}

const LOCATOR: EventLocator = {
  sensor: "sensor-1",
  time: "2026-04-22T10:00:00.000000000Z",
  origAddr: "10.0.0.5",
  origPort: 54321,
  respAddr: "203.0.113.45",
  respPort: 80,
  proto: 6,
  kind: "HttpThreat",
  level: "HIGH",
};

describe("fetchEventByLocator", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGraphqlRequest.mockReset();
  });

  it("translates the locator into a tight EventListFilterInput", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest.mockResolvedValue({
      eventList: {
        totalCount: "1",
        nodes: [
          {
            __typename: "HttpThreat",
            time: LOCATOR.time,
            sensor: LOCATOR.sensor,
            confidence: 0.9,
            category: null,
            level: "HIGH",
            triageScores: null,
            origAddr: LOCATOR.origAddr,
            respAddr: LOCATOR.respAddr,
            origPort: LOCATOR.origPort,
            respPort: LOCATOR.respPort,
            proto: LOCATOR.proto,
          },
        ],
      },
    });

    const { fetchEventByLocator, locatorToEventListFilter } = await import(
      "@/lib/detection"
    );

    const filter = locatorToEventListFilter(LOCATOR);
    expect(filter).toEqual({
      start: LOCATOR.time,
      end: LOCATOR.time,
      source: LOCATOR.origAddr,
      destination: LOCATOR.respAddr,
      kinds: ["HttpThreat"],
      levels: [3],
    });

    const result = await fetchEventByLocator(makeSession(), LOCATOR);

    expect(result.status).toBe("one");
    const [, variables, context] = mockGraphqlRequest.mock.calls[0];
    expect(variables.filter).toEqual(filter);
    expect(context).toEqual({
      role: "Security Monitor",
      customerIds: [42],
    });
  });

  it('returns "zero" when eventList is empty', async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest.mockResolvedValue({
      eventList: { totalCount: "0", nodes: [] },
    });

    const { fetchEventByLocator } = await import("@/lib/detection");
    const result = await fetchEventByLocator(makeSession(), LOCATOR);
    expect(result).toEqual({ status: "zero" });
  });

  it('returns "multiple" when more than one event matches', async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    const nodes = [
      {
        __typename: "HttpThreat",
        time: LOCATOR.time,
        sensor: LOCATOR.sensor,
        confidence: 0.9,
        category: null,
        level: "HIGH",
        triageScores: null,
      },
      {
        __typename: "HttpThreat",
        time: LOCATOR.time,
        sensor: LOCATOR.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      },
    ];
    mockGraphqlRequest.mockResolvedValue({
      eventList: { totalCount: "2", nodes },
    });

    const { fetchEventByLocator } = await import("@/lib/detection");
    const result = await fetchEventByLocator(makeSession(), LOCATOR);

    expect(result.status).toBe("multiple");
    if (result.status === "multiple") {
      expect(result.event).toBe(nodes[0]);
      expect(result.totalCount).toBe("2");
    }
  });

  it("selects addressing fields for array-responder / array-originator subtypes", () => {
    const printed = print(EVENT_DETAIL_QUERY);
    // RdpBruteForce: singular origAddr + array respAddrs — without
    // this fragment the header endpoint summary drops for RDP events
    // and EndpointsTab has no destination address to render.
    const rdp = extractFragmentBody(printed, "RdpBruteForce");
    expect(rdp).toContain("respAddrs");
    expect(rdp).toMatch(/\borigAddr\b/);
    // ExternalDdos: array origAddrs + singular respAddr — symmetric
    // case. The header summary picks the first entry; the fragment
    // must actually deliver the array so the Endpoints tab can
    // render all originators once encoded locators land for the
    // subtype.
    const ddos = extractFragmentBody(printed, "ExternalDdos");
    expect(ddos).toContain("origAddrs");
    expect(ddos).toMatch(/\brespAddr\b/);
  });

  it("rejects callers without detection:read before dispatching", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { fetchEventByLocator, DetectionUnauthorizedError } = await import(
      "@/lib/detection"
    );
    await expect(
      fetchEventByLocator(makeSession(), LOCATOR),
    ).rejects.toBeInstanceOf(DetectionUnauthorizedError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});
