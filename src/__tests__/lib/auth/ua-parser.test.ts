import { describe, expect, it } from "vitest";

import {
  compareBrowserFingerprints,
  extractBrowserFingerprint,
} from "@/lib/auth/ua-parser";

describe("extractBrowserFingerprint", () => {
  it("extracts Chrome fingerprint", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    expect(extractBrowserFingerprint(ua)).toBe("Chrome/131");
  });

  it("extracts Firefox fingerprint", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
    expect(extractBrowserFingerprint(ua)).toBe("Firefox/133");
  });

  it("extracts Safari fingerprint", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(extractBrowserFingerprint(ua)).toBe("Safari/17");
  });

  it("extracts Edge fingerprint (not Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
    expect(extractBrowserFingerprint(ua)).toBe("Edge/131");
  });

  it("extracts Opera fingerprint (not Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0";
    expect(extractBrowserFingerprint(ua)).toBe("Opera/116");
  });

  it('returns "Unknown/0" for empty string', () => {
    expect(extractBrowserFingerprint("")).toBe("Unknown/0");
  });

  it('returns "Unknown/0" for bot/crawler UA', () => {
    const ua = "Googlebot/2.1 (+http://www.google.com/bot.html)";
    expect(extractBrowserFingerprint(ua)).toBe("Unknown/0");
  });

  it("extracts Edge Android (EdgA) fingerprint", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0";
    expect(extractBrowserFingerprint(ua)).toBe("Edge/131");
  });

  it("extracts Edge iOS (EdgiOS) fingerprint", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/131.0.0.0 Mobile/15E148 Safari/604.1";
    expect(extractBrowserFingerprint(ua)).toBe("Edge/131");
  });

  it("ignores minor/patch version numbers", () => {
    const ua1 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
    const ua2 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.6778.85 Safari/537.36";
    expect(extractBrowserFingerprint(ua1)).toBe("Chrome/131");
    expect(extractBrowserFingerprint(ua2)).toBe("Chrome/131");
  });
});

describe("compareBrowserFingerprints", () => {
  it('returns "same" for identical fingerprints', () => {
    expect(compareBrowserFingerprints("Chrome/131", "Chrome/131")).toBe("same");
  });

  it('returns "minor" for same family, different major version', () => {
    expect(compareBrowserFingerprints("Chrome/131", "Chrome/132")).toBe(
      "minor",
    );
  });

  it('returns "major" for different family', () => {
    expect(compareBrowserFingerprints("Chrome/131", "Firefox/133")).toBe(
      "major",
    );
  });

  it('returns "major" for Unknown vs any known browser', () => {
    expect(compareBrowserFingerprints("Unknown/0", "Chrome/131")).toBe("major");
  });

  it('returns "same" for two Unknown fingerprints', () => {
    expect(compareBrowserFingerprints("Unknown/0", "Unknown/0")).toBe("same");
  });

  it('returns "major" for malformed fingerprint (no slash)', () => {
    expect(compareBrowserFingerprints("Chrome", "")).toBe("major");
  });

  it('returns "same" for two empty strings', () => {
    expect(compareBrowserFingerprints("", "")).toBe("same");
  });
});
