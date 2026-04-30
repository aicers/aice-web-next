import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockGetEffectiveCustomerScope = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  getEffectiveCustomerScope: mockGetEffectiveCustomerScope,
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

describe("listCustomersForFilter", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockGetEffectiveCustomerScope.mockReset();
  });

  it("rejects a caller without detection:read", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { listCustomersForFilter, DetectionUnauthorizedError } = await import(
      "@/lib/detection"
    );

    await expect(listCustomersForFilter(makeSession())).rejects.toBeInstanceOf(
      DetectionUnauthorizedError,
    );
    expect(mockGetEffectiveCustomerScope).not.toHaveBeenCalled();
  });

  it("returns the assigned scope as { id, name } pairs", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockGetEffectiveCustomerScope.mockResolvedValue({
      kind: "assigned",
      customers: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Globex" },
      ],
    });

    const { listCustomersForFilter } = await import("@/lib/detection");
    const result = await listCustomersForFilter(makeSession());
    expect(result).toEqual({
      kind: "assigned",
      customers: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Globex" },
      ],
    });
  });

  it("returns kind:'admin' with the full registered customer list", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockGetEffectiveCustomerScope.mockResolvedValue({
      kind: "admin",
      customers: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Globex" },
        { id: 3, name: "Initech" },
      ],
    });

    const { listCustomersForFilter } = await import("@/lib/detection");
    const result = await listCustomersForFilter(
      makeSession({ roles: ["System Administrator"] }),
    );
    expect(result.kind).toBe("admin");
    expect(result.customers).toHaveLength(3);
  });

  it("returns kind:'empty' with an empty array (NOT an error)", async () => {
    // The drawer renders the disabled "No customer access" affordance
    // for `kind: 'empty'`; the BFF dispatch path is the authoritative
    // gate. Letting the helper succeed here keeps the drawer's
    // loading-vs-empty UI distinguishable.
    mockHasPermission.mockResolvedValue(true);
    mockGetEffectiveCustomerScope.mockResolvedValue({
      kind: "empty",
      customers: [],
    });

    const { listCustomersForFilter } = await import("@/lib/detection");
    const result = await listCustomersForFilter(makeSession());
    expect(result).toEqual({ kind: "empty", customers: [] });
  });
});
