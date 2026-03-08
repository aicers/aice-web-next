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

// ── Helpers ─────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

const ACCOUNT_UUID = "00000000-0000-0000-0000-000000000001";

const adminSession: AuthSession = {
  accountId: ACCOUNT_UUID,
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

const tenantAdminSession: AuthSession = {
  ...adminSession,
  accountId: "00000000-0000-0000-0000-000000000003",
  roles: ["Tenant Administrator"],
};

const TARGET_UUID = "00000000-0000-0000-0000-000000000002";

function makeContext(id = TARGET_UUID, customerId = "1") {
  return { params: Promise.resolve({ id, customerId }) };
}

// ── DELETE /api/accounts/[id]/customers/[customerId] ────────────

describe("DELETE /api/accounts/[id]/customers/[customerId]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockGetAccountCustomerIds.mockReset();
  });

  it("removes assignment as System Administrator", async () => {
    // Assignment exists
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ account_id: TARGET_UUID, customer_id: 1 }],
      })
      // DELETE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/1`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer.unassign",
        target: "account",
        targetId: TARGET_UUID,
        details: { customerId: 1 },
      }),
    );
  });

  it("returns 404 when assignment does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/999`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(TARGET_UUID, "999"));

    expect(response.status).toBe(404);
  });

  it("returns 403 when Tenant Admin unassigns out-of-scope customer", async () => {
    currentSession = tenantAdminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    // Assignment exists
    mockQuery.mockResolvedValueOnce({
      rows: [{ account_id: TARGET_UUID, customer_id: 5 }],
    });

    // Caller's customers don't include 5
    mockGetAccountCustomerIds.mockResolvedValue([1, 2]);

    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/5`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(TARGET_UUID, "5"));

    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid account ID", async () => {
    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      "http://localhost:3000/api/accounts/not-uuid/customers/1",
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext("not-uuid", "1"));

    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid customer ID", async () => {
    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/abc`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(TARGET_UUID, "abc"));

    expect(response.status).toBe(400);
  });

  it("returns 403 without accounts:write permission", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/1`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext());

    expect(response.status).toBe(403);
  });

  it("removes assignment as Tenant Admin within scope", async () => {
    currentSession = tenantAdminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    // Assignment exists
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ account_id: TARGET_UUID, customer_id: 1 }],
      })
      // DELETE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Caller has customer 1 in scope
    mockGetAccountCustomerIds.mockResolvedValue([1, 2]);

    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/1`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer.unassign",
        target: "account",
        targetId: TARGET_UUID,
        details: { customerId: 1 },
      }),
    );
  });

  it("returns 400 for zero customer ID", async () => {
    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/0`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(TARGET_UUID, "0"));

    expect(response.status).toBe(400);
  });

  it("returns 400 for negative customer ID", async () => {
    const { DELETE } = await import(
      "@/app/api/accounts/[id]/customers/[customerId]/route"
    );
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers/-1`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, makeContext(TARGET_UUID, "-1"));

    expect(response.status).toBe(400);
  });
});
