import { describe, expect, it } from "vitest";

import { AUTH_COOKIE_NAME, isPublicPath } from "@/lib/auth/proxy-auth";

describe("AUTH_COOKIE_NAME", () => {
  it('equals "at"', () => {
    expect(AUTH_COOKIE_NAME).toBe("at");
  });
});

describe("isPublicPath", () => {
  describe("public paths", () => {
    it("returns true for root /", () => {
      expect(isPublicPath("/")).toBe(true);
    });

    it("returns true for /en (root with default locale)", () => {
      expect(isPublicPath("/en")).toBe(true);
    });

    it("returns true for /ko (root with non-default locale)", () => {
      expect(isPublicPath("/ko")).toBe(true);
    });

    it("returns true for /sign-in", () => {
      expect(isPublicPath("/sign-in")).toBe(true);
    });

    it("returns true for /en/sign-in", () => {
      expect(isPublicPath("/en/sign-in")).toBe(true);
    });

    it("returns true for /ko/sign-in", () => {
      expect(isPublicPath("/ko/sign-in")).toBe(true);
    });
  });

  describe("protected paths (fail-closed)", () => {
    it("returns false for /audit-logs", () => {
      expect(isPublicPath("/audit-logs")).toBe(false);
    });

    it("returns false for /en/audit-logs", () => {
      expect(isPublicPath("/en/audit-logs")).toBe(false);
    });

    it("returns false for /ko/audit-logs", () => {
      expect(isPublicPath("/ko/audit-logs")).toBe(false);
    });

    it("returns false for unknown path (fail-closed)", () => {
      expect(isPublicPath("/some-future-page")).toBe(false);
    });

    it("returns false for nested unknown path", () => {
      expect(isPublicPath("/en/some/nested/path")).toBe(false);
    });
  });
});
