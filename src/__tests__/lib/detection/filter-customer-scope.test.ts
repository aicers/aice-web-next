import { describe, expect, it } from "vitest";

import { DetectionForbiddenError } from "@/lib/detection/errors";
import {
  parsePositiveCustomerId,
  validateFilterScope,
} from "@/lib/detection/filter-customer-scope";

describe("parsePositiveCustomerId", () => {
  it("accepts a positive integer string", () => {
    expect(parsePositiveCustomerId("42")).toBe(42);
    expect(parsePositiveCustomerId("1")).toBe(1);
  });

  it("accepts a positive integer number", () => {
    expect(parsePositiveCustomerId(42)).toBe(42);
  });

  it("rejects zero, negatives, and non-integers", () => {
    expect(parsePositiveCustomerId("0")).toBeNull();
    expect(parsePositiveCustomerId("-1")).toBeNull();
    expect(parsePositiveCustomerId("1.5")).toBeNull();
    expect(parsePositiveCustomerId(0)).toBeNull();
    expect(parsePositiveCustomerId(-1)).toBeNull();
    expect(parsePositiveCustomerId(1.5)).toBeNull();
  });

  it("rejects malformed strings", () => {
    expect(parsePositiveCustomerId("")).toBeNull();
    expect(parsePositiveCustomerId("   ")).toBeNull();
    expect(parsePositiveCustomerId("abc")).toBeNull();
    expect(parsePositiveCustomerId("0x10")).toBeNull();
    expect(parsePositiveCustomerId("01")).toBeNull();
    expect(parsePositiveCustomerId("+1")).toBeNull();
    expect(parsePositiveCustomerId(" 1 ")).toBe(1); // trim is allowed
  });

  it("rejects non-string / non-number values", () => {
    expect(parsePositiveCustomerId(null)).toBeNull();
    expect(parsePositiveCustomerId(undefined)).toBeNull();
    expect(parsePositiveCustomerId({})).toBeNull();
    expect(parsePositiveCustomerId([])).toBeNull();
  });

  it("rejects NaN and Infinity", () => {
    expect(parsePositiveCustomerId(Number.NaN)).toBeNull();
    expect(parsePositiveCustomerId(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("validateFilterScope", () => {
  it("is a no-op when filter is query mode", () => {
    expect(() =>
      validateFilterScope({ mode: "query", text: "ip:1.1.1.1" }, [1, 2]),
    ).not.toThrow();
  });

  it("is a no-op when filter has no customers field", () => {
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { start: null, end: null } },
        [1, 2],
      ),
    ).not.toThrow();
  });

  it("is a no-op when customers list is empty", () => {
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: [] } },
        [1, 2],
      ),
    ).not.toThrow();
  });

  it("accepts an in-scope subset", () => {
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["1"] } },
        [1, 2],
      ),
    ).not.toThrow();
  });

  it("accepts the entire allowed scope", () => {
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["1", "2"] } },
        [1, 2],
      ),
    ).not.toThrow();
  });

  it("rejects a fully-out-of-scope ID with DetectionForbiddenError", () => {
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["3"] } },
        [1, 2],
      ),
    ).toThrow(DetectionForbiddenError);
  });

  it("rejects mixed legal/illegal IDs (no silent narrowing)", () => {
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["1", "3"] } },
        [1, 2],
      ),
    ).toThrow(DetectionForbiddenError);
  });

  it("rejects an unknown admin-target ID (admin must still be a known customer)", () => {
    // Admins are not exempted: their effective scope is materialised
    // upstream into the explicit list of every registered customer.
    // An unknown ID like 999999 is therefore not in `allowed`.
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["999999"] } },
        [1, 2, 3],
      ),
    ).toThrow(DetectionForbiddenError);
  });

  it("rejects malformed wire entries (NaN / non-integer / negative)", () => {
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["abc"] } },
        [1, 2],
      ),
    ).toThrow(DetectionForbiddenError);
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["1.5"] } },
        [1, 2],
      ),
    ).toThrow(DetectionForbiddenError);
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["-1"] } },
        [1, 2],
      ),
    ).toThrow(DetectionForbiddenError);
    expect(() =>
      validateFilterScope(
        { mode: "structured", input: { customers: ["0"] } },
        [1, 2],
      ),
    ).toThrow(DetectionForbiddenError);
  });
});
