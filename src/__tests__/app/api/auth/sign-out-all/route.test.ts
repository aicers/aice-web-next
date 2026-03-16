import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockWithTransaction = vi.hoisted(() => vi.fn());
const mockDeleteAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockDeleteTokenExpCookie = vi.hoisted(() => vi.fn());
const mockDeleteTokenTtlCookie = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockExtractClientIp = vi.hoisted(() => vi.fn());
const mockCookieDelete = vi.hoisted(() => vi.fn());
const mockWithAuth = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: mockWithAuth.mockImplementation(
    (handler: HandlerFn, _options?: unknown) => {
      return async (request: NextRequest, context: unknown) => {
        return handler(request, context, currentSession);
      };
    },
  ),
}));

vi.mock("@/lib/db/client", () => ({
  withTransaction: vi.fn((...args: unknown[]) => mockWithTransaction(...args)),
}));

vi.mock("@/lib/auth/cookies", () => ({
  deleteAccessTokenCookie: vi.fn((...args: unknown[]) =>
    mockDeleteAccessTokenCookie(...args),
  ),
  deleteTokenExpCookie: vi.fn((...args: unknown[]) =>
    mockDeleteTokenExpCookie(...args),
  ),
  deleteTokenTtlCookie: vi.fn((...args: unknown[]) =>
    mockDeleteTokenTtlCookie(...args),
  ),
}));

vi.mock("@/lib/auth/csrf", () => ({
  CSRF_COOKIE_NAME: "csrf",
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn((...args: unknown[]) => mockExtractClientIp(...args)),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({ delete: mockCookieDelete })),
}));

describe("POST /api/auth/sign-out-all", () => {
  const now = Math.floor(Date.now() / 1000);
  let mockClientQuery: ReturnType<typeof vi.fn>;

  const validSession: AuthSession = {
    accountId: "acc-1",
    sessionId: "sess-1",
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

  function makeRequest() {
    return new NextRequest("http://localhost:3000/api/auth/sign-out-all", {
      method: "POST",
    });
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  beforeEach(() => {
    vi.resetModules();
    mockWithTransaction.mockReset();
    mockDeleteAccessTokenCookie.mockReset();
    mockDeleteTokenExpCookie.mockReset();
    mockDeleteTokenTtlCookie.mockReset();
    mockAuditRecord.mockReset();
    mockExtractClientIp.mockReset();
    mockCookieDelete.mockReset();

    mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    mockWithTransaction.mockImplementation(
      async (fn: (client: { query: ReturnType<typeof vi.fn> }) => unknown) =>
        fn({ query: mockClientQuery }),
    );
  });

  it("returns 200 with { ok: true } on success", async () => {
    currentSession = validSession;
    mockDeleteAccessTokenCookie.mockResolvedValueOnce(undefined);
    mockAuditRecord.mockResolvedValueOnce(undefined);
    mockExtractClientIp.mockReturnValue("127.0.0.1");

    const { POST } = await import("@/app/api/auth/sign-out-all/route");
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("increments token_version in DB", async () => {
    currentSession = validSession;
    mockDeleteAccessTokenCookie.mockResolvedValueOnce(undefined);
    mockAuditRecord.mockResolvedValueOnce(undefined);
    mockExtractClientIp.mockReturnValue("127.0.0.1");

    const { POST } = await import("@/app/api/auth/sign-out-all/route");
    await POST(makeRequest(), makeContext());

    expect(mockClientQuery).toHaveBeenCalledWith(
      "UPDATE accounts SET token_version = token_version + 1 WHERE id = $1",
      ["acc-1"],
    );
  });

  it("revokes all non-revoked sessions for the account", async () => {
    currentSession = validSession;
    mockDeleteAccessTokenCookie.mockResolvedValueOnce(undefined);
    mockAuditRecord.mockResolvedValueOnce(undefined);
    mockExtractClientIp.mockReturnValue("127.0.0.1");

    const { POST } = await import("@/app/api/auth/sign-out-all/route");
    await POST(makeRequest(), makeContext());

    expect(mockClientQuery).toHaveBeenCalledWith(
      `UPDATE sessions SET revoked = true
         WHERE account_id = $1 AND revoked = false`,
      ["acc-1"],
    );
  });

  it("deletes all session cookies", async () => {
    currentSession = validSession;
    mockDeleteAccessTokenCookie.mockResolvedValueOnce(undefined);
    mockDeleteTokenExpCookie.mockResolvedValueOnce(undefined);
    mockDeleteTokenTtlCookie.mockResolvedValueOnce(undefined);
    mockAuditRecord.mockResolvedValueOnce(undefined);
    mockExtractClientIp.mockReturnValue("127.0.0.1");

    const { POST } = await import("@/app/api/auth/sign-out-all/route");
    await POST(makeRequest(), makeContext());

    expect(mockDeleteAccessTokenCookie).toHaveBeenCalled();
    expect(mockDeleteTokenExpCookie).toHaveBeenCalled();
    expect(mockDeleteTokenTtlCookie).toHaveBeenCalled();
    expect(mockCookieDelete).toHaveBeenCalledWith("csrf");
  });

  it("records audit with action session.revoke and target account", async () => {
    currentSession = validSession;
    mockDeleteAccessTokenCookie.mockResolvedValueOnce(undefined);
    mockAuditRecord.mockResolvedValueOnce(undefined);
    mockExtractClientIp.mockReturnValue("127.0.0.1");

    const { POST } = await import("@/app/api/auth/sign-out-all/route");
    await POST(makeRequest(), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "session.revoke",
      target: "account",
      targetId: "acc-1",
      ip: "127.0.0.1",
      sid: "sess-1",
    });
  });

  it("calls withAuth with skipPasswordCheck: true", async () => {
    await import("@/app/api/auth/sign-out-all/route");

    expect(mockWithAuth).toHaveBeenCalledWith(expect.any(Function), {
      skipPasswordCheck: true,
    });
  });
});
