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
  /**
   * RFC 0002 Phase 0.5 delivery watermark — ISO 8601 UTC timestamp of
   * the `aimer_push_state` cursor at the time this envelope was minted.
   * Pre-batch value: the rows in `events_data` may sit AFTER this
   * timestamp, but everything at-or-below it has already been
   * delivered. Allows aimer-web to shorten its DAILY settle delay.
   *
   * Paired with {@link cursor_quality} — both fields are included on
   * the wire only when both are supplied. `signEventsEnvelope` will
   * not emit one without the other (a half-claim is uninterpretable on
   * the verify side).
   */
  cursor_event_time?: string;
  /**
   * RFC 0002 Phase 0.5 delivery-watermark quality:
   *
   *  - `"strict"` — every row at-or-below `cursor_event_time` has been
   *    delivered. Set on the baseline streaming branch where the
   *    cursor is the authoritative high-water mark.
   *  - `"soft"` — late-commit stragglers may still arrive AT OR BEFORE
   *    `cursor_event_time` (see the story forward-streaming branch).
   *    Verifiers should treat the watermark as a best-effort lower
   *    bound on settle delay rather than a hard guarantee.
   */
  cursor_quality?: "strict" | "soft";
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

  const claims: Record<string, unknown> = {
    aice_id: input.aice_id,
    customer_ids: input.customer_ids,
    schema_version: input.schema_version,
    event_count: input.event_count,
    context_jti: input.context_jti,
    payload_hash: payloadHash,
  };
  // Phase 0.5 watermark is emitted only when BOTH fields are supplied
  // (a half-claim is uninterpretable on the verify side).
  if (
    input.cursor_event_time !== undefined &&
    input.cursor_quality !== undefined
  ) {
    claims.cursor_event_time = input.cursor_event_time;
    claims.cursor_quality = input.cursor_quality;
  }

  return new SignJWT(claims)
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
