/**
 * Browser-safe asset endpoint classifier for the Triage menu.
 *
 * Side-specific by design: the caller picks `"orig"` or `"resp"` and
 * the helper looks up only that side's address and network metadata,
 * so it is impossible to accidentally compare `origAddr` against
 * `respNetwork` membership (or vice versa).
 *
 * The IP parsing / CIDR matching is reimplemented locally rather
 * than imported from `src/lib/auth/cidr.ts` because that module is
 * `server-only` and depends on `node:net`. This file must stay
 * importable from React client components — see the unit test that
 * asserts the import boundary.
 */

import type {
  TriageEvent,
  TriageHostNetworkGroup,
  TriageNetwork,
} from "./types";

type IpVersion = 4 | 6;

interface ParsedIp {
  version: IpVersion;
  bytes: Uint8Array;
}

const IPV4_OCTET = /^\d+$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    if (!IPV4_OCTET.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(ip: string): Uint8Array | null {
  // Strip optional zone identifier (e.g. "fe80::1%eth0").
  const stripped = ip.split("%")[0];

  // Expand a trailing dotted-quad (e.g. "::ffff:1.2.3.4") into two
  // hex groups so the rest of the parser can stay v6-only.
  let preprocessed = stripped;
  const lastColon = stripped.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = stripped.slice(lastColon + 1);
    if (tail.includes(".")) {
      const v4 = parseIpv4(tail);
      if (!v4) return null;
      const head = stripped.slice(0, lastColon + 1);
      const a = ((v4[0] << 8) | v4[1]).toString(16);
      const b = ((v4[2] << 8) | v4[3]).toString(16);
      preprocessed = `${head}${a}:${b}`;
    }
  }

  const halves = preprocessed.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && left.length !== 8) return null;

  const groups = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!IPV6_GROUP.test(groups[i])) return null;
    const value = Number.parseInt(groups[i], 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function parseIp(ip: string): ParsedIp | null {
  if (ip.includes(":")) {
    const bytes = parseIpv6(ip);
    return bytes ? { version: 6, bytes } : null;
  }
  const bytes = parseIpv4(ip);
  return bytes ? { version: 4, bytes } : null;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function matchesCidrBytes(
  clientBytes: Uint8Array,
  networkBytes: Uint8Array,
  prefixLen: number,
): boolean {
  if (clientBytes.length !== networkBytes.length) return false;
  const fullBytes = Math.floor(prefixLen / 8);
  const remainderBits = prefixLen % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (clientBytes[i] !== networkBytes[i]) return false;
  }
  if (remainderBits > 0 && fullBytes < clientBytes.length) {
    const mask = 0xff << (8 - remainderBits);
    if ((clientBytes[fullBytes] & mask) !== (networkBytes[fullBytes] & mask)) {
      return false;
    }
  }
  return true;
}

function inCidrString(client: ParsedIp, cidr: string): boolean {
  const slashIndex = cidr.indexOf("/");
  let networkIp: string;
  let prefixLen: number;
  if (slashIndex === -1) {
    networkIp = cidr;
    prefixLen = client.version === 4 ? 32 : 128;
  } else {
    networkIp = cidr.slice(0, slashIndex);
    prefixLen = Number(cidr.slice(slashIndex + 1));
    if (Number.isNaN(prefixLen) || prefixLen < 0) return false;
  }
  const network = parseIp(networkIp);
  if (!network || network.version !== client.version) return false;
  const max = client.version === 4 ? 32 : 128;
  if (prefixLen > max) return false;
  return matchesCidrBytes(client.bytes, network.bytes, prefixLen);
}

function inRange(client: ParsedIp, start: string, end: string): boolean {
  const s = parseIp(start);
  const e = parseIp(end);
  if (
    !s ||
    !e ||
    s.version !== client.version ||
    e.version !== client.version
  ) {
    return false;
  }
  return (
    compareBytes(client.bytes, s.bytes) >= 0 &&
    compareBytes(client.bytes, e.bytes) <= 0
  );
}

function inAnyCidr(client: ParsedIp, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    if (inCidrString(client, cidr)) return true;
  }
  return false;
}

function inHostNetworkGroup(
  client: ParsedIp,
  group: TriageHostNetworkGroup,
): boolean {
  for (const host of group.hosts ?? []) {
    const parsed = parseIp(host);
    if (!parsed) continue;
    if (
      parsed.version === client.version &&
      compareBytes(parsed.bytes, client.bytes) === 0
    ) {
      return true;
    }
  }
  if (inAnyCidr(client, group.networks ?? [])) return true;
  for (const range of group.ranges ?? []) {
    if (inRange(client, range.start, range.end)) return true;
  }
  return false;
}

/**
 * RFC1918 / loopback / link-local / CGNAT (IPv4) and loopback / ULA
 * / link-local (IPv6). Used only when the side has no customer
 * network metadata to consult.
 */
const PRIVATE_CIDRS_V4: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "100.64.0.0/10",
];
const PRIVATE_CIDRS_V6: readonly string[] = [
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

export type TriageEndpointClassification = "external" | "internal" | "unknown";

/**
 * Classify one side of an event as `internal` / `external` /
 * `unknown` for the asset pivot.
 *
 * Two-step rule (#476 §2):
 *   1. If the requested side carries customer network metadata
 *      (`origNetwork` / `respNetwork`), it is authoritative —
 *      addresses inside the customer-defined network are
 *      `internal`, everything else `external`.
 *   2. Otherwise fall back to RFC1918 + IPv6 special-use ranges.
 *   3. Unparseable addresses (or absent / non-string addresses)
 *      return `unknown`; the caller decides whether to pivot.
 */
export function classifyTriageEndpoint(
  event: TriageEvent,
  side: "orig" | "resp",
): TriageEndpointClassification {
  const addr = side === "orig" ? event.origAddr : event.respAddr;
  if (typeof addr !== "string" || addr.length === 0) return "unknown";
  const parsed = parseIp(addr);
  if (!parsed) return "unknown";

  const network: TriageNetwork | null | undefined =
    side === "orig" ? event.origNetwork : event.respNetwork;
  if (network?.networks) {
    return inHostNetworkGroup(parsed, network.networks)
      ? "internal"
      : "external";
  }

  const fallback = parsed.version === 4 ? PRIVATE_CIDRS_V4 : PRIVATE_CIDRS_V6;
  return inAnyCidr(parsed, fallback) ? "internal" : "external";
}
