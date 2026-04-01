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

const mockGetActiveSessions = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());
const mockRevokeSession = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/dashboard/queries", () => ({
  getActiveSessions: mockGetActiveSessions,
}));

vi.mock("@/lib/auth/session", () => ({
  revokeSession: mockRevokeSession,
}));

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: () => "127.0.0.1",
}));

const now = Math.floor(Date.now() / 1000);
const adminSession: AuthSession = {
  accountId: "admin-id",
  sessionId: "admin-session",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: now,
  exp: now + 900,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "Chrome/131",
  sessionBrowserFingerprint: "Chrome/131",
  needsReauth: false,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
};

const viewerSession: AuthSession = {
  ...adminSession,
  roles: ["viewer"],
};

describe("GET /api/dashboard/sessions", () => {
  function makeRequest() {
    return new NextRequest("http://localhost:3000/api/dashboard/sessions");
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  beforeEach(() => {
    mockGetActiveSessions.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;
  });

  it("returns 403 when user lacks dashboard:read", async () => {
    currentSession = viewerSession;
    mockHasPermission.mockResolvedValue(false);
    const { GET } = await import("@/app/api/dashboard/sessions/route");
    const response = await GET(makeRequest(), makeContext());
    expect(response.status).toBe(403);
  });

  it("returns active sessions list", async () => {
    const sessions = [
      {
        sid: "s1",
        account_id: "a1",
        username: "admin",
        display_name: "Admin",
        ip_address: "10.0.0.1",
        user_agent: "Chrome",
        created_at: "2026-03-16T00:00:00Z",
        last_active_at: "2026-03-16T01:00:00Z",
        needs_reauth: false,
      },
    ];
    mockGetActiveSessions.mockResolvedValueOnce(sessions);

    const { GET } = await import("@/app/api/dashboard/sessions/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sid).toBe("s1");
  });

  it("returns empty array when no sessions", async () => {
    mockGetActiveSessions.mockResolvedValueOnce([]);

    const { GET } = await import("@/app/api/dashboard/sessions/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
  });
});

describe("POST /api/dashboard/sessions/[sid]/revoke", () => {
  const validSid = "12345678-1234-1234-1234-123456789abc";

  function makeRequest() {
    return new NextRequest(
      `http://localhost:3000/api/dashboard/sessions/${validSid}/revoke`,
      { method: "POST" },
    );
  }

  function makeContext(sid = validSid) {
    return { params: Promise.resolve({ sid }) };
  }

  beforeEach(() => {
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockQuery.mockReset();
    mockRevokeSession.mockReset().mockResolvedValue(undefined);
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    currentSession = adminSession;
  });

  it("returns 403 when user lacks dashboard:write", async () => {
    currentSession = viewerSession;
    mockHasPermission.mockResolvedValue(false);

    const { POST } = await import(
      "@/app/api/dashboard/sessions/[sid]/revoke/route"
    );
    const response = await POST(makeRequest(), makeContext());
    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid session ID format", async () => {
    const { POST } = await import(
      "@/app/api/dashboard/sessions/[sid]/revoke/route"
    );
    const response = await POST(
      new NextRequest(
        "http://localhost:3000/api/dashboard/sessions/not-a-uuid/revoke",
        { method: "POST" },
      ),
      makeContext("not-a-uuid"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 when session not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { POST } = await import(
      "@/app/api/dashboard/sessions/[sid]/revoke/route"
    );
    const response = await POST(makeRequest(), makeContext());
    expect(response.status).toBe(404);
  });

  it("revokes session and records audit log", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ sid: validSid, account_id: "target-account" }],
      rowCount: 1,
    });

    const { POST } = await import(
      "@/app/api/dashboard/sessions/[sid]/revoke/route"
    );
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockRevokeSession).toHaveBeenCalledWith(validSid);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.revoke",
        target: "session",
        targetId: validSid,
        details: expect.objectContaining({
          targetAccountId: "target-account",
        }),
      }),
    );
  });
});
