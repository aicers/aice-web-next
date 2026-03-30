import { describe, expect, it, vi } from "vitest";

import {
  base64urlToUint8Array,
  bufferToBase64url,
  getRelyingParty,
} from "@/lib/auth/webauthn";

// Mock server-only since unit tests run outside Next.js
vi.mock("server-only", () => ({}));

// Mock DB client since we only test pure functions here
vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
}));

describe("webauthn", () => {
  describe("getRelyingParty", () => {
    it("returns defaults when no env vars are set", () => {
      delete process.env.BASE_URL;
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_RP_NAME;
      delete process.env.WEBAUTHN_RP_ORIGIN;

      const rp = getRelyingParty();
      expect(rp.id).toBe("localhost");
      expect(rp.name).toBe("AICE");
      expect(rp.origin).toBe("http://localhost:3000");
    });

    it("returns defaults when BASE_URL is empty string", () => {
      process.env.BASE_URL = "";
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_RP_NAME;
      delete process.env.WEBAUTHN_RP_ORIGIN;

      const rp = getRelyingParty();
      expect(rp.id).toBe("localhost");
      expect(rp.name).toBe("AICE");
      expect(rp.origin).toBe("http://localhost:3000");

      delete process.env.BASE_URL;
    });

    it("returns defaults when BASE_URL is a relative path (Vitest injects '/')", () => {
      process.env.BASE_URL = "/";
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_RP_NAME;
      delete process.env.WEBAUTHN_RP_ORIGIN;

      const rp = getRelyingParty();
      expect(rp.id).toBe("localhost");
      expect(rp.name).toBe("AICE");
      expect(rp.origin).toBe("http://localhost:3000");

      delete process.env.BASE_URL;
    });

    it("derives RP ID from BASE_URL hostname", () => {
      process.env.BASE_URL = "https://app.example.com";
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_RP_NAME;
      delete process.env.WEBAUTHN_RP_ORIGIN;

      const rp = getRelyingParty();
      expect(rp.id).toBe("app.example.com");
      expect(rp.origin).toBe("https://app.example.com");

      delete process.env.BASE_URL;
    });

    it("uses explicit WEBAUTHN_RP_ID over BASE_URL", () => {
      process.env.BASE_URL = "https://app.example.com";
      process.env.WEBAUTHN_RP_ID = "example.com";
      delete process.env.WEBAUTHN_RP_NAME;
      delete process.env.WEBAUTHN_RP_ORIGIN;

      const rp = getRelyingParty();
      expect(rp.id).toBe("example.com");

      delete process.env.BASE_URL;
      delete process.env.WEBAUTHN_RP_ID;
    });

    it("uses WEBAUTHN_RP_NAME when set", () => {
      delete process.env.BASE_URL;
      process.env.WEBAUTHN_RP_NAME = "My App";
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_RP_ORIGIN;

      const rp = getRelyingParty();
      expect(rp.name).toBe("My App");

      delete process.env.WEBAUTHN_RP_NAME;
    });

    it("uses WEBAUTHN_RP_ORIGIN when set", () => {
      process.env.BASE_URL = "https://app.example.com";
      process.env.WEBAUTHN_RP_ORIGIN = "https://custom.example.com";
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_RP_NAME;

      const rp = getRelyingParty();
      expect(rp.origin).toBe("https://custom.example.com");

      delete process.env.BASE_URL;
      delete process.env.WEBAUTHN_RP_ORIGIN;
    });

    it("derives all three fields from BASE_URL with port", () => {
      process.env.BASE_URL = "https://app.example.com:8443";
      delete process.env.WEBAUTHN_RP_ID;
      delete process.env.WEBAUTHN_RP_NAME;
      delete process.env.WEBAUTHN_RP_ORIGIN;

      const rp = getRelyingParty();
      expect(rp.id).toBe("app.example.com");
      expect(rp.name).toBe("AICE");
      expect(rp.origin).toBe("https://app.example.com:8443");

      delete process.env.BASE_URL;
    });
  });

  describe("bufferToBase64url", () => {
    it("encodes an empty buffer", () => {
      expect(bufferToBase64url(new Uint8Array([]))).toBe("");
    });

    it("encodes a simple buffer", () => {
      const buf = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const result = bufferToBase64url(buf);
      expect(result).toBe("SGVsbG8");
      // Standard base64 would be "SGVsbG8=" — verify no padding
      expect(result).not.toContain("=");
    });

    it("replaces + with - and / with _", () => {
      // 0xFB, 0xFF, 0xFE produces base64 with + and / characters
      const buf = new Uint8Array([0xfb, 0xff, 0xfe]);
      const result = bufferToBase64url(buf);
      expect(result).not.toContain("+");
      expect(result).not.toContain("/");
    });

    it("produces valid base64url characters only", () => {
      const buf = new Uint8Array(32);
      for (let i = 0; i < 32; i++) buf[i] = i * 8;
      const result = bufferToBase64url(buf);
      expect(result).toMatch(/^[A-Za-z0-9_-]*$/);
    });
  });

  describe("base64urlToUint8Array", () => {
    it("decodes a simple base64url string", () => {
      const result = base64urlToUint8Array("SGVsbG8");
      expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]);
    });

    it("handles padding correctly", () => {
      // "YQ" is base64url for [97] ("a"), standard base64 "YQ=="
      const result = base64urlToUint8Array("YQ");
      expect(Array.from(result)).toEqual([97]);
    });

    it("handles base64url characters (- and _)", () => {
      // Encode with bufferToBase64url, decode back
      const original = new Uint8Array([0xfb, 0xff, 0xfe]);
      const encoded = bufferToBase64url(original);
      const decoded = base64urlToUint8Array(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("round-trips correctly for random data", () => {
      const original = new Uint8Array(64);
      for (let i = 0; i < 64; i++)
        original[i] = Math.floor(Math.random() * 256);
      const encoded = bufferToBase64url(original);
      const decoded = base64urlToUint8Array(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("decodes an empty string", () => {
      const result = base64urlToUint8Array("");
      expect(result.length).toBe(0);
    });
  });
});
