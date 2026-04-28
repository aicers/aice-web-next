import { describe, expect, it } from "vitest";

import {
  disallowXss,
  ipAddress,
  ipV4,
  ipV6,
  nodeHostnameChars,
  noLeadingTrailingWhitespace,
  portRange,
  retentionDuration,
  retentionFromWire,
  retentionToWire,
} from "@/lib/node/validation";

describe("disallowXss", () => {
  it("rejects XSS punctuation characters", () => {
    for (const ch of "<>&\"'/\\`=(){}[]") {
      expect(disallowXss(`a${ch}b`)).toBe(false);
    }
  });

  it("accepts plain text", () => {
    expect(disallowXss("normal-name 1")).toBe(true);
  });
});

describe("noLeadingTrailingWhitespace", () => {
  it("rejects leading or trailing whitespace", () => {
    expect(noLeadingTrailingWhitespace(" a")).toBe(false);
    expect(noLeadingTrailingWhitespace("a ")).toBe(false);
  });
  it("accepts internal spaces and empty strings", () => {
    expect(noLeadingTrailingWhitespace("a b")).toBe(true);
    expect(noLeadingTrailingWhitespace("")).toBe(true);
  });
});

describe("nodeHostnameChars", () => {
  it("accepts a-z, 0-9, dot, and hyphen", () => {
    expect(nodeHostnameChars("aice-1.demo")).toBe(true);
  });
  it("rejects uppercase and other punctuation", () => {
    expect(nodeHostnameChars("ABC")).toBe(false);
    expect(nodeHostnameChars("a_b")).toBe(false);
  });
  it("rejects leading or trailing dot/hyphen and consecutive specials", () => {
    expect(nodeHostnameChars(".aice")).toBe(false);
    expect(nodeHostnameChars("-aice")).toBe(false);
    expect(nodeHostnameChars("aice.")).toBe(false);
    expect(nodeHostnameChars("aice-")).toBe(false);
    expect(nodeHostnameChars("a..b")).toBe(false);
    expect(nodeHostnameChars("a--b")).toBe(false);
  });
});

describe("ipV4", () => {
  it("accepts valid v4 addresses", () => {
    expect(ipV4("0.0.0.0")).toBe(true);
    expect(ipV4("192.168.1.1")).toBe(true);
    expect(ipV4("255.255.255.255")).toBe(true);
  });
  it("rejects out-of-range octets and zero-padded numbers", () => {
    expect(ipV4("256.0.0.0")).toBe(false);
    expect(ipV4("01.2.3.4")).toBe(false);
    expect(ipV4("1.2.3")).toBe(false);
    expect(ipV4("1.2.3.4.5")).toBe(false);
    expect(ipV4("a.b.c.d")).toBe(false);
  });
});

describe("ipV6", () => {
  it("accepts canonical and compressed forms", () => {
    expect(ipV6("::1")).toBe(true);
    expect(ipV6("::")).toBe(true);
    expect(ipV6("2001:db8::1")).toBe(true);
    expect(ipV6("fe80::1234:5678:9abc:def0")).toBe(true);
    expect(ipV6("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
  });
  it("accepts IPv4-embedded suffix", () => {
    expect(ipV6("::ffff:192.168.1.1")).toBe(true);
    expect(ipV6("::192.0.2.1")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(ipV6("")).toBe(false);
    expect(ipV6("gggg::1")).toBe(false);
    expect(ipV6("1::2::3")).toBe(false);
    expect(ipV6("2001:db8:85a3::8a2e:370:7334:extra:1234")).toBe(false);
    expect(ipV6("192.168.1.1")).toBe(false);
    expect(ipV6("[::1]")).toBe(false);
  });
});

describe("ipAddress", () => {
  it("accepts both IPv4 and IPv6", () => {
    expect(ipAddress("192.168.1.1")).toBe(true);
    expect(ipAddress("::1")).toBe(true);
    expect(ipAddress("2001:db8::1")).toBe(true);
  });
  it("rejects strings that are neither", () => {
    expect(ipAddress("256.0.0.1")).toBe(false);
    expect(ipAddress("not-an-address")).toBe(false);
    expect(ipAddress("")).toBe(false);
  });
});

describe("portRange", () => {
  it("accepts ports within 0..65535", () => {
    expect(portRange(0)).toBe(true);
    expect(portRange(65535)).toBe(true);
  });
  it("rejects out-of-range and non-integers", () => {
    expect(portRange(-1)).toBe(false);
    expect(portRange(65536)).toBe(false);
    expect(portRange(8.5)).toBe(false);
  });
});

describe("retentionDuration", () => {
  it("accepts d/w/M units with positive integer prefix", () => {
    expect(retentionDuration("100d")).toBe(true);
    expect(retentionDuration("4w")).toBe(true);
    expect(retentionDuration("3M")).toBe(true);
  });
  it("rejects malformed values", () => {
    expect(retentionDuration("0d")).toBe(false);
    expect(retentionDuration("100")).toBe(false);
    expect(retentionDuration("100m")).toBe(false);
  });
});

describe("retention round-trip", () => {
  it("retentionToWire concatenates value and unit", () => {
    expect(retentionToWire({ value: 100, unit: "d" })).toBe("100d");
    expect(retentionToWire({ value: 2, unit: "M" })).toBe("2M");
  });
  it("retentionFromWire splits value and unit", () => {
    expect(retentionFromWire("100d")).toEqual({ value: 100, unit: "d" });
    expect(retentionFromWire("3M")).toEqual({ value: 3, unit: "M" });
  });
});
