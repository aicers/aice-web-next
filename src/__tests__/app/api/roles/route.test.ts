import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

interface WithAuthOptions {
  requiredPermissions?: string[];
}

const mockGetRoles = vi.hoisted(() => vi.fn());
const mockGetRolesWithDetails = vi.hoisted(() => vi.fn());
const mockCreateRole = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn, options?: WithAuthOptions) => {
    return async (request: NextRequest, context: unknown) => {
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

vi.mock("@/lib/auth/role-management", () => ({
  getRoles: mockGetRoles,
  getRolesWithDetails: mockGetRolesWithDetails,
  createRole: mockCreateRole,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

const now = Math.floor(Date.now() / 1000);

const adminSession: AuthSession = {
  accountId: "account-1",
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  iat: now,
  exp: now + 900,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "Mozilla/5.0 Chrome/131",
  sessionBrowserFingerprint: "Chrome/131",
  needsReauth: false,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
};

function makeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /api/roles", () => {
  beforeEach(() => {
    mockGetRoles.mockReset();
    mockGetRolesWithDetails.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;
  });

  it("returns detailed roles when user has roles:read", async () => {
    const roles = [
      {
        id: 1,
        name: "System Administrator",
        is_builtin: true,
        permissions: ["accounts:read"],
        account_count: 2,
      },
    ];
    mockGetRolesWithDetails.mockResolvedValueOnce(roles);

    const { GET } = await import("@/app/api/roles/route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/roles"),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].permissions).toEqual(["accounts:read"]);
    expect(body.data[0].account_count).toBe(2);
    expect(mockGetRolesWithDetails).toHaveBeenCalledOnce();
    expect(mockGetRoles).not.toHaveBeenCalled();
  });

  it("returns minimal roles when user lacks roles:read", async () => {
    // hasPermission returns false for roles:read
    mockHasPermission.mockResolvedValue(false);
    const roles = [
      {
        id: 1,
        name: "System Administrator",
        description: "Full access",
        is_builtin: true,
      },
    ];
    mockGetRoles.mockResolvedValueOnce(roles);

    const { GET } = await import("@/app/api/roles/route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/roles"),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("System Administrator");
    expect(body.data[0]).not.toHaveProperty("permissions");
    expect(body.data[0]).not.toHaveProperty("account_count");
    expect(mockGetRoles).toHaveBeenCalledOnce();
    expect(mockGetRolesWithDetails).not.toHaveBeenCalled();
  });
});

describe("POST /api/roles", () => {
  beforeEach(() => {
    mockCreateRole.mockReset();
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;
  });

  it("returns 403 without roles:write", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { POST } = await import("@/app/api/roles/route");
    const response = await POST(
      new NextRequest("http://localhost:3000/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", permissions: [] }),
      }),
      makeContext(),
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 for missing name", async () => {
    const { POST } = await import("@/app/api/roles/route");
    const response = await POST(
      new NextRequest("http://localhost:3000/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: [] }),
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/name/i);
  });

  it("returns 400 for missing permissions", async () => {
    const { POST } = await import("@/app/api/roles/route");
    const response = await POST(
      new NextRequest("http://localhost:3000/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/permissions/i);
  });

  it("creates role and records audit log", async () => {
    mockCreateRole.mockResolvedValueOnce({
      valid: true,
      data: { id: 10, name: "Custom Role", permissions: ["accounts:read"] },
    });

    const { POST } = await import("@/app/api/roles/route");
    const response = await POST(
      new NextRequest("http://localhost:3000/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Custom Role",
          permissions: ["accounts:read"],
        }),
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.name).toBe("Custom Role");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "role.create", target: "role" }),
    );
  });
});
