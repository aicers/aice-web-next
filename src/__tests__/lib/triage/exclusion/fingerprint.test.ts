import { describe, expect, it } from "vitest";

import {
  computeExclusionsFingerprint,
  EMPTY_EXCLUSIONS_FINGERPRINT,
  type ExclusionRule,
} from "@/lib/triage/exclusion";

describe("computeExclusionsFingerprint", () => {
  it("produces a stable empty-set fingerprint", () => {
    const fp = computeExclusionsFingerprint([]);
    expect(fp).toBe(EMPTY_EXCLUSIONS_FINGERPRINT);
    expect(typeof fp).toBe("string");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes set-equal inputs identically (rule order and intra-array permutation)", () => {
    const a: ExclusionRule[] = [
      { hostname: ["a.example", "b.example"] },
      { uri: ["/x", "/y"] },
    ];
    const b: ExclusionRule[] = [
      { uri: ["/y", "/x"] },
      { hostname: ["b.example", "a.example"] },
    ];
    expect(computeExclusionsFingerprint(a)).toBe(
      computeExclusionsFingerprint(b),
    );
  });

  it("treats duplicate values as one (de-dup)", () => {
    const a: ExclusionRule[] = [{ hostname: ["a.example", "a.example"] }];
    const b: ExclusionRule[] = [{ hostname: ["a.example"] }];
    expect(computeExclusionsFingerprint(a)).toBe(
      computeExclusionsFingerprint(b),
    );
  });

  it("hashes IpAddressGroup content order-independently", () => {
    const a: ExclusionRule[] = [
      {
        ipAddress: {
          hosts: ["10.0.0.1", "10.0.0.2"],
          networks: ["10.0.0.0/24"],
          ranges: [{ start: "10.0.0.5", end: "10.0.0.10" }],
        },
      },
    ];
    const b: ExclusionRule[] = [
      {
        ipAddress: {
          hosts: ["10.0.0.2", "10.0.0.1"],
          networks: ["10.0.0.0/24"],
          ranges: [{ start: "10.0.0.5", end: "10.0.0.10" }],
        },
      },
    ];
    expect(computeExclusionsFingerprint(a)).toBe(
      computeExclusionsFingerprint(b),
    );
  });

  it("differs when content differs", () => {
    const a: ExclusionRule[] = [{ hostname: ["a.example"] }];
    const b: ExclusionRule[] = [{ hostname: ["b.example"] }];
    expect(computeExclusionsFingerprint(a)).not.toBe(
      computeExclusionsFingerprint(b),
    );
  });

  it("ignores empty rules (all four fields null/empty) so they do not perturb the fingerprint", () => {
    const a: ExclusionRule[] = [
      { hostname: ["a.example"] },
      { hostname: [] },
      {},
    ];
    const b: ExclusionRule[] = [{ hostname: ["a.example"] }];
    expect(computeExclusionsFingerprint(a)).toBe(
      computeExclusionsFingerprint(b),
    );
  });

  it("EMPTY_EXCLUSIONS_FINGERPRINT is a 64-char hex string (sha256 hex)", () => {
    expect(EMPTY_EXCLUSIONS_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
  });
});
