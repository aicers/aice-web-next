import { print } from "graphql";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import { EVENT_BY_ID_QUERY } from "@/lib/detection/queries";
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
  id: "evt-AAAA-BBBB-CCCC",
};

describe("fetchEventByLocator", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGraphqlRequest.mockReset();
  });

  it("dispatches event(id:) with the locator's id and returns status:one on a hit", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest.mockResolvedValue({
      event: {
        __typename: "HttpThreat",
        id: LOCATOR.id,
        time: "2026-04-22T10:00:00.000000000Z",
        sensor: "sensor-1",
        confidence: 0.9,
        category: null,
        level: "HIGH",
        triageScores: null,
        origAddr: "10.0.0.5",
        respAddr: "203.0.113.45",
        origPort: 54321,
        respPort: 80,
        proto: 6,
      },
    });

    const { fetchEventByLocator } = await import("@/lib/detection");
    const result = await fetchEventByLocator(makeSession(), LOCATOR);

    expect(result.status).toBe("one");
    if (result.status === "one") {
      expect(result.event.id).toBe(LOCATOR.id);
    }
    const [, variables, context] = mockGraphqlRequest.mock.calls[0];
    expect(variables).toEqual({ id: LOCATOR.id });
    expect(context).toEqual({
      role: "Security Monitor",
      customerIds: [42],
    });
  });

  it('returns "zero" when event(id:) returns null', async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);
    mockGraphqlRequest.mockResolvedValue({ event: null });

    const { fetchEventByLocator } = await import("@/lib/detection");
    const result = await fetchEventByLocator(makeSession(), LOCATOR);
    expect(result).toEqual({ status: "zero" });
  });

  it("selects addressing fields for array-responder / array-originator subtypes", () => {
    const printed = print(EVENT_BY_ID_QUERY);
    // RdpBruteForce: singular origAddr + array respAddrs — without
    // this fragment the header endpoint summary drops for RDP events
    // and EndpointsTab has no destination address to render.
    const rdp = extractFragmentBody(printed, "RdpBruteForce");
    expect(rdp).toContain("respAddrs");
    expect(rdp).toMatch(/\borigAddr\b/);
    // ExternalDdos: array origAddrs + singular respAddr — symmetric
    // case. The fragment must actually deliver the array so the
    // Endpoints tab can render all originators.
    const ddos = extractFragmentBody(printed, "ExternalDdos");
    expect(ddos).toContain("origAddrs");
    expect(ddos).toMatch(/\brespAddr\b/);
  });

  it("encodes a token from an event id and resolves it back to status:one", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42]);

    const id = "evt-12345-abcde";
    const event = {
      __typename: "HttpThreat" as const,
      id,
      time: "2026-03-12T05:17:40.076967Z",
      sensor: "sensor-1",
      confidence: 0.9,
      category: null,
      level: "HIGH" as const,
      triageScores: null,
      origAddr: "10.0.0.5",
      respAddr: "203.0.113.45",
      origPort: 54321,
      respPort: 80,
      proto: 6,
    };

    const { encodeEventLocator, decodeEventLocator } = await import(
      "@/lib/events/event-locator"
    );
    const token = encodeEventLocator({ id });
    expect(token).not.toBeNull();
    const decoded = decodeEventLocator(token as string);
    expect(decoded).toEqual({ id });

    mockGraphqlRequest.mockImplementation(async (_doc, variables) => {
      const v = variables as { id: string };
      return v.id === id ? { event } : { event: null };
    });

    const { fetchEventByLocator } = await import("@/lib/detection");
    const result = await fetchEventByLocator(
      makeSession(),
      decoded as NonNullable<ReturnType<typeof decodeEventLocator>>,
    );
    expect(result.status).toBe("one");
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
