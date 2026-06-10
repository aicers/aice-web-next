import { describe, expect, it } from "vitest";

import { reduceDomainPatternToSuffix } from "@/lib/triage/exclusion/suffix-reducer";

describe("reduceDomainPatternToSuffix", () => {
  it("reduces ^foo\\.example\\.com$ to exact host", () => {
    const r = reduceDomainPatternToSuffix("^foo\\.example\\.com$");
    expect(r).toEqual({
      value: "foo.example.com",
      subset: "exact",
    });
  });

  it("reduces ^.*\\.example\\.com$ to suffix-only", () => {
    // `.*\.` requires at least one literal dot before the suffix, so
    // bare `example.com` is NOT in the regex's match set. The planner
    // must emit a suffix-only LIKE predicate; over-deleting the bare
    // host is a regression caught here.
    const r = reduceDomainPatternToSuffix("^.*\\.example\\.com$");
    expect(r).toEqual({
      value: ".example.com",
      subset: "suffix",
    });
  });

  it("reduces ^.+\\.example\\.com$ to suffix-only", () => {
    const r = reduceDomainPatternToSuffix("^.+\\.example\\.com$");
    expect(r).toEqual({
      value: ".example.com",
      subset: "suffix",
    });
  });

  it("does not reduce ^[^.]+\\.example\\.com$ — single-label is not SQL-expressible", () => {
    // The regex matches exactly one label before the suffix; a
    // `host LIKE '%.example.com'` predicate would over-match
    // `a.b.example.com`. Treat as full-regex-only — forward matching
    // still applies.
    expect(reduceDomainPatternToSuffix("^[^.]+\\.example\\.com$")).toBeNull();
  });

  it("reduces ^([a-z0-9-]+\\.)*example\\.com$ to exact-or-suffix", () => {
    // `*` permits zero label prefixes, so the bare host IS in the
    // regex's match set; the planner emits both `host = 'example.com'`
    // and `host LIKE '%.example.com'`.
    const r = reduceDomainPatternToSuffix("^([a-z0-9-]+\\.)*example\\.com$");
    expect(r).toEqual({
      value: ".example.com",
      subset: "exactOrSuffix",
    });
  });

  it("returns null for alternation", () => {
    expect(
      reduceDomainPatternToSuffix("^(foo|bar)\\.example\\.com$"),
    ).toBeNull();
  });

  it("returns null when not anchored", () => {
    expect(reduceDomainPatternToSuffix("foo\\.example\\.com")).toBeNull();
  });

  it("returns null for nested expressions", () => {
    expect(
      reduceDomainPatternToSuffix("^foo[abc]\\.example\\.com$"),
    ).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(reduceDomainPatternToSuffix("^$")).toBeNull();
  });
});
