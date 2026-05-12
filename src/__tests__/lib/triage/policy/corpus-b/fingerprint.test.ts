import { describe, expect, it } from "vitest";

import {
  computePoliciesFingerprint,
  EMPTY_POLICIES_FINGERPRINT,
} from "@/lib/triage/policy/corpus-b/fingerprint";
import type { TriagePolicyRow } from "@/lib/triage/policy/types";

function buildPolicy(overrides: Partial<TriagePolicyRow>): TriagePolicyRow {
  return {
    id: 1,
    name: "p",
    packet_attr: [],
    confidence: [],
    response: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("computePoliciesFingerprint", () => {
  it("produces a stable empty-set fingerprint", () => {
    const fp = computePoliciesFingerprint([]);
    expect(fp).toBe(EMPTY_POLICIES_FINGERPRINT);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes set-equal inputs identically (policy order)", () => {
    const a: TriagePolicyRow[] = [
      buildPolicy({ id: 1, name: "a" }),
      buildPolicy({ id: 2, name: "b" }),
    ];
    const b: TriagePolicyRow[] = [
      buildPolicy({ id: 2, name: "b" }),
      buildPolicy({ id: 1, name: "a" }),
    ];
    expect(computePoliciesFingerprint(a)).toBe(computePoliciesFingerprint(b));
  });

  it("hashes intra-policy rule order permutations identically", () => {
    const ruleA = {
      raw_event_kind: "http" as const,
      attr_name: "host",
      value_kind: "string" as const,
      cmp_kind: "equal" as const,
      first_value: "evil",
      second_value: null,
      weight: 1,
    };
    const ruleB = { ...ruleA, attr_name: "uri", first_value: "/admin" };
    const a = buildPolicy({ packet_attr: [ruleA, ruleB] });
    const b = buildPolicy({ packet_attr: [ruleB, ruleA] });
    expect(computePoliciesFingerprint([a])).toBe(
      computePoliciesFingerprint([b]),
    );
  });

  it("changes when rule values change", () => {
    const a = buildPolicy({
      packet_attr: [
        {
          raw_event_kind: "http",
          attr_name: "host",
          value_kind: "string",
          cmp_kind: "equal",
          first_value: "evil",
          second_value: null,
          weight: null,
        },
      ],
    });
    const b = buildPolicy({
      packet_attr: [
        {
          raw_event_kind: "http",
          attr_name: "host",
          value_kind: "string",
          cmp_kind: "equal",
          first_value: "good",
          second_value: null,
          weight: null,
        },
      ],
    });
    expect(computePoliciesFingerprint([a])).not.toBe(
      computePoliciesFingerprint([b]),
    );
  });

  it("changes when policy id changes", () => {
    const a = buildPolicy({ id: 1 });
    const b = buildPolicy({ id: 2 });
    expect(computePoliciesFingerprint([a])).not.toBe(
      computePoliciesFingerprint([b]),
    );
  });
});
