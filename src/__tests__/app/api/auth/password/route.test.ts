import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockQuery = vi.hoisted(() => vi.fn());
const mockWithTransaction = vi.hoisted(() => vi.fn());
const mockVerifyPassword = vi.hoisted(() => vi.fn());
const mockHashPassword = vi.hoisted(() => vi.fn());
const mockValidatePassword = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockCheckSensitiveOpRateLimit = vi.hoisted(() => vi.fn());
const mockReissueAuthCookies = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn, _options?: unknown) => {
    return async (request: NextRequest, context: unknown) => {
      return handler(request, context, currentSession);
    };
  }),
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
  withTransaction: vi.fn((...args: unknown[]) => mockWithTransaction(...args)),
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: vi.fn((...args: unknown[]) => mockVerifyPassword(...args)),
  hashPassword: vi.fn((...args: unknown[]) => mockHashPassword(...args)),
}));

vi.mock("@/lib/auth/password-validator", () => ({
  validatePassword: vi.fn((...args: unknown[]) =>
    mockValidatePassword(...args),
  ),
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/rate-limit/limiter", () => ({
  checkSensitiveOpRateLimit: vi.fn((...args: unknown[]) =>
    mockCheckSensitiveOpRateLimit(...args),
  ),
}));

vi.mock("@/lib/auth/rotation", () => ({
  reissueAuthCookies: vi.fn((...args: unknown[]) =>
    mockReissueAuthCookies(...args),
  ),
}));

describe("POST /api/auth/password", () => {
  const now = Math.floor(Date.now() / 1000);

  const session: AuthSession = {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: true,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };

  function makeRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost:3000/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  let mockClientQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    currentSession = { ...session, roles: [...session.roles] };
    mockQuery.mockReset();
    mockWithTransaction.mockReset();
    mockVerifyPassword.mockReset();
    mockHashPassword.mockReset();
    mockValidatePassword.mockReset();
    mockAuditRecord.mockReset();
    mockCheckSensitiveOpRateLimit.mockReset();
    mockReissueAuthCookies.mockReset();

    // Defaults
    mockCheckSensitiveOpRateLimit.mockResolvedValue({ limited: false });
    mockQuery.mockResolvedValue({
      rows: [{ password_hash: "$argon2id$hash" }],
      rowCount: 1,
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockValidatePassword.mockResolvedValue({ valid: true, errors: [] });
    mockHashPassword.mockResolvedValue("$argon2id$newhash");
    mockReissueAuthCookies.mockResolvedValue(true);
    mockClientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE accounts")) {
        return { rows: [{ token_version: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    mockWithTransaction.mockImplementation(
      async (fn: (client: { query: ReturnType<typeof vi.fn> }) => unknown) =>
        fn({ query: mockClientQuery }),
    );
  });

  it("returns 401 when current password is incorrect", async () => {
    mockVerifyPassword.mockResolvedValue(false);

    const { POST } = await import("@/app/api/auth/password/route");
    const response = await POST(
      makeRequest({ currentPassword: "wrong", newPassword: "NewPass123!abc" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe("INCORRECT_PASSWORD");
  });

  it("returns 400 when new password violates policy", async () => {
    mockValidatePassword.mockResolvedValue({
      valid: false,
      errors: ["TOO_SHORT", "BLOCKLISTED"],
    });

    const { POST } = await import("@/app/api/auth/password/route");
    const response = await POST(
      makeRequest({ currentPassword: "old", newPassword: "short" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.codes).toEqual(["TOO_SHORT", "BLOCKLISTED"]);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckSensitiveOpRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 60,
    });

    const { POST } = await import("@/app/api/auth/password/route");
    const response = await POST(
      makeRequest({ currentPassword: "old", newPassword: "NewPass123!abc" }),
      makeContext(),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("returns 200 on successful password change", async () => {
    const { POST } = await import("@/app/api/auth/password/route");
    const response = await POST(
      makeRequest({
        currentPassword: "OldPass123!",
        newPassword: "NewPass123!abc",
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockWithTransaction).toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.change",
        target: "account",
        targetId: "account-1",
      }),
    );
    expect(mockReissueAuthCookies).toHaveBeenCalledWith({
      accountId: "account-1",
      sessionId: "session-1",
      roles: ["System Administrator"],
      tokenVersion: 1,
    });
  });

  it("transaction updates hash, clears must_change_password, bumps token_version", async () => {
    const { POST } = await import("@/app/api/auth/password/route");
    await POST(
      makeRequest({
        currentPassword: "OldPass123!",
        newPassword: "NewPass123!abc",
      }),
      makeContext(),
    );

    expect(mockClientQuery).toHaveBeenCalledTimes(3);

    // 1st call: UPDATE accounts
    const updateCall = mockClientQuery.mock.calls[0];
    expect(updateCall[0]).toContain("UPDATE accounts");
    expect(updateCall[0]).toContain("must_change_password = false");
    expect(updateCall[0]).toContain("token_version = token_version + 1");
    expect(updateCall[1]).toEqual(["account-1", "$argon2id$newhash"]);

    // 2nd call: INSERT into password_history
    const historyCall = mockClientQuery.mock.calls[1];
    expect(historyCall[0]).toContain("INSERT INTO password_history");
    expect(historyCall[1]).toEqual(["account-1", "$argon2id$newhash"]);

    // 3rd call: Revoke other sessions (except current)
    const revokeCall = mockClientQuery.mock.calls[2];
    expect(revokeCall[0]).toContain("UPDATE sessions SET revoked = true");
    expect(revokeCall[0]).toContain("sid != $2");
    expect(revokeCall[1]).toEqual(["account-1", "session-1"]);
  });

  it("updates the in-memory session after re-issuing auth cookies", async () => {
    const { POST } = await import("@/app/api/auth/password/route");
    await POST(
      makeRequest({
        currentPassword: "OldPass123!",
        newPassword: "NewPass123!abc",
      }),
      makeContext(),
    );

    expect(currentSession.tokenVersion).toBe(1);
    expect(currentSession.mustChangePassword).toBe(false);
  });

  it("returns 500 when auth cookies cannot be re-issued", async () => {
    mockReissueAuthCookies.mockResolvedValue(false);

    const { POST } = await import("@/app/api/auth/password/route");
    const response = await POST(
      makeRequest({
        currentPassword: "OldPass123!",
        newPassword: "NewPass123!abc",
      }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Server configuration error");
  });

  it("returns 404 when account not found", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { POST } = await import("@/app/api/auth/password/route");
    const response = await POST(
      makeRequest({
        currentPassword: "OldPass123!",
        newPassword: "NewPass123!abc",
      }),
      makeContext(),
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for missing fields", async () => {
    const { POST } = await import("@/app/api/auth/password/route");
    const response = await POST(
      makeRequest({ currentPassword: "old" }),
      makeContext(),
    );

    expect(response.status).toBe(400);
  });
});
