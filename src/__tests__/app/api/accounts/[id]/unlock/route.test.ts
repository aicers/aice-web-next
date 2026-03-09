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
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

describe("POST /api/accounts/[id]/unlock", () => {
  const now = Math.floor(Date.now() / 1000);

  const adminSession: AuthSession = {
    accountId: "admin-1",
    sessionId: "session-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
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

  function makeRequest() {
    return new NextRequest(
      `http://localhost:3000/api/accounts/${targetAccountId}/unlock`,
      { method: "POST" },
    );
  }

  function makeContext() {
    return { params: Promise.resolve({ id: targetAccountId }) };
  }

  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
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
    mockGetAccountCustomerIds.mockResolvedValue([1]);
  });

  it("returns 403 when user lacks accounts:write permission", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(403);
  });

  it("returns 404 when account does not exist", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Account not found");
  });

  it("returns 404 when Tenant Admin targets an out-of-scope account", async () => {
    currentSession = tenantSession;
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: targetAccountId,
          role_name: "Security Monitor",
          status: "locked",
          lockout_count: 1,
        },
      ],
      rowCount: 1,
    });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2])
      .mockResolvedValueOnce([3]);

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(404);
  });

  it("returns 403 when Tenant Admin targets an in-scope Tenant Administrator", async () => {
    currentSession = tenantSession;
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: targetAccountId,
          role_name: "Tenant Administrator",
          status: "locked",
          lockout_count: 1,
        },
      ],
      rowCount: 1,
    });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2])
      .mockResolvedValueOnce([1]);

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain("Security Monitor");
  });

  it("unlocks a locked account", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: targetAccountId,
              role_name: "Security Monitor",
              status: "locked",
              lockout_count: 1,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, action: "unlocked" });

    // Verify UPDATE preserves lockout_count
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"),
      [targetAccountId],
    );
    const updateCall = mockQuery.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("UPDATE") &&
        args[0].includes("status = 'active'"),
    );
    expect(updateCall?.[0]).not.toContain("lockout_count");

    // Verify audit event
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.unlock",
        actor: "admin-1",
        target: "account",
        targetId: targetAccountId,
        details: { previousLockoutCount: 1 },
      }),
    );
  });

  it("restores a suspended account", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: targetAccountId,
              role_name: "Security Monitor",
              status: "suspended",
              lockout_count: 2,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, action: "restored" });

    // Verify UPDATE resets lockout_count
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("lockout_count = 0"),
      [targetAccountId],
    );

    // Verify audit event
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.restore",
        actor: "admin-1",
        target: "account",
        targetId: targetAccountId,
        details: { previousLockoutCount: 2 },
      }),
    );
  });

  it("unlocks a locked account with lockout_count=0", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: targetAccountId,
              role_name: "Security Monitor",
              status: "locked",
              lockout_count: 0,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, action: "unlocked" });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.unlock",
        details: { previousLockoutCount: 0 },
      }),
    );
  });

  it("unlock resets failed_sign_in_count for locked account", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: targetAccountId,
              role_name: "Security Monitor",
              status: "locked",
              lockout_count: 1,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    await POST(makeRequest(), makeContext());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("failed_sign_in_count = 0"),
      [targetAccountId],
    );
  });

  it("restore resets both failed_sign_in_count and lockout_count", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rows: [
            {
              id: targetAccountId,
              role_name: "Security Monitor",
              status: "suspended",
              lockout_count: 1,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    await POST(makeRequest(), makeContext());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("failed_sign_in_count = 0"),
      [targetAccountId],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("lockout_count = 0"),
      [targetAccountId],
    );
  });

  it("returns 400 for active account", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: targetAccountId,
          role_name: "Security Monitor",
          status: "active",
          lockout_count: 0,
        },
      ],
      rowCount: 1,
    });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Account is not locked or suspended");
  });

  it("returns 400 for disabled account", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: targetAccountId,
          role_name: "Security Monitor",
          status: "disabled",
          lockout_count: 0,
        },
      ],
      rowCount: 1,
    });

    const { POST } = await import("@/app/api/accounts/[id]/unlock/route");
    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(400);
  });
});
