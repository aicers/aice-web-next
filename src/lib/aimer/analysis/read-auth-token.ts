import "server-only";

import { randomUUID } from "node:crypto";

import { importJWK, SignJWT } from "jose";

import {
  type AimerSigningKeyMaterial,
  loadActiveSigningKeyMaterial,
} from "@/lib/aimer/signing-key";

/**
 * Audience claim for the AI-analysis read-side request token. Same
 * `aud` value the Phase 2 push uses on its context token — aimer-web
 * verifies the token against a single audience identifier on both
 * push and read paths.
 */
export const AIMER_READ_AUTH_AUDIENCE = "aimer-web";

/**
 * Time-to-live for the read-side request token. The token only needs
 * to survive a single GET-and-response round trip; matches the
 * 60-second TTL of the Phase 2 context token so the verifier-side
 * clock-skew allowance is identical on both flows.
 */
export const AIMER_READ_AUTH_TOKEN_TTL_SECONDS = 60;

/**
 * Decoded shape of the read-side request token JWS payload. Mirrors
 * the Phase 2 context-token shape (`iss`, `aud`, `aice_id`,
 * `customer_ids`, `iat`, `exp`, `jti`) so aimer-web can verify both
 * tokens with a single JWS-validation path keyed on the active
 * signing `kid`.
 *
 * - `customer_ids` is a single-element array of the resolved
 *   customer's `external_key`. Never the internal numeric `id` —
 *   aimer-web only knows the customer by `external_key`, and the
 *   bridge URL path carries the same identifier.
 */
export interface ReadAuthTokenPayload {
  iss: string;
  aud: string;
  aice_id: string;
  customer_ids: string[];
  iat: number;
  exp: number;
  jti: string;
}

/**
 * Build a fresh read-side auth token payload for the given
 * `aice_id` + customer `external_key`. The `iat` / `exp` window is
 * derived here so the route layer cannot accidentally mint a
 * long-lived token.
 */
export function buildReadAuthTokenPayload(
  aiceId: string,
  externalKey: string,
): ReadAuthTokenPayload {
  const iat = Math.floor(Date.now() / 1000);
  return {
    iss: aiceId,
    aud: AIMER_READ_AUTH_AUDIENCE,
    aice_id: aiceId,
    customer_ids: [externalKey],
    iat,
    exp: iat + AIMER_READ_AUTH_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  };
}

/**
 * Sign a read-side auth token using the active Aimer signing key.
 * Produces an ES256 JWS in compact serialization with the active
 * `kid` set in the protected header — the same envelope shape used
 * for the Phase 2 context token (`src/lib/aimer/context-token.ts`).
 *
 * Throws when no active signing key is available. The route layer
 * gates on `hasActiveAimerSigningKey()` before calling, so this is
 * treated as a programming error rather than a recoverable error.
 */
export async function signReadAuthToken(
  payload: ReadAuthTokenPayload,
  options: { keyMaterial?: AimerSigningKeyMaterial } = {},
): Promise<string> {
  const keyMaterial = options.keyMaterial ?? loadActiveSigningKeyMaterial();
  if (!keyMaterial) {
    throw new Error(
      "No active Aimer signing key. Verify integration setup before signing.",
    );
  }
  const privateKey = await importJWK(
    keyMaterial.privateJwk,
    keyMaterial.algorithm,
  );

  return new SignJWT({
    aice_id: payload.aice_id,
    customer_ids: payload.customer_ids,
  })
    .setProtectedHeader({ alg: keyMaterial.algorithm, kid: keyMaterial.kid })
    .setIssuer(payload.iss)
    .setAudience(payload.aud)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .setJti(payload.jti)
    .sign(privateKey);
}
