import { describe, expect, it } from "vitest";

import {
  encodeRuleBytes,
  encodeValueByKind,
  InlinePolicyEncodingError,
} from "@/lib/triage/inline-policy";
import type { PacketAttr } from "@/lib/triage/policy/types";

/**
 * Round-trip guard for the byte-array encoder.
 *
 * Each test pins one of the documented wire-format claims from the
 * issue body's "Encoding rules per `value_kind`" table. A failure here
 * is a wire-format break that would cause `eventListWithTriage`'s
 * resolver to read garbage into its `firstValue` / `secondValue`
 * fields.
 */

function buildRule(overrides: Partial<PacketAttr>): PacketAttr {
  return {
    raw_event_kind: "http",
    attr_name: "host",
    value_kind: "string",
    cmp_kind: "equal",
    first_value: "",
    second_value: null,
    weight: null,
    ...overrides,
  };
}

describe("encodeValueByKind", () => {
  it("encodes bool 'true' as 0x01 and 'false' as 0x00", () => {
    expect(encodeValueByKind("bool", "true")).toEqual([0x01]);
    expect(encodeValueByKind("bool", "false")).toEqual([0x00]);
  });

  it("encodes string as UTF-8 bytes", () => {
    expect(encodeValueByKind("string", "AB")).toEqual([0x41, 0x42]);
    // 3-byte UTF-8 for the EURO SIGN (U+20AC).
    expect(encodeValueByKind("string", "€")).toEqual([0xe2, 0x82, 0xac]);
  });

  it("encodes integer as 8-byte big-endian two's complement i64", () => {
    expect(encodeValueByKind("integer", "0")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(encodeValueByKind("integer", "1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(encodeValueByKind("integer", "-1")).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    // i64 min and max boundaries.
    expect(encodeValueByKind("integer", "9223372036854775807")).toEqual([
      0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    expect(encodeValueByKind("integer", "-9223372036854775808")).toEqual([
      0x80, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("encodes u_integer as 8-byte big-endian unsigned u64", () => {
    expect(encodeValueByKind("u_integer", "0")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(encodeValueByKind("u_integer", "18446744073709551615")).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("encodes float as 8-byte big-endian IEEE-754 f64", () => {
    // 1.0 in IEEE-754 double: 0x3FF0000000000000.
    expect(encodeValueByKind("float", "1.0")).toEqual([
      0x3f, 0xf0, 0, 0, 0, 0, 0, 0,
    ]);
    // 0.0
    expect(encodeValueByKind("float", "0")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("encodes ipaddr v4 literal as 4 packed octets", () => {
    expect(encodeValueByKind("ipaddr", "1.2.3.4")).toEqual([1, 2, 3, 4]);
    expect(encodeValueByKind("ipaddr", "127.0.0.1")).toEqual([127, 0, 0, 1]);
  });

  it("encodes ipaddr v6 literal as 16 packed octets", () => {
    const out = encodeValueByKind("ipaddr", "::1");
    expect(out).toHaveLength(16);
    expect(out[15]).toBe(0x01);
    for (let i = 0; i < 15; i += 1) expect(out[i]).toBe(0);
  });

  it("encodes ipv6 with embedded ipv4 form (::ffff:1.2.3.4)", () => {
    const out = encodeValueByKind("ipaddr", "::ffff:1.2.3.4");
    expect(out).toHaveLength(16);
    expect(out.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
  });

  it("rejects CIDR notation for value_kind=ipaddr", () => {
    expect(() => encodeValueByKind("ipaddr", "1.2.3.0/24")).toThrow(
      InlinePolicyEncodingError,
    );
    expect(() => encodeValueByKind("ipaddr", "2001:db8::/32")).toThrow(
      InlinePolicyEncodingError,
    );
  });

  it("rejects vector with a structured error", () => {
    expect(() => encodeValueByKind("vector", "[1,2,3]")).toThrow(
      InlinePolicyEncodingError,
    );
    try {
      encodeValueByKind("vector", "[1,2,3]");
    } catch (err) {
      expect(err).toBeInstanceOf(InlinePolicyEncodingError);
      expect((err as InlinePolicyEncodingError).kind).toBe(
        "vector_unsupported",
      );
    }
  });

  it("rejects invalid bool", () => {
    expect(() => encodeValueByKind("bool", "yes")).toThrow(
      InlinePolicyEncodingError,
    );
  });

  it("rejects i64 overflow", () => {
    expect(() => encodeValueByKind("integer", "9223372036854775808")).toThrow(
      InlinePolicyEncodingError,
    );
  });

  it("rejects negative u64", () => {
    expect(() => encodeValueByKind("u_integer", "-1")).toThrow(
      InlinePolicyEncodingError,
    );
  });

  it("rejects non-numeric integer string", () => {
    expect(() => encodeValueByKind("integer", "abc")).toThrow(
      InlinePolicyEncodingError,
    );
  });

  it("rejects invalid IP literal", () => {
    expect(() => encodeValueByKind("ipaddr", "not-an-ip")).toThrow(
      InlinePolicyEncodingError,
    );
  });
});

describe("encodeRuleBytes", () => {
  it("encodes both first and second values for a range cmp", () => {
    const rule = buildRule({
      value_kind: "integer",
      cmp_kind: "close_range",
      first_value: "1",
      second_value: "10",
    });
    const out = encodeRuleBytes(rule);
    expect(out.firstValue).toHaveLength(8);
    expect(out.secondValue).toHaveLength(8);
    expect(out.firstValue[7]).toBe(1);
    expect((out.secondValue as number[])[7]).toBe(10);
  });

  it("omits secondValue (null) for a single-value cmp", () => {
    const rule = buildRule({
      value_kind: "integer",
      cmp_kind: "equal",
      first_value: "5",
      second_value: null,
    });
    const out = encodeRuleBytes(rule);
    expect(out.secondValue).toBeNull();
  });

  it("rejects a range cmp with empty second_value", () => {
    const rule = buildRule({
      value_kind: "integer",
      cmp_kind: "open_range",
      first_value: "1",
      second_value: null,
    });
    expect(() => encodeRuleBytes(rule)).toThrow(InlinePolicyEncodingError);
  });

  it("rejects a single-value cmp that carries a non-empty second_value", () => {
    const rule = buildRule({
      value_kind: "integer",
      cmp_kind: "equal",
      first_value: "1",
      second_value: "2",
    });
    expect(() => encodeRuleBytes(rule)).toThrow(InlinePolicyEncodingError);
  });
});
