import { describe, expect, it } from "vitest";

import {
  normalizeAimerWebBridgeUrl,
  validateAiceId,
} from "@/lib/aimer/settings";

describe("validateAiceId (RFC 1123 hostname)", () => {
  it("accepts a typical deployment hostname", () => {
    expect(validateAiceId("aice-acme.example.com").valid).toBe(true);
  });

  it("accepts a single label", () => {
    expect(validateAiceId("aice").valid).toBe(true);
  });

  it("accepts long labels up to 63 chars", () => {
    expect(validateAiceId(`${"a".repeat(63)}.example.com`).valid).toBe(true);
  });

  it("rejects empty / whitespace", () => {
    expect(validateAiceId("").valid).toBe(false);
    // Whitespace is treated as a label that fails the regex.
    expect(validateAiceId(" ").valid).toBe(false);
  });

  it("rejects underscores (intentional — used as JWT iss)", () => {
    expect(validateAiceId("ace_id.example.com").valid).toBe(false);
  });

  it("rejects labels starting or ending with a hyphen", () => {
    expect(validateAiceId("-bad.example.com").valid).toBe(false);
    expect(validateAiceId("bad-.example.com").valid).toBe(false);
  });

  it("rejects labels longer than 63 chars", () => {
    expect(validateAiceId(`${"a".repeat(64)}.example.com`).valid).toBe(false);
  });

  it("rejects total length over 253 chars", () => {
    const label = "a".repeat(60);
    const value = Array(5).fill(label).join(".");
    // 5 * 60 + 4 dots = 304 chars
    expect(value.length).toBeGreaterThan(253);
    expect(validateAiceId(value).valid).toBe(false);
  });
});

describe("normalizeAimerWebBridgeUrl (HTTPS-only base URL)", () => {
  it("accepts a bare https origin", () => {
    const result = normalizeAimerWebBridgeUrl("https://aimer.example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toBe("https://aimer.example.com");
    }
  });

  it("strips a trailing slash", () => {
    const result = normalizeAimerWebBridgeUrl("https://aimer.example.com/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toBe("https://aimer.example.com");
    }
  });

  it("preserves an internal path but strips a trailing slash", () => {
    const result = normalizeAimerWebBridgeUrl(
      "https://aimer.example.com/bridge/",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toBe("https://aimer.example.com/bridge");
    }
  });

  it("trims surrounding whitespace", () => {
    const result = normalizeAimerWebBridgeUrl("  https://aimer.example.com  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toBe("https://aimer.example.com");
    }
  });

  it("rejects http://", () => {
    const result = normalizeAimerWebBridgeUrl("http://aimer.example.com");
    expect(result.ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(normalizeAimerWebBridgeUrl("").ok).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(normalizeAimerWebBridgeUrl("not a url").ok).toBe(false);
  });

  it("rejects credentials in the URL", () => {
    expect(
      normalizeAimerWebBridgeUrl("https://user:pass@aimer.example.com").ok,
    ).toBe(false);
  });

  it("rejects query strings and fragments on the base URL", () => {
    expect(normalizeAimerWebBridgeUrl("https://aimer.example.com?x=1").ok).toBe(
      false,
    );
    expect(
      normalizeAimerWebBridgeUrl("https://aimer.example.com#frag").ok,
    ).toBe(false);
  });
});
