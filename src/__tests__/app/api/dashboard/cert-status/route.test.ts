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

const mockGetCertStatus = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/dashboard/cert-expiry", () => ({
  getCertStatus: mockGetCertStatus,
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

function makeRequest() {
  return new NextRequest("http://localhost:3000/api/dashboard/cert-status");
}

function makeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /api/dashboard/cert-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = adminSession;
    mockHasPermission.mockResolvedValue(true);
  });

  it("returns cert status data when configured", async () => {
    const certData = {
      configured: true,
      subject: "CN=test",
      issuer: "CN=test-ca",
      validFrom: "Jan 1 00:00:00 2025 GMT",
      validTo: "Dec 31 23:59:59 2026 GMT",
      daysRemaining: 290,
      severity: "ok" as const,
    };
    mockGetCertStatus.mockReturnValue(certData);

    const { GET } = await import("@/app/api/dashboard/cert-status/route");
    const response = await GET(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(certData);
  });

  it("returns configured: false when no cert is set", async () => {
    mockGetCertStatus.mockReturnValue({ configured: false });

    const { GET } = await import("@/app/api/dashboard/cert-status/route");
    const response = await GET(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ configured: false });
  });

  it("returns 403 when user lacks dashboard:read", async () => {
    currentSession = viewerSession;
    mockHasPermission.mockResolvedValue(false);

    const { GET } = await import("@/app/api/dashboard/cert-status/route");
    const response = await GET(makeRequest(), makeContext());

    expect(response.status).toBe(403);
  });

  it("requires dashboard:read permission", async () => {
    mockGetCertStatus.mockReturnValue({ configured: false });

    const { GET } = await import("@/app/api/dashboard/cert-status/route");
    await GET(makeRequest(), makeContext());

    expect(mockHasPermission).toHaveBeenCalledWith(
      currentSession.roles,
      "dashboard:read",
    );
  });
});
