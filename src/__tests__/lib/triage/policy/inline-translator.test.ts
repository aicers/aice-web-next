import { describe, expect, it } from "vitest";

import { InlinePolicyEncodingError } from "@/lib/triage/inline-policy";
import { translatePolicyToInlineInput } from "@/lib/triage/policy/inline-translator";
import type { TriagePolicyRow } from "@/lib/triage/policy/types";

/**
 * Acceptance tests for the inline-policy translator (1B-6 / #460).
 *
 *   - Round-trip a stored TriagePolicy row through the byte encoder
 *     and check the wire-shape result against the documented contract.
 *   - Panic-free smoke for `Confidence.threat_category = None` at the
 *     **runner boundary** — even when the storage shape allows null
 *     (or a hand-crafted inline input synthesises one), the runner
 *     must surface a sensible inline object rather than panicking.
 *   - Encoding errors surface as structured `InlinePolicyEncodingError`
 *     instances carrying enough context for `last_error`.
 */

function buildPolicy(overrides: Partial<TriagePolicyRow>): TriagePolicyRow {
  return {
    id: 1,
    name: "test",
    packet_attr: [],
    confidence: [],
    response: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("translatePolicyToInlineInput", () => {
  it("round-trips a stored row to the documented wire shape", () => {
    const policy = buildPolicy({
      id: 42,
      packet_attr: [
        {
          raw_event_kind: "http",
          attr_name: "host",
          value_kind: "string",
          cmp_kind: "equal",
          first_value: "AB",
          second_value: null,
          weight: 0.5,
        },
      ],
      confidence: [
        {
          threat_category: "execution",
          threat_kind: "MaliciousScript",
          confidence: 0.9,
          weight: 1.0,
        },
      ],
      response: [
        {
          minimum_score: 0.5,
          kind: "manual",
        },
      ],
    });
    const out = translatePolicyToInlineInput(policy);
    expect(out.id).toBe(42);
    expect(out.packetAttr).toEqual([
      {
        rawEventKind: "HTTP",
        attrName: "host",
        valueKind: "STRING",
        cmpKind: "EQUAL",
        firstValue: [0x41, 0x42],
        secondValue: null,
        weight: 0.5,
      },
    ]);
    expect(out.confidence).toEqual([
      {
        threatCategory: "EXECUTION",
        threatKind: "MaliciousScript",
        confidence: 0.9,
        weight: 1.0,
      },
    ]);
    expect(out.response).toEqual([{ minimumScore: 0.5, kind: "MANUAL" }]);
  });

  it("does not panic when Confidence.threat_category is null (runner-boundary smoke)", () => {
    // Storage currently requires `threat_category`, but the runner must
    // defend against a null arriving via any path — synthesized in
    // tests, future storage relaxation, or hand-crafted inline input.
    // The translator surfaces a null `threatCategory` rather than
    // throwing.
    const policy = buildPolicy({
      confidence: [
        {
          // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing storage type
          threat_category: null as any,
          threat_kind: "MaliciousScript",
          confidence: 0.9,
          weight: null,
        },
      ],
    });
    const out = translatePolicyToInlineInput(policy);
    expect(out.confidence[0].threatCategory).toBeNull();
    expect(out.confidence[0].threatKind).toBe("MaliciousScript");
  });

  it("surfaces a structured error with policyId context on encoding failure", () => {
    const policy = buildPolicy({
      id: 7,
      packet_attr: [
        {
          raw_event_kind: "http",
          attr_name: "addr",
          value_kind: "ipaddr",
          cmp_kind: "equal",
          first_value: "10.0.0.0/24",
          second_value: null,
          weight: null,
        },
      ],
    });
    try {
      translatePolicyToInlineInput(policy);
      expect.fail("expected InlinePolicyEncodingError");
    } catch (err) {
      expect(err).toBeInstanceOf(InlinePolicyEncodingError);
      const e = err as InlinePolicyEncodingError;
      expect(e.kind).toBe("ipaddr_cidr_not_supported");
      expect(e.context?.policyId).toBe(7);
      expect(e.context?.ruleIndex).toBe(0);
    }
  });

  it("surfaces a structured error for vector value_kind", () => {
    const policy = buildPolicy({
      id: 3,
      packet_attr: [
        {
          raw_event_kind: "http",
          attr_name: "anything",
          value_kind: "vector",
          cmp_kind: "equal",
          first_value: "[1,2,3]",
          second_value: null,
          weight: null,
        },
      ],
    });
    try {
      translatePolicyToInlineInput(policy);
      expect.fail("expected InlinePolicyEncodingError");
    } catch (err) {
      expect(err).toBeInstanceOf(InlinePolicyEncodingError);
      expect((err as InlinePolicyEncodingError).kind).toBe(
        "vector_unsupported",
      );
      expect((err as InlinePolicyEncodingError).context?.policyId).toBe(3);
    }
  });
});
