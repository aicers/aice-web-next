import * as OTPAuth from "otpauth";
import { describe, expect, it, vi } from "vitest";

import {
  buildTotpUri,
  generateTotpSecret,
  verifyTotpCode,
} from "@/lib/auth/totp";

// Mock server-only since unit tests run outside Next.js
vi.mock("server-only", () => ({}));

// Mock DB client since we only test pure TOTP functions here
vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

describe("totp", () => {
  describe("generateTotpSecret", () => {
    it("produces a valid base32 string", () => {
      const secret = generateTotpSecret();
      expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    });

    it("produces a 32-character base32 string (20 bytes)", () => {
      const secret = generateTotpSecret();
      expect(secret.length).toBe(32);
    });

    it("produces unique secrets", () => {
      const s1 = generateTotpSecret();
      const s2 = generateTotpSecret();
      expect(s1).not.toBe(s2);
    });
  });

  describe("buildTotpUri", () => {
    it("returns an otpauth:// URI with correct parameters", () => {
      const secret = generateTotpSecret();
      const uri = buildTotpUri(secret, "testuser");

      expect(uri).toMatch(/^otpauth:\/\/totp\//);
      expect(uri).toContain("issuer=AICE");
      expect(uri).toContain("algorithm=SHA1");
      expect(uri).toContain("digits=6");
      expect(uri).toContain("period=30");
      expect(uri).toContain(`secret=${secret}`);
    });

    it("includes the username in the label", () => {
      const secret = generateTotpSecret();
      const uri = buildTotpUri(secret, "alice");
      expect(uri).toContain("alice");
    });
  });

  describe("verifyTotpCode", () => {
    function generateCode(secret: string, offset = 0): string {
      const now = Math.floor(Date.now() / 1000);
      const counter = Math.floor(now / 30) + offset;
      const hotp = new OTPAuth.HOTP({
        algorithm: "SHA1",
        digits: 6,
        secret: OTPAuth.Secret.fromBase32(secret),
      });
      return hotp.generate({ counter });
    }

    it("accepts a valid current code", () => {
      const secret = generateTotpSecret();
      const code = generateCode(secret, 0);
      expect(verifyTotpCode(secret, code)).toBe(true);
    });

    it("rejects an incorrect code", () => {
      const secret = generateTotpSecret();
      expect(verifyTotpCode(secret, "000000")).toBe(false);
    });

    it("accepts code from one step behind (window = 1)", () => {
      const secret = generateTotpSecret();
      const code = generateCode(secret, -1);
      expect(verifyTotpCode(secret, code)).toBe(true);
    });

    it("accepts code from one step ahead (window = 1)", () => {
      const secret = generateTotpSecret();
      const code = generateCode(secret, 1);
      expect(verifyTotpCode(secret, code)).toBe(true);
    });

    it("rejects code from two steps behind (outside window)", () => {
      const secret = generateTotpSecret();
      const code = generateCode(secret, -2);
      expect(verifyTotpCode(secret, code)).toBe(false);
    });

    it("rejects code from two steps ahead (outside window)", () => {
      const secret = generateTotpSecret();
      const code = generateCode(secret, 2);
      expect(verifyTotpCode(secret, code)).toBe(false);
    });
  });
});
