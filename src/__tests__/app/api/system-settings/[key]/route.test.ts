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

const mockUpdateSystemSetting = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/auth/system-settings", () => ({
  updateSystemSetting: mockUpdateSystemSetting,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

describe("PATCH /api/system-settings/[key]", () => {
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

  function makeRequest(body: unknown) {
    return new NextRequest(
      "http://localhost:3000/api/system-settings/password_policy",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  function makeContext(key = "password_policy") {
    return { params: Promise.resolve({ key }) };
  }

  beforeEach(() => {
    mockUpdateSystemSetting.mockReset();
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockHasPermission.mockReset().mockResolvedValue(true);
    currentSession = adminSession;
  });

  // ── Permission ──────────────────────────────────────────────────

  it("returns 403 when user lacks system-settings:write", async () => {
    currentSession = viewerSession;
    mockHasPermission.mockResolvedValue(false);

    const { PATCH } = await import("@/app/api/system-settings/[key]/route");
    const response = await PATCH(makeRequest({ value: {} }), makeContext());

    expect(response.status).toBe(403);
  });

  // ── Request validation ──────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/system-settings/password_policy",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
    );

    const { PATCH } = await import("@/app/api/system-settings/[key]/route");
    const response = await PATCH(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 when value field is missing", async () => {
    const { PATCH } = await import("@/app/api/system-settings/[key]/route");
    const response = await PATCH(makeRequest({}), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Missing required field: value");
  });

  // ── Validation failure ──────────────────────────────────────────

  it("returns 400 with details when validation fails", async () => {
    mockUpdateSystemSetting.mockResolvedValueOnce({
      valid: false,
      errors: ["min_length must be >= 8"],
    });

    const { PATCH } = await import("@/app/api/system-settings/[key]/route");
    const response = await PATCH(
      makeRequest({ value: { min_length: 3 } }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toContain("min_length must be >= 8");
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  // ── Success ─────────────────────────────────────────────────────

  it("updates setting and records audit log on success", async () => {
    const updatedSetting = {
      key: "password_policy",
      value: { min_length: 16, max_length: 128 },
      updated_at: "2025-01-01",
    };
    mockUpdateSystemSetting.mockResolvedValueOnce({
      valid: true,
      data: updatedSetting,
    });

    const { PATCH } = await import("@/app/api/system-settings/[key]/route");
    const response = await PATCH(
      makeRequest({ value: { min_length: 16, max_length: 128 } }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.key).toBe("password_policy");
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "account-1",
        action: "system_settings.update",
        target: "system_settings",
        targetId: "password_policy",
      }),
    );
  });

  it("passes the correct key from URL params", async () => {
    mockUpdateSystemSetting.mockResolvedValueOnce({
      valid: true,
      data: {
        key: "jwt_policy",
        value: { access_token_expiration_minutes: 30 },
        updated_at: "2025-01-01",
      },
    });

    const { PATCH } = await import("@/app/api/system-settings/[key]/route");
    const request = new NextRequest(
      "http://localhost:3000/api/system-settings/jwt_policy",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: { access_token_expiration_minutes: 30 },
        }),
      },
    );
    await PATCH(request, makeContext("jwt_policy"));

    expect(mockUpdateSystemSetting).toHaveBeenCalledWith("jwt_policy", {
      access_token_expiration_minutes: 30,
    });
  });
});
