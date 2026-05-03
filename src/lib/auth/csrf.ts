import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────

const NONCE_BYTES = 16;
const MUTATION_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * CSRF cookie name.
 *
 * `__Host-` prefix requires `Secure` and `Path=/` without `Domain`,
 * which only works over HTTPS.  In development (HTTP) we drop the
 * prefix so the browser accepts the cookie.
 */
export const CSRF_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-csrf" : "csrf";

/** Header name the client sends the CSRF token in. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * Cookie options for the CSRF cookie.
 *
 * `httpOnly: false` — the client-side JS must be able to read the
 * cookie value and attach it to the `X-CSRF-Token` header.
 */
export const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

// ── Token generation ─────────────────────────────────────────────

/**
 * Generate an HMAC-based CSRF token bound to the given session ID.
 *
 * Token format: `<nonce>.<issued_at>.<signature>`
 * where `signature = HMAC-SHA256(sid + nonce + issued_at, secret)`.
 *
 * The token is designed for the Double Submit Cookie pattern: set it
 * as a non-httpOnly cookie, and the client reads it and sends it back
 * in the `X-CSRF-Token` header on mutation requests.
 */
export function generateCsrfToken(
  sid: string,
  secret: string,
): { token: string } {
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = computeSignature(sid, nonce, issuedAt, secret);

  return { token: `${nonce}.${issuedAt}.${signature}` };
}

// ── Token validation ─────────────────────────────────────────────

/**
 * Validate an HMAC-based CSRF token.
 *
 * Rejects if:
 * - Token format is invalid (not 3 dot-separated parts)
 * - HMAC signature mismatch (covers both tampering and `sid` mismatch,
 *   because `sid` is part of the HMAC input)
 * - `issued_at` < `jwtIat` (stale token — the CSRF token was issued
 *   before the current JWT, meaning it belongs to a previous session
 *   or a pre-rotation token)
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export function validateCsrfToken(
  token: string,
  sid: string,
  secret: string,
  jwtIat: number,
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [nonce, issuedAtStr, signature] = parts;

  const issuedAt = Number(issuedAtStr);
  if (Number.isNaN(issuedAt)) return false;

  // Stale token check: CSRF must be issued at or after the JWT
  if (issuedAt < jwtIat) return false;

  // Recompute expected signature and compare in constant time
  const expected = computeSignature(sid, nonce, issuedAt, secret);
  return constantTimeEqual(signature, expected);
}

// ── Origin / Referer verification ────────────────────────────────

/**
 * Canonicalize an origin string for comparison.
 *
 * Strips any trailing slash and lowercases scheme + host.  Browsers
 * send `Origin` without a trailing slash and with a lowercase
 * scheme/host; canonicalizing here means that
 * `EXPECTED_ORIGIN=https://Example.com/` does not silently mismatch
 * `Origin: https://example.com`.
 *
 * Returns `null` if the input is not a parseable absolute origin.
 */
export function canonicalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    // URL parsing already lowercases the scheme and host; constructing
    // the origin via the URL API drops any path/query/fragment and
    // also drops a trailing slash because `URL.origin` never includes
    // one.
    if (!url.origin || url.origin === "null") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the configured `EXPECTED_ORIGIN`, canonicalized.
 *
 * Returns `null` when the env var is unset or not a parseable origin.
 * A malformed value is treated as unset rather than crashing the
 * mutation guard — the caller falls back to `request.nextUrl.origin`,
 * preserving today's behavior.
 */
export function getConfiguredExpectedOrigin(): string | null {
  const raw = process.env.EXPECTED_ORIGIN;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return canonicalizeOrigin(trimmed);
}

/**
 * Verify that the request originates from the expected app origin.
 *
 * Checks the `Origin` header first; falls back to extracting the
 * origin from the `Referer` header.  Rejects if neither header is
 * present or if neither matches.
 *
 * This is a defense-in-depth measure alongside the HMAC token.
 *
 * Returns the actual origin (Origin header value, or the parsed
 * Referer origin) when the headers are usable but mismatch — useful
 * for non-production debug responses and for server-side warning
 * logs.  Returns `null` when neither header is present / parseable.
 */
export interface OriginCheckResult {
  ok: boolean;
  /** Origin actually presented by the request, when extractable. */
  actual: string | null;
  /** Expected origin used in the comparison (canonicalized). */
  expected: string;
}

export function checkOrigin(
  originHeader: string | null,
  refererHeader: string | null,
  expectedOrigin: string,
): OriginCheckResult {
  const expected = canonicalizeOrigin(expectedOrigin) ?? expectedOrigin;

  if (originHeader) {
    const actual = canonicalizeOrigin(originHeader) ?? originHeader;
    return { ok: actual === expected, actual, expected };
  }

  if (refererHeader) {
    const actual = canonicalizeOrigin(refererHeader);
    if (actual === null) {
      return { ok: false, actual: null, expected };
    }
    return { ok: actual === expected, actual, expected };
  }

  // Neither Origin nor Referer present — reject
  return { ok: false, actual: null, expected };
}

/**
 * Boolean shorthand for {@link checkOrigin}, retained for the
 * existing callers and tests.
 */
export function validateOrigin(
  originHeader: string | null,
  refererHeader: string | null,
  expectedOrigin: string,
): boolean {
  return checkOrigin(originHeader, refererHeader, expectedOrigin).ok;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Check whether the HTTP method requires CSRF validation. */
export function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

function computeSignature(
  sid: string,
  nonce: string,
  issuedAt: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${sid}${nonce}${issuedAt}`)
    .digest("hex");
}

/**
 * Constant-time string comparison.
 *
 * Returns `false` early if lengths differ (length is not secret),
 * then uses `crypto.timingSafeEqual` for the actual comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
