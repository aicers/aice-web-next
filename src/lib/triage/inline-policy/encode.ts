/**
 * Byte-array encoding for inline policy `firstValue` / `secondValue`.
 *
 * `eventListWithTriage`'s `PacketAttrInput` carries `firstValue:
 * [Int!]!` and `secondValue: [Int!]` on the wire — packed byte arrays
 * whose layout depends on the rule's `value_kind`. The stored
 * TriagePolicy shape (#459 / `src/lib/triage/policy/types.ts`) keeps
 * those values as human-readable JSONB strings tagged by `value_kind`.
 * This module bridges the two so the corpus B runner can call the
 * resolver with a faithful inline policy without policy-side code
 * touching wire encoding.
 *
 * Lives outside `src/lib/triage/policy/` per the §6 deprecatability
 * rule — the encoder is the **inline-policy boundary** and is shared
 * with any future inline-policy caller. Removing the policy mode
 * leaves this module in place; baseline-side code never needs it but
 * the encoder does not depend on the policy/ namespace either.
 *
 * The encoding rules below are anchored in `eventListWithTriage`'s
 * resolver expectations (review-web#842); any deviation is a bug,
 * not a tunable. The round-trip test in
 * `__tests__/lib/triage/inline-policy/encode.test.ts` pins each
 * encoding against the documented contract.
 */

import { isIPv4, isIPv6 } from "node:net";

import type { CmpKind, PacketAttr, ValueKind } from "@/lib/triage/policy/types";
import { RANGE_CMP_KINDS } from "@/lib/triage/policy/types";

/**
 * Structured error surfaced when a stored `packet_attr` rule cannot be
 * encoded for the inline `PacketAttrInput` shape. The corpus B runner
 * catches these and transitions the run to `status='failed'` with
 * `last_error` identifying the offending policy / rule — never a
 * thrown panic.
 */
export class InlinePolicyEncodingError extends Error {
  readonly kind: string;
  /** Optional context the runner forwards into `last_error`. */
  readonly context?: Record<string, unknown>;

  constructor(
    kind: string,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InlinePolicyEncodingError";
    this.kind = kind;
    this.context = context;
  }
}

/**
 * One encoded `PacketAttrInput`. Field names are camelCase because the
 * GraphQL wire-side input expects camelCase.
 */
export interface EncodedPacketAttrInput {
  rawEventKind: string;
  attrName: string;
  valueKind: string;
  cmpKind: string;
  /** Required `[Int!]!`. */
  firstValue: number[];
  /** Nullable `[Int!]`; `null` for single-value comparisons. */
  secondValue: number[] | null;
  weight: number | null;
}

const U8_MAX = 0xff;

const I64_MIN = -(BigInt(1) << BigInt(63));
const I64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/**
 * Encode the bytes for one stored `packet_attr` rule's `firstValue` and
 * `secondValue` payloads. Used by `encodePacketAttrInput` and exposed
 * directly so tests can drive the encoding without going through the
 * full enum-name conversion.
 *
 * `cmpKind` decides whether `secondValue` must be encoded (range cmp
 * kinds) or omitted (`null`). Range cmps with missing `second_value`
 * have already been rejected at policy storage time
 * (`validatePolicySemantics`), but the encoder defends again so a
 * hand-crafted inline call cannot smuggle one through.
 */
export function encodeRuleBytes(rule: PacketAttr): {
  firstValue: number[];
  secondValue: number[] | null;
} {
  const valueKind = rule.value_kind as ValueKind;
  const cmpKind = rule.cmp_kind as CmpKind;
  const firstValue = encodeValueByKind(valueKind, rule.first_value);
  if (!RANGE_CMP_KINDS.has(cmpKind)) {
    if (
      rule.second_value !== null &&
      rule.second_value !== undefined &&
      rule.second_value.length > 0
    ) {
      // Stored row has a non-empty `second_value` for a non-range
      // comparison; the resolver expects `secondValue: null` here.
      // Encoding it would silently change the rule's semantics — the
      // engine would treat the extra bytes as the upper bound of a
      // range. Fail loudly instead.
      throw new InlinePolicyEncodingError(
        "second_value_unexpected",
        `cmp_kind '${cmpKind}' does not accept second_value`,
        { cmpKind },
      );
    }
    return { firstValue, secondValue: null };
  }
  if (
    rule.second_value === null ||
    rule.second_value === undefined ||
    rule.second_value.length === 0
  ) {
    throw new InlinePolicyEncodingError(
      "second_value_required",
      `cmp_kind '${cmpKind}' requires a non-empty second_value`,
      { cmpKind },
    );
  }
  const secondValue = encodeValueByKind(valueKind, rule.second_value);
  return { firstValue, secondValue };
}

/**
 * Encode one stored value (as JSONB-stored text) according to its
 * declared `value_kind`. Returns an array of `[0, 255]` integers ready
 * for the GraphQL `[Int!]!` shape.
 */
export function encodeValueByKind(kind: ValueKind, value: string): number[] {
  switch (kind) {
    case "bool":
      return [encodeBool(value)];
    case "string":
      return encodeUtf8(value);
    case "integer":
      return encodeI64(value);
    case "u_integer":
      return encodeU64(value);
    case "float":
      return encodeF64(value);
    case "ipaddr":
      return encodeIpLiteral(value);
    case "vector":
      // Vector is out of scope for this issue per §3.5 — the stored
      // shape has no separate element kind, so the wire-format target
      // is ambiguous. Reject so the runner can transition to failed.
      throw new InlinePolicyEncodingError(
        "vector_unsupported",
        "value_kind 'vector' is not supported by the inline-policy encoder",
        { valueKind: kind },
      );
  }
}

function encodeBool(value: string): number {
  if (value === "true" || value === "True" || value === "TRUE") return 0x01;
  if (value === "false" || value === "False" || value === "FALSE") return 0x00;
  throw new InlinePolicyEncodingError(
    "bool_invalid",
    `Expected 'true' or 'false' for value_kind=bool, got ${JSON.stringify(value)}`,
    { valueKind: "bool" },
  );
}

function encodeUtf8(value: string): number[] {
  const bytes = Buffer.from(value, "utf8");
  const out = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i];
  return out;
}

function encodeI64(value: string): number[] {
  const trimmed = value.trim();
  let big: bigint;
  try {
    big = BigInt(trimmed);
  } catch {
    throw new InlinePolicyEncodingError(
      "integer_invalid",
      `Expected i64 string for value_kind=integer, got ${JSON.stringify(value)}`,
      { valueKind: "integer" },
    );
  }
  if (big < I64_MIN || big > I64_MAX) {
    throw new InlinePolicyEncodingError(
      "integer_overflow",
      `Value ${trimmed} does not fit in i64`,
      { valueKind: "integer" },
    );
  }
  // Two's complement big-endian, 8 bytes.
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(big, 0);
  return Array.from(buf.values());
}

function encodeU64(value: string): number[] {
  const trimmed = value.trim();
  let big: bigint;
  try {
    big = BigInt(trimmed);
  } catch {
    throw new InlinePolicyEncodingError(
      "u_integer_invalid",
      `Expected u64 string for value_kind=u_integer, got ${JSON.stringify(value)}`,
      { valueKind: "u_integer" },
    );
  }
  if (big < BigInt(0) || big > U64_MAX) {
    throw new InlinePolicyEncodingError(
      "u_integer_overflow",
      `Value ${trimmed} does not fit in u64`,
      { valueKind: "u_integer" },
    );
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(big, 0);
  return Array.from(buf.values());
}

function encodeF64(value: string): number[] {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new InlinePolicyEncodingError(
      "float_invalid",
      `Expected finite IEEE-754 number for value_kind=float, got ${JSON.stringify(value)}`,
      { valueKind: "float" },
    );
  }
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(num, 0);
  return Array.from(buf.values());
}

function encodeIpLiteral(value: string): number[] {
  // CIDR is intentionally rejected at the encoder boundary. Prefix
  // length has no agreed wire representation in `PacketAttrInput`;
  // CIDR is an exclusion / network-group concern, not an inline
  // packet-attr concern. Even if storage (#459) currently allows a
  // CIDR string for `value_kind=ipaddr`, the inline encoder must not.
  if (value.includes("/")) {
    throw new InlinePolicyEncodingError(
      "ipaddr_cidr_not_supported",
      `CIDR notation is not supported by the inline-policy encoder (value_kind=ipaddr expects an IP literal): ${JSON.stringify(value)}`,
      { valueKind: "ipaddr" },
    );
  }
  if (isIPv4(value)) {
    const parts = value.split(".");
    if (parts.length !== 4) {
      throw new InlinePolicyEncodingError(
        "ipaddr_invalid",
        `Invalid IPv4 literal: ${JSON.stringify(value)}`,
        { valueKind: "ipaddr" },
      );
    }
    const out: number[] = [];
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > U8_MAX) {
        throw new InlinePolicyEncodingError(
          "ipaddr_invalid",
          `Invalid IPv4 octet ${JSON.stringify(p)} in ${JSON.stringify(value)}`,
          { valueKind: "ipaddr" },
        );
      }
      out.push(n);
    }
    return out;
  }
  if (isIPv6(value)) {
    return encodeIpv6(value);
  }
  throw new InlinePolicyEncodingError(
    "ipaddr_invalid",
    `Not a valid IP literal: ${JSON.stringify(value)}`,
    { valueKind: "ipaddr" },
  );
}

function encodeIpv6(value: string): number[] {
  // Expand the optional `::` and any embedded IPv4 suffix (e.g.
  // `::ffff:1.2.3.4`) into eight 16-bit groups, then emit 16 bytes
  // big-endian. Behaviour matches Node's net `isIPv6`.
  let normalized = value;
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon !== -1 && normalized.includes(".", lastColon)) {
    const tail = normalized.slice(lastColon + 1);
    if (isIPv4(tail)) {
      const parts = tail.split(".").map((p) => Number(p));
      const w1 = ((parts[0] << 8) | parts[1]).toString(16);
      const w2 = ((parts[2] << 8) | parts[3]).toString(16);
      normalized = `${normalized.slice(0, lastColon + 1)}${w1}:${w2}`;
    }
  }
  let head: string;
  let tail: string;
  if (normalized.includes("::")) {
    const [h, t] = normalized.split("::", 2);
    head = h ?? "";
    tail = t ?? "";
  } else {
    head = normalized;
    tail = "";
  }
  const headParts = head.length === 0 ? [] : head.split(":");
  const tailParts = tail.length === 0 ? [] : tail.split(":");
  if (headParts.length + tailParts.length > 8) {
    throw new InlinePolicyEncodingError(
      "ipaddr_invalid",
      `Invalid IPv6 literal: ${JSON.stringify(value)}`,
      { valueKind: "ipaddr" },
    );
  }
  const zeros = new Array(8 - headParts.length - tailParts.length).fill("0");
  const all = [...headParts, ...zeros, ...tailParts];
  if (all.length !== 8) {
    throw new InlinePolicyEncodingError(
      "ipaddr_invalid",
      `Invalid IPv6 literal: ${JSON.stringify(value)}`,
      { valueKind: "ipaddr" },
    );
  }
  const out: number[] = [];
  for (const part of all) {
    const word = Number.parseInt(part, 16);
    if (!Number.isFinite(word) || word < 0 || word > 0xffff) {
      throw new InlinePolicyEncodingError(
        "ipaddr_invalid",
        `Invalid IPv6 word ${JSON.stringify(part)} in ${JSON.stringify(value)}`,
        { valueKind: "ipaddr" },
      );
    }
    out.push((word >> 8) & U8_MAX);
    out.push(word & U8_MAX);
  }
  return out;
}
