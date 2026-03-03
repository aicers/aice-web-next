import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockVerifyJwtFull = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockValidateCsrfToken = vi.hoisted(() => vi.fn());
const mockValidateOrigin = vi.hoisted(() => vi.fn());
const mockCheckApiRateLimit = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/auth/csrf", () => ({
  CSRF_HEADER_NAME: "x-csrf-token",
  isMutationMethod: vi.fn((method: string) =>
    new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method.toUpperCase()),
  ),
  validateCsrfToken: mockValidateCsrfToken,
  validateOrigin: mockValidateOrigin,
}));

describe("withAuth", () => {
  let guard: typeof import("@/lib/auth/guard");

  const validSession: AuthSession = {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["admin"],
    tokenVersion: 0,
    mustChangePassword: false,
    iat: Math.floor(Date.now() / 1000),
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
});
