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

const mockGetSystemSettings = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/auth/system-settings", () => ({
  getSystemSettings: mockGetSystemSettings,
}));

describe("GET /api/system-settings", () => {
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

  const viewerSession: AuthSession = {
    ...adminSession,
    roles: ["viewer"],
  };

  function makeRequest() {
    return new NextRequest("http://localhost:3000/api/system-settings");
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  beforeEach(() => {
    mockGetSystemSettings.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;
  });

  it("returns 403 when user lacks system-settings:read", async () => {
    currentSession = viewerSession;
    mockHasPermission.mockResolvedValue(false);
    const { GET } = await import("@/app/api/system-settings/route");
    const response = await GET(makeRequest(), makeContext());

    expect(response.status).toBe(403);
  });

  it("returns all settings", async () => {
    const settings = [
      {
        key: "jwt_policy",
        value: { access_token_expiration_minutes: 15 },
        updated_at: "2025-01-01",
      },
      {
        key: "password_policy",
        value: { min_length: 12 },
        updated_at: "2025-01-01",
      },
    ];
    mockGetSystemSettings.mockResolvedValueOnce(settings);

    const { GET } = await import("@/app/api/system-settings/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].key).toBe("jwt_policy");
    expect(body.data[1].key).toBe("password_policy");
  });

  it("returns empty array when no settings exist", async () => {
    mockGetSystemSettings.mockResolvedValueOnce([]);

    const { GET } = await import("@/app/api/system-settings/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
  });
});
