/**
 * Active-exclusion matcher (1B-1 cadence step c).
 *
 * Applies an active set of exclusion rules in-memory against an event's
 * normalized columns. The semantics mirror review-web's `EventTriageExclusionInput`
 * resolver-side matching exactly:
 *
 *   - IpAddress: CIDR / range / exact-host containment over `orig_addr`
 *     and `resp_addr`.
 *   - Hostname: exact match against `host`.
 *   - Uri: exact match against `uri`.
 *   - Domain: regex `RegexSet::is_match` against `host` and `dns_query`
 *     only — never `uri` (URI matching is the Uri exclusion's job).
 *
 * The cadence-side application is the **authoritative exclusion
 * enforcement** for corpus filling (the resolver's Stage 1 pre-cut is
 * intentionally not used by cadence). Pre-#457 the `ActiveExclusionSet`
 * is empty so this is a no-op pass-through; once #457 wires real
 * storage the same code matches against real rules without the cadence
 * runner changing.
 */

import { isIPv4, isIPv6 } from "node:net";

import { compileDomainPatterns } from "./regex";
import type {
  ActiveExclusionSet,
  ExclusionRule,
  IpAddressExclusionInput,
  NormalizedEventColumns,
} from "./types";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const SHIFT_8 = BigInt(8);
const SHIFT_16 = BigInt(16);

/**
 * `true` iff the event's normalized columns match any rule in `active`.
 * Caller drops the event from the corpus when this returns `true`.
 *
 * The matcher pre-compiles per-rule regex / numeric structures once per
 * call; for a long page the active set is small (low tens) so doing the
 * compile per `isExcluded` call is fine. The runner can lift the
 * compile out to per-page if profiling later shows it matters.
 */
export function isExcluded(
  cols: NormalizedEventColumns,
  active: ActiveExclusionSet,
): boolean {
  for (const rule of active.rules) {
    if (matchRule(cols, rule)) return true;
  }
  return false;
}

function matchRule(cols: NormalizedEventColumns, rule: ExclusionRule): boolean {
  if (rule.ipAddress && matchIpAddress(cols, rule.ipAddress)) return true;
  if (rule.hostname && matchHostname(cols, rule.hostname)) return true;
  if (rule.uri && matchUri(cols, rule.uri)) return true;
  if (rule.domain && matchDomain(cols, rule.domain)) return true;
  return false;
}

function matchIpAddress(
  cols: NormalizedEventColumns,
  group: IpAddressExclusionInput,
): boolean {
  const addrs = [cols.origAddr, cols.respAddr].filter(
    (a): a is string => a !== null,
  );
  if (addrs.length === 0) return false;
  for (const addr of addrs) {
    if (group.hosts.includes(addr)) return true;
    for (const cidr of group.networks) {
      if (cidrContains(cidr, addr)) return true;
    }
    for (const range of group.ranges) {
      if (rangeContains(range, addr)) return true;
    }
  }
  return false;
}

function matchHostname(
  cols: NormalizedEventColumns,
  hostnames: string[],
): boolean {
  if (cols.host === null) return false;
  return hostnames.includes(cols.host);
}

function matchUri(cols: NormalizedEventColumns, uris: string[]): boolean {
  if (cols.uri === null) return false;
  return uris.includes(cols.uri);
}

function matchDomain(
  cols: NormalizedEventColumns,
  patterns: string[],
): boolean {
  const matcher = compileDomainPatterns(patterns);
  if (!matcher) return false;
  if (cols.host !== null && matcher.test(cols.host)) return true;
  if (cols.dnsQuery !== null && matcher.test(cols.dnsQuery)) return true;
  return false;
}

function ipToBigInt(ip: string): bigint | null {
  if (isIPv4(ip)) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let n = ZERO;
    for (const p of parts) {
      const byte = Number(p);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
      n = (n << SHIFT_8) | BigInt(byte);
    }
    return n;
  }
  if (isIPv6(ip)) {
    return ipv6ToBigInt(ip);
  }
  return null;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Handle the embedded IPv4 form `::ffff:1.2.3.4`.
  let normalized = ip;
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon !== -1 && normalized.includes(".", lastColon)) {
    const tail = normalized.slice(lastColon + 1);
    if (isIPv4(tail)) {
      const parts = tail.split(".").map((p) => Number(p));
      const word1 = ((parts[0] << 8) | parts[1]).toString(16);
      const word2 = ((parts[2] << 8) | parts[3]).toString(16);
      normalized = `${normalized.slice(0, lastColon + 1)}${word1}:${word2}`;
    }
  }
  let head: string;
  let tail: string;
  if (normalized.includes("::")) {
    const [hPart, tPart] = normalized.split("::", 2);
    head = hPart ?? "";
    tail = tPart ?? "";
  } else {
    head = normalized;
    tail = "";
  }
  const headParts = head.length === 0 ? [] : head.split(":");
  const tailParts = tail.length === 0 ? [] : tail.split(":");
  const totalParts = headParts.length + tailParts.length;
  if (totalParts > 8) return null;
  const zeros = new Array(8 - totalParts).fill("0");
  const all = [...headParts, ...zeros, ...tailParts];
  if (all.length !== 8) return null;
  let n = ZERO;
  for (const part of all) {
    const word = Number.parseInt(part, 16);
    if (!Number.isFinite(word) || word < 0 || word > 0xffff) return null;
    n = (n << SHIFT_16) | BigInt(word);
  }
  return n;
}

function cidrContains(cidr: string, addr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash === -1) return false;
  const network = cidr.slice(0, slash);
  const prefix = Number.parseInt(cidr.slice(slash + 1), 10);
  if (!Number.isInteger(prefix) || prefix < 0) return false;

  const networkBig = ipToBigInt(network);
  const addrBig = ipToBigInt(addr);
  if (networkBig === null || addrBig === null) return false;

  const isV4Network = isIPv4(network);
  const isV4Addr = isIPv4(addr);
  if (isV4Network !== isV4Addr) return false;
  const totalBits = isV4Network ? 32 : 128;
  if (prefix > totalBits) return false;
  const hostBits = BigInt(totalBits - prefix);
  const mask = hostBits === ZERO ? ZERO : (ONE << hostBits) - ONE;
  return (networkBig & ~mask) === (addrBig & ~mask);
}

function rangeContains(
  range: { start: string; end: string },
  addr: string,
): boolean {
  const startBig = ipToBigInt(range.start);
  const endBig = ipToBigInt(range.end);
  const addrBig = ipToBigInt(addr);
  if (startBig === null || endBig === null || addrBig === null) return false;
  // Mixed-family ranges are rejected by the schema; if one slips in
  // here, treat it as a non-match rather than throwing.
  const startV4 = isIPv4(range.start);
  const endV4 = isIPv4(range.end);
  const addrV4 = isIPv4(addr);
  if (startV4 !== endV4) return false;
  if (startV4 !== addrV4) return false;
  return startBig <= addrBig && addrBig <= endBig;
}

export const _testing = {
  matchIpAddress,
  matchHostname,
  matchUri,
  matchDomain,
  ipToBigInt,
  cidrContains,
  rangeContains,
};
