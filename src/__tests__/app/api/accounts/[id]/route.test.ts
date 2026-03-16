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

vi.mock("@/lib/auth/bootstrap", () => ({
  MAX_SYSTEM_ADMINISTRATORS: 5,
}));

// ── Helpers ─────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

const ADMIN_UUID = "00000000-0000-0000-0000-000000000001";
const TARGET_UUID = "00000000-0000-0000-0000-000000000002";

const adminSession: AuthSession = {
  accountId: ADMIN_UUID,
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
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

function makeRoleLookupRow(id: number, name: string, permissions: string[]) {
  return { id, name, permissions };
}

function makeContext(id = TARGET_UUID) {
  return { params: Promise.resolve({ id }) };
}

const targetRow = {
  id: TARGET_UUID,
  username: "target-user",
  display_name: "Target User",
  email: null,
  phone: null,
  role_id: 3,
  role_name: "Security Monitor",
  role_permissions: [] as string[],
  status: "active",
  last_sign_in_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ── Tests ───────────────────────────────────────────────────────

describe("GET /api/accounts/[id]", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockGetAccountCustomerIds.mockReset();
    mockHasPermission.mockReset();
    currentSession = adminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (
          perm === "accounts:read" ||
          perm === "accounts:write" ||
          perm === "accounts:delete"
        ) {
          return (
            currentSession.roles.includes("System Administrator") ||
            currentSession.roles.includes("Tenant Administrator")
          );
        }
        return (
          perm === "customers:access-all" &&
          currentSession.roles.includes("System Administrator")
        );
      },
    );
    mockAuditRecord.mockResolvedValue(undefined);
  });

  it("returns account for System Administrator", async () => {
    const { GET } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.username).toBe("target-user");
  });

  it("returns 400 for invalid UUID", async () => {
    const { GET } = await import("@/app/api/accounts/[id]/route");

    const response = await GET(
      new NextRequest("http://localhost:3000/api/accounts/not-a-uuid"),
      makeContext("not-a-uuid"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for non-existent account", async () => {
    const { GET } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when Tenant Admin accesses out-of-scope account", async () => {
    currentSession = tenantSession;
    const { GET } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([3]); // target customers (no overlap)

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("allows Tenant Admin to view own account without customer overlap", async () => {
    currentSession = tenantSession;
    const { GET } = await import("@/app/api/accounts/[id]/route");
    const selfRow = {
      ...targetRow,
      id: tenantSession.accountId,
      username: "tenant-self",
    };
    mockQuery.mockResolvedValueOnce({ rows: [selfRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1]) // caller customers
      .mockResolvedValueOnce([3]); // target (self) customers - no overlap

    const response = await GET(
      new NextRequest(
        `http://localhost:3000/api/accounts/${tenantSession.accountId}`,
      ),
      makeContext(tenantSession.accountId),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.username).toBe("tenant-self");
  });

  it("allows Tenant Admin to access in-scope account", async () => {
    currentSession = tenantSession;
    const { GET } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap on 1)

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.username).toBe("target-user");
  });
});

describe("PATCH /api/accounts/[id]", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockGetAccountCustomerIds.mockReset();
    mockHasPermission.mockReset();
    currentSession = adminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (
          perm === "accounts:read" ||
          perm === "accounts:write" ||
          perm === "accounts:delete"
        ) {
          return (
            currentSession.roles.includes("System Administrator") ||
            currentSession.roles.includes("Tenant Administrator")
          );
        }
        return (
          perm === "customers:access-all" &&
          currentSession.roles.includes("System Administrator")
        );
      },
    );
    mockAuditRecord.mockResolvedValue(undefined);
  });

  it("allows self-update of basic fields without accounts:write", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const selfRow = { ...targetRow, id: ADMIN_UUID, username: "admin" };
    mockQuery
      .mockResolvedValueOnce({ rows: [selfRow], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [{ id: ADMIN_UUID }], rowCount: 1 }) // update
      .mockResolvedValueOnce({
        rows: [{ ...selfRow, display_name: "Updated" }],
        rowCount: 1,
      }); // refetch

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${ADMIN_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Updated" }),
      }),
      makeContext(ADMIN_UUID),
    );
    expect(response.status).toBe(200);
  });

  it("returns 403 when updating other account without accounts:write", async () => {
    currentSession = { ...adminSession, roles: ["Security Monitor"] };
    mockHasPermission.mockResolvedValue(false);
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Changed" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 when trying to change own role", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const selfRow = {
      ...targetRow,
      id: ADMIN_UUID,
      role_name: "System Administrator",
    };
    mockQuery.mockResolvedValueOnce({ rows: [selfRow], rowCount: 1 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${ADMIN_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 2 }),
      }),
      makeContext(ADMIN_UUID),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot change own role");
  });

  it("returns 400 when trying to change own status", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const selfRow = { ...targetRow, id: ADMIN_UUID };
    mockQuery.mockResolvedValueOnce({ rows: [selfRow], rowCount: 1 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${ADMIN_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "disabled" }),
      }),
      makeContext(ADMIN_UUID),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot change own status");
  });

  it("returns 400 for invalid UUID on PATCH", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");

    const response = await PATCH(
      new NextRequest("http://localhost:3000/api/accounts/not-a-uuid", {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Changed" }),
      }),
      makeContext("not-a-uuid"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 when account does not exist on PATCH", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Changed" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 403 when changing roleId without accounts:write", async () => {
    currentSession = { ...adminSession, roles: ["Security Monitor"] };
    mockHasPermission.mockResolvedValue(false);
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 2 }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 when changing status without accounts:write", async () => {
    currentSession = { ...adminSession, roles: ["Security Monitor"] };
    mockHasPermission.mockResolvedValue(false);
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 when role not found during role change", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery
      .mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // role lookup (not found)

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 999 }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Role not found");
  });

  it("returns 400 when demoting last System Administrator", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const sysAdminTarget = {
      ...targetRow,
      role_id: 1,
      role_name: "System Administrator",
      role_permissions: SYSTEM_ADMIN_PERMISSIONS,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [sysAdminTarget], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({
        rows: [
          makeRoleLookupRow(
            2,
            "Tenant Administrator",
            TENANT_ADMIN_PERMISSIONS,
          ),
        ],
        rowCount: 1,
      }) // role lookup
      .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 }); // count

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 2 }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("last System Administrator");
  });

  it("returns 400 when promoting to SysAdmin at max limit", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery
      .mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({
        rows: [
          makeRoleLookupRow(
            1,
            "System Administrator",
            SYSTEM_ADMIN_PERMISSIONS,
          ),
        ],
        rowCount: 1,
      }) // role lookup
      .mockResolvedValueOnce({ rows: [{ count: "5" }], rowCount: 1 }); // count at max

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 1 }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Maximum");
  });

  it("updates status to non-disabled value without bumping token_version", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const lockedTarget = { ...targetRow, status: "locked" };
    mockQuery
      .mockResolvedValueOnce({ rows: [lockedTarget], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }], rowCount: 1 }) // update
      .mockResolvedValueOnce({
        rows: [{ ...lockedTarget, status: "active" }],
        rowCount: 1,
      }); // refetch

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    // Should NOT contain token_version bump
    expect(mockQuery).toHaveBeenCalledWith(
      expect.not.stringContaining("token_version"),
      expect.anything(),
    );
  });

  it("updates email and phone fields", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery
      .mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }], rowCount: 1 }) // update
      .mockResolvedValueOnce({
        rows: [
          {
            ...targetRow,
            email: "new@example.com",
            phone: "5551234",
          },
        ],
        rowCount: 1,
      }); // refetch

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({
          email: "new@example.com",
          phone: "5551234",
        }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.email).toBe("new@example.com");
    expect(body.data.phone).toBe("5551234");
  });

  it("allows Tenant Admin to update in-scope account", async () => {
    currentSession = tenantSession;
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }], rowCount: 1 }) // update
      .mockResolvedValueOnce({
        rows: [{ ...targetRow, display_name: "Updated" }],
        rowCount: 1,
      }); // refetch

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Updated" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
  });

  it("allows Tenant Admin to update status for in-scope Security Monitor", async () => {
    currentSession = tenantSession;
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const lockedTarget = { ...targetRow, status: "locked" };
    mockQuery.mockResolvedValueOnce({ rows: [lockedTarget], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }], rowCount: 1 }) // update
      .mockResolvedValueOnce({
        rows: [{ ...lockedTarget, status: "active" }],
        rowCount: 1,
      }); // refetch

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
  });

  it("returns 404 when Tenant Admin tries to update out-of-scope account", async () => {
    currentSession = tenantSession;
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([3]); // target customers (no overlap)

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Changed" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 403 when Tenant Admin tries to update in-scope Tenant Administrator account", async () => {
    currentSession = tenantSession;
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const tenantAdminTarget = {
      ...targetRow,
      role_id: 2,
      role_name: "Tenant Administrator",
      role_permissions: TENANT_ADMIN_PERMISSIONS,
    };
    mockQuery.mockResolvedValueOnce({ rows: [tenantAdminTarget], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Changed" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Security Monitor");
  });

  it("returns 403 when Tenant Admin tries to change status of in-scope Tenant Administrator account", async () => {
    currentSession = tenantSession;
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    const tenantAdminTarget = {
      ...targetRow,
      role_id: 2,
      role_name: "Tenant Administrator",
      role_permissions: TENANT_ADMIN_PERMISSIONS,
    };
    mockQuery.mockResolvedValueOnce({ rows: [tenantAdminTarget], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "disabled" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Security Monitor");
  });

  it("updates status and bumps token_version when disabling", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery
      .mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }], rowCount: 1 }) // update
      .mockResolvedValueOnce({
        rows: [{ ...targetRow, status: "disabled" }],
        rowCount: 1,
      }); // refetch

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "disabled" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("token_version = token_version + 1"),
      expect.anything(),
    );
  });

  it("returns 400 for invalid status value", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "hacked" }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid status");
  });

  it("returns 403 when Tenant Admin tries to assign System Administrator role", async () => {
    currentSession = tenantSession;
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeRoleLookupRow(1, "System Administrator", SYSTEM_ADMIN_PERMISSIONS),
      ],
      rowCount: 1,
    });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 1 }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Security Monitor");
  });

  it("returns 403 when Tenant Admin tries to assign Tenant Administrator role", async () => {
    currentSession = tenantSession;
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeRoleLookupRow(2, "Tenant Administrator", TENANT_ADMIN_PERMISSIONS),
      ],
      rowCount: 1,
    });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 2 }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Security Monitor");
  });

  it("returns existing data when no updates provided", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.username).toBe("target-user");
  });

  it("updates role and audits the change", async () => {
    const { PATCH } = await import("@/app/api/accounts/[id]/route");
    mockQuery
      .mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({
        rows: [
          makeRoleLookupRow(
            2,
            "Tenant Administrator",
            TENANT_ADMIN_PERMISSIONS,
          ),
        ],
        rowCount: 1,
      }) // role lookup
      .mockResolvedValueOnce({ rows: [{ id: TARGET_UUID }], rowCount: 1 }) // update
      .mockResolvedValueOnce({
        rows: [
          {
            ...targetRow,
            role_id: 2,
            role_name: "Tenant Administrator",
            role_permissions: TENANT_ADMIN_PERMISSIONS,
          },
        ],
        rowCount: 1,
      }); // refetch

    const response = await PATCH(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId: 2 }),
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.update",
        target: "account",
        targetId: TARGET_UUID,
      }),
    );
  });
});

describe("DELETE /api/accounts/[id]", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
    mockGetAccountCustomerIds.mockReset();
    mockHasPermission.mockReset();
    currentSession = adminSession;
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => {
        if (
          perm === "accounts:read" ||
          perm === "accounts:write" ||
          perm === "accounts:delete"
        ) {
          return (
            currentSession.roles.includes("System Administrator") ||
            currentSession.roles.includes("Tenant Administrator")
          );
        }
        return (
          perm === "customers:access-all" &&
          currentSession.roles.includes("System Administrator")
        );
      },
    );
    mockAuditRecord.mockResolvedValue(undefined);
  });

  it("soft-deletes an account", async () => {
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    mockQuery
      .mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // update

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'disabled'"),
      [TARGET_UUID],
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.delete",
        target: "account",
        targetId: TARGET_UUID,
      }),
    );
  });

  it("returns 400 when deleting own account", async () => {
    const { DELETE } = await import("@/app/api/accounts/[id]/route");

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${ADMIN_UUID}`, {
        method: "DELETE",
      }),
      makeContext(ADMIN_UUID),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot delete own account");
  });

  it("returns 404 for non-existent account", async () => {
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when target is already disabled", async () => {
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...targetRow, status: "disabled" }],
      rowCount: 1,
    });

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("already disabled");
  });

  it("returns 400 when deleting last System Administrator", async () => {
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    const sysAdminTarget = {
      ...targetRow,
      role_id: 1,
      role_name: "System Administrator",
      role_permissions: SYSTEM_ADMIN_PERMISSIONS,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [sysAdminTarget], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 }); // count check

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("last System Administrator");
  });

  it("returns 403 when Tenant Admin tries to delete in-scope System Administrator", async () => {
    currentSession = tenantSession;
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    const sysAdminTarget = {
      ...targetRow,
      role_id: 1,
      role_name: "System Administrator",
      role_permissions: SYSTEM_ADMIN_PERMISSIONS,
    };
    mockQuery.mockResolvedValueOnce({
      rows: [sysAdminTarget],
      rowCount: 1,
    });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Security Monitor");
  });

  it("returns 403 when Tenant Admin tries to delete in-scope Tenant Administrator", async () => {
    currentSession = tenantSession;
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    const tenantAdminTarget = {
      ...targetRow,
      role_id: 2,
      role_name: "Tenant Administrator",
      role_permissions: TENANT_ADMIN_PERMISSIONS,
    };
    mockQuery.mockResolvedValueOnce({
      rows: [tenantAdminTarget],
      rowCount: 1,
    });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers (overlap)

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Security Monitor");
  });

  it("returns 404 when Tenant Admin deletes out-of-scope account", async () => {
    currentSession = tenantSession;
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([3]); // target customers (no overlap)

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid UUID on DELETE", async () => {
    const { DELETE } = await import("@/app/api/accounts/[id]/route");

    const response = await DELETE(
      new NextRequest("http://localhost:3000/api/accounts/not-a-uuid", {
        method: "DELETE",
      }),
      makeContext("not-a-uuid"),
    );
    expect(response.status).toBe(400);
  });

  it("deletes SysAdmin when not the last one", async () => {
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    const sysAdminTarget = {
      ...targetRow,
      role_id: 1,
      role_name: "System Administrator",
      role_permissions: SYSTEM_ADMIN_PERMISSIONS,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [sysAdminTarget], rowCount: 1 }) // fetch
      .mockResolvedValueOnce({ rows: [{ count: "3" }], rowCount: 1 }) // count (3 SysAdmins)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // update

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.delete",
      }),
    );
  });

  it("Tenant Admin can delete Security Monitor within scope", async () => {
    currentSession = tenantSession;
    const { DELETE } = await import("@/app/api/accounts/[id]/route");
    mockQuery.mockResolvedValueOnce({ rows: [targetRow], rowCount: 1 });
    mockGetAccountCustomerIds
      .mockResolvedValueOnce([1, 2]) // caller customers
      .mockResolvedValueOnce([1]); // target customers
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // update

    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/accounts/${TARGET_UUID}`, {
        method: "DELETE",
      }),
      makeContext(),
    );
    expect(response.status).toBe(200);
  });
});
