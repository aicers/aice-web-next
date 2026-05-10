/**
 * Stored-row exclusion input parser (#457).
 *
 * `parseStoredExclusionInput` validates and normalizes a single
 * user-submitted exclusion row before INSERT into either
 * `auth_db.global_triage_exclusion` or each tenant DB's
 * `triage_exclusion`. The output `ParsedStoredExclusion` carries the
 * exact column values to write.
 *
 * Distinct from {@link parseExclusionInput} (in `parse.ts`), which
 * parses the multi-field GraphQL `EventTriageExclusionInput` shape used
 * by the inline cadence path. The storage CRUD operates on per-row
 * `(kind, value, note)` tuples; both representations round-trip into
 * the same in-memory `ExclusionRule` matcher via the
 * `loadActiveExclusions` adapter.
 *
 * Failure produces a structured {@link StoredExclusionValidationError}
 * surfaced inline by the UI.
 */

import { isIPv4, isIPv6 } from "node:net";

import { validateDomainPattern } from "./regex";
import { reduceDomainPatternToSuffix } from "./suffix-reducer";

const BIG_ZERO = BigInt(0);
const BIG_8 = BigInt(8);
const BIG_16 = BigInt(16);
const BIG_24 = BigInt(24);
const BIG_FF = BigInt(0xff);
const BIG_FFFF = BigInt(0xffff);

export type StoredExclusionKind = "ipAddress" | "hostname" | "uri" | "domain";

export const STORED_EXCLUSION_KINDS: readonly StoredExclusionKind[] = [
  "ipAddress",
  "hostname",
  "uri",
  "domain",
];

/** Defensive cap to bound index footprint and reject pathological regex. */
export const MAX_STORED_EXCLUSION_VALUE_LENGTH = 1024;
/** Soft cap on note length so a single row cannot bloat the audit detail. */
export const MAX_STORED_EXCLUSION_NOTE_LENGTH = 500;

export interface StoredExclusionInput {
  kind: string;
  value: string;
  note?: string | null;
}

export interface ParsedStoredExclusion {
  kind: StoredExclusionKind;
  value: string;
  domainSuffix: string | null;
  note: string | null;
}

export class StoredExclusionValidationError extends Error {
  readonly code: string;
  readonly field: "kind" | "value" | "note";

  constructor(field: "kind" | "value" | "note", code: string, message: string) {
    super(message);
    this.name = "StoredExclusionValidationError";
    this.field = field;
    this.code = code;
  }
}

/**
 * Validate + normalize a single user-submitted exclusion row.
 *
 * Throws {@link StoredExclusionValidationError} for any failure mode the
 * UI can surface inline. Successful return guarantees the row can be
 * INSERTed without further validation.
 */
export function parseStoredExclusionInput(
  input: StoredExclusionInput,
): ParsedStoredExclusion {
  const kind = parseKind(input.kind);
  const rawValue = typeof input.value === "string" ? input.value : "";

  if (rawValue.length === 0) {
    throw new StoredExclusionValidationError(
      "value",
      "empty",
      "Value is required.",
    );
  }
  if (rawValue.length > MAX_STORED_EXCLUSION_VALUE_LENGTH) {
    throw new StoredExclusionValidationError(
      "value",
      "too_long",
      `Value must be at most ${MAX_STORED_EXCLUSION_VALUE_LENGTH} characters.`,
    );
  }

  const note = parseNote(input.note ?? null);

  switch (kind) {
    case "ipAddress": {
      const value = normalizeIpAddress(rawValue);
      return { kind, value, domainSuffix: null, note };
    }
    case "hostname": {
      const value = normalizeHostname(rawValue);
      return { kind, value, domainSuffix: null, note };
    }
    case "uri": {
      const value = normalizeUri(rawValue);
      return { kind, value, domainSuffix: null, note };
    }
    case "domain": {
      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        throw new StoredExclusionValidationError(
          "value",
          "empty",
          "Value is required.",
        );
      }
      const result = validateDomainPattern(trimmed);
      if (!result.ok) {
        throw new StoredExclusionValidationError(
          "value",
          "invalid_regex",
          result.reason,
        );
      }
      const reduction = reduceDomainPatternToSuffix(trimmed);
      return {
        kind,
        value: trimmed,
        domainSuffix: reduction ? reduction.value : null,
        note,
      };
    }
  }
}

function parseKind(raw: string): StoredExclusionKind {
  if (typeof raw !== "string") {
    throw new StoredExclusionValidationError(
      "kind",
      "invalid_kind",
      "Kind must be one of ipAddress, hostname, uri, domain.",
    );
  }
  if (
    raw === "ipAddress" ||
    raw === "hostname" ||
    raw === "uri" ||
    raw === "domain"
  ) {
    return raw;
  }
  throw new StoredExclusionValidationError(
    "kind",
    "invalid_kind",
    "Kind must be one of ipAddress, hostname, uri, domain.",
  );
}

function parseNote(raw: string | null): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_STORED_EXCLUSION_NOTE_LENGTH) {
    throw new StoredExclusionValidationError(
      "note",
      "too_long",
      `Note must be at most ${MAX_STORED_EXCLUSION_NOTE_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/**
 * Normalize an IP literal or CIDR into its canonical CIDR form.
 *
 *   - bare `192.168.1.5`  → `192.168.1.5/32`
 *   - bare `2001:db8::1`  → `2001:db8::1/128`
 *   - `192.168.1.5/24`    → `192.168.1.0/24` (host bits zeroed)
 *   - `2001:db8::/32`     → `2001:db8::/32`
 *
 * The implementation does the canonicalization in JS rather than
 * round-tripping through PostgreSQL `inet::text` because the parser
 * runs at request time before any DB call. Behavioural equivalence is
 * verified by unit tests over the documented edge cases (single host,
 * CIDR with host bits, IPv6 zone literals are rejected).
 */
function normalizeIpAddress(raw: string): string {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  let host: string;
  let prefix: number | null;
  if (slash === -1) {
    host = trimmed;
    prefix = null;
  } else {
    host = trimmed.slice(0, slash);
    const prefixRaw = trimmed.slice(slash + 1);
    const parsed = Number(prefixRaw);
    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      prefixRaw.length === 0
    ) {
      throw new StoredExclusionValidationError(
        "value",
        "invalid_ip",
        `Invalid CIDR prefix: ${JSON.stringify(prefixRaw)}.`,
      );
    }
    prefix = parsed;
  }

  if (host.includes("%")) {
    throw new StoredExclusionValidationError(
      "value",
      "invalid_ip",
      "IPv6 zone literals are not allowed in exclusions.",
    );
  }

  const v4 = isIPv4(host);
  const v6 = !v4 && isIPv6(host);
  if (!v4 && !v6) {
    throw new StoredExclusionValidationError(
      "value",
      "invalid_ip",
      `Not a valid IP literal: ${JSON.stringify(host)}.`,
    );
  }
  const totalBits = v4 ? 32 : 128;
  const finalPrefix = prefix ?? totalBits;
  if (finalPrefix > totalBits) {
    throw new StoredExclusionValidationError(
      "value",
      "invalid_ip",
      `CIDR prefix /${finalPrefix} exceeds maximum /${totalBits}.`,
    );
  }

  // Canonicalize the host portion (zero-fill IPv6, strip leading
  // zeros, and zero out host bits per `prefix`).
  const big = ipToBigInt(host);
  if (big === null) {
    throw new StoredExclusionValidationError(
      "value",
      "invalid_ip",
      `Could not parse IP literal: ${JSON.stringify(host)}.`,
    );
  }
  const hostBits = BigInt(totalBits - finalPrefix);
  const masked = hostBits === BIG_ZERO ? big : (big >> hostBits) << hostBits;
  const network = v4 ? bigIntToIpv4(masked) : bigIntToIpv6(masked);
  return `${network}/${finalPrefix}`;
}

function normalizeHostname(raw: string): string {
  let trimmed = raw.trim();
  if (trimmed.endsWith(".")) trimmed = trimmed.slice(0, -1);
  trimmed = trimmed.toLowerCase();
  if (trimmed.length === 0) {
    throw new StoredExclusionValidationError(
      "value",
      "invalid_hostname",
      "Hostname is required.",
    );
  }
  if (trimmed.length > 253) {
    throw new StoredExclusionValidationError(
      "value",
      "invalid_hostname",
      "Hostname exceeds the DNS-name length limit (253 characters).",
    );
  }
  for (const label of trimmed.split(".")) {
    if (!isValidDnsLabel(label)) {
      throw new StoredExclusionValidationError(
        "value",
        "invalid_hostname",
        `Hostname contains an invalid DNS label: ${JSON.stringify(label)}.`,
      );
    }
  }
  return trimmed;
}

function normalizeUri(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new StoredExclusionValidationError(
      "value",
      "invalid_uri",
      "URI is required.",
    );
  }
  return trimmed;
}

function isValidDnsLabel(label: string): boolean {
  if (label.length === 0 || label.length > 63) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

function ipToBigInt(ip: string): bigint | null {
  if (isIPv4(ip)) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let n = BIG_ZERO;
    for (const p of parts) {
      const byte = Number(p);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
      n = (n << BIG_8) | BigInt(byte);
    }
    return n;
  }
  if (isIPv6(ip)) {
    return ipv6ToBigInt(ip);
  }
  return null;
}

function ipv6ToBigInt(ip: string): bigint | null {
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
  let n = BIG_ZERO;
  for (const part of all) {
    if (part.length === 0 || part.length > 4) return null;
    const word = Number.parseInt(part, 16);
    if (!Number.isFinite(word) || word < 0 || word > 0xffff) return null;
    n = (n << BIG_16) | BigInt(word);
  }
  return n;
}

function bigIntToIpv4(n: bigint): string {
  const a = Number((n >> BIG_24) & BIG_FF);
  const b = Number((n >> BIG_16) & BIG_FF);
  const c = Number((n >> BIG_8) & BIG_FF);
  const d = Number(n & BIG_FF);
  return `${a}.${b}.${c}.${d}`;
}

function bigIntToIpv6(n: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i -= 1) {
    const word = Number((n >> BigInt(i * 16)) & BIG_FFFF);
    groups.push(word.toString(16));
  }
  // Compress the longest run of zero groups into `::`.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

export const _testing = {
  normalizeIpAddress,
  normalizeHostname,
  normalizeUri,
  isValidDnsLabel,
};
