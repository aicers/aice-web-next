import { describe, expect, it } from "vitest";

import { reduceDomainPatternToSuffix } from "@/lib/triage/exclusion/suffix-reducer";

describe("reduceDomainPatternToSuffix", () => {
  it("reduces ^foo\\.example\\.com$ to exact host", () => {
    const r = reduceDomainPatternToSuffix("^foo\\.example\\.com$");
    expect(r).toEqual({ value: "foo.example.com", exact: true });
  });

  it("reduces ^.*\\.example\\.com$ to .example.com", () => {
    const r = reduceDomainPatternToSuffix("^.*\\.example\\.com$");
    expect(r).toEqual({ value: ".example.com", exact: false });
  });

  it("reduces ^.+\\.example\\.com$ to .example.com", () => {
    const r = reduceDomainPatternToSuffix("^.+\\.example\\.com$");
    expect(r).toEqual({ value: ".example.com", exact: false });
  });

  it("reduces ^[^.]+\\.example\\.com$ to .example.com", () => {
    const r = reduceDomainPatternToSuffix("^[^.]+\\.example\\.com$");
    expect(r).toEqual({ value: ".example.com", exact: false });
  });

  it("reduces ^([a-z0-9-]+\\.)*example\\.com$ to .example.com", () => {
    const r = reduceDomainPatternToSuffix("^([a-z0-9-]+\\.)*example\\.com$");
    expect(r).toEqual({ value: ".example.com", exact: false });
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
