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
const mockWithTransaction = vi.hoisted(() => vi.fn());

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

const VALID_UUID = "00000000-0000-0000-0000-000000000001";
const TARGET_UUID = "00000000-0000-0000-0000-000000000002";

const adminSession: AuthSession = {
  accountId: VALID_UUID,
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

const tenantAdminSession: AuthSession = {
  ...adminSession,
  accountId: "00000000-0000-0000-0000-000000000003",
  roles: ["Tenant Administrator"],
};

const TENANT_ADMIN_PERMISSIONS = [
  "accounts:read",
  "accounts:write",
  "accounts:delete",
  "customers:read",
  "customers:write",
];

function makeAccountRoleRow(
  roleId: number,
  roleName: string,
  rolePermissions: string[],
) {
  return {
    id: TARGET_UUID,
    role_id: roleId,
    role_name: roleName,
    role_permissions: rolePermissions,
  };
}

function makeContext(id = TARGET_UUID) {
  return { params: Promise.resolve({ id }) };
}

// ── GET /api/accounts/[id]/customers ────────────────────────────

describe("GET /api/accounts/[id]/customers", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockGetAccountCustomerIds.mockReset();
  });

  it("returns customer assignments for System Administrator", async () => {
    // SELECT account exists
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }] })
      // SELECT assignments
      .mockResolvedValueOnce({
        rows: [
          { customer_id: 1, customer_name: "Acme Corp" },
          { customer_id: 2, customer_name: "Beta Inc" },
        ],
      });

    const { GET } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
    );
    const response = await GET(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].customer_name).toBe("Acme Corp");
  });

  it("scopes by tenant for Tenant Administrator", async () => {
    currentSession = tenantAdminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    // Account exists
    mockQuery.mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }] });

    // Caller has customers [1, 2], target has [2, 3] → overlap on 2
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller
      .mockResolvedValueOnce([2, 3]); // target

    // Assignments query
    mockQuery.mockResolvedValueOnce({
      rows: [{ customer_id: 2, customer_name: "Beta Inc" }],
    });

    const { GET } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
    );
    const response = await GET(request, makeContext());

    expect(response.status).toBe(200);
  });

  it("returns 404 when Tenant Admin has no overlap", async () => {
    currentSession = tenantAdminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    mockQuery.mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }] });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller
      .mockResolvedValueOnce([3, 4]); // target — no overlap

    const { GET } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
    );
    const response = await GET(request, makeContext());

    expect(response.status).toBe(404);
  });

  it("returns 404 when account does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { GET } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
    );
    const response = await GET(request, makeContext());

    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const { GET } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      "http://localhost:3000/api/accounts/not-a-uuid/customers",
    );
    const response = await GET(request, makeContext("not-a-uuid"));

    expect(response.status).toBe(400);
  });

  it("returns 403 without accounts:read permission", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { GET } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
    );
    const response = await GET(request, makeContext());

    expect(response.status).toBe(403);
  });
});

// ── POST /api/accounts/[id]/customers ───────────────────────────

describe("POST /api/accounts/[id]/customers", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockGetAccountCustomerIds.mockReset();
    mockWithTransaction.mockReset();
  });

  it("assigns customers as System Administrator", async () => {
    // Account exists with role
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeAccountRoleRow(2, "Tenant Administrator", TENANT_ADMIN_PERMISSIONS),
      ],
    });
    // Customers exist
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
    });

    // withTransaction executes the callback
    mockWithTransaction.mockImplementation(
      async (fn: (client: unknown) => unknown) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [] }),
        };
        return fn(mockClient);
      },
    );

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1, 2] }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.assigned).toEqual([1, 2]);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer.assign",
        target: "account",
        targetId: TARGET_UUID,
      }),
    );
  });

  it("returns 403 when Tenant Admin assigns out-of-scope customer", async () => {
    currentSession = tenantAdminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    // Account exists
    mockQuery.mockResolvedValueOnce({
      rows: [makeAccountRoleRow(3, "Security Monitor", [])],
    });
    // Customers exist
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 5 }],
    });
    // Caller only has customer 1
    mockGetAccountCustomerIds.mockResolvedValue([1]);

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1, 5] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(403);
  });

  it("returns 400 when Security Monitor would exceed single customer", async () => {
    // Account exists as Security Monitor
    mockQuery.mockResolvedValueOnce({
      rows: [makeAccountRoleRow(3, "Security Monitor", [])],
    });
    // Customers exist
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
    });

    // withTransaction: already has 0 assignments, but trying to add 2
    mockWithTransaction.mockImplementation(
      async (fn: (client: unknown) => unknown) => {
        const mockClient = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // COUNT
            .mockResolvedValueOnce({ rows: [] }), // SELECT existing
        };
        return fn(mockClient);
      },
    );

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1, 2] }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("single customer");
  });

  it("returns 400 when customerIds is missing", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
  });

  it("returns 400 when customerIds is empty", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
  });

  it("returns 404 when account does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(404);
  });

  it("returns 400 when a customer does not exist", async () => {
    // Account exists
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeAccountRoleRow(2, "Tenant Administrator", TENANT_ADMIN_PERMISSIONS),
      ],
    });
    // Only customer 1 found out of [1, 999]
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }],
    });

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1, 999] }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("999");
  });

  it("returns 400 for invalid JSON", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: "not json",
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
  });

  it("returns 403 without accounts:write permission", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid UUID", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      "http://localhost:3000/api/accounts/not-a-uuid/customers",
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1] }),
      },
    );
    const response = await POST(request, makeContext("not-a-uuid"));

    expect(response.status).toBe(400);
  });

  it("assigns customer as Tenant Admin within scope", async () => {
    currentSession = tenantAdminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      },
    );

    // Account exists
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeAccountRoleRow(2, "Tenant Administrator", TENANT_ADMIN_PERMISSIONS),
      ],
    });
    // Customer exists
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    // Caller has customer 1 in their scope
    mockGetAccountCustomerIds.mockResolvedValue([1, 2]);

    mockWithTransaction.mockImplementation(
      async (fn: (client: unknown) => unknown) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [] }),
        };
        return fn(mockClient);
      },
    );

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1] }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.assigned).toEqual([1]);
  });

  it("deduplicates customerIds", async () => {
    // Account exists
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeAccountRoleRow(2, "Tenant Administrator", TENANT_ADMIN_PERMISSIONS),
      ],
    });
    // Only unique IDs should be checked — [1, 2] not [1, 2, 1, 2]
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });

    mockWithTransaction.mockImplementation(
      async (fn: (client: unknown) => unknown) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [] }),
        };
        return fn(mockClient);
      },
    );

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1, 2, 1, 2] }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.assigned).toEqual([1, 2]);
  });

  it("returns 400 when Security Monitor already has 1 customer and adds another", async () => {
    // Account exists as Security Monitor
    mockQuery.mockResolvedValueOnce({
      rows: [makeAccountRoleRow(3, "Security Monitor", [])],
    });
    // Customer exists
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    // Already has 1 assignment, trying to add 1 new one → total 2 > 1
    mockWithTransaction.mockImplementation(
      async (fn: (client: unknown) => unknown) => {
        const mockClient = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: "1" }] }) // COUNT existing
            .mockResolvedValueOnce({ rows: [] }), // SELECT already assigned (none of requested)
        };
        return fn(mockClient);
      },
    );

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [2] }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("single customer");
  });

  it("allows Security Monitor to re-assign already assigned customer (idempotent)", async () => {
    // Account exists as Security Monitor
    mockQuery.mockResolvedValueOnce({
      rows: [makeAccountRoleRow(3, "Security Monitor", [])],
    });
    // Customer exists
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    // Already has 1 assignment, but the requested ID is the same one → no new IDs
    mockWithTransaction.mockImplementation(
      async (fn: (client: unknown) => unknown) => {
        const mockClient = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: "1" }] }) // COUNT existing
            .mockResolvedValueOnce({ rows: [{ customer_id: 1 }] }) // already assigned
            .mockResolvedValueOnce({ rows: [] }), // INSERT ON CONFLICT DO NOTHING
        };
        return fn(mockClient);
      },
    );

    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1] }),
      },
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
  });

  it("returns 400 when customerIds contains zero", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [0] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
  });

  it("returns 400 when customerIds contains non-integers", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [1.5] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
  });

  it("returns 400 when customerIds contains negative numbers", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: [-1] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
  });

  it("returns 400 when customerIds contains strings", async () => {
    const { POST } = await import("@/app/api/accounts/[id]/customers/route");
    const request = new NextRequest(
      `http://localhost:3000/api/accounts/${TARGET_UUID}/customers`,
      {
        method: "POST",
        body: JSON.stringify({ customerIds: ["abc"] }),
      },
    );
    const response = await POST(request, makeContext());

    expect(response.status).toBe(400);
  });
});
