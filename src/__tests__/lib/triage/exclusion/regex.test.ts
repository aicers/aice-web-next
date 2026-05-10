import { describe, expect, it } from "vitest";

import {
  compileDomainPatterns,
  validateDomainPattern,
} from "@/lib/triage/exclusion";

describe("validateDomainPattern — Rust ∩ JS intersection grammar", () => {
  it.each([
    ".",
    "^example\\.com$",
    "ads\\.example\\.com",
    "(?:foo|bar)\\.example",
    "[a-z0-9-]+\\.example\\.org",
    "tracker[0-9]{1,3}\\.net",
    "non-greedy.*?end",
  ])("accepts intersection-grammar pattern %s", (pattern) => {
    expect(validateDomainPattern(pattern)).toEqual({ ok: true });
  });

  it.each<[string, RegExp]>([
    ["(?i)case-insensitive", /Inline modifier flags/],
    ["(?i:case)", /Inline modifier groups/],
    ["(?<=foo)bar", /Lookbehind/],
    ["(?<!foo)bar", /Lookbehind/],
    ["(?=foo)bar", /Lookahead/],
    ["(?!foo)bar", /Lookahead/],
    ["(?<name>foo)", /Named capture groups/],
    ["(?P<name>foo)", /Rust-style named capture groups/],
    ["\\Aexample", /anchors are rejected/],
    ["example\\z", /anchors are rejected/],
    ["(foo)\\1", /Back-references/],
    ["(?<n>foo)\\k<n>", /Named back-references|Named capture/],
    ["", /Empty Domain pattern/],
  ])("rejects %s", (pattern, expected) => {
    const result = validateDomainPattern(pattern);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(expected);
  });

  it("rejects malformed regex even when no engine-specific construct is present", () => {
    const result = validateDomainPattern("[unterminated");
    expect(result.ok).toBe(false);
  });
});

describe("compileDomainPatterns — RegexSet::is_match semantics (substring)", () => {
  it("matches any pattern in the set (OR semantics)", () => {
    const matcher = compileDomainPatterns([
      "ads\\.example",
      "tracker\\.example",
    ]);
    expect(matcher).not.toBeNull();
    expect(matcher?.test("ads.example.com")).toBe(true);
    expect(matcher?.test("tracker.example.org")).toBe(true);
    expect(matcher?.test("safe.example.com")).toBe(false);
  });

  it("returns null for the empty pattern set", () => {
    expect(compileDomainPatterns([])).toBeNull();
  });

  it("alternation in a single pattern stays scoped to that pattern", () => {
    const matcher = compileDomainPatterns(["foo|bar", "baz"]);
    expect(matcher?.test("foo")).toBe(true);
    expect(matcher?.test("bar")).toBe(true);
    expect(matcher?.test("baz")).toBe(true);
    expect(matcher?.test("qux")).toBe(false);
  });

  it("throws on an invalid pattern (storage path is supposed to validate first)", () => {
    expect(() => compileDomainPatterns(["(?i)broken"])).toThrow(
      /Inline modifier flags/,
    );
  });
});
