import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────

const mockVerifyJwtStateless = vi.hoisted(() => vi.fn());
const mockIntlMiddleware = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/jwt-verify-stateless", () => ({
  verifyJwtStateless: mockVerifyJwtStateless,
}));

vi.mock("next-intl/middleware", () => ({
  default: () => mockIntlMiddleware,
}));

// ── Import under test (after mocks) ───────────────────────────

import proxy, { config } from "@/proxy";

// ── Helpers ────────────────────────────────────────────────────

function makeRequest(path: string, cookie?: string): NextRequest {
  const request = new NextRequest(`http://localhost:3000${path}`);
  if (cookie) {
    request.cookies.set("at", cookie);
  }
  return request;
}

function getRedirectPathname(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return new URL(location).pathname;
}

// ── Tests ──────────────────────────────────────────────────────

describe("proxy", () => {
  beforeEach(() => {
    mockVerifyJwtStateless.mockReset();
    mockIntlMiddleware.mockReset();
    mockIntlMiddleware.mockReturnValue(new Response(null, { status: 200 }));
  });

  describe("public routes", () => {
    it("passes / to intl middleware without auth check", async () => {
      await proxy(makeRequest("/"));

      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
      expect(mockVerifyJwtStateless).not.toHaveBeenCalled();
    });

    it("passes /sign-in to intl middleware without auth check", async () => {
      await proxy(makeRequest("/sign-in"));

      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
      expect(mockVerifyJwtStateless).not.toHaveBeenCalled();
    });

    it("passes /ko/sign-in to intl middleware without auth check", async () => {
      await proxy(makeRequest("/ko/sign-in"));

      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
      expect(mockVerifyJwtStateless).not.toHaveBeenCalled();
    });
  });

  describe("protected routes — no cookie", () => {
    it("redirects /audit-logs to /sign-in", async () => {
      const response = await proxy(makeRequest("/audit-logs"));

      expect(response.status).toBe(307);
      expect(getRedirectPathname(response)).toBe("/sign-in");
      expect(mockIntlMiddleware).not.toHaveBeenCalled();
    });

    it("redirects /ko/audit-logs to /ko/sign-in", async () => {
      const response = await proxy(makeRequest("/ko/audit-logs"));

      expect(response.status).toBe(307);
      expect(getRedirectPathname(response)).toBe("/ko/sign-in");
    });

    it("redirects /en/audit-logs to /sign-in (default locale, no prefix)", async () => {
      const response = await proxy(makeRequest("/en/audit-logs"));

      expect(response.status).toBe(307);
      // "en" is the default locale — redirect has no locale prefix
      expect(getRedirectPathname(response)).toBe("/sign-in");
    });
  });

  describe("protected routes — invalid JWT", () => {
    it("redirects when verifyJwtStateless throws", async () => {
      mockVerifyJwtStateless.mockRejectedValue(new Error("JWT expired"));

      const response = await proxy(makeRequest("/audit-logs", "bad-token"));

      expect(response.status).toBe(307);
      expect(getRedirectPathname(response)).toBe("/sign-in");
      expect(mockVerifyJwtStateless).toHaveBeenCalledWith("bad-token");
    });
  });

  describe("protected routes — valid JWT", () => {
    it("calls intl middleware when JWT is valid", async () => {
      mockVerifyJwtStateless.mockResolvedValue({
        sub: "account-1",
        sid: "session-1",
        roles: ["admin"],
        token_version: 0,
        kid: "key-1",
      });

      await proxy(makeRequest("/audit-logs", "valid-token"));

      expect(mockVerifyJwtStateless).toHaveBeenCalledWith("valid-token");
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
    });

    it("does not redirect when JWT is valid", async () => {
      mockVerifyJwtStateless.mockResolvedValue({
        sub: "account-1",
        sid: "session-1",
        roles: ["admin"],
        token_version: 0,
        kid: "key-1",
      });

      const response = await proxy(makeRequest("/audit-logs", "valid-token"));

      expect(response.status).toBe(200);
    });
  });

  describe("config", () => {
    it("exports matcher that excludes api, _next, and static files", () => {
      expect(config.matcher).toBe("/((?!api|trpc|_next|_vercel|.*\\..*).*)");
    });
  });
});
