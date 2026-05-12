/**
 * Inline-policy seam (1B-6 / discussion #447 §3.5).
 *
 * Owns the wire enums, GraphQL enum-name mapping, and the byte-array
 * encoder for review-web's `eventListWithTriage` `EventTriagePolicyInput`.
 * Shared with every inline-policy caller; deliberately NOT part of the
 * `triage/policy/` deprecatability namespace, so removing the policy
 * mode leaves the seam in place for other callers.
 *
 * The storage→wire translator that consumes `TriagePolicyRow` lives at
 * `src/lib/triage/policy/inline-translator.ts` — re-exported there
 * because it legitimately depends on the storage shape.
 */

export {
  type EncodedPacketAttrInput,
  encodeRuleBytes,
  encodeValueByKind,
  InlinePolicyEncodingError,
  type PacketAttrRule,
} from "./encode";
export {
  cmpKindToGraphql,
  rawEventKindToGraphql,
  responseKindToGraphql,
  threatCategoryToGraphql,
  valueKindToGraphql,
} from "./graphql-names";
export {
  CMP_KINDS,
  type CmpKind,
  RANGE_CMP_KINDS,
  RAW_EVENT_KINDS,
  type RawEventKind,
  RESPONSE_KINDS,
  type ResponseKind,
  THREAT_CATEGORIES,
  type ThreatCategory,
  VALUE_KINDS,
  type ValueKind,
} from "./kinds";
