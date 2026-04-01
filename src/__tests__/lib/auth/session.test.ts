import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockVerifyJwtFull = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());
const mockRedirect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/cookies", () => ({
  getAccessTokenCookie: mockGetAccessTokenCookie,
}));

vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: mockVerifyJwtFull,
}));

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

beforeEach(() => {
  mockGetAccessTokenCookie.mockReset();
  mockVerifyJwtFull.mockReset();
  mockHasPermission.mockReset();
  mockRedirect.mockReset();
  vi.resetModules();
});

const now = Math.floor(Date.now() / 1000);

const validSession: AuthSession = {
  accountId: "account-1",
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: now,
  exp: now + 900,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "Mozilla/5.0 Chrome/131",
  sessionBrowserFingerprint: "Chrome/131",
  needsReauth: false,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
};

describe("session helpers", () => {
  describe("getCurrentSession", () => {
    it("returns session when cookie and JWT are valid", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("valid-token");
      mockVerifyJwtFull.mockResolvedValue(validSession);

      const { getCurrentSession } = await import("@/lib/auth/session");
      const session = await getCurrentSession();

      expect(session).toEqual(validSession);
    });

    it("returns null when no cookie is present", async () => {
      mockGetAccessTokenCookie.mockResolvedValue(undefined);

      const { getCurrentSession } = await import("@/lib/auth/session");
      const session = await getCurrentSession();

      expect(session).toBeNull();
      expect(mockVerifyJwtFull).not.toHaveBeenCalled();
    });

    it("returns null when JWT verification fails", async () => {
      mockGetAccessTokenCookie.mockResolvedValue("bad-token");
      mockVerifyJwtFull.mockRejectedValue(new Error("Invalid token"));

      const { getCurrentSession } = await import("@/lib/auth/session");
      const session = await getCurrentSession();

      expect(session).toBeNull();
    });
  });

  describe("requirePermission", () => {
    it("does not redirect when permission is present", async () => {
      mockHasPermission.mockResolvedValue(true);

      const { requirePermission } = await import("@/lib/auth/session");
      await requirePermission(validSession, "audit-logs:read");

      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("redirects to root when permission is missing", async () => {
      mockHasPermission.mockResolvedValue(false);

      const { requirePermission } = await import("@/lib/auth/session");
      await requirePermission(validSession, "accounts:delete");

      expect(mockRedirect).toHaveBeenCalledWith("/");
    });

    it("passes correct roles and permission to hasPermission", async () => {
      mockHasPermission.mockResolvedValue(true);

      const { requirePermission } = await import("@/lib/auth/session");
      await requirePermission(validSession, "audit-logs:read");

      expect(mockHasPermission).toHaveBeenCalledWith(
        ["System Administrator"],
        "audit-logs:read",
      );
    });
  });
});
