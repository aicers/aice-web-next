import { describe, expect, it } from "vitest";

import { isIpAllowed } from "@/lib/auth/cidr";

describe("isIpAllowed", () => {
  describe("empty allowlist", () => {
    it("allows any IP when allowedCidrs is empty", () => {
      expect(isIpAllowed("192.168.1.1", [])).toBe(true);
    });
  });

  describe("IPv4 exact match", () => {
    it("matches a plain IP (no prefix)", () => {
      expect(isIpAllowed("10.0.0.1", ["10.0.0.1"])).toBe(true);
    });

    it("rejects a different IP", () => {
      expect(isIpAllowed("10.0.0.2", ["10.0.0.1"])).toBe(false);
    });
  });

  describe("IPv4 CIDR range", () => {
    it("matches IP within /24 range", () => {
      expect(isIpAllowed("192.168.1.100", ["192.168.1.0/24"])).toBe(true);
    });

    it("rejects IP outside /24 range", () => {
      expect(isIpAllowed("192.168.2.1", ["192.168.1.0/24"])).toBe(false);
    });

    it("matches IP within /16 range", () => {
      expect(isIpAllowed("172.16.5.10", ["172.16.0.0/16"])).toBe(true);
    });

    it("matches with /32 (single host)", () => {
      expect(isIpAllowed("10.0.0.5", ["10.0.0.5/32"])).toBe(true);
    });
  });

  describe("multiple CIDR entries", () => {
    it("matches if any entry matches", () => {
      expect(isIpAllowed("10.0.0.5", ["192.168.1.0/24", "10.0.0.0/8"])).toBe(
        true,
      );
    });

    it("rejects if no entry matches", () => {
      expect(isIpAllowed("172.16.0.1", ["192.168.1.0/24", "10.0.0.0/8"])).toBe(
        false,
      );
    });
  });

  describe("IPv6", () => {
    it("matches IPv6 exact address", () => {
      expect(isIpAllowed("::1", ["::1"])).toBe(true);
    });

    it("matches IPv6 CIDR range", () => {
      expect(isIpAllowed("fe80::1", ["fe80::/16"])).toBe(true);
    });

    it("rejects IPv6 outside range", () => {
      expect(isIpAllowed("fe81::1", ["fe80::/32"])).toBe(false);
    });
  });

  describe("invalid input", () => {
    it("returns false for invalid client IP", () => {
      expect(isIpAllowed("not-an-ip", ["10.0.0.0/8"])).toBe(false);
    });

    it("skips invalid CIDR entries gracefully", () => {
      expect(isIpAllowed("10.0.0.1", ["invalid-cidr", "10.0.0.0/8"])).toBe(
        true,
      );
    });

    it("skips entries with negative prefix", () => {
      expect(isIpAllowed("10.0.0.1", ["10.0.0.0/-1"])).toBe(false);
    });
  });

  describe("version mismatch", () => {
    it("does not match IPv4 client against IPv6 CIDR", () => {
      expect(isIpAllowed("10.0.0.1", ["::1/128"])).toBe(false);
    });

    it("does not match IPv6 client against IPv4 CIDR", () => {
      expect(isIpAllowed("::1", ["10.0.0.0/8"])).toBe(false);
    });
  });
});
