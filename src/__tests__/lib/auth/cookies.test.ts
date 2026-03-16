import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSet = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: mockSet,
    get: mockGet,
    delete: mockDelete,
  })),
}));

describe("cookies", () => {
  let cookiesMod: typeof import("@/lib/auth/cookies");

  beforeEach(async () => {
    mockSet.mockReset();
    mockGet.mockReset();
    mockDelete.mockReset();

    cookiesMod = await import("@/lib/auth/cookies");
  });

  describe("ACCESS_TOKEN_COOKIE", () => {
    it("is 'at'", () => {
      expect(cookiesMod.ACCESS_TOKEN_COOKIE).toBe("at");
    });
  });

  describe("setAccessTokenCookie", () => {
    it("sets the cookie with correct name, value, and options", async () => {
      await cookiesMod.setAccessTokenCookie("my-token", 900);

      expect(mockSet).toHaveBeenCalledWith("at", "my-token", {
        httpOnly: true,
        secure: false, // NODE_ENV !== "production" in test
        sameSite: "strict",
        path: "/",
        maxAge: 900,
      });
    });

    it("passes maxAge through", async () => {
      await cookiesMod.setAccessTokenCookie("tok", 300);

      expect(mockSet).toHaveBeenCalledWith(
        "at",
        "tok",
        expect.objectContaining({ maxAge: 300 }),
      );
    });
  });

  describe("getAccessTokenCookie", () => {
    it("returns the token value when cookie exists", async () => {
      mockGet.mockReturnValue({ value: "stored-token" });

      const result = await cookiesMod.getAccessTokenCookie();
      expect(result).toBe("stored-token");
      expect(mockGet).toHaveBeenCalledWith("at");
    });

    it("returns undefined when cookie does not exist", async () => {
      mockGet.mockReturnValue(undefined);

      const result = await cookiesMod.getAccessTokenCookie();
      expect(result).toBeUndefined();
    });
  });

  describe("deleteAccessTokenCookie", () => {
    it("calls delete with the correct cookie name", async () => {
      await cookiesMod.deleteAccessTokenCookie();

      expect(mockDelete).toHaveBeenCalledWith("at");
    });
  });

  // ── token_exp cookie ──────────────────────────────────────────

  describe("TOKEN_EXP_COOKIE", () => {
    it("is 'token_exp'", () => {
      expect(cookiesMod.TOKEN_EXP_COOKIE).toBe("token_exp");
    });
  });

  describe("setTokenExpCookie", () => {
    it("sets the cookie with correct name, value, and non-httpOnly options", async () => {
      await cookiesMod.setTokenExpCookie(1700000000, 900);

      expect(mockSet).toHaveBeenCalledWith("token_exp", "1700000000", {
        httpOnly: false,
        secure: false,
        sameSite: "strict",
        path: "/",
        maxAge: 900,
      });
    });

    it("converts expSeconds to string", async () => {
      await cookiesMod.setTokenExpCookie(1700000999, 600);

      expect(mockSet).toHaveBeenCalledWith(
        "token_exp",
        "1700000999",
        expect.objectContaining({ maxAge: 600 }),
      );
    });
  });

  describe("deleteTokenExpCookie", () => {
    it("calls delete with the correct cookie name", async () => {
      await cookiesMod.deleteTokenExpCookie();

      expect(mockDelete).toHaveBeenCalledWith("token_exp");
    });
  });

  describe("TOKEN_TTL_COOKIE", () => {
    it("is 'token_ttl'", () => {
      expect(cookiesMod.TOKEN_TTL_COOKIE).toBe("token_ttl");
    });
  });

  describe("setTokenTtlCookie", () => {
    it("sets the cookie with the TTL as both value and maxAge", async () => {
      await cookiesMod.setTokenTtlCookie(900);

      expect(mockSet).toHaveBeenCalledWith("token_ttl", "900", {
        httpOnly: false,
        secure: false,
        sameSite: "strict",
        path: "/",
        maxAge: 900,
      });
    });
  });

  describe("deleteTokenTtlCookie", () => {
    it("calls delete with the correct cookie name", async () => {
      await cookiesMod.deleteTokenTtlCookie();

      expect(mockDelete).toHaveBeenCalledWith("token_ttl");
    });
  });
});
