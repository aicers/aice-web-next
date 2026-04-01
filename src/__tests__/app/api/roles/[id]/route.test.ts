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

const mockUpdateRole = vi.hoisted(() => vi.fn());
const mockDeleteRole = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/auth/role-management", () => ({
  updateRole: mockUpdateRole,
  deleteRole: mockDeleteRole,
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
  mustEnrollMfa: false,
  iat: now,
  exp: now + 900,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "Mozilla/5.0 Chrome/131",
  sessionBrowserFingerprint: "Chrome/131",
  needsReauth: false,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
};

function makeContext(id = "10") {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH /api/roles/[id]", () => {
  beforeEach(() => {
    mockUpdateRole.mockReset();
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;
  });

  it("returns 403 without roles:write", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { PATCH } = await import("@/app/api/roles/[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost:3000/api/roles/10", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", permissions: [] }),
      }),
      makeContext(),
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid role ID", async () => {
    const { PATCH } = await import("@/app/api/roles/[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost:3000/api/roles/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", permissions: [] }),
      }),
      makeContext("abc"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid role ID");
  });

  it("returns 403 for built-in role modification", async () => {
    mockUpdateRole.mockResolvedValueOnce({
      valid: false,
      errors: ["Built-in roles cannot be modified"],
    });

    const { PATCH } = await import("@/app/api/roles/[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost:3000/api/roles/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", permissions: [] }),
      }),
      makeContext("1"),
    );

    expect(response.status).toBe(403);
  });

  it("updates role and records audit log", async () => {
    mockUpdateRole.mockResolvedValueOnce({
      valid: true,
      data: { id: 10, name: "Updated", permissions: ["accounts:read"] },
    });

    const { PATCH } = await import("@/app/api/roles/[id]/route");
    const response = await PATCH(
      new NextRequest("http://localhost:3000/api/roles/10", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated",
          permissions: ["accounts:read"],
        }),
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.name).toBe("Updated");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "role.update", targetId: "10" }),
    );
  });
});

describe("DELETE /api/roles/[id]", () => {
  beforeEach(() => {
    mockDeleteRole.mockReset();
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;
  });

  it("returns 403 without roles:delete", async () => {
    mockHasPermission.mockResolvedValue(false);

    const { DELETE } = await import("@/app/api/roles/[id]/route");
    const response = await DELETE(
      new NextRequest("http://localhost:3000/api/roles/10", {
        method: "DELETE",
      }),
      makeContext(),
    );

    expect(response.status).toBe(403);
  });

  it("returns 403 for built-in role deletion", async () => {
    mockDeleteRole.mockResolvedValueOnce({
      valid: false,
      errors: ["Built-in roles cannot be deleted"],
    });

    const { DELETE } = await import("@/app/api/roles/[id]/route");
    const response = await DELETE(
      new NextRequest("http://localhost:3000/api/roles/1", {
        method: "DELETE",
      }),
      makeContext("1"),
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 for role in use", async () => {
    mockDeleteRole.mockResolvedValueOnce({
      valid: false,
      errors: [
        "Cannot delete a role that is assigned to accounts. Reassign accounts first.",
      ],
    });

    const { DELETE } = await import("@/app/api/roles/[id]/route");
    const response = await DELETE(
      new NextRequest("http://localhost:3000/api/roles/10", {
        method: "DELETE",
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/assigned to accounts/);
  });

  it("deletes role and records audit log", async () => {
    mockDeleteRole.mockResolvedValueOnce({ valid: true });

    const { DELETE } = await import("@/app/api/roles/[id]/route");
    const response = await DELETE(
      new NextRequest("http://localhost:3000/api/roles/10", {
        method: "DELETE",
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "role.delete", targetId: "10" }),
    );
  });
});
