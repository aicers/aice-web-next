/**
 * Stored TriagePolicy row → inline `EventTriagePolicyInput`.
 *
 * Combines the enum-name translator (`src/lib/triage/policy/inline-input.ts`)
 * with the byte-array encoder from `./encode.ts` so the corpus B runner
 * can call `eventListWithTriage(triage: { policies: [...] })` with a
 * faithful wire representation of stored rows. Lives outside
 * `src/lib/triage/policy/` per §6: this is the inline-policy boundary
 * (shared with any future inline-policy caller), not a policy-mode
 * orchestrator.
 */

import {
  cmpKindToGraphql,
  rawEventKindToGraphql,
  responseKindToGraphql,
  threatCategoryToGraphql,
  valueKindToGraphql,
} from "@/lib/triage/policy/inline-input";
import type {
  CmpKind,
  Confidence,
  PacketAttr,
  RawEventKind,
  Response,
  ResponseKind,
  ThreatCategory,
  TriagePolicyRow,
  ValueKind,
} from "@/lib/triage/policy/types";

import {
  type EncodedPacketAttrInput,
  encodeRuleBytes,
  InlinePolicyEncodingError,
} from "./encode";

/**
 * Wire-shape ConfidenceInput. `threatCategory` is nullable to mirror
 * review-web's schema: a confidence rule that elides the category
 * matches against any category for its `(threatKind, confidence)`
 * pair. The runner-side panic-free contract requires us to round-trip
 * this null faithfully — see the smoke test in
 * `__tests__/lib/triage/inline-policy/translate.test.ts`.
 */
export interface EncodedConfidenceInput {
  threatCategory: string | null;
  threatKind: string;
  confidence: number;
  weight: number | null;
}

export interface EncodedResponseInput {
  minimumScore: number;
  kind: string;
}

export interface EncodedEventTriagePolicyInput {
  id: number;
  packetAttr: EncodedPacketAttrInput[];
  confidence: EncodedConfidenceInput[];
  response: EncodedResponseInput[];
}

/**
 * Translate one stored `TriagePolicyRow` into the wire-shape
 * `EventTriagePolicyInput` the resolver expects.
 *
 * Throws {@link InlinePolicyEncodingError} on any encoding-time
 * failure (bad ipaddr literal, vector value kind, etc.). The corpus B
 * runner surfaces the error as `status='failed'` with `last_error`
 * identifying the policy.
 */
export function translatePolicyToInlineInput(
  policy: TriagePolicyRow,
): EncodedEventTriagePolicyInput {
  try {
    return {
      id: policy.id,
      packetAttr: policy.packet_attr.map((rule, index) =>
        translatePacketAttr(rule, policy.id, index),
      ),
      confidence: policy.confidence.map((rule, index) =>
        translateConfidence(rule, policy.id, index),
      ),
      response: policy.response.map((rule, index) =>
        translateResponse(rule, policy.id, index),
      ),
    };
  } catch (err) {
    if (err instanceof InlinePolicyEncodingError) {
      // Re-throw with policy id context populated. Throw the same
      // structured error type so the runner's catch sees a single
      // class.
      throw new InlinePolicyEncodingError(err.kind, err.message, {
        ...err.context,
        policyId: policy.id,
      });
    }
    throw err;
  }
}

function translatePacketAttr(
  rule: PacketAttr,
  policyId: number,
  index: number,
): EncodedPacketAttrInput {
  let bytes: { firstValue: number[]; secondValue: number[] | null };
  try {
    bytes = encodeRuleBytes(rule);
  } catch (err) {
    if (err instanceof InlinePolicyEncodingError) {
      throw new InlinePolicyEncodingError(err.kind, err.message, {
        ...err.context,
        policyId,
        ruleIndex: index,
        path: `packet_attr.${index}`,
      });
    }
    throw err;
  }
  return {
    rawEventKind: rawEventKindToGraphql(rule.raw_event_kind as RawEventKind),
    attrName: rule.attr_name,
    valueKind: valueKindToGraphql(rule.value_kind as ValueKind),
    cmpKind: cmpKindToGraphql(rule.cmp_kind as CmpKind),
    firstValue: bytes.firstValue,
    secondValue: bytes.secondValue,
    weight: rule.weight ?? null,
  };
}

function translateConfidence(
  rule: Confidence,
  _policyId: number,
  _index: number,
): EncodedConfidenceInput {
  // `threat_category` is Required at the storage layer (#459's Zod
  // schema enforces it). Defend against a hand-crafted inline value
  // sneaking a null in via the runner's test harnesses: if it ever
  // arrives null here we must NOT panic — translate to `null` and
  // let the resolver see the optional field unset. The runner-side
  // smoke test (panic-free) covers this contract.
  const category = rule.threat_category as ThreatCategory | null | undefined;
  const threatCategory =
    category === null || category === undefined
      ? null
      : threatCategoryToGraphql(category);
  return {
    threatCategory,
    threatKind: rule.threat_kind,
    confidence: rule.confidence,
    weight: rule.weight ?? null,
  };
}

function translateResponse(
  rule: Response,
  _policyId: number,
  _index: number,
): EncodedResponseInput {
  return {
    minimumScore: rule.minimum_score,
    kind: responseKindToGraphql(rule.kind as ResponseKind),
  };
}
