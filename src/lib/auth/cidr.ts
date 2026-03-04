import "server-only";

import { isIP } from "node:net";

// ── Types ───────────────────────────────────────────────────────

type IpVersion = 4 | 6;

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Parse an IPv4 address string into a 4-byte Uint8Array.
 * Returns `null` if the format is invalid.
 */
function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (Number.isNaN(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

/**
 * Parse an IPv6 address string into a 16-byte Uint8Array.
 * Handles `::` expansion.  Returns `null` if the format is invalid.
 */
function parseIpv6(ip: string): Uint8Array | null {
  const halves = ip.split("::");
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
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i], 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/**
 * Parse an IP address string into a byte array.
 * Returns `null` if the address is invalid or the version doesn't
 * match the expected version (when provided).
 */
function parseIp(ip: string, expectedVersion?: IpVersion): Uint8Array | null {
  const version = isIP(ip);
  if (version === 0) return null;
  if (expectedVersion && version !== expectedVersion) return null;

  return version === 4 ? parseIpv4(ip) : parseIpv6(ip);
}

/**
 * Check whether `clientBytes` falls within the network defined by
 * `networkBytes` and `prefixLen`.
 */
function matchesCidr(
  clientBytes: Uint8Array,
  networkBytes: Uint8Array,
  prefixLen: number,
): boolean {
  const fullBytes = Math.floor(prefixLen / 8);
  const remainderBits = prefixLen % 8;

  // Compare full bytes
  for (let i = 0; i < fullBytes; i++) {
    if (clientBytes[i] !== networkBytes[i]) return false;
  }

  // Compare remaining bits (if any)
  if (remainderBits > 0 && fullBytes < clientBytes.length) {
    const mask = 0xff << (8 - remainderBits);
    if ((clientBytes[fullBytes] & mask) !== (networkBytes[fullBytes] & mask)) {
      return false;
    }
  }

  return true;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Check whether a client IP is allowed by a list of CIDR ranges.
 *
 * - An **empty** `allowedCidrs` array means no restriction (allows all).
 * - Each entry may be a plain IP (`"10.0.0.1"`) or CIDR (`"10.0.0.0/24"`).
 * - Plain IPs are treated as `/32` (IPv4) or `/128` (IPv6).
 * - Returns `false` if `clientIp` is invalid or doesn't match any entry.
 * - Invalid CIDR entries are silently skipped.
 */
export function isIpAllowed(clientIp: string, allowedCidrs: string[]): boolean {
  if (allowedCidrs.length === 0) return true;

  const clientVersion = isIP(clientIp) as 0 | 4 | 6;
  if (clientVersion === 0) return false;

  const clientBytes = parseIp(clientIp);
  if (!clientBytes) return false;

  for (const cidr of allowedCidrs) {
    const slashIndex = cidr.indexOf("/");

    let networkIp: string;
    let prefixLen: number;

    if (slashIndex === -1) {
      // Plain IP — treat as /32 or /128
      networkIp = cidr;
      prefixLen = clientVersion === 4 ? 32 : 128;
    } else {
      networkIp = cidr.slice(0, slashIndex);
      prefixLen = Number(cidr.slice(slashIndex + 1));
      if (Number.isNaN(prefixLen) || prefixLen < 0) continue;
    }

    const networkBytes = parseIp(networkIp, clientVersion as IpVersion);
    if (!networkBytes) continue;

    const maxPrefix = clientVersion === 4 ? 32 : 128;
    if (prefixLen > maxPrefix) continue;

    if (matchesCidr(clientBytes, networkBytes, prefixLen)) {
      return true;
    }
  }

  return false;
}
