/**
 * Inline-policy boundary barrel (1B-6 / discussion #447 §3.5).
 *
 * Bridges the stored TriagePolicy shape (#459, JSONB) to the
 * `eventListWithTriage` `EventTriagePolicyInput` shape on the wire.
 * Shared with any future inline-policy caller; not part of the
 * policy/ deprecatability namespace.
 */

export {
  type EncodedPacketAttrInput,
  encodeRuleBytes,
  encodeValueByKind,
  InlinePolicyEncodingError,
} from "./encode";
export {
  type EncodedConfidenceInput,
  type EncodedEventTriagePolicyInput,
  type EncodedResponseInput,
  translatePolicyToInlineInput,
} from "./translate";
