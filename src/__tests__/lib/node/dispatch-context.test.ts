import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Tenant Administrator"],
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

describe("buildDispatchContext", () => {
  beforeEach(() => {
    mockResolveEffectiveCustomerIds.mockReset();
  });

  it("rejects a non-System-Administrator with empty customer_ids", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { buildDispatchContext } = await import(
      "@/lib/node/dispatch-context"
    );
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(buildDispatchContext(makeSession())).rejects.toBeInstanceOf(
      NodePermissionError,
    );
  });

  it("allows a System Administrator through with empty customer_ids", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { buildDispatchContext } = await import(
      "@/lib/node/dispatch-context"
    );
    const ctx = await buildDispatchContext(
      makeSession({ roles: ["System Administrator"] }),
    );
    expect(ctx).toEqual({ role: "System Administrator", customerIds: [] });
  });

  it("returns a materialized customer_ids list for tenant admin", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([5, 9]);
    const { buildDispatchContext } = await import(
      "@/lib/node/dispatch-context"
    );
    const ctx = await buildDispatchContext(
      makeSession({ roles: ["Tenant Administrator"] }),
    );
    expect(ctx).toEqual({
      role: "Tenant Administrator",
      customerIds: [5, 9],
    });
  });
});

describe("assertNodeInScope", () => {
  it("permits a System Administrator regardless of customer", async () => {
    const { assertNodeInScope } = await import("@/lib/node/dispatch-context");
    expect(() =>
      assertNodeInScope({ role: "System Administrator", customerIds: [] }, 7),
    ).not.toThrow();
  });

  it("rejects a tenant admin scoped to customer 5 from touching customer 7", async () => {
    const { assertNodeInScope } = await import("@/lib/node/dispatch-context");
    const { NodePermissionError } = await import("@/lib/node/errors");
    expect(() =>
      assertNodeInScope({ role: "Tenant Administrator", customerIds: [5] }, 7),
    ).toThrow(NodePermissionError);
  });

  it("permits a tenant admin scoped to customer 5 to touch customer 5", async () => {
    const { assertNodeInScope } = await import("@/lib/node/dispatch-context");
    expect(() =>
      assertNodeInScope({ role: "Tenant Administrator", customerIds: [5] }, 5),
    ).not.toThrow();
  });
});
