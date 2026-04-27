import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
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
    mockHasPermission.mockReset();
  });

  it("rejects a caller without customers:access-all and empty customer_ids", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockHasPermission.mockResolvedValue(false);
    const { buildDispatchContext } = await import(
      "@/lib/node/dispatch-context"
    );
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(buildDispatchContext(makeSession())).rejects.toBeInstanceOf(
      NodePermissionError,
    );
  });

  it("allows a caller with customers:access-all through with empty customer_ids", async () => {
    // Bypass is keyed off the effective `customers:access-all`
    // permission rather than the audit-only role string, so a custom
    // role granting that permission (or a multi-role account whose
    // first role is not "System Administrator") is treated correctly.
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockHasPermission.mockImplementation(
      async (_roles: string[], permission: string) =>
        permission === "customers:access-all",
    );
    const { buildDispatchContext } = await import(
      "@/lib/node/dispatch-context"
    );
    const ctx = await buildDispatchContext(
      makeSession({ roles: ["Custom Auditor", "System Administrator"] }),
    );
    expect(ctx).toEqual({
      role: "Custom Auditor",
      customerIds: [],
      hasGlobalScope: true,
    });
  });

  it("returns a materialized customer_ids list for tenant admin", async () => {
    mockResolveEffectiveCustomerIds.mockResolvedValue([5, 9]);
    mockHasPermission.mockResolvedValue(false);
    const { buildDispatchContext } = await import(
      "@/lib/node/dispatch-context"
    );
    const ctx = await buildDispatchContext(
      makeSession({ roles: ["Tenant Administrator"] }),
    );
    expect(ctx).toEqual({
      role: "Tenant Administrator",
      customerIds: [5, 9],
      hasGlobalScope: false,
    });
  });
});

describe("assertNodeInScope", () => {
  it("permits a caller with hasGlobalScope=true regardless of customer", async () => {
    const { assertNodeInScope } = await import("@/lib/node/dispatch-context");
    expect(() =>
      assertNodeInScope(
        { role: "Custom Auditor", customerIds: [], hasGlobalScope: true },
        7,
      ),
    ).not.toThrow();
  });

  it("rejects a tenant admin scoped to customer 5 from touching customer 7", async () => {
    const { assertNodeInScope } = await import("@/lib/node/dispatch-context");
    const { NodePermissionError } = await import("@/lib/node/errors");
    expect(() =>
      assertNodeInScope(
        {
          role: "Tenant Administrator",
          customerIds: [5],
          hasGlobalScope: false,
        },
        7,
      ),
    ).toThrow(NodePermissionError);
  });

  it("permits a tenant admin scoped to customer 5 to touch customer 5", async () => {
    const { assertNodeInScope } = await import("@/lib/node/dispatch-context");
    expect(() =>
      assertNodeInScope(
        {
          role: "Tenant Administrator",
          customerIds: [5],
          hasGlobalScope: false,
        },
        5,
      ),
    ).not.toThrow();
  });

  it("permits a multi-role caller whose first role is not 'System Administrator' but who carries customers:access-all", async () => {
    // Regression for Round 6: the privileged-caller bypass must follow
    // effective scope, not the audit-only `role` string.
    const { assertNodeInScope } = await import("@/lib/node/dispatch-context");
    expect(() =>
      assertNodeInScope(
        {
          role: "Tenant Administrator",
          customerIds: [5],
          hasGlobalScope: true,
        },
        99,
      ),
    ).not.toThrow();
  });
});
