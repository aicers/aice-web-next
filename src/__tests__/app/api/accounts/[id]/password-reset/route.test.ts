import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
  session: AuthSession,
) => Promise<Response>;

interface WithAuthOptions {
  requiredPermissions?: string[];
}

const mockQuery = vi.hoisted(() => vi.fn());
const mockWithTransaction = vi.hoisted(() => vi.fn());
const mockHashPassword = vi.hoisted(() => vi.fn());
const mockValidatePassword = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());
const mockGetAccountCustomerIds = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn, options?: WithAuthOptions) => {
    return async (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> },
    ) => {
      if (options?.requiredPermissions) {
        for (const perm of options.requiredPermissions) {
          if (!(await mockHasPermission(currentSession.roles, perm))) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
        }
      }
      return handler(request, context, currentSession);
    };
  }),
}));

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  getAccountCustomerIds: vi.fn((...args: unknown[]) =>
    mockGetAccountCustomerIds(...args),
  ),
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
  withTransaction: vi.fn((...args: unknown[]) => mockWithTransaction(...args)),
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn((...args: unknown[]) => mockHashPassword(...args)),
}));

vi.mock("@/lib/auth/password-validator", () => ({
  validatePassword: vi.fn((...args: unknown[]) =>
    mockValidatePassword(...args),
  ),
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

describe("POST /api/accounts/[id]/password-reset", () => {
  const now = Math.floor(Date.now() / 1000);
  const TENANT_ADMIN_PERMISSIONS = [
    "accounts:read",
    "accounts:write",
    "accounts:delete",
    "customers:read",
    "customers:write",
  ];

  const adminSession: AuthSession = {
    accountId: "admin-1",
    sessionId: "session-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };
  const tenantSession: AuthSession = {
    ...adminSession,
    accountId: "tenant-1",
    roles: ["Tenant Administrator"],
  };

  const targetAccountId = "target-account-1";
  let mockClientQuery: ReturnType<typeof vi.fn>;

  function makeRequest(body: Record<string, unknown>) {
    return new NextRequest(
      `http://localhost:3000/api/accounts/${targetAccountId}/password-reset`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  function makeContext() {
    return { params: Promise.resolve({ id: targetAccountId }) };
  }

  function makeSelfContext() {
    return { params: Promise.resolve({ id: currentSession.accountId }) };
  }

  function makeTargetAccount(roleName: string, rolePermissions: string[]) {
    return {
      id: targetAccountId,
      role_id: roleName === "Tenant Administrator" ? 2 : 3,
      role_name: roleName,
      role_permissions: rolePermissions,
    };
  }

  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockWithTransaction.mockReset();
    mockHashPassword.mockReset();
    mockValidatePassword.mockReset();
    mockAuditRecord.mockReset();
    mockGetAccountCustomerIds.mockReset();
    mockHasPermission
      .mockReset()
      .mockImplementation(async (roles: string[], perm: string) => {
        if (perm === "accounts:write") {
          return (
            roles.includes("System Administrator") ||
            roles.includes("Tenant Administrator")
          );
        }
        return (
          perm === "customers:access-all" &&
          roles.includes("System Administrator")
        );
      });

    // Default: account exists
    mockQuery.mockResolvedValue({
      rows: [makeTargetAccount("Security Monitor", [])],
      rowCount: 1,
    });
    mockGetAccountCustomerIds.mockResolvedValue([1]);
    mockValidatePassword.mockResolvedValue({ valid: true, errors: [] });
    mockHashPassword.mockResolvedValue("$argon2id$newhash");
    mockClientQuery = vi.fn();
    mockWithTransaction.mockImplementation(
      async (fn: (client: { query: ReturnType<typeof vi.fn> }) => unknown) =>
        fn({ query: mockClientQuery }),
    );
  });

  it("returns 403 when user lacks accounts:write permission", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    const response = await POST(
      makeRequest({ newPassword: "TempPass123!abc" }),
      makeContext(),
    );

    expect(response.status).toBe(403);
  });

  it("returns 404 when target account does not exist", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    const response = await POST(
      makeRequest({ newPassword: "TempPass123!abc" }),
      makeContext(),
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 when attempting to reset own password", async () => {
    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    const response = await POST(
      makeRequest({ newPassword: "TempPass123!abc" }),
      makeSelfContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Cannot reset own password");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when Tenant Admin targets an out-of-scope account", async () => {
    currentSession = tenantSession;
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2])
      .mockResolvedValueOnce([3]);

    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    const response = await POST(
      makeRequest({ newPassword: "TempPass123!abc" }),
      makeContext(),
    );

    expect(response.status).toBe(404);
  });

  it("returns 403 when Tenant Admin targets an in-scope Tenant Administrator", async () => {
    currentSession = tenantSession;
    mockQuery.mockResolvedValue({
      rows: [
        makeTargetAccount("Tenant Administrator", TENANT_ADMIN_PERMISSIONS),
      ],
      rowCount: 1,
    });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2])
      .mockResolvedValueOnce([1]);

    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    const response = await POST(
      makeRequest({ newPassword: "TempPass123!abc" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain("Security Monitor");
  });

  it("returns 400 when password violates policy", async () => {
    mockValidatePassword.mockResolvedValue({
      valid: false,
      errors: ["TOO_SHORT"],
    });

    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    const response = await POST(
      makeRequest({ newPassword: "short" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.codes).toEqual(["TOO_SHORT"]);
  });

  it("returns 200 on successful reset", async () => {
    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    const response = await POST(
      makeRequest({ newPassword: "TempPass123!abc" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockWithTransaction).toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset",
        actor: "admin-1",
        target: "account",
        targetId: targetAccountId,
      }),
    );
  });

  it("passes skipReuse=true to validatePassword", async () => {
    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    await POST(makeRequest({ newPassword: "TempPass123!abc" }), makeContext());

    expect(mockValidatePassword).toHaveBeenCalledWith(
      "TempPass123!abc",
      targetAccountId,
      true,
    );
  });

  it("transaction sets must_change_password=true, bumps token_version, revokes sessions", async () => {
    const { POST } = await import(
      "@/app/api/accounts/[id]/password-reset/route"
    );
    await POST(makeRequest({ newPassword: "TempPass123!abc" }), makeContext());

    expect(mockClientQuery).toHaveBeenCalledTimes(3);

    // 1st call: UPDATE accounts — set hash, force must_change_password, bump token_version
    const updateCall = mockClientQuery.mock.calls[0];
    expect(updateCall[0]).toContain("UPDATE accounts");
    expect(updateCall[0]).toContain("must_change_password = true");
    expect(updateCall[0]).toContain("token_version = token_version + 1");
    expect(updateCall[1]).toEqual([targetAccountId, "$argon2id$newhash"]);

    // 2nd call: INSERT into password_history
    const historyCall = mockClientQuery.mock.calls[1];
    expect(historyCall[0]).toContain("INSERT INTO password_history");
    expect(historyCall[1]).toEqual([targetAccountId, "$argon2id$newhash"]);

    // 3rd call: Revoke ALL sessions (admin reset revokes all, unlike self-change)
    const revokeCall = mockClientQuery.mock.calls[2];
    expect(revokeCall[0]).toContain("UPDATE sessions SET revoked = true");
    expect(revokeCall[0]).not.toContain("sid !=");
    expect(revokeCall[1]).toEqual([targetAccountId]);
  });
});
