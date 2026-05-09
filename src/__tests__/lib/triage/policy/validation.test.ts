import { describe, expect, it } from "vitest";

import {
  _validateIpOrCidr,
  validatePolicySemantics,
} from "@/lib/triage/policy/validation";

describe("validateIpOrCidr", () => {
  it("accepts plain IPv4", () => {
    expect(_validateIpOrCidr("192.168.1.1")).toBeNull();
  });

  it("accepts plain IPv6", () => {
    expect(_validateIpOrCidr("::1")).toBeNull();
    expect(_validateIpOrCidr("2001:db8::1")).toBeNull();
  });

  it("accepts IPv4 CIDR", () => {
    expect(_validateIpOrCidr("10.0.0.0/8")).toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/32")).toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/0")).toBeNull();
  });

  it("accepts IPv6 CIDR", () => {
    expect(_validateIpOrCidr("2001:db8::/32")).toBeNull();
    expect(_validateIpOrCidr("::/0")).toBeNull();
  });

  it("rejects invalid IPs", () => {
    expect(_validateIpOrCidr("not-an-ip")).not.toBeNull();
    expect(_validateIpOrCidr("999.999.999.999")).not.toBeNull();
  });

  it("rejects out-of-range CIDR prefix", () => {
    expect(_validateIpOrCidr("10.0.0.0/33")).not.toBeNull();
    expect(_validateIpOrCidr("2001:db8::/129")).not.toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/-1")).not.toBeNull();
  });

  it("rejects non-decimal CIDR prefixes that Number() would coerce", () => {
    // Empty / whitespace prefixes.
    expect(_validateIpOrCidr("10.0.0.0/")).not.toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/ ")).not.toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/ 8")).not.toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/8 ")).not.toBeNull();
    // Signed prefixes.
    expect(_validateIpOrCidr("10.0.0.0/+8")).not.toBeNull();
    // Exponent / hex / float / underscore notation.
    expect(_validateIpOrCidr("10.0.0.0/1e1")).not.toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/0x8")).not.toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/8.0")).not.toBeNull();
    expect(_validateIpOrCidr("10.0.0.0/0_8")).not.toBeNull();
    expect(_validateIpOrCidr("2001:db8::/0x10")).not.toBeNull();
  });
});

describe("validatePolicySemantics", () => {
  it("flags a packet_attr ipaddr rule with a bad first_value", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [
        {
          raw_event_kind: "conn",
          attr_name: "src_addr",
          value_kind: "ipaddr",
          cmp_kind: "equal",
          first_value: "not-an-ip",
        },
      ],
      confidence: [],
      response: [],
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe("packet_attr.0.first_value");
  });

  it("accepts a packet_attr ipaddr rule with a valid CIDR", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [
        {
          raw_event_kind: "conn",
          attr_name: "src_addr",
          value_kind: "ipaddr",
          cmp_kind: "equal",
          first_value: "10.0.0.0/8",
        },
      ],
      confidence: [],
      response: [],
    });
    expect(result.valid).toBe(true);
  });

  it("flags a range cmp_kind without a second_value", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [
        {
          raw_event_kind: "conn",
          attr_name: "duration",
          value_kind: "integer",
          cmp_kind: "open_range",
          first_value: "100",
        },
      ],
      confidence: [],
      response: [],
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe("packet_attr.0.second_value");
    expect(result.issues[0].message).toContain("open_range");
  });

  it("accepts a range cmp_kind with both ends set", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [
        {
          raw_event_kind: "conn",
          attr_name: "duration",
          value_kind: "integer",
          cmp_kind: "close_range",
          first_value: "100",
          second_value: "200",
        },
      ],
      confidence: [],
      response: [],
    });
    expect(result.valid).toBe(true);
  });

  it("validates ipaddr second_value when present and non-empty", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [
        {
          raw_event_kind: "conn",
          attr_name: "src_addr",
          value_kind: "ipaddr",
          cmp_kind: "less_or_equal",
          first_value: "10.0.0.0",
          second_value: "bad-ip",
        },
      ],
      confidence: [],
      response: [],
    });
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((i) => i.path === "packet_attr.0.second_value"),
    ).toBe(true);
  });

  it("ignores second_value when null or empty string for non-range cmp", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [
        {
          raw_event_kind: "conn",
          attr_name: "src_addr",
          value_kind: "ipaddr",
          cmp_kind: "equal",
          first_value: "10.0.0.0",
          second_value: "",
        },
      ],
      confidence: [],
      response: [],
    });
    expect(result.valid).toBe(true);
  });

  it("flags an empty threat_kind", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [],
      confidence: [
        {
          threat_category: "execution",
          threat_kind: "   ",
          confidence: 0.5,
        },
      ],
      response: [],
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe("confidence.0.threat_kind");
  });

  it("returns valid for an empty policy", () => {
    const result = validatePolicySemantics({
      name: "p",
      packet_attr: [],
      confidence: [],
      response: [],
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
