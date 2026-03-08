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
const mockProvisionCustomerDb = vi.hoisted(() => vi.fn());
const mockDropCustomerDb = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/db/migrate", () => ({
  provisionCustomerDb: vi.fn((...args: unknown[]) =>
    mockProvisionCustomerDb(...args),
  ),
  dropCustomerDb: vi.fn((...args: unknown[]) => mockDropCustomerDb(...args)),
}));

// ── Helpers ─────────────────────────────────────────────────────

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

const sampleCustomer = {
  id: 1,
  name: "Acme Corp",
  description: "A test customer",
  database_name: "customer_acme_corp_abc123",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function makeContext() {
  return { params: Promise.resolve({}) };
}

// ── GET /api/customers ──────────────────────────────────────────

describe("GET /api/customers", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
  });

  it("returns all customers when user has customers:access-all", async () => {
    mockQuery.mockResolvedValue({
      rows: [sampleCustomer],
      rowCount: 1,
    });

    const { GET } = await import("@/app/api/customers/route");
    const request = new NextRequest("http://localhost:3000/api/customers");
    const response = await GET(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("Acme Corp");
  });

  it("returns scoped customers when user lacks customers:access-all", async () => {
    // First call: hasPermission for customers:read → true
    // Second call: hasPermission for customers:access-all → false
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    mockQuery.mockResolvedValue({
      rows: [sampleCustomer],
      rowCount: 1,
    });

    const { GET } = await import("@/app/api/customers/route");
    const request = new NextRequest("http://localhost:3000/api/customers");
    const response = await GET(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);

    // Should have used JOIN with account_customer
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("account_customer"),
      [adminSession.accountId],
    );
  });

  it("returns 403 without customers:read permission", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { GET } = await import("@/app/api/customers/route");
    const request = new NextRequest("http://localhost:3000/api/customers");
    const response = await GET(request, makeContext());

    expect(response.status).toBe(403);
  });
});

// ── POST /api/customers ─────────────────────────────────────────

describe("POST /api/customers", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockProvisionCustomerDb.mockReset().mockResolvedValue(undefined);
    mockDropCustomerDb.mockReset().mockResolvedValue(undefined);
  });

  it("creates a customer and provisions its database", async () => {
    const provisionedCustomer = { ...sampleCustomer, status: "provisioning" };
    const activeCustomer = { ...sampleCustomer, status: "active" };

    mockQuery
      .mockResolvedValueOnce({ rows: [provisionedCustomer], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [activeCustomer], rowCount: 1 }); // UPDATE

    const { POST } = await import("@/app/api/customers/route");
    const request = new NextRequest("http://localhost:3000/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Acme Corp", description: "A test" }),
    });
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.status).toBe("active");
    expect(mockProvisionCustomerDb).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer.create",
        target: "customer",
      }),
    );
  });

  it("returns 400 when name is missing", async () => {
    const { POST } = await import("@/app/api/customers/route");
    const request = new NextRequest("http://localhost:3000/api/customers", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("name");
  });

  it("returns 400 for invalid JSON", async () => {
    const { POST } = await import("@/app/api/customers/route");
    const request = new NextRequest("http://localhost:3000/api/customers", {
      method: "POST",
      body: "not json",
    });
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("cleans up on provisioning failure", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...sampleCustomer, id: 42, status: "provisioning" }],
      rowCount: 1,
    });
    mockProvisionCustomerDb.mockRejectedValueOnce(
      new Error("DB create failed"),
    );

    const { POST } = await import("@/app/api/customers/route");
    const request = new NextRequest("http://localhost:3000/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Bad Customer" }),
    });

    await expect(POST(request, makeContext())).rejects.toThrow(
      "DB create failed",
    );

    // Should have deleted the row
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM customers"),
      [42],
    );
  });
});
