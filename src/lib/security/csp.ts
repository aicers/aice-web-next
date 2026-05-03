/**
 * Content-Security-Policy nonce + header builder.
 *
 * Used by the request `proxy` (Next 16's middleware equivalent) to
 * mint a per-request nonce, propagate it to RSC layouts via the
 * `x-nonce` request header, and emit the
 * `Content-Security-Policy-Report-Only` response header.
 *
 * The header is shipped in Report-Only mode first so any Next.js
 * inline-style/script breakages surface in real traffic before the
 * policy is promoted to enforcing.  Promotion to
 * `Content-Security-Policy` is a follow-up after one release of
 * Report-Only validation.
 */

/** Header forwarded to RSC layouts so they can read the per-request nonce. */
export const NONCE_HEADER = "x-nonce";

/**
 * Generate a CSP nonce.
 *
 * Uses the Edge runtime's global `crypto.getRandomValues` so the same
 * implementation runs in both the Node and Edge proxy runtimes.
 * 16 bytes of entropy (encoded base64) is the conventional minimum.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Cross-runtime base64: avoid relying on Node's `Buffer` so this
  // also works in the Edge runtime.
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // btoa is available in both Node 24 and Edge.
  return btoa(binary);
}

/**
 * Build the Content-Security-Policy header value for the given
 * request nonce.
 *
 * `style-src` keeps `'unsafe-inline'` for now — Next.js styled-jsx
 * and a number of inline styles in the app would break under a
 * strict `style-src`.  Nonce-based hardening for styles is tracked
 * as a follow-up issue.
 */
export function buildCspHeaderValue(nonce: string): string {
  // `'strict-dynamic'` lets the framework's nonce-trusted scripts
  // load further scripts they author, which is required for the
  // Next.js client-side hydration entry to succeed under a strict
  // script-src.
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

/** Header name we emit. Shipped in Report-Only mode for one release. */
export const CSP_HEADER_NAME = "Content-Security-Policy-Report-Only";
