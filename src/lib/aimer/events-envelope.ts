import "server-only";

import { createHash } from "node:crypto";

import { importJWK, SignJWT } from "jose";

import type { Phase2SchemaVersion } from "./phase2/wire-types";
import {
  type AimerSigningKeyMaterial,
  loadActiveSigningKeyMaterial,
} from "./signing-key";

/**
 * `schema_version` claim accepted by {@link signEventsEnvelope}.
 *
 * - `"analyze-bridge.v1"` — the events_data shape carried by the
 *   `POST /api/analysis/analyze-bridge` flow (#629). One event per
 *   submission, snake_case canonical fields.
 * - {@link Phase2SchemaVersion} — RFC 0002 §6 Phase 2 wire schemas
 *   (baseline / story / policy_run / withdraw / refresh_window /
 *   backfill). Selected by the matching schema in the Phase 2 schema
 *   registry before the orchestration helper signs.
 */
export type EventsEnvelopeSchemaVersion =
  | "analyze-bridge.v1"
  | Phase2SchemaVersion;

/**
 * Caller-supplied input for {@link signEventsEnvelope}.
 *
 * Note: `payload_hash` is intentionally absent — the signer derives
 * it from the bytes via `SHA-256(eventsData)` so the hash and the
 * signed bytes can never drift.
 */
export interface EventsEnvelopeInput {
  iss: string;
  aice_id: string;
  customer_ids: string[];
  schema_version: EventsEnvelopeSchemaVersion;
  event_count: number;
  iat: number;
  exp: number;
  context_jti: string;
}

/**
 * Sign an events envelope using the active Aimer signing key.
 *
 * The JWS payload is the {@link EventsEnvelopeInput} fields plus the
 * function-computed `payload_hash` (base64url SHA-256 of the
 * `eventsData` bytes), matching the 9-field shape that aimer-web's
 * `verifyEventsEnvelope` expects.
 */
export async function signEventsEnvelope(
  input: EventsEnvelopeInput,
  eventsData: Uint8Array,
  options: {
    /**
     * Pre-loaded signing key material. When omitted the helper loads
     * the active key itself — kept so Phase 2 orchestration callers
     * and tests stay terse. The analyze-envelope route in
     * `/api/aimer/analyze-envelope` always passes this so its three
     * sibling JWSes share one `kid` even across a mid-mint key
     * rotation.
     */
    keyMaterial?: AimerSigningKeyMaterial;
  } = {},
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

  const payloadHash = sha256Base64Url(eventsData);

  return new SignJWT({
    aice_id: input.aice_id,
    customer_ids: input.customer_ids,
    schema_version: input.schema_version,
    event_count: input.event_count,
    context_jti: input.context_jti,
    payload_hash: payloadHash,
  })
    .setProtectedHeader({ alg: keyMaterial.algorithm, kid: keyMaterial.kid })
    .setIssuer(input.iss)
    .setIssuedAt(input.iat)
    .setExpirationTime(input.exp)
    .sign(privateKey);
}

function sha256Base64Url(data: Uint8Array): string {
  const digest = createHash("sha256").update(data).digest();
  return digest
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
