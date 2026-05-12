/**
 * `policies_fingerprint` — canonical fingerprint of the inline policy
 * set used to seed a corpus B run.
 *
 * Mirrors the design of `exclusions_fp` from `src/lib/triage/exclusion/
 * fingerprint.ts`: equal logical inputs (any ordering of policies,
 * any ordering of rules within a policy, any duplicate-tolerant set
 * shape) hash to the same digest so the corpus B partial unique index
 * recognises a recompute that re-selects the same policies as a
 * cache hit.
 *
 * Canonicalization rules:
 *
 *   1. Each policy's `packet_attr` / `confidence` / `response` arrays
 *      are sorted by a stable per-element JSON serialization; nullable
 *      fields are normalized to `null`.
 *   2. Policies are serialized to a stable JSON shape and sorted by
 *      their serialization (the id is included).
 *   3. The combined string is hashed with SHA-256; the hex digest is
 *      stored on `policy_triage_run.policies_fingerprint`.
 *
 * The empty policy set is well-defined: `computePoliciesFingerprint([])`
 * → SHA-256 of the canonical empty payload. Pre-#459 the API would
 * not call corpus B with an empty set in practice, but the empty case
 * is well-defined for tests / future replay.
 */

import { createHash } from "node:crypto";

import type {
  Confidence,
  PacketAttr,
  Response,
  TriagePolicyRow,
} from "../types";

const FINGERPRINT_VERSION = "v1";

interface CanonicalPacketAttr {
  raw_event_kind: string;
  attr_name: string;
  value_kind: string;
  cmp_kind: string;
  first_value: string;
  second_value: string | null;
  weight: number | null;
}

interface CanonicalConfidence {
  threat_category: string | null;
  threat_kind: string;
  confidence: number;
  weight: number | null;
}

interface CanonicalResponse {
  minimum_score: number;
  kind: string;
}

interface CanonicalPolicy {
  id: number;
  packet_attr: CanonicalPacketAttr[];
  confidence: CanonicalConfidence[];
  response: CanonicalResponse[];
}

function canonicalizePacketAttr(rule: PacketAttr): CanonicalPacketAttr {
  return {
    raw_event_kind: rule.raw_event_kind,
    attr_name: rule.attr_name,
    value_kind: rule.value_kind,
    cmp_kind: rule.cmp_kind,
    first_value: rule.first_value,
    second_value:
      rule.second_value === undefined || rule.second_value === null
        ? null
        : rule.second_value,
    weight: rule.weight ?? null,
  };
}

function canonicalizeConfidence(rule: Confidence): CanonicalConfidence {
  return {
    threat_category: rule.threat_category ?? null,
    threat_kind: rule.threat_kind,
    confidence: rule.confidence,
    weight: rule.weight ?? null,
  };
}

function canonicalizeResponse(rule: Response): CanonicalResponse {
  return {
    minimum_score: rule.minimum_score,
    kind: rule.kind,
  };
}

function sortBySerialized<T>(items: T[]): T[] {
  return items
    .map((item) => ({ item, s: JSON.stringify(item) }))
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))
    .map(({ item }) => item);
}

function canonicalizePolicy(policy: TriagePolicyRow): CanonicalPolicy {
  return {
    id: policy.id,
    packet_attr: sortBySerialized(
      policy.packet_attr.map(canonicalizePacketAttr),
    ),
    confidence: sortBySerialized(policy.confidence.map(canonicalizeConfidence)),
    response: sortBySerialized(policy.response.map(canonicalizeResponse)),
  };
}

/**
 * Hash the inline policy set into a stable hex SHA-256 string. The
 * function consumes stored `TriagePolicyRow` objects directly so the
 * corpus B runner can fingerprint a snapshot of the policies in one
 * place — the fingerprint covers id, rule shape, and rule values, so
 * the partial unique index recognises rule edits and policy renames
 * as distinct fingerprints.
 *
 * Set-equal inputs (any policy ordering, any rule ordering inside a
 * policy) hash to the same digest.
 */
export function computePoliciesFingerprint(
  policies: ReadonlyArray<TriagePolicyRow>,
): string {
  const canonical = policies
    .map(canonicalizePolicy)
    .map((p) => JSON.stringify(p))
    .sort();
  const payload = JSON.stringify({
    version: FINGERPRINT_VERSION,
    policies: canonical,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export const EMPTY_POLICIES_FINGERPRINT = computePoliciesFingerprint([]);
