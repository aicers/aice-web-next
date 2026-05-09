import { describe, expect, it } from "vitest";
import {
  extractRegistrableDomain,
  normalizeUriPattern,
} from "@/lib/triage/pivot";
import { isIpLiteral } from "@/lib/triage/pivot/normalize";

describe("extractRegistrableDomain", () => {
  it("returns the eTLD+1 for a simple hostname", () => {
    expect(extractRegistrableDomain("foo.example.com")).toBe("example.com");
  });

  it("respects multi-level public suffixes (ccTLD)", () => {
    expect(extractRegistrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
  });

  it("respects PSL private-domain suffixes (s3.amazonaws.com)", () => {
    expect(extractRegistrableDomain("foo.bar.s3.amazonaws.com")).toBe(
      "bar.s3.amazonaws.com",
    );
  });

  it("strips a trailing :port before resolving", () => {
    expect(extractRegistrableDomain("example.com:8443")).toBe("example.com");
  });

  it("handles IDN by leaving punycoded labels intact", () => {
    // tldts returns punycode for IDN; either form is acceptable as long
    // as it resolves to a stable canonical key.
    expect(extractRegistrableDomain("xn--fsq.example.com")).toBe("example.com");
  });

  it("returns null for IP literals", () => {
    expect(extractRegistrableDomain("203.0.113.5")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(extractRegistrableDomain(null)).toBeNull();
    expect(extractRegistrableDomain(undefined)).toBeNull();
    expect(extractRegistrableDomain("")).toBeNull();
    expect(extractRegistrableDomain("   ")).toBeNull();
  });

  it("lowercases the domain so case variants do not split groups", () => {
    expect(extractRegistrableDomain("Foo.EXAMPLE.com")).toBe("example.com");
  });
});

describe("normalizeUriPattern", () => {
  it("strips the query string", () => {
    expect(normalizeUriPattern("/api/v1/users?token=foo")).toBe(
      "/api/v1/users",
    );
  });

  it("templates numeric segments to {id}", () => {
    expect(normalizeUriPattern("/api/v1/users/42")).toBe("/api/v1/users/{id}");
  });

  it("templates UUID segments to {uuid}", () => {
    expect(
      normalizeUriPattern("/files/3fa85f64-5717-4562-b3fc-2c963f66afa6"),
    ).toBe("/files/{uuid}");
  });

  it("templates long pure-hex segments to {hex}", () => {
    expect(
      normalizeUriPattern("/objects/abcdef0123456789abcdef0123456789abcdef01"),
    ).toBe("/objects/{hex}");
  });

  it("preserves the leading slash and segment structure", () => {
    expect(normalizeUriPattern("/")).toBe("/");
    expect(normalizeUriPattern("/api/v1/")).toBe("/api/v1/");
  });

  it("strips fragments as well as query strings", () => {
    expect(normalizeUriPattern("/foo/bar#anchor")).toBe("/foo/bar");
  });

  it("returns null for empty or whitespace input", () => {
    expect(normalizeUriPattern(null)).toBeNull();
    expect(normalizeUriPattern(undefined)).toBeNull();
    expect(normalizeUriPattern("")).toBeNull();
    expect(normalizeUriPattern("   ")).toBeNull();
  });
});

describe("isIpLiteral", () => {
  it("accepts well-formed IPv4 addresses", () => {
    expect(isIpLiteral("1.2.3.4")).toBe(true);
    expect(isIpLiteral("203.0.113.5")).toBe(true);
    expect(isIpLiteral("0.0.0.0")).toBe(true);
    expect(isIpLiteral("255.255.255.255")).toBe(true);
  });

  it("rejects IPv4 strings with out-of-range octets", () => {
    expect(isIpLiteral("256.0.0.1")).toBe(false);
    expect(isIpLiteral("1.2.3")).toBe(false);
    expect(isIpLiteral("1.2.3.4.5")).toBe(false);
  });

  it("accepts canonical and compressed IPv6 addresses", () => {
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(isIpLiteral("::ffff:1.2.3.4")).toBe(true);
  });

  it("rejects non-IP DNS-answer payloads", () => {
    expect(isIpLiteral("cdn.example.com")).toBe(false);
    expect(isIpLiteral("NXDOMAIN")).toBe(false);
    expect(isIpLiteral("")).toBe(false);
    expect(isIpLiteral(":::")).toBe(false);
  });
});
