import { describe, expect, it } from "vitest";

import {
  CSRF_COOKIE_OPTIONS,
  CSRF_HEADER_NAME,
  generateCsrfToken,
  isMutationMethod,
  validateCsrfToken,
  validateOrigin,
} from "@/lib/auth/csrf";

const TEST_SID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_SECRET = "test-csrf-secret-at-least-32-bytes-long";

describe("CSRF", () => {
  // ── generateCsrfToken() ─────────────────────────────────────

  describe("generateCsrfToken()", () => {
    it("returns token in nonce.issuedAt.signature format", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const parts = token.split(".");

      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatch(/^[0-9a-f]+$/); // hex nonce
      expect(Number(parts[1])).not.toBeNaN(); // numeric timestamp
      expect(parts[2]).toMatch(/^[0-9a-f]+$/); // hex signature
    });

    it("nonce is 32 hex characters (16 bytes)", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const nonce = token.split(".")[0];

      expect(nonce).toHaveLength(32);
    });

    it("issued_at is a valid Unix timestamp in seconds", () => {
      const before = Math.floor(Date.now() / 1000);
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const after = Math.floor(Date.now() / 1000);

      const issuedAt = Number(token.split(".")[1]);
      expect(issuedAt).toBeGreaterThanOrEqual(before);
      expect(issuedAt).toBeLessThanOrEqual(after);
    });

    it("produces different tokens on each call", () => {
      const t1 = generateCsrfToken(TEST_SID, TEST_SECRET);
      const t2 = generateCsrfToken(TEST_SID, TEST_SECRET);

      expect(t1.token).not.toBe(t2.token);
      // Nonces should differ
      expect(t1.token.split(".")[0]).not.toBe(t2.token.split(".")[0]);
    });
  });

  // ── validateCsrfToken() — acceptance ────────────────────────

  describe("validateCsrfToken() — acceptance", () => {
    it("accepts a freshly generated token with same sid and secret", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      // jwtIat is before or at the token's issuedAt
      const jwtIat = Math.floor(Date.now() / 1000) - 10;

      expect(validateCsrfToken(token, TEST_SID, TEST_SECRET, jwtIat)).toBe(
        true,
      );
    });

    it("accepts token when issued_at equals jwtIat", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const issuedAt = Number(token.split(".")[1]);

      expect(validateCsrfToken(token, TEST_SID, TEST_SECRET, issuedAt)).toBe(
        true,
      );
    });

    it("accepts token when issued_at is after jwtIat (re-issued CSRF)", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const issuedAt = Number(token.split(".")[1]);

      // JWT was issued 60 seconds before CSRF token
      expect(
        validateCsrfToken(token, TEST_SID, TEST_SECRET, issuedAt - 60),
      ).toBe(true);
    });
  });

  // ── validateCsrfToken() — rejection ─────────────────────────

  describe("validateCsrfToken() — rejection", () => {
    it("rejects token with wrong secret (HMAC mismatch)", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const jwtIat = Math.floor(Date.now() / 1000) - 10;

      expect(validateCsrfToken(token, TEST_SID, "wrong-secret", jwtIat)).toBe(
        false,
      );
    });

    it("rejects token with wrong sid (HMAC mismatch)", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const jwtIat = Math.floor(Date.now() / 1000) - 10;

      expect(
        validateCsrfToken(token, "different-sid", TEST_SECRET, jwtIat),
      ).toBe(false);
    });

    it("rejects stale token (issued_at < jwtIat)", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      // jwtIat is far in the future — token is stale
      const jwtIat = Math.floor(Date.now() / 1000) + 3600;

      expect(validateCsrfToken(token, TEST_SID, TEST_SECRET, jwtIat)).toBe(
        false,
      );
    });

    it("rejects malformed token (missing parts)", () => {
      const jwtIat = Math.floor(Date.now() / 1000) - 10;

      expect(
        validateCsrfToken("only-one-part", TEST_SID, TEST_SECRET, jwtIat),
      ).toBe(false);
      expect(
        validateCsrfToken("two.parts", TEST_SID, TEST_SECRET, jwtIat),
      ).toBe(false);
    });

    it("rejects empty string", () => {
      const jwtIat = Math.floor(Date.now() / 1000) - 10;

      expect(validateCsrfToken("", TEST_SID, TEST_SECRET, jwtIat)).toBe(false);
    });

    it("rejects token with tampered signature", () => {
      const { token } = generateCsrfToken(TEST_SID, TEST_SECRET);
      const jwtIat = Math.floor(Date.now() / 1000) - 10;
      const parts = token.split(".");

      // Flip last char of signature
      const lastChar = parts[2].slice(-1);
      const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${lastChar === "0" ? "1" : "0"}`;

      expect(validateCsrfToken(tampered, TEST_SID, TEST_SECRET, jwtIat)).toBe(
        false,
      );
    });

    it("rejects token with non-numeric issued_at", () => {
      const jwtIat = Math.floor(Date.now() / 1000) - 10;

      expect(
        validateCsrfToken(
          "aabbccdd.notanumber.eeff0011",
          TEST_SID,
          TEST_SECRET,
          jwtIat,
        ),
      ).toBe(false);
    });
  });

  // ── validateOrigin() ────────────────────────────────────────

  describe("validateOrigin()", () => {
    const EXPECTED = "https://app.example.com";

    it("accepts when Origin header matches", () => {
      expect(validateOrigin(EXPECTED, null, EXPECTED)).toBe(true);
    });

    it("rejects when Origin header does not match", () => {
      expect(validateOrigin("https://evil.com", null, EXPECTED)).toBe(false);
    });

    it("accepts Referer when Origin is absent", () => {
      expect(
        validateOrigin(null, "https://app.example.com/path", EXPECTED),
      ).toBe(true);
    });

    it("rejects Referer when Origin is absent and Referer does not match", () => {
      expect(validateOrigin(null, "https://evil.com/attack", EXPECTED)).toBe(
        false,
      );
    });

    it("rejects when neither Origin nor Referer is present", () => {
      expect(validateOrigin(null, null, EXPECTED)).toBe(false);
    });

    it("rejects when Referer is malformed URL", () => {
      expect(validateOrigin(null, "not-a-url", EXPECTED)).toBe(false);
    });

    it("prefers Origin over Referer", () => {
      // Origin matches but Referer doesn't — should accept
      expect(validateOrigin(EXPECTED, "https://evil.com/path", EXPECTED)).toBe(
        true,
      );
    });
  });

  // ── isMutationMethod() ──────────────────────────────────────

  describe("isMutationMethod()", () => {
    it.each([
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ])("returns true for %s", (method) => {
      expect(isMutationMethod(method)).toBe(true);
    });

    it.each(["GET", "HEAD", "OPTIONS"])("returns false for %s", (method) => {
      expect(isMutationMethod(method)).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isMutationMethod("post")).toBe(true);
      expect(isMutationMethod("get")).toBe(false);
    });
  });

  // ── Constants ───────────────────────────────────────────────

  describe("constants", () => {
    it("CSRF_HEADER_NAME is lowercase", () => {
      expect(CSRF_HEADER_NAME).toBe("x-csrf-token");
    });

    it("CSRF_COOKIE_OPTIONS has httpOnly=false", () => {
      expect(CSRF_COOKIE_OPTIONS.httpOnly).toBe(false);
    });

    it("CSRF_COOKIE_OPTIONS has sameSite=strict", () => {
      expect(CSRF_COOKIE_OPTIONS.sameSite).toBe("strict");
    });

    it("CSRF_COOKIE_OPTIONS has path=/", () => {
      expect(CSRF_COOKIE_OPTIONS.path).toBe("/");
    });
  });
});
