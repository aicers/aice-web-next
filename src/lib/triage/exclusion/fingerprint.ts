/**
 * `exclusions_fp` — canonical fingerprint of the active exclusion set.
 *
 * The cadence runner (#481), the corpus B runner (#460), and the
 * retroactive-DELETE planner (#457) all derive `exclusions_fp` from
 * this single function so the same active set produces the same
 * fingerprint everywhere. Without that, the corpus B partial unique
 * index (#460) and the cadence's freshness checks would silently drift
 * apart whenever the active set permuted to an equivalent shape.
 *
 * Canonicalization rules (designed so set-equal inputs hash equal):
 *   1. Each rule's IP / domain / hostname / uri arrays are sorted
 *      lexicographically and de-duplicated.
 *   2. Each `IpAddressExclusionInput` group's `hosts`, `networks`, and
 *      `ranges` are likewise sorted.
 *   3. Rules are serialized to a stable JSON shape with a fixed key
 *      order, then sorted lexicographically by their serialization.
 *   4. The combined string is hashed with SHA-256. The hex digest is
 *      stored as `baseline_corpus_state.exclusions_fp` and on each
 *      `baseline_triaged_event` row.
 *
 * The empty-set fingerprint is well-defined: `computeExclusionsFingerprint([])`
 * → SHA-256 of the canonical empty payload. Pre-#457 every cadence row
 * carries this value (real value, not NULL) so the column stays
 * NOT NULL throughout the lifecycle.
 */

import { createHash } from "node:crypto";

import type { ExclusionRule, IpAddressExclusionInput } from "./types";

const FINGERPRINT_VERSION = "v1";

interface CanonicalIpRange {
  start: string;
  end: string;
}

interface CanonicalRule {
  ipAddress: {
    hosts: string[];
    networks: string[];
    ranges: CanonicalIpRange[];
  } | null;
  domain: string[] | null;
  hostname: string[] | null;
  uri: string[] | null;
}

function dedupSorted(values: readonly string[] | null | undefined): string[] {
  if (!values || values.length === 0) return [];
  return Array.from(new Set(values)).sort();
}

function canonicalizeIpAddress(
  group: IpAddressExclusionInput,
): CanonicalRule["ipAddress"] {
  const hosts = dedupSorted(group.hosts);
  const networks = dedupSorted(group.networks);
  // De-dup ranges by their `start|end` serialization so identical
  // ranges stored twice on the wire collapse into one.
  const seen = new Set<string>();
  const ranges: CanonicalIpRange[] = [];
  for (const range of group.ranges) {
    const key = `${range.start}|${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({ start: range.start, end: range.end });
  }
  ranges.sort((a, b) => {
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    if (a.end !== b.end) return a.end < b.end ? -1 : 1;
    return 0;
  });
  if (hosts.length === 0 && networks.length === 0 && ranges.length === 0) {
    return null;
  }
  return { hosts, networks, ranges };
}

function canonicalizeRule(rule: ExclusionRule): CanonicalRule | null {
  const ipAddress = rule.ipAddress
    ? canonicalizeIpAddress(rule.ipAddress)
    : null;
  const domain = dedupSorted(rule.domain);
  const hostname = dedupSorted(rule.hostname);
  const uri = dedupSorted(rule.uri);
  if (
    ipAddress === null &&
    domain.length === 0 &&
    hostname.length === 0 &&
    uri.length === 0
  ) {
    return null;
  }
  return {
    ipAddress,
    domain: domain.length === 0 ? null : domain,
    hostname: hostname.length === 0 ? null : hostname,
    uri: uri.length === 0 ? null : uri,
  };
}

function serializeCanonicalRule(rule: CanonicalRule): string {
  // Stable key order to make the JSON serialization permutation-free.
  return JSON.stringify({
    ipAddress: rule.ipAddress,
    domain: rule.domain,
    hostname: rule.hostname,
    uri: rule.uri,
  });
}

/**
 * Hash the active exclusion set into a stable hex SHA-256 string. Set-
 * equal inputs (any ordering, duplicate-tolerant) hash to the same
 * digest.
 */
export function computeExclusionsFingerprint(
  rules: readonly ExclusionRule[],
): string {
  const canonical = rules
    .map(canonicalizeRule)
    .filter((r): r is CanonicalRule => r !== null)
    .map(serializeCanonicalRule)
    .sort();
  const payload = JSON.stringify({
    version: FINGERPRINT_VERSION,
    rules: canonical,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export const EMPTY_EXCLUSIONS_FINGERPRINT = computeExclusionsFingerprint([]);
