import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockQuery = vi.hoisted(() => vi.fn());
const mockIsUserMfaEnrolled = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
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
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/auth/mfa-enforcement", () => ({
  isUserMfaEnrolled: vi.fn((...args: unknown[]) =>
    mockIsUserMfaEnrolled(...args),
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

vi.mock("server-only", () => ({}));

describe("POST /api/auth/mfa/enrollment-complete", () => {
  const now = Math.floor(Date.now() / 1000);

  const validSession: AuthSession = {
    accountId: "acc-1",
    sessionId: "sess-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: true,
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
    return new NextRequest(
      "http://localhost:3000/api/auth/mfa/enrollment-complete",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 Chrome/131",
        },
      },
    );
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  afterEach(() => {
    mockQuery.mockReset();
    mockIsUserMfaEnrolled.mockReset();
    mockAuditRecord.mockReset();
  });

  // ── withAuth options ───────────────────────────────────────────

  it("calls withAuth with skipMfaEnrollCheck", async () => {
    await import("@/app/api/auth/mfa/enrollment-complete/route");

    expect(mockWithAuth).toHaveBeenCalledWith(expect.any(Function), {
      skipMfaEnrollCheck: true,
    });
  });

  // ── No MFA enrolled ───────────────────────────────────────────

  it("returns 400 when user has no MFA enrolled", async () => {
    currentSession = validSession;
    mockIsUserMfaEnrolled.mockResolvedValue(false);

    const { POST } = await import(
      "@/app/api/auth/mfa/enrollment-complete/route"
    );
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("No MFA method enrolled");
  });

  // ── Successful completion ─────────────────────────────────────

  it("returns 200 with success true when user has MFA enrolled", async () => {
    currentSession = validSession;
    mockIsUserMfaEnrolled.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import(
      "@/app/api/auth/mfa/enrollment-complete/route"
    );
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("updates session must_enroll_mfa = false via correct query", async () => {
    currentSession = validSession;
    mockIsUserMfaEnrolled.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import(
      "@/app/api/auth/mfa/enrollment-complete/route"
    );
    await POST(makeRequest(), makeContext());

    expect(mockQuery).toHaveBeenCalledWith(
      "UPDATE sessions SET must_enroll_mfa = false WHERE sid = $1",
      ["sess-1"],
    );
  });

  it("records audit log mfa.enrollment.complete on success", async () => {
    currentSession = validSession;
    mockIsUserMfaEnrolled.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import(
      "@/app/api/auth/mfa/enrollment-complete/route"
    );
    await POST(makeRequest(), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "mfa.enrollment.complete",
      target: "mfa",
      targetId: "acc-1",
      ip: "127.0.0.1",
      sid: "sess-1",
    });
  });

  // ── Idempotent behavior ───────────────────────────────────────

  it("returns success when must_enroll_mfa is already false", async () => {
    currentSession = { ...validSession, mustEnrollMfa: false };
    mockIsUserMfaEnrolled.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import(
      "@/app/api/auth/mfa/enrollment-complete/route"
    );
    const response = await POST(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
