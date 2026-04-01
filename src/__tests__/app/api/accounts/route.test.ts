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
const mockHashPassword = vi.hoisted(() => vi.fn());
const mockValidatePassword = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn((...args: unknown[]) => mockHashPassword(...args)),
}));

vi.mock("@/lib/auth/password-validator", () => ({
  validatePassword: vi.fn((...args: unknown[]) =>
    mockValidatePassword(...args),
  ),
}));

vi.mock("@/lib/auth/bootstrap", () => ({
  MAX_SYSTEM_ADMINISTRATORS: 5,
}));

// ── Helpers ─────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

const ADMIN_UUID = "00000000-0000-0000-0000-000000000001";

const adminSession: AuthSession = {
  accountId: ADMIN_UUID,
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: now,
  exp: now + 900,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
  sessionIp: "127.0.0.1",
  sessionUserAgent: "test",
  sessionBrowserFingerprint: "Chrome/120",
  needsReauth: false,
};

const tenantSession: AuthSession = {
  ...adminSession,
  accountId: "00000000-0000-0000-0000-000000000010",
  roles: ["Tenant Administrator"],
};

const SYSTEM_ADMIN_PERMISSIONS = [
  "accounts:read",
  "accounts:write",
  "accounts:delete",
  "roles:read",
  "roles:write",
  "roles:delete",
  "customers:read",
  "customers:write",
  "customers:access-all",
  "audit-logs:read",
  "system-settings:read",
  "system-settings:write",
];

const TENANT_ADMIN_PERMISSIONS = [
  "accounts:read",
  "accounts:write",
  "accounts:delete",
  "customers:read",
  "customers:write",
];

function makeRoleRow(id: number, name: string, permissions: string[]) {
  return { id, name, permissions };
}

function makeContext() {
  return { params: Promise.resolve({}) };
}

// ── Tests ───────────────────────────────────────────────────────

describe("GET /api/accounts", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetAccountCustomerIds.mockReset();
    mockHasPermission.mockReset();
    currentSession = adminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) =>
        perm !== "customers:access-all"
          ? currentSession.roles.includes("System Administrator") ||
            currentSession.roles.includes("Tenant Administrator")
          : currentSession.roles.includes("System Administrator"),
    );
  });

  it("returns paginated accounts for System Administrator", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [{ count: "2" }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "id1",
          username: "user1",
          role_name: "Security Monitor",
          status: "active",
        },
        {
          id: "id2",
          username: "user2",
          role_name: "Tenant Administrator",
          status: "active",
        },
      ],
      rowCount: 2,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts");
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
  });

  it("scopes results for Tenant Administrator", async () => {
    currentSession = tenantSession;
    const { GET } = await import("@/app/api/accounts/route");
    mockGetAccountCustomerIds.mockResolvedValue([1, 2]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ count: "1" }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "id1", username: "user1" }],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts");
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toHaveLength(1);
  });

  it("returns empty for Tenant Admin with no customer assignments", async () => {
    currentSession = tenantSession;
    const { GET } = await import("@/app/api/accounts/route");
    mockGetAccountCustomerIds.mockResolvedValue([]);

    const request = new NextRequest("http://localhost:3000/api/accounts");
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("applies search filter", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?search=admin",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ILIKE"),
      expect.arrayContaining(["%admin%"]),
    );
  });

  it("applies role filter", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?role=Security+Monitor",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("r.name ="),
      expect.arrayContaining(["Security Monitor"]),
    );
  });

  it("returns 403 without accounts:read permission", async () => {
    currentSession = {
      ...adminSession,
      roles: ["Security Monitor"],
    };
    const { GET } = await import("@/app/api/accounts/route");
    mockHasPermission.mockResolvedValue(false);

    const request = new NextRequest("http://localhost:3000/api/accounts");
    const response = await GET(request, makeContext());
    expect(response.status).toBe(403);
  });

  it("applies status filter", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?status=active",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("a.status ="),
      expect.arrayContaining(["active"]),
    );
  });

  it("applies customer filter", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?customerId=5",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ac.customer_id ="),
      expect.arrayContaining([5]),
    );
  });

  it("respects pagination parameters", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "50" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?page=3&pageSize=10",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.page).toBe(3);
    expect(body.pageSize).toBe(10);
    // offset = (3-1) * 10 = 20
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT"),
      expect.arrayContaining([10, 20]),
    );
  });

  it("ignores invalid status filter value", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?status=hacked",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    // "hacked" is not in VALID_STATUSES, so no status filter should be applied
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("a.status ="),
      expect.anything(),
    );
  });

  it("ignores invalid customerIdFilter", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?customerId=abc",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("ac.customer_id ="),
      expect.anything(),
    );
  });

  it("clamps page to minimum of 1", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?page=-5",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.page).toBe(1);
  });

  it("clamps negative pageSize to minimum of 1", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?pageSize=-5",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pageSize).toBe(1);
  });

  it("applies multiple filters simultaneously", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?search=test&role=Security+Monitor&status=active",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ILIKE"),
      expect.arrayContaining(["%test%", "Security Monitor", "active"]),
    );
  });

  it("caps pageSize at MAX_PAGE_SIZE", async () => {
    const { GET } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest(
      "http://localhost:3000/api/accounts?pageSize=999",
    );
    const response = await GET(request, makeContext());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pageSize).toBe(100);
  });
});

describe("POST /api/accounts", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset();
    mockGetAccountCustomerIds.mockReset();
    mockWithTransaction.mockReset();
    mockHashPassword.mockReset();
    mockValidatePassword.mockReset();
    currentSession = adminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) =>
        perm !== "customers:access-all"
          ? currentSession.roles.includes("System Administrator") ||
            currentSession.roles.includes("Tenant Administrator")
          : currentSession.roles.includes("System Administrator"),
    );
    mockHashPassword.mockResolvedValue("$argon2id$hashed");
    mockValidatePassword.mockResolvedValue({ valid: true, errors: [] });
    mockAuditRecord.mockResolvedValue(undefined);
  });

  it("creates an account successfully", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    // Role lookup
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(3, "Security Monitor", [])],
      rowCount: 1,
    });
    // Customer existence check
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }],
      rowCount: 1,
    });
    // Transaction: username check + insert + customer assign + password history
    const newId = "00000000-0000-0000-0000-000000000099";
    mockWithTransaction.mockImplementation(
      async (fn: (...args: unknown[]) => unknown) => {
        const client = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // username check
            .mockResolvedValueOnce({ rows: [{ id: newId }], rowCount: 1 }) // insert account
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // customer assign
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }), // password history
        };
        return fn(client);
      },
    );
    // Fetch created account
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: newId,
          username: "newuser",
          role_name: "Security Monitor",
          status: "active",
        },
      ],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "newuser",
        displayName: "New User",
        password: "SecurePass1!",
        roleId: 3,
        customerIds: [1],
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.data.username).toBe("newuser");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.create",
        target: "account",
      }),
    );
  });

  it("returns 400 when missing username", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        displayName: "Test",
        password: "Pass1234!",
        roleId: 3,
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("username");
  });

  it("returns 400 when missing displayName", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        password: "Pass1234!",
        roleId: 3,
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("displayName");
  });

  it("returns 400 when missing password", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        roleId: 3,
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("password");
  });

  it("returns 400 when missing roleId", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("roleId");
  });

  it("returns 400 when role not found", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 999,
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Role not found");
  });

  it("returns 403 when Tenant Admin tries to create non-Security Monitor", async () => {
    currentSession = tenantSession;
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(2, "Tenant Administrator", TENANT_ADMIN_PERMISSIONS)],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 2,
        customerIds: [1],
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(403);
  });

  it("returns 400 when System Admin count limit reached", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(1, "System Administrator", SYSTEM_ADMIN_PERMISSIONS)],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ count: "5" }],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 1,
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Maximum");
  });

  it("returns 400 when non-SysAdmin has no customerIds", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(3, "Security Monitor", [])],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 3,
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Customer assignment is required");
  });

  it("returns 400 when Security Monitor has more than 1 customer", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(3, "Security Monitor", [])],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 3,
        customerIds: [1, 2],
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("single customer");
  });

  it("returns 409 when username already exists", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(3, "Security Monitor", [])],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockWithTransaction.mockImplementation(
      async (fn: (...args: unknown[]) => unknown) => {
        const client = {
          query: vi.fn().mockResolvedValueOnce({
            rows: [{ id: "existing-id" }],
            rowCount: 1,
          }),
        };
        return fn(client);
      },
    );

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "existing",
        displayName: "Existing",
        password: "Pass1234!",
        roleId: 3,
        customerIds: [1],
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(409);
  });

  it("returns 400 when password fails validation", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(1, "System Administrator", SYSTEM_ADMIN_PERMISSIONS)],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    mockValidatePassword.mockResolvedValueOnce({
      valid: false,
      errors: ["TOO_SHORT"],
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "short",
        roleId: 1,
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details).toContain("TOO_SHORT");
  });

  it("returns 400 when customerIds contain non-positive integers", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(3, "Security Monitor", [])],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 3,
        customerIds: [0],
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("positive integers");
  });

  it("returns 400 when customerIds reference non-existent customers", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    // Role lookup → Tenant Administrator
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(2, "Tenant Administrator", TENANT_ADMIN_PERMISSIONS)],
      rowCount: 1,
    });
    // Customer existence check → only id=1 found, id=999 missing
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 2,
        customerIds: [1, 999],
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Customers not found");
    expect(body.error).toContain("999");
  });

  it("creates account with optional email and phone", async () => {
    const { POST } = await import("@/app/api/accounts/route");
    const newId = "00000000-0000-0000-0000-000000000088";
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(3, "Security Monitor", [])],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockWithTransaction.mockImplementation(
      async (fn: (...args: unknown[]) => unknown) => {
        const client = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [{ id: newId }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
        };
        return fn(client);
      },
    );
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: newId,
          username: "withcontact",
          email: "test@example.com",
          phone: "1234567890",
          role_name: "Security Monitor",
          status: "active",
        },
      ],
      rowCount: 1,
    });

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "withcontact",
        displayName: "With Contact",
        password: "SecurePass1!",
        roleId: 3,
        customerIds: [1],
        email: "  test@example.com  ",
        phone: "  1234567890  ",
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.email).toBe("test@example.com");
    expect(body.data.phone).toBe("1234567890");
  });

  it("returns 403 when Tenant Admin assigns out-of-scope customers", async () => {
    currentSession = tenantSession;
    const { POST } = await import("@/app/api/accounts/route");
    mockQuery.mockResolvedValueOnce({
      rows: [makeRoleRow(3, "Security Monitor", [])],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
    mockGetAccountCustomerIds.mockResolvedValue([1, 2]);

    const request = new NextRequest("http://localhost:3000/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        username: "test",
        displayName: "Test",
        password: "Pass1234!",
        roleId: 3,
        customerIds: [5],
      }),
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(403);
  });
});
