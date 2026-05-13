import { describe, expect, it } from "vitest";

import {
  _validateIp,
  validatePolicySemantics,
} from "@/lib/triage/policy/validation";

describe("validateIp", () => {
  it("accepts plain IPv4", () => {
    expect(_validateIp("192.168.1.1")).toBeNull();
  });

  it("accepts plain IPv6", () => {
    expect(_validateIp("::1")).toBeNull();
    expect(_validateIp("2001:db8::1")).toBeNull();
  });

  it("rejects invalid IPs", () => {
    expect(_validateIp("not-an-ip")).not.toBeNull();
    expect(_validateIp("999.999.999.999")).not.toBeNull();
  });

  it("rejects any value containing '/'", () => {
    // CIDR notation has no wire shape inside a packet-attr equality /
    // range comparison; the encoder rejects it and so does this
    // storage-time validator. Any slash is enough — we do not parse
    // the prefix.
    expect(_validateIp("10.0.0.0/8")).not.toBeNull();
    expect(_validateIp("10.0.0.0/32")).not.toBeNull();
    expect(_validateIp("10.0.0.0/0")).not.toBeNull();
    expect(_validateIp("2001:db8::/32")).not.toBeNull();
    expect(_validateIp("::/0")).not.toBeNull();
    expect(_validateIp("10.0.0.0/33")).not.toBeNull();
    expect(_validateIp("10.0.0.0/")).not.toBeNull();
    expect(_validateIp("not-an-ip/8")).not.toBeNull();
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

  it("rejects a packet_attr ipaddr rule whose first_value is CIDR", () => {
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
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe("packet_attr.0.first_value");
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
