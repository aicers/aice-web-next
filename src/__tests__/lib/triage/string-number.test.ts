import { describe, expect, it } from "vitest";

import {
  compareStringNumber,
  parseStringNumber,
  stringNumberGreaterThan,
} from "@/lib/triage/string-number";

describe("parseStringNumber", () => {
  it("parses non-negative integer strings", () => {
    expect(parseStringNumber("0")).toBe(BigInt(0));
    expect(parseStringNumber("42")).toBe(BigInt(42));
    expect(parseStringNumber("9007199254740993")).toBe(
      BigInt("9007199254740993"),
    );
  });

  it("returns null for null / undefined / empty / non-integer input", () => {
    expect(parseStringNumber(null)).toBeNull();
    expect(parseStringNumber(undefined)).toBeNull();
    expect(parseStringNumber("")).toBeNull();
    expect(parseStringNumber("-1")).toBeNull();
    expect(parseStringNumber("3.5")).toBeNull();
    expect(parseStringNumber("1e3")).toBeNull();
    expect(parseStringNumber("not-a-number")).toBeNull();
  });
});

describe("stringNumberGreaterThan", () => {
  it("compares without losing precision past 2^53", () => {
    // 2^53 = 9007199254740992. Adding 1 produces a value that loses
    // precision when cast to Number — the BigInt path keeps it.
    expect(
      stringNumberGreaterThan("9007199254740993", BigInt("9007199254740992")),
    ).toBe(true);
    expect(
      stringNumberGreaterThan("9007199254740992", BigInt("9007199254740993")),
    ).toBe(false);
  });

  it("returns false when the count cannot be parsed", () => {
    expect(stringNumberGreaterThan(null, 0)).toBe(false);
    expect(stringNumberGreaterThan("abc", 0)).toBe(false);
  });

  it("supports the 20,000 modal threshold from #453", () => {
    expect(stringNumberGreaterThan("19999", 20000)).toBe(false);
    expect(stringNumberGreaterThan("20000", 20000)).toBe(false);
    expect(stringNumberGreaterThan("20001", 20000)).toBe(true);
  });
});

describe("compareStringNumber", () => {
  it("orders nulls last and parsed values numerically", () => {
    expect(compareStringNumber("10", "20")).toBeLessThan(0);
    expect(compareStringNumber("20", "10")).toBeGreaterThan(0);
    expect(compareStringNumber("10", "10")).toBe(0);
    expect(compareStringNumber(null, "10")).toBeLessThan(0);
    expect(compareStringNumber("10", null)).toBeGreaterThan(0);
    expect(compareStringNumber(null, null)).toBe(0);
  });
});
