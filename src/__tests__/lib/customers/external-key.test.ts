import { describe, expect, it } from "vitest";

import {
  EXTERNAL_KEY_MAX_LENGTH,
  ExternalKeyValidationError,
  isExternalKeyUniqueViolation,
  isPgUniqueViolation,
  normalizeExternalKey,
} from "@/lib/customers/external-key";

describe("normalizeExternalKey", () => {
  it("returns undefined for an omitted field", () => {
    expect(normalizeExternalKey(undefined)).toBeUndefined();
  });

  it("returns null for explicit null", () => {
    expect(normalizeExternalKey(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeExternalKey("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normalizeExternalKey("   \t  \n")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeExternalKey("  acmecorp.com  ")).toBe("acmecorp.com");
  });

  it("preserves a non-empty value", () => {
    expect(normalizeExternalKey("acmecorp.com")).toBe("acmecorp.com");
  });

  it("rejects non-string values", () => {
    expect(() => normalizeExternalKey(123)).toThrow(ExternalKeyValidationError);
    expect(() => normalizeExternalKey({})).toThrow(ExternalKeyValidationError);
    expect(() => normalizeExternalKey([])).toThrow(ExternalKeyValidationError);
  });

  it(`rejects strings longer than ${EXTERNAL_KEY_MAX_LENGTH} chars`, () => {
    const tooLong = "a".repeat(EXTERNAL_KEY_MAX_LENGTH + 1);
    expect(() => normalizeExternalKey(tooLong)).toThrow(
      ExternalKeyValidationError,
    );
  });

  it(`accepts strings exactly ${EXTERNAL_KEY_MAX_LENGTH} chars long`, () => {
    const exact = "a".repeat(EXTERNAL_KEY_MAX_LENGTH);
    expect(normalizeExternalKey(exact)).toBe(exact);
  });

  it("rejects values containing C0 control characters", () => {
    expect(() =>
      normalizeExternalKey(`acme${String.fromCharCode(0x01)}corp`),
    ).toThrow(ExternalKeyValidationError);
    expect(() => normalizeExternalKey("acme\ncorp")).toThrow(
      ExternalKeyValidationError,
    );
    expect(() => normalizeExternalKey("acme\tcorp")).toThrow(
      ExternalKeyValidationError,
    );
  });

  it("rejects values containing DEL or C1 control characters", () => {
    expect(() =>
      normalizeExternalKey(`acme${String.fromCharCode(0x7f)}corp`),
    ).toThrow(ExternalKeyValidationError);
    expect(() =>
      normalizeExternalKey(`acme${String.fromCharCode(0x9f)}corp`),
    ).toThrow(ExternalKeyValidationError);
  });

  it("allows non-ASCII printable characters (e.g. Hangul, accents)", () => {
    expect(normalizeExternalKey("회사-001")).toBe("회사-001");
    expect(normalizeExternalKey("café-Ω-42")).toBe("café-Ω-42");
  });
});

describe("isPgUniqueViolation", () => {
  it("matches errors with code 23505", () => {
    expect(isPgUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(isPgUniqueViolation(null)).toBe(false);
    expect(isPgUniqueViolation(undefined)).toBe(false);
    expect(isPgUniqueViolation({ code: "23502" })).toBe(false);
    expect(isPgUniqueViolation(new Error("boom"))).toBe(false);
  });
});

describe("isExternalKeyUniqueViolation", () => {
  it("matches the customers_external_key_key constraint", () => {
    expect(
      isExternalKeyUniqueViolation({
        code: "23505",
        constraint: "customers_external_key_key",
      }),
    ).toBe(true);
  });

  it("does not match other unique violations", () => {
    expect(
      isExternalKeyUniqueViolation({
        code: "23505",
        constraint: "customers_database_name_key",
      }),
    ).toBe(false);
  });

  it("does not match non-unique errors", () => {
    expect(
      isExternalKeyUniqueViolation({
        code: "23502",
        constraint: "customers_external_key_key",
      }),
    ).toBe(false);
  });
});
