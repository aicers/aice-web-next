/**
 * Semantic validation for TriagePolicy rules beyond Zod's structural
 * checks.
 *
 * Scope here is the IP literal validity of `ipaddr`-typed `packet_attr`
 * values and the range-cmp invariant that range comparisons carry both
 * ends of the interval. CIDR notation is rejected here so the failure
 * surfaces at authoring time — the inline-policy encoder
 * (`@/lib/triage/inline-policy/encode`) keeps its CIDR-reject branch
 * as a belt-and-braces guard at the wire boundary. Domain exclusion
 * regex compilability — the other half of the wording in #459 — lives
 * on `ExclusionReason` rows under ticket 1B-2 (#447 §2.1, §3.4) and is
 * not part of TriagePolicy under the new model. Removing the legacy
 * `match` / `not_match` cmp kinds here keeps the stored shape aligned
 * with review-web's `AttrCmpKind` enum (see
 * `@/lib/triage/inline-policy/kinds`).
 */

import { isIP } from "node:net";

import type {
  Confidence,
  PacketAttr,
  PolicyCreateInput,
  PolicyUpdateInput,
  Response,
} from "./types";
import { RANGE_CMP_KINDS } from "./types";

export interface PolicyValidationIssue {
  /** Dot-path to the offending field, e.g. "packet_attr.0.first_value". */
  path: string;
  message: string;
}

export interface PolicyValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
}

function validateIp(value: string): string | null {
  // CIDR notation has no agreed wire shape inside a packet-attr
  // equality / range comparison and the inline-policy encoder rejects
  // it at the wire boundary. Reject here too so the failure surfaces
  // at authoring time rather than at corpus B run time. If CIDR
  // semantics are needed later, introduce a separate `value_kind`
  // rather than overloading `ipaddr`.
  if (value.includes("/")) return "CIDR notation is not accepted";
  if (isIP(value) === 0) return "Not a valid IP address";
  return null;
}

function validatePacketAttr(
  rule: PacketAttr,
  index: number,
  issues: PolicyValidationIssue[],
): void {
  if (rule.value_kind === "ipaddr") {
    const firstErr = validateIp(rule.first_value);
    if (firstErr) {
      issues.push({
        path: `packet_attr.${index}.first_value`,
        message: firstErr,
      });
    }
    if (
      rule.second_value !== undefined &&
      rule.second_value !== null &&
      rule.second_value.length > 0
    ) {
      const secondErr = validateIp(rule.second_value);
      if (secondErr) {
        issues.push({
          path: `packet_attr.${index}.second_value`,
          message: secondErr,
        });
      }
    }
  }

  // Range comparisons need both endpoints; the engine has no way to
  // resolve `open_range` / `close_range` / `*_range` without the
  // upper bound. Reject the rule rather than persisting half a range.
  if (RANGE_CMP_KINDS.has(rule.cmp_kind)) {
    const hasSecond =
      rule.second_value !== undefined &&
      rule.second_value !== null &&
      rule.second_value.length > 0;
    if (!hasSecond) {
      issues.push({
        path: `packet_attr.${index}.second_value`,
        message: `cmp_kind '${rule.cmp_kind}' requires a non-empty second_value`,
      });
    }
  }
}

function validateConfidence(
  rule: Confidence,
  index: number,
  issues: PolicyValidationIssue[],
): void {
  if (rule.threat_kind.trim().length === 0) {
    issues.push({
      path: `confidence.${index}.threat_kind`,
      message: "threat_kind must not be empty",
    });
  }
}

function validateResponse(
  rule: Response,
  index: number,
  issues: PolicyValidationIssue[],
): void {
  if (!Number.isFinite(rule.minimum_score)) {
    issues.push({
      path: `response.${index}.minimum_score`,
      message: "minimum_score must be a finite number",
    });
  }
}

/**
 * Run semantic checks on a fully-parsed policy payload (create or update).
 * Pure: returns issues without throwing so callers can shape error
 * responses.
 */
export function validatePolicySemantics(
  input: PolicyCreateInput | PolicyUpdateInput,
): PolicyValidationResult {
  const issues: PolicyValidationIssue[] = [];

  if (input.packet_attr) {
    input.packet_attr.forEach((rule, i) => {
      validatePacketAttr(rule, i, issues);
    });
  }
  if (input.confidence) {
    input.confidence.forEach((rule, i) => {
      validateConfidence(rule, i, issues);
    });
  }
  if (input.response) {
    input.response.forEach((rule, i) => {
      validateResponse(rule, i, issues);
    });
  }

  return { valid: issues.length === 0, issues };
}

// Re-exported for tests covering address parsing in isolation.
export { validateIp as _validateIp };
