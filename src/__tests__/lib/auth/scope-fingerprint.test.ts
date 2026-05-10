import { describe, expect, it } from "vitest";

import { computeScopeFingerprint } from "@/lib/auth/scope-fingerprint";

describe("computeScopeFingerprint", () => {
  const ACCOUNT_A = "00000000-0000-0000-0000-00000000000a";
  const ACCOUNT_B = "00000000-0000-0000-0000-00000000000b";

  it("is stable across calls with the same inputs", () => {
    expect(computeScopeFingerprint(ACCOUNT_A, [1, 2, 3])).toBe(
      computeScopeFingerprint(ACCOUNT_A, [1, 2, 3]),
    );
  });

  it("ignores customer id ordering (sorted before hashing)", () => {
    expect(computeScopeFingerprint(ACCOUNT_A, [3, 1, 2])).toBe(
      computeScopeFingerprint(ACCOUNT_A, [1, 2, 3]),
    );
  });

  it("differs for the same account when the customer set changes", () => {
    // Same-account scope swap (X → Y) — what the cache surfaces are
    // guarded against (#393 Task A). The fingerprint must visibly
    // change so cached entries miss.
    expect(computeScopeFingerprint(ACCOUNT_A, [1, 2])).not.toBe(
      computeScopeFingerprint(ACCOUNT_A, [1, 3]),
    );
  });

  it("differs across accounts even when the scope is identical", () => {
    expect(computeScopeFingerprint(ACCOUNT_A, [1, 2, 3])).not.toBe(
      computeScopeFingerprint(ACCOUNT_B, [1, 2, 3]),
    );
  });

  it("differs between empty scope and a scope with one customer (account A)", () => {
    expect(computeScopeFingerprint(ACCOUNT_A, [])).not.toBe(
      computeScopeFingerprint(ACCOUNT_A, [1]),
    );
  });

  it("yields a fixed-length hex string suitable for use as a cache key segment", () => {
    const fp = computeScopeFingerprint(ACCOUNT_A, [1, 2, 3]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
