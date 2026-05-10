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
    ["host\\d+", /Shorthand \\d is rejected/],
    ["host\\D+", /Shorthand \\D is rejected/],
    ["[\\d]", /Shorthand \\d is rejected/],
    ["a\\wb", /Shorthand \\w is rejected/],
    ["a\\Wb", /Shorthand \\W is rejected/],
    ["a\\sb", /Shorthand \\s is rejected/],
    ["a\\Sb", /Shorthand \\S is rejected/],
    ["foo\\bbar", /Shorthand \\b is rejected/],
    ["foo\\Bbar", /Shorthand \\B is rejected/],
    ["(?:trk|ads)\\d{1,3}", /Shorthand \\d is rejected/],
  ])("rejects %s", (pattern, expected) => {
    const result = validateDomainPattern(pattern);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(expected);
  });

  it.each([
    "literal-backslash-then-d\\\\d",
    "literal-backslash-then-w\\\\w",
    "tracker[0-9]{1,3}\\.example",
    "host[A-Za-z0-9_]+\\.example",
    "ws[ \\t\\r\\n]+",
  ])("accepts ASCII alternative or escaped backslash before letter %s", (pattern) => {
    expect(validateDomainPattern(pattern)).toEqual({ ok: true });
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
