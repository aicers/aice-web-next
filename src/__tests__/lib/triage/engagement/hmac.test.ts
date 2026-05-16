import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  _resetEngagementHmacKey,
  hmacAccountId,
  hmacAssetKey,
  hmacCountry,
  hmacDomain,
  hmacFingerprint,
  hmacIp,
  normalizeAccountId,
  normalizeCountry,
  normalizeDomain,
  normalizeFingerprint,
  normalizeIp,
} from "@/lib/triage/engagement/hmac";

const TEST_KEY = "x".repeat(64);
const ORIGINAL_KEY = process.env.ENGAGEMENT_HMAC_KEY;

beforeAll(() => {
  process.env.ENGAGEMENT_HMAC_KEY = TEST_KEY;
  _resetEngagementHmacKey();
});

afterEach(() => {
  process.env.ENGAGEMENT_HMAC_KEY = TEST_KEY;
  _resetEngagementHmacKey();
});

describe("engagement HMAC normalizers", () => {
  it("normalizes IPv4 by stripping leading zeros", () => {
    expect(normalizeIp("010.000.000.001")).toBe("10.0.0.1");
    expect(normalizeIp("192.168.001.001")).toBe("192.168.1.1");
  });

  it("normalizes IPv6 to lowercase compressed form", () => {
    expect(normalizeIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe(
      "[2001:db8::1]".slice(1, -1),
    );
    expect(normalizeIp("::1")).toBe("[::1]".slice(1, -1));
  });

  it("normalizes domains by lowercasing and stripping trailing dot", () => {
    expect(normalizeDomain("EXAMPLE.COM.")).toBe("example.com");
    expect(normalizeDomain("  Foo.Bar.Example  ")).toBe("foo.bar.example");
  });

  it("punycode-normalizes non-ASCII domains", () => {
    // "한글.example" → punycode-encoded by URL hostname rule.
    const out = normalizeDomain("한글.example");
    expect(out).toBe("xn--bj0bj06e.example");
  });

  it("lowercases TLS fingerprints", () => {
    expect(normalizeFingerprint("AB12cd34EF")).toBe("ab12cd34ef");
  });

  it("uppercases country codes", () => {
    expect(normalizeCountry("kr")).toBe("KR");
  });

  it("lowercases account ids", () => {
    expect(normalizeAccountId("  AliceID  ")).toBe("aliceid");
  });
});

describe("engagement HMAC determinism", () => {
  it("produces the same HMAC for equivalent IPs", () => {
    expect(hmacIp("10.0.0.1")).toBe(hmacIp("010.000.000.001"));
  });

  it("produces the same HMAC for equivalent domains", () => {
    expect(hmacDomain("Example.com")).toBe(hmacDomain("example.com."));
  });

  it("produces the same HMAC for equivalent fingerprints", () => {
    expect(hmacFingerprint("AB12CD")).toBe(hmacFingerprint("ab12cd"));
  });

  it("produces the same HMAC for equivalent country codes", () => {
    expect(hmacCountry("kr")).toBe(hmacCountry("KR"));
  });

  it("produces the same HMAC for equivalent account ids", () => {
    expect(hmacAccountId("ABC")).toBe(hmacAccountId("abc"));
  });

  it("hmacAssetKey collapses on the IP normalization path", () => {
    expect(hmacAssetKey("10.0.0.1")).toBe(hmacIp("10.0.0.1"));
  });

  it("produces different HMACs for different values", () => {
    expect(hmacIp("10.0.0.1")).not.toBe(hmacIp("10.0.0.2"));
    expect(hmacDomain("foo.example")).not.toBe(hmacDomain("bar.example"));
  });
});

describe("engagement HMAC key validation", () => {
  it("rejects a missing key", () => {
    process.env.ENGAGEMENT_HMAC_KEY = "";
    _resetEngagementHmacKey();
    expect(() => hmacIp("10.0.0.1")).toThrow(
      /Missing environment variable: ENGAGEMENT_HMAC_KEY/,
    );
  });

  it("rejects a non-base64 key (invalid alphabet)", () => {
    // 64 chars but `!` is outside the base64 alphabet, so this is the
    // arbitrary-UTF-8 string the previous guard let through.
    process.env.ENGAGEMENT_HMAC_KEY = "!".repeat(64);
    _resetEngagementHmacKey();
    expect(() => hmacIp("10.0.0.1")).toThrow(/not valid base64/);
  });

  it("rejects a base64 key that decodes to <32 bytes", () => {
    // `openssl rand -base64 24` produces a 32-char base64 string that
    // decodes to only 24 random bytes — the issue called this out
    // explicitly as the under-entropy footgun the previous guard
    // accepted.
    const twentyFourBytes = Buffer.alloc(24, 0x42).toString("base64");
    expect(twentyFourBytes.length).toBe(32);
    process.env.ENGAGEMENT_HMAC_KEY = twentyFourBytes;
    _resetEngagementHmacKey();
    expect(() => hmacIp("10.0.0.1")).toThrow(/24 bytes/);
  });

  it("accepts a standard base64 key of ≥32 bytes", () => {
    const thirtyTwoBytes = Buffer.alloc(32, 0x7a).toString("base64");
    process.env.ENGAGEMENT_HMAC_KEY = thirtyTwoBytes;
    _resetEngagementHmacKey();
    expect(() => hmacIp("10.0.0.1")).not.toThrow();
  });

  it("accepts a URL-safe base64 key of ≥32 bytes", () => {
    // Buffer with bits that produce `+` and `/` characters in standard
    // base64, then swapped to `-` / `_` for URL-safe form.
    const raw = Buffer.from([
      0xfb, 0xff, 0xbf, 0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf,
      0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf,
      0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf, 0xfe, 0xff, 0xbf,
    ]);
    const urlSafe = raw
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    process.env.ENGAGEMENT_HMAC_KEY = urlSafe;
    _resetEngagementHmacKey();
    expect(() => hmacIp("10.0.0.1")).not.toThrow();
  });

  it("treats the cached key as load-once per process", () => {
    process.env.ENGAGEMENT_HMAC_KEY = TEST_KEY;
    _resetEngagementHmacKey();
    const a = hmacIp("10.0.0.1");
    // Mutating the env after first use does not change the cached key.
    process.env.ENGAGEMENT_HMAC_KEY = `${TEST_KEY}extra`;
    const b = hmacIp("10.0.0.1");
    expect(a).toBe(b);
  });
});

// Restore the original key (if any) so other tests in the same run
// keep their state.
afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ENGAGEMENT_HMAC_KEY;
  } else {
    process.env.ENGAGEMENT_HMAC_KEY = ORIGINAL_KEY;
  }
  _resetEngagementHmacKey();
});
