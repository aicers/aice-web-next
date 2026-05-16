import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/**
 * HMAC contract for the engagement store (#588).
 *
 * Key source.
 *   Read from `ENGAGEMENT_HMAC_KEY` at first use. Global (not per-
 *   tenant) because the engagement signals are long-lived analytics
 *   that may be aggregated across tenants in later phases. The value
 *   MUST be base64 (standard or URL-safe) of ≥32 random bytes; the
 *   helper decodes the env var and rejects invalid base64 or under-
 *   entropy keys at runtime so a deploy with a typo or an
 *   `openssl rand -base64 24` mistake fails fast instead of
 *   pseudonymizing long-lived analytics rows with a weak secret.
 *
 * Normalization.
 *   Each dimension has a canonical form applied BEFORE the HMAC so
 *   identical logical values produce identical HMAC outputs across
 *   rows. Helpers below own the normalization; callers never pre-
 *   normalize on their own.
 *
 * Rotation policy.
 *   The key does not rotate. Engagement signals are long-lived
 *   analytics; rotating would invalidate every historical row's join
 *   key. A future rotation would need to expand the schema with a
 *   `_key_version` column and rewrite the read paths, which is out of
 *   scope for Phase 1.
 */

const HMAC_ALGORITHM = "sha256";
const MIN_KEY_BYTES = 32;

// Standard and URL-safe base64 alphabets, with optional `=` padding.
// `Buffer.from(raw, "base64")` silently strips invalid characters and
// accepts impossible unpadded lengths (e.g. 45-char strings whose
// payload is 1 mod 4, which no real base64 encoder produces), so we
// validate both the alphabet and the length shape before decoding.
const BASE64_ALPHABET_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

function isValidBase64Shape(raw: string): boolean {
  if (!BASE64_ALPHABET_PATTERN.test(raw)) return false;
  // Padded form: alphabet regex constrains padding to at most two `=`
  // anchored at the end, so the only remaining shape check is that
  // the total length is a multiple of 4.
  // Unpadded form: length mod 4 must be 0, 2, or 3 — a length of
  // 1 mod 4 is never a valid base64 encoding of any byte sequence.
  if (raw.endsWith("=")) return raw.length % 4 === 0;
  return raw.length % 4 !== 1;
}

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey !== null) return cachedKey;
  const raw = process.env.ENGAGEMENT_HMAC_KEY;
  if (raw === undefined || raw.length === 0) {
    throw new Error(
      "Missing environment variable: ENGAGEMENT_HMAC_KEY. Set it to base64 of ≥32 random bytes for engagement-signal pseudonymization.",
    );
  }
  if (!isValidBase64Shape(raw)) {
    throw new Error(
      "ENGAGEMENT_HMAC_KEY is not valid base64. Set it to base64 of ≥32 random bytes (e.g. `openssl rand -base64 48`).",
    );
  }
  // Normalize URL-safe alphabet to standard so `Buffer.from` decodes
  // both forms identically. Padding can be omitted for URL-safe; we
  // leave that to `Buffer.from`'s base64 mode (it accepts unpadded
  // input).
  const standardized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(standardized, "base64");
  if (decoded.length < MIN_KEY_BYTES) {
    throw new Error(
      `ENGAGEMENT_HMAC_KEY decodes to only ${decoded.length} bytes; need ≥${MIN_KEY_BYTES} random bytes (e.g. \`openssl rand -base64 48\`).`,
    );
  }
  cachedKey = decoded;
  return cachedKey;
}

/**
 * Test/teardown hook only — clears the cached key so tests can swap
 * `ENGAGEMENT_HMAC_KEY` between cases.
 */
export function _resetEngagementHmacKey(): void {
  cachedKey = null;
}

function rawHmac(input: string): string {
  return createHmac(HMAC_ALGORITHM, loadKey())
    .update(`${input}`, "utf8")
    .digest("hex");
}

// ── Normalizers ─────────────────────────────────────────────────

/**
 * IP / asset address normalization. IPv4 strips leading zeros per
 * octet; IPv6 lowercases and trims redundant zeros where possible
 * (Node's `URL` performs canonicalization for `http://[...]` hosts;
 * we use that path for IPv6 and a manual strip for IPv4 to avoid the
 * `URL` parsing edge cases).
 */
const IPV4_LIKE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function normalizeIp(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  // Match the IPv4 shape directly so leading-zero forms (which Node's
  // `isIP` rejects as ambiguous octal) still normalize to their
  // decimal equivalent.
  const ipv4Match = trimmed.match(IPV4_LIKE);
  if (ipv4Match !== null) {
    const parts = ipv4Match
      .slice(1, 5)
      .map((octet) => Number.parseInt(octet, 10));
    if (parts.every((p) => Number.isFinite(p) && p >= 0 && p <= 255)) {
      return parts.join(".");
    }
  }
  const version = isIP(trimmed);
  if (version === 6) {
    try {
      const url = new URL(`http://[${trimmed}]/`);
      // url.hostname is `[<canonical>]`; strip brackets.
      const host = url.hostname;
      return host.startsWith("[") && host.endsWith("]")
        ? host.slice(1, -1).toLowerCase()
        : host.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  }
  return trimmed.toLowerCase();
}

/**
 * Domain / hostname / DNS query normalization. Lowercases, strips a
 * single trailing dot, and applies the URL hostname's punycode
 * mapping when the value contains non-ASCII labels.
 */
export function normalizeDomain(value: string): string {
  let trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.endsWith(".")) trimmed = trimmed.slice(0, -1);
  try {
    const url = new URL(`http://${trimmed}/`);
    return url.hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** TLS / SSH fingerprint hex normalization — lowercase, trim. */
export function normalizeFingerprint(value: string): string {
  return value.trim().toLowerCase();
}

/** ISO-3166 alpha-2 country code normalization — uppercase, trim. */
export function normalizeCountry(value: string): string {
  return value.trim().toUpperCase();
}

/** Account id normalization for `account_id_hmac` storage. */
export function normalizeAccountId(value: string): string {
  return value.trim().toLowerCase();
}

// ── HMAC entrypoints ────────────────────────────────────────────

export function hmacIp(value: string): string {
  return rawHmac(normalizeIp(value));
}

export function hmacDomain(value: string): string {
  return rawHmac(normalizeDomain(value));
}

export function hmacFingerprint(value: string): string {
  return rawHmac(normalizeFingerprint(value));
}

export function hmacCountry(value: string): string {
  return rawHmac(normalizeCountry(value));
}

export function hmacAccountId(value: string): string {
  return rawHmac(normalizeAccountId(value));
}

/**
 * Generic HMAC for asset addresses. Asset addresses in this codebase
 * are IPs, so the normalization path is the same as {@link hmacIp};
 * the named entry point exists for readability at call sites.
 */
export function hmacAssetKey(address: string): string {
  return rawHmac(normalizeIp(address));
}

/**
 * Catch-all HMAC for pivot dimensions that fall outside the typed
 * normalizers above. Callers MUST hand in an already-normalized value
 * (use one of the typed helpers when possible). Phase 2's pivot
 * widening (#589) is expected to enumerate the dimension list and
 * collapse this seam.
 */
export function hmacNormalized(normalized: string): string {
  return rawHmac(normalized);
}
