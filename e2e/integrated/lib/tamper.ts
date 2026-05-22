import { decodeJws, type Es256JwkPrivate, signJws } from "./jws";

/**
 * Returns an `analyze_params_token` JWS with one cross-binding claim
 * replaced by a deliberately-broken value, re-signed with the supplied
 * private key so the JWS itself still verifies on aimer-web's side.
 * That isolates the failure to aimer-web's cross-binding check
 * (`verifyAnalyzeParamsToken`) — the response error code is
 * `invalid_analyze_params_token` per aimer-web#274 §10.
 *
 * Per #635 §3 the three relevant claims are `context_jti`,
 * `payload_hash`, `envelope_hash`. Other JWS-level failures (wrong
 * key, expired token, replay) are exhaustively covered by aimer-web's
 * own Q2 tests and out of scope here.
 */
export type CrossBindingClaim =
  | "context_jti"
  | "payload_hash"
  | "envelope_hash";

const TAMPERED_VALUES: Record<CrossBindingClaim, string> = {
  // RFC 4122 v4 UUID that the BFF would not have minted for any
  // concurrent context_token — guaranteed jti mismatch.
  context_jti: "00000000-0000-4000-8000-000000000000",
  // 32-byte SHA-256 base64url of the empty string; the actual
  // payload_hash is computed over `events_data`, which is never
  // empty in a real round-trip.
  payload_hash: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  // Same constant — substituting it for envelope_hash makes the
  // claim diverge from the real `sha256(events_envelope JWS bytes)`.
  envelope_hash: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
};

export function tamperAnalyzeParamsToken(
  jws: string,
  claim: CrossBindingClaim,
  privateJwk: Es256JwkPrivate,
): string {
  const { header, payload } = decodeJws(jws);
  const tampered = { ...payload, [claim]: TAMPERED_VALUES[claim] };
  return signJws(header, tampered, privateJwk);
}
