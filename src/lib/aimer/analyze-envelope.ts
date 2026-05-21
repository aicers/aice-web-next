import "server-only";

import { createHash } from "node:crypto";

import { importJWK, SignJWT } from "jose";

import { loadActiveSigningKeyMaterial } from "./signing-key";

/**
 * Allowed values for the `lang` claim in {@link AnalyzeParamsTokenClaims}.
 * aimer-web's `verifyAnalyzeParamsToken` rejects any other value with
 * `lang_unsupported`.
 */
export type AnalyzeLang = "ENGLISH" | "KOREAN";

/**
 * Map a locale code from the aice-web-next UI to the upstream `lang`
 * claim accepted by aimer-web.
 *
 * Locales not in the curated mapping are treated as English so the
 * analyze flow stays operational on a new locale rollout (the LLM
 * answer can be re-rendered, the request itself stays valid).
 */
export function localeToAnalyzeLang(locale: string): AnalyzeLang {
  return locale.toLowerCase() === "ko" ? "KOREAN" : "ENGLISH";
}

/**
 * Claims embedded in the `analyze_params_token` JWS.
 *
 * The 9 fields below mirror the `verifyAnalyzeParamsToken` contract
 * documented in aicers/aimer-web#274. Three of them
 * (`context_jti`, `payload_hash`, `envelope_hash`) cross-bind this
 * token to the sibling `context_token` and `events_envelope` JWSes
 * so an attacker cannot swap one envelope for another without
 * invalidating the signature.
 */
export interface AnalyzeParamsTokenClaims {
  context_jti: string;
  payload_hash: string;
  envelope_hash: string;
  event_key: string;
  lang: AnalyzeLang;
  model_name: string;
  model: string;
  force: boolean;
  external_key: string;
}

/**
 * Sign an `analyze_params_token` using the active Aimer signing key.
 *
 * The JWS uses the same `kid` and `alg` (ES256) as the sibling
 * `events_envelope` JWS so aimer-web's verifier can locate the key
 * from a single trust-registry lookup.
 *
 * `iat` / `exp` are written by the caller so the token TTL stays
 * aligned with `context_token` / `events_envelope`.
 */
export async function signAnalyzeParamsToken(
  claims: AnalyzeParamsTokenClaims,
  options: { iss: string; iat: number; exp: number },
): Promise<string> {
  const keyMaterial = loadActiveSigningKeyMaterial();
  if (!keyMaterial) {
    throw new Error(
      "No active Aimer signing key. Verify integration setup before signing.",
    );
  }
  const privateKey = await importJWK(
    keyMaterial.privateJwk,
    keyMaterial.algorithm,
  );

  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: keyMaterial.algorithm, kid: keyMaterial.kid })
    .setIssuer(options.iss)
    .setIssuedAt(options.iat)
    .setExpirationTime(options.exp)
    .sign(privateKey);
}

/**
 * Hash the compact-serialization bytes of an `events_envelope` JWS
 * into the `envelope_hash` claim of an {@link AnalyzeParamsTokenClaims}.
 * Used by aimer-web's cross-binding check to detect an envelope
 * swapped between sign and verify.
 */
export function eventsEnvelopeHash(eventsEnvelopeJws: string): string {
  return sha256Base64Url(Buffer.from(eventsEnvelopeJws, "utf8"));
}

/**
 * SHA-256 a byte buffer and emit the base64url (no padding) digest.
 * Shared between the `payload_hash` and `envelope_hash` cross-binding
 * claims so the two values are computed identically.
 */
export function sha256Base64Url(data: Uint8Array): string {
  return base64UrlEncode(createHash("sha256").update(data).digest());
}

function base64UrlEncode(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decimal i128 event-key pattern, matching the customer DB column
 * (`NUMERIC(39,0)`). aimer-web rejects mismatched keys with the
 * `event_key_mismatch` error code, so this gate runs before any
 * envelope is minted.
 */
export const ANALYZE_EVENT_KEY_PATTERN = /^[0-9]{1,39}$/;

/**
 * Map a `Record<string, unknown>` produced by REview's GraphQL
 * client into the snake-case canonical shape consumed by
 * aimer-web's analyze-bridge endpoint.
 *
 * - `__typename` (camelCase) is mapped to top-level `kind` (snake).
 * - Nested objects are recursed.
 * - Arrays are mapped element-wise.
 *
 * The mapper is intentionally generic across the curated event
 * union: aimer-web treats `event_data` as `jsonb` and dispatches on
 * `kind`, so passing the full snake-cased selection-set is safe and
 * keeps the wire shape consistent across subtypes.
 */
export function eventToSnakeCase(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "__typename") {
      if (typeof value === "string") out.kind = value;
      continue;
    }
    out[camelToSnake(key)] = mapValue(value);
  }
  return out;
}

function mapValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(mapValue);
  if (typeof value === "object") {
    return eventToSnakeCase(value as Record<string, unknown>);
  }
  return value;
}

function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
