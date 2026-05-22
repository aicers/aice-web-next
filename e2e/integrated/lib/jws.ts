import { createPrivateKey, createSign } from "node:crypto";

/**
 * Minimal ES256 JWS encode/decode/sign helpers for the integrated
 * harness. The aice-web-next codebase uses `jose` end-to-end for this,
 * but the spec runs under Playwright with no `jose` dep — Node's
 * built-in `crypto` is enough for the narrow needs of the tamper
 * scenarios (decode an existing JWS, mutate one payload claim, re-sign
 * with the same key so the signature still verifies on aimer-web).
 */

export interface DecodedJws<
  Header = Record<string, unknown>,
  Payload = Record<string, unknown>,
> {
  header: Header;
  payload: Payload;
  signature: string;
}

export function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function base64UrlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function decodeJws<
  H = Record<string, unknown>,
  P = Record<string, unknown>,
>(jws: string): DecodedJws<H, P> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWS: expected 3 dot-separated parts");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  return {
    header: JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as H,
    payload: JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as P,
    signature: signatureB64,
  };
}

export interface Es256JwkPrivate {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
  kid?: string;
}

/**
 * Re-signs a JWS using ES256 with the given JWK private key. The
 * caller has already mutated the decoded `payload`; this function
 * recomputes the signature against `header.payload` so the JWS still
 * verifies under the trust-registry-published public key.
 */
export function signJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateJwk: Es256JwkPrivate,
): string {
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  // Node's typing for createPrivateKey expects an open-shaped
  // `JsonWebKey` (with `[key: string]: any`); our shape is intentionally
  // narrower for compile-time safety. Cast on the boundary.
  const key = createPrivateKey({
    key: privateJwk as unknown as Record<string, unknown>,
    format: "jwk",
  });
  const sig = createSign("SHA256").update(signingInput).sign({
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64UrlEncode(sig)}`;
}
