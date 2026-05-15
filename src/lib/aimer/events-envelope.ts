import "server-only";

import { createHash } from "node:crypto";

import { importJWK, SignJWT } from "jose";

import type { Phase2SchemaVersion } from "./phase2/schemas";
import { loadActiveSigningKeyMaterial } from "./signing-key";

/**
 * `schema_version` claim accepted by {@link signEventsEnvelope}.
 *
 * - `"0.0-stub"` — the first-cycle Phase 1 stub envelope used by the
 *   Send to Aimer button (#439 / #440).
 * - {@link Phase2SchemaVersion} — RFC 0002 §6 Phase 2 wire schemas
 *   (baseline / story / policy_run / withdraw / refresh_window /
 *   backfill). Selected by the matching schema in the Phase 2 schema
 *   registry before the orchestration helper signs.
 */
export type EventsEnvelopeSchemaVersion = "0.0-stub" | Phase2SchemaVersion;

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
 * Stub `events_data` payload for the first cycle of the Send to
 * Aimer flow.  Carries no real detection data — just enough to
 * exercise the multipart / signing pipeline end-to-end while the
 * production schema is being decided in a follow-up.
 */
export function buildStubEventsData(): Uint8Array {
  return new TextEncoder().encode(
    '{"hello":"world","schema_version":"0.0-stub","event_count":1}',
  );
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
