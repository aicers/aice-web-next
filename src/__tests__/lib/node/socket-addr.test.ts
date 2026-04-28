import { describe, expect, it } from "vitest";

import { formatSocketAddr, parseSocketAddr } from "@/lib/node/socket-addr";

describe("formatSocketAddr", () => {
  it("emits the bare ip:port form for IPv4", () => {
    expect(formatSocketAddr("192.168.1.1", 38370)).toBe("192.168.1.1:38370");
  });
  it("brackets IPv6 literals so the colon stays unambiguous", () => {
    expect(formatSocketAddr("::1", 38370)).toBe("[::1]:38370");
    expect(formatSocketAddr("2001:db8::1", 8443)).toBe("[2001:db8::1]:8443");
  });
});

describe("parseSocketAddr", () => {
  it("parses IPv4 ip:port", () => {
    expect(parseSocketAddr("10.0.0.5:8443", 0)).toEqual({
      ip: "10.0.0.5",
      port: 8443,
    });
  });
  it("parses bracketed IPv6 [ip]:port without consuming the embedded colons", () => {
    expect(parseSocketAddr("[2001:db8::1]:38370", 0)).toEqual({
      ip: "2001:db8::1",
      port: 38370,
    });
    expect(parseSocketAddr("[::1]:8443", 0)).toEqual({
      ip: "::1",
      port: 8443,
    });
  });
  it("falls back to the supplied port for malformed input", () => {
    expect(parseSocketAddr("", 9999)).toEqual({ ip: "", port: 9999 });
    expect(parseSocketAddr("[::1]", 9999)).toEqual({ ip: "::1", port: 9999 });
    expect(parseSocketAddr("[::1]:", 9999)).toEqual({ ip: "::1", port: 9999 });
  });
});
