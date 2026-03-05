import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockVerifyJwtFull = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockValidateCsrfToken = vi.hoisted(() => vi.fn());
const mockValidateOrigin = vi.hoisted(() => vi.fn());
const mockCheckApiRateLimit = vi.hoisted(() => vi.fn());
const mockShouldRotate = vi.hoisted(() => vi.fn());
const mockRotateTokens = vi.hoisted(() => vi.fn());
const mockLoadSessionPolicy = vi.hoisted(() => vi.fn());
const mockIsIdleTimedOut = vi.hoisted(() => vi.fn());
const mockIsAbsoluteTimedOut = vi.hoisted(() => vi.fn());
const mockAssessIpUaRisk = vi.hoisted(() => vi.fn());
const mockExtractBrowserFingerprint = vi.hoisted(() => vi.fn());
const mockExtractClientIp = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/cookies", () => ({
  getAccessTokenCookie: mockGetAccessTokenCookie,
}));

vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: mockVerifyJwtFull,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

vi.mock("@/lib/rate-limit/limiter", () => ({
  checkApiRateLimit: mockCheckApiRateLimit,
}));

vi.mock("@/lib/auth/rotation", () => ({
  shouldRotate: mockShouldRotate,
  rotateTokens: mockRotateTokens,
}));

vi.mock("@/lib/auth/csrf", () => ({
  CSRF_HEADER_NAME: "x-csrf-token",
  isMutationMethod: vi.fn((method: string) =>
    new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method.toUpperCase()),
  ),
  validateCsrfToken: mockValidateCsrfToken,
  validateOrigin: mockValidateOrigin,
}));

vi.mock("@/lib/auth/session-policy", () => ({
  loadSessionPolicy: mockLoadSessionPolicy,
  isIdleTimedOut: mockIsIdleTimedOut,
  isAbsoluteTimedOut: mockIsAbsoluteTimedOut,
}));

vi.mock("@/lib/auth/session-validator", () => ({
  assessIpUaRisk: mockAssessIpUaRisk,
}));

vi.mock("@/lib/auth/ua-parser", () => ({
  extractBrowserFingerprint: mockExtractBrowserFingerprint,
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: mockExtractClientIp,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: mockAuditRecord,
  },
}));

describe("withAuth", () => {
  let guard: typeof import("@/lib/auth/guard");

  const now = Math.floor(Date.now() / 1000);

  const validSession: AuthSession = {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["admin"],
    tokenVersion: 0,
    mustChangePassword: false,
    iat: now,
    exp: now + 900, // 15 minutes
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0 Chrome/131",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };

  const defaultPolicy = {
    idleTimeoutMinutes: 30,
    absoluteTimeoutHours: 8,
    maxSessions: null,
  };

  const noRisk = {
    proceed: true,
    requiresReauth: false,
    riskLevel: "none" as const,
    auditActions: [],
  };

  function makeRequest(
    url = "http://localhost:3000/api/test",
    options?: { method?: string; headers?: Record<string, string> },
  ) {
    return new NextRequest(url, {
      method: options?.method ?? "GET",
      headers: options?.headers,
    });
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  beforeEach(async () => {
    mockGetAccessTokenCookie.mockReset();
    mockVerifyJwtFull.mockReset();
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockValidateCsrfToken.mockReset();
    mockValidateOrigin.mockReset();
    mockCheckApiRateLimit.mockReset().mockResolvedValue({ limited: false });
    mockShouldRotate.mockReset().mockReturnValue(false);
    mockRotateTokens.mockReset().mockResolvedValue(undefined);
    mockLoadSessionPolicy.mockReset().mockResolvedValue(defaultPolicy);
    mockIsIdleTimedOut.mockReset().mockReturnValue(false);
    mockIsAbsoluteTimedOut.mockReset().mockReturnValue(false);
    mockAssessIpUaRisk.mockReset().mockReturnValue(noRisk);
    mockExtractBrowserFingerprint.mockReset().mockReturnValue("Chrome/131");
    mockExtractClientIp.mockReset().mockReturnValue("127.0.0.1");
    mockAuditRecord.mockReset().mockResolvedValue(undefined);

    process.env.CSRF_SECRET = "test-csrf-secret";

    guard = await import("@/lib/auth/guard");
  });

  afterEach(() => {
    delete process.env.CSRF_SECRET;
  });

  // ── Authentication ──────────────────────────────────────────

  describe("authentication", () => {
    it("returns 401 when no cookie is present", async () => {
      mockGetAccessTokenCookie.mockResolvedValue(undefined);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Authentication required");
      expect(handler).not.toHaveBeenCalled();
    });

    it("returns 401 when token verification fails", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("bad-token");
      mockVerifyJwtFull.mockRejectedValue(new Error("Invalid token"));

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe("Invalid or expired token");
      expect(handler).not.toHaveBeenCalled();
    });

    it("returns 403 when mustChangePassword is true", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue({
        ...validSession,
        mustChangePassword: true,
      });

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("Password change required");
      expect(body.redirect).toBe("/change-password");
      expect(handler).not.toHaveBeenCalled();
    });

    it("calls handler with session on valid GET request", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      const request = makeRequest();
      const context = makeContext();

      const response = await wrapped(request, context);
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(handler).toHaveBeenCalledWith(request, context, validSession);
    });

    it("updates last_active_at in the database", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      await wrapped(makeRequest(), makeContext());

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET last_active_at"),
        ["session-1"],
      );
    });

    it("updates last_active_at before calling the handler", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const callOrder: string[] = [];

      mockPoolQuery.mockImplementation(async () => {
        callOrder.push("db-update");
        return { rows: [], rowCount: 0 };
      });

      const handler = vi.fn().mockImplementation(async () => {
        callOrder.push("handler");
        return NextResponse.json({ ok: true });
      });

      const wrapped = guard.withAuth(handler);
      await wrapped(makeRequest(), makeContext());

      expect(callOrder).toEqual(["db-update", "handler"]);
    });
  });

  // ── CSRF protection ─────────────────────────────────────────

  describe("CSRF protection", () => {
    it("GET request passes without CSRF validation", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
      expect(mockValidateCsrfToken).not.toHaveBeenCalled();
      expect(mockValidateOrigin).not.toHaveBeenCalled();
    });

    it("POST with valid CSRF token and valid Origin passes", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockValidateOrigin.mockReturnValue(true);
      mockValidateCsrfToken.mockReturnValue(true);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "valid-csrf-token",
        },
      });

      const response = await wrapped(request, makeContext());
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("POST without CSRF token returns 403", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockValidateOrigin.mockReturnValue(true);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      });

      const response = await wrapped(request, makeContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("Invalid CSRF token");
      expect(handler).not.toHaveBeenCalled();
    });

    it("POST with invalid CSRF token returns 403", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockValidateOrigin.mockReturnValue(true);
      mockValidateCsrfToken.mockReturnValue(false);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "invalid-token",
        },
      });

      const response = await wrapped(request, makeContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("Invalid CSRF token");
      expect(handler).not.toHaveBeenCalled();
    });

    it("POST with mismatched Origin returns 403", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockValidateOrigin.mockReturnValue(false);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: {
          origin: "https://evil.com",
          "x-csrf-token": "some-token",
        },
      });

      const response = await wrapped(request, makeContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("Origin mismatch");
      expect(handler).not.toHaveBeenCalled();
      // CSRF token should not be checked when origin fails
      expect(mockValidateCsrfToken).not.toHaveBeenCalled();
    });

    it("missing CSRF_SECRET on POST returns 500", async () => {
      delete process.env.CSRF_SECRET;
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      });

      const response = await wrapped(request, makeContext());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe("Server configuration error");
      expect(handler).not.toHaveBeenCalled();
    });

    it("passes correct arguments to validateCsrfToken", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockValidateOrigin.mockReturnValue(true);
      mockValidateCsrfToken.mockReturnValue(true);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "the-csrf-token",
        },
      });

      await wrapped(request, makeContext());

      expect(mockValidateCsrfToken).toHaveBeenCalledWith(
        "the-csrf-token",
        validSession.sessionId,
        "test-csrf-secret",
        validSession.iat,
      );
    });

    it.each([
      "PUT",
      "PATCH",
      "DELETE",
    ])("%s request also requires CSRF validation", async (method) => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockValidateOrigin.mockReturnValue(true);
      mockValidateCsrfToken.mockReturnValue(false);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method,
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "bad",
        },
      });

      const response = await wrapped(request, makeContext());
      expect(response.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── Rate limiting ─────────────────────────────────────────────

  describe("rate limiting", () => {
    it("GET request within rate limit passes", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockCheckApiRateLimit.mockResolvedValue({ limited: false });

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("returns 429 with Retry-After when rate limit exceeded", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockCheckApiRateLimit.mockResolvedValue({
        limited: true,
        retryAfterSeconds: 42,
      });

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe("Too many requests");
      expect(response.headers.get("Retry-After")).toBe("42");
      expect(handler).not.toHaveBeenCalled();
    });

    it("rate limit applies to POST requests as well", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockCheckApiRateLimit.mockResolvedValue({
        limited: true,
        retryAfterSeconds: 10,
      });

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);

      const request = makeRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "some-token",
        },
      });

      const response = await wrapped(request, makeContext());

      expect(response.status).toBe(429);
      // CSRF should not be checked when rate limited
      expect(mockValidateCsrfToken).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("passes accountId to checkApiRateLimit", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      await wrapped(makeRequest(), makeContext());

      expect(mockCheckApiRateLimit).toHaveBeenCalledWith("account-1");
    });
  });

  // ── Session policy enforcement ─────────────────────────────────

  describe("session policy enforcement", () => {
    it("returns 401 when absolute timeout exceeded", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockIsAbsoluteTimedOut.mockReturnValue(true);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe("SESSION_EXPIRED");
      expect(handler).not.toHaveBeenCalled();
      // Session should be revoked in DB
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET revoked = true"),
        ["session-1"],
      );
      // Audit log should be recorded
      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "session.absolute_timeout",
          target: "session",
          targetId: "session-1",
        }),
      );
    });

    it("returns 401 when idle timeout exceeded", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockIsIdleTimedOut.mockReturnValue(true);

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe("SESSION_IDLE_TIMEOUT");
      expect(handler).not.toHaveBeenCalled();
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET revoked = true"),
        ["session-1"],
      );
      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "session.idle_timeout",
        }),
      );
    });

    it("proceeds when session is within both timeouts", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("returns 401 REAUTH_REQUIRED when UA major version changes", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockAssessIpUaRisk.mockReturnValue({
        proceed: false,
        requiresReauth: true,
        riskLevel: "medium",
        auditActions: ["session.ua_mismatch"],
      });

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe("REAUTH_REQUIRED");
      expect(handler).not.toHaveBeenCalled();
      // Session should be flagged needs_reauth
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET needs_reauth = true"),
        ["session-1"],
      );
    });

    it("returns 401 REAUTH_REQUIRED when both IP and UA change", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockAssessIpUaRisk.mockReturnValue({
        proceed: false,
        requiresReauth: true,
        riskLevel: "high",
        auditActions: ["session.ip_mismatch", "session.ua_mismatch"],
      });

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe("REAUTH_REQUIRED");
      expect(handler).not.toHaveBeenCalled();
      // Both audit actions should be recorded
      expect(mockAuditRecord).toHaveBeenCalledTimes(2);
    });

    it("proceeds normally when only IP changes (low risk)", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockAssessIpUaRisk.mockReturnValue({
        proceed: true,
        requiresReauth: false,
        riskLevel: "low",
        auditActions: ["session.ip_mismatch"],
      });

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
      // Audit action should still be recorded
      expect(mockAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "session.ip_mismatch",
        }),
      );
    });

    it("returns 401 REAUTH_REQUIRED when session already has needsReauth", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue({
        ...validSession,
        needsReauth: true,
      });

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe("REAUTH_REQUIRED");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── skipSessionPolicy option ──────────────────────────────────

  describe("skipSessionPolicy option", () => {
    it("skips timeout and IP/UA checks when skipSessionPolicy is true", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue({
        ...validSession,
        needsReauth: true,
      });

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler, {
        skipPasswordCheck: true,
        skipSessionPolicy: true,
      });
      const response = await wrapped(makeRequest(), makeContext());

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
      // Policy loader should not be called
      expect(mockLoadSessionPolicy).not.toHaveBeenCalled();
      expect(mockAssessIpUaRisk).not.toHaveBeenCalled();
    });
  });

  // ── Sliding rotation ──────────────────────────────────────────

  describe("sliding rotation", () => {
    it("rotates tokens when shouldRotate returns true", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockShouldRotate.mockReturnValue(true);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      await wrapped(makeRequest(), makeContext());

      expect(mockShouldRotate).toHaveBeenCalledWith(
        validSession.iat,
        validSession.exp,
      );
      expect(mockRotateTokens).toHaveBeenCalledWith(validSession);
    });

    it("does not rotate when shouldRotate returns false", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockShouldRotate.mockReturnValue(false);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler);
      await wrapped(makeRequest(), makeContext());

      expect(mockShouldRotate).toHaveBeenCalledWith(
        validSession.iat,
        validSession.exp,
      );
      expect(mockRotateTokens).not.toHaveBeenCalled();
    });

    it("returns the handler's response after rotation", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockShouldRotate.mockReturnValue(true);

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ data: "hello" }));
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(body.data).toBe("hello");
      expect(mockRotateTokens).toHaveBeenCalled();
    });

    it("rotation happens after the handler is called", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);
      mockShouldRotate.mockReturnValue(true);

      const callOrder: string[] = [];

      mockRotateTokens.mockImplementation(async () => {
        callOrder.push("rotate");
      });

      const handler = vi.fn().mockImplementation(async () => {
        callOrder.push("handler");
        return NextResponse.json({ ok: true });
      });

      const wrapped = guard.withAuth(handler);
      await wrapped(makeRequest(), makeContext());

      expect(callOrder).toEqual(["handler", "rotate"]);
    });
  });

  // ── skipPasswordCheck option ──────────────────────────────────

  describe("skipPasswordCheck option", () => {
    it("allows handler when mustChangePassword is true and skipPasswordCheck is true", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue({
        ...validSession,
        mustChangePassword: true,
      });

      const handler = vi
        .fn()
        .mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = guard.withAuth(handler, { skipPasswordCheck: true });
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(handler).toHaveBeenCalled();
    });

    it("still blocks when mustChangePassword is true and no options are given", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue({
        ...validSession,
        mustChangePassword: true,
      });

      const handler = vi.fn();
      const wrapped = guard.withAuth(handler);
      const response = await wrapped(makeRequest(), makeContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("Password change required");
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
