import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockIssueAccessToken = vi.hoisted(() => vi.fn());
const mockGenerateCsrfToken = vi.hoisted(() => vi.fn());
const mockSetAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockSetTokenExpCookie = vi.hoisted(() => vi.fn());
const mockSetTokenTtlCookie = vi.hoisted(() => vi.fn());
const mockCookiesSet = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/jwt", () => ({
  issueAccessToken: mockIssueAccessToken,
}));

vi.mock("@/lib/auth/csrf", () => ({
  CSRF_COOKIE_NAME: "csrf",
  CSRF_COOKIE_OPTIONS: {
    httpOnly: false,
    secure: false,
    sameSite: "strict",
    path: "/",
  },
  generateCsrfToken: mockGenerateCsrfToken,
}));

vi.mock("@/lib/auth/cookies", () => ({
  setAccessTokenCookie: mockSetAccessTokenCookie,
  setTokenExpCookie: mockSetTokenExpCookie,
  setTokenTtlCookie: mockSetTokenTtlCookie,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mockCookiesSet })),
}));

vi.mock("@/lib/auth/jwt-policy", () => ({
  loadJwtPolicy: vi.fn(async () => ({ accessTokenExpirationMinutes: 15 })),
}));

describe("rotation", () => {
  let rotation: typeof import("@/lib/auth/rotation");

  const now = Math.floor(Date.now() / 1000);

  const validSession: AuthSession = {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["admin"],
    tokenVersion: 0,
    mustChangePassword: false,
    iat: now - 600, // 10 min ago
    exp: now + 300, // 5 min from now (total 15 min)
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0 Chrome/131",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };

  beforeEach(async () => {
    mockIssueAccessToken.mockReset().mockResolvedValue("new-jwt-token");
    mockGenerateCsrfToken.mockReset().mockReturnValue({ token: "new-csrf" });
    mockSetAccessTokenCookie.mockReset().mockResolvedValue(undefined);
    mockSetTokenExpCookie.mockReset().mockResolvedValue(undefined);
    mockSetTokenTtlCookie.mockReset().mockResolvedValue(undefined);
    mockCookiesSet.mockReset();

    process.env.CSRF_SECRET = "test-csrf-secret";

    rotation = await import("@/lib/auth/rotation");
  });

  afterEach(() => {
    delete process.env.CSRF_SECRET;
  });

  // ── shouldRotate() ────────────────────────────────────────────

  describe("shouldRotate()", () => {
    it("returns false when plenty of time remaining", () => {
      // 10 min left of 15 min total — well outside rotation window
      const iat = now - 300; // 5 min ago
      const exp = now + 600; // 10 min from now

      expect(rotation.shouldRotate(iat, exp)).toBe(false);
    });

    it("returns true when ≤ 1/3 remaining", () => {
      // 4 min left of 15 min total — inside rotation window
      const iat = now - 660; // 11 min ago
      const exp = now + 240; // 4 min from now

      expect(rotation.shouldRotate(iat, exp)).toBe(true);
    });

    it("returns true at exactly 1/3 boundary", () => {
      // 5 min left of 15 min total — exactly at boundary
      const iat = now - 600; // 10 min ago
      const exp = now + 300; // 5 min from now (300 = 900/3)

      expect(rotation.shouldRotate(iat, exp)).toBe(true);
    });

    it("returns true when about to expire", () => {
      // 30 sec left
      const iat = now - 870; // 14.5 min ago
      const exp = now + 30;

      expect(rotation.shouldRotate(iat, exp)).toBe(true);
    });

    it("returns false when token is already expired", () => {
      const iat = now - 900;
      const exp = now - 10; // expired 10 sec ago

      expect(rotation.shouldRotate(iat, exp)).toBe(false);
    });
  });

  // ── rotateTokens() ───────────────────────────────────────────

  describe("reissueAuthCookies()", () => {
    it("returns true after issuing fresh auth cookies", async () => {
      await expect(rotation.reissueAuthCookies(validSession)).resolves.toBe(
        true,
      );
    });

    it("returns false when CSRF_SECRET is missing", async () => {
      delete process.env.CSRF_SECRET;

      await expect(rotation.reissueAuthCookies(validSession)).resolves.toBe(
        false,
      );
      expect(mockIssueAccessToken).not.toHaveBeenCalled();
      expect(mockGenerateCsrfToken).not.toHaveBeenCalled();
      expect(mockSetTokenExpCookie).not.toHaveBeenCalled();
      expect(mockSetTokenTtlCookie).not.toHaveBeenCalled();
    });
  });

  describe("rotateTokens()", () => {
    it("issues new JWT with correct session params", async () => {
      await rotation.rotateTokens(validSession);

      expect(mockIssueAccessToken).toHaveBeenCalledWith({
        accountId: "account-1",
        sessionId: "session-1",
        roles: ["admin"],
        tokenVersion: 0,
      });
    });

    it("generates new CSRF token with sid and secret", async () => {
      await rotation.rotateTokens(validSession);

      expect(mockGenerateCsrfToken).toHaveBeenCalledWith(
        "session-1",
        "test-csrf-secret",
      );
    });

    it("sets JWT cookie via setAccessTokenCookie", async () => {
      await rotation.rotateTokens(validSession);

      expect(mockSetAccessTokenCookie).toHaveBeenCalledWith(
        "new-jwt-token",
        900, // 15 * 60
      );
    });

    it("sets token_exp cookie with new expiry", async () => {
      const before = Math.floor(Date.now() / 1000) + 900;
      await rotation.rotateTokens(validSession);
      const after = Math.floor(Date.now() / 1000) + 900;

      expect(mockSetTokenExpCookie).toHaveBeenCalledTimes(1);
      const [expArg, maxAgeArg] = mockSetTokenExpCookie.mock.calls[0];
      expect(expArg).toBeGreaterThanOrEqual(before);
      expect(expArg).toBeLessThanOrEqual(after);
      expect(maxAgeArg).toBe(900);
    });

    it("sets CSRF cookie with correct options", async () => {
      await rotation.rotateTokens(validSession);

      expect(mockCookiesSet).toHaveBeenCalledWith("csrf", "new-csrf", {
        httpOnly: false,
        secure: false,
        sameSite: "strict",
        path: "/",
        maxAge: 900,
      });
    });

    it("sets token_ttl cookie with the current JWT lifetime", async () => {
      await rotation.rotateTokens(validSession);

      expect(mockSetTokenTtlCookie).toHaveBeenCalledWith(900);
    });

    it("skips silently when CSRF_SECRET is missing", async () => {
      delete process.env.CSRF_SECRET;

      await rotation.rotateTokens(validSession);

      expect(mockIssueAccessToken).not.toHaveBeenCalled();
      expect(mockGenerateCsrfToken).not.toHaveBeenCalled();
      expect(mockSetTokenExpCookie).not.toHaveBeenCalled();
      expect(mockSetTokenTtlCookie).not.toHaveBeenCalled();
    });
  });
});
