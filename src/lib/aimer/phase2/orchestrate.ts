/**
 * Phase 2 push orchestration helper (RFC 0002 §6.1 / sub-issue #591).
 *
 * Builds the three multipart components — `context_token`,
 * `events_envelope`, `events_data` — that aimer-web's Phase 2 endpoints
 * accept. Shared by drain routes (`<kind>/next-batch`) and manual-Send
 * routes (`<kind>/build-and-post`) so the wire format is produced from
 * exactly one place.
 *
 * Cross-side trust model is unchanged from Phase 1: ES256 JWS,
 * single-customer dispatch (the context token's `customer_ids` is the
 * resolved `external_key` as a single-element array), `payload_hash`
 * derived by the envelope signer from the serialized bytes so the
 * hash and the bytes cannot drift.
 */

import "server-only";

import {
  AIMER_CONTEXT_TOKEN_AUDIENCE,
  generateContextTokenJti,
  signContextToken,
} from "@/lib/aimer/context-token";
import { signEventsEnvelope } from "@/lib/aimer/events-envelope";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { query } from "@/lib/db/client";

import { type Phase2SchemaVersion, validatePhase2Payload } from "./schemas";

// ── Reserved sentinels ─────────────────────────────────────────────

/**
 * Sentinel UUID used for `last_sent_by` on opportunistic (system-driven)
 * Phase 2 pushes. It is **not** a row in `accounts` — lookups for this
 * value MUST be skipped. UI and audit consumers detect this sentinel at
 * read time and render the label "system" (i18n key
 * `audit.actor.system`, EN "System" / KR "시스템") instead of attempting
 * an `accounts` lookup.
 *
 * Exported from this module because Phase 2 callers reach for it here.
 * If downstream consumers (audit / UI) find this awkward to import
 * without dragging in the orchestration module, the constant moves to
 * `src/lib/aimer/phase2/system-actor.ts` in a follow-up.
 */
export const SYSTEM_ACTOR_ACCOUNT_ID =
  "00000000-0000-0000-0000-000000000000" as const;

// ── Constants ──────────────────────────────────────────────────────

/** Context-token TTL in seconds (within RFC 0002 §6.1's 30s–2min band). */
const CONTEXT_TOKEN_TTL_SECONDS = 60;

// ── Errors ─────────────────────────────────────────────────────────

export class Phase2OrchestrationError extends Error {
  readonly code:
    | "aimer_integration_not_configured"
    | "customer_not_found"
    | "customer_external_key_missing";

  constructor(code: Phase2OrchestrationError["code"], message: string) {
    super(message);
    this.name = "Phase2OrchestrationError";
    this.code = code;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export interface BuildPhase2PushInput {
  schemaVersion: Phase2SchemaVersion;
  /** Internal numeric `customers.id` of the target customer. */
  customerId: number;
  /**
   * Authenticated session's `accountId`. Threaded into the context
   * token's `sub` claim (verification side); audit attribution is a
   * separate concern (`last_sent_by` is the session account for manual
   * paths, {@link SYSTEM_ACTOR_ACCOUNT_ID} for opportunistic drains).
   */
  accountId: string;
  /**
   * Inner payload matching the schema registered for `schemaVersion`.
   * The helper resolves the customer's `external_key` and threads it
   * into both the context token's `customer_ids` and the payload's
   * `external_key` field before validation — any caller-supplied value
   * for that key is overwritten so the two surfaces cannot disagree.
   */
  payload: unknown;
}

export interface Phase2PushTokens {
  /** ES256 JWS — the `context_token` multipart part. */
  context_token: string;
  /** ES256 JWS — the `events_envelope` multipart part. */
  events_envelope: string;
  /** Canonical UTF-8 bytes — the `events_data` multipart part, as a string. */
  events_data: string;
  /** `jti` minted for this push. Surfaced for callers that need to ack-track. */
  context_jti: string;
}

/**
 * Build a Phase 2 push: resolve customer, validate payload, mint the
 * two JWSes. The caller is responsible for everything else — pause
 * gating, queue claim / inflight record, audit, transport.
 *
 * @throws {Phase2OrchestrationError} when the customer / integration
 *   setup blocks the push (`code` distinguishes the cause).
 * @throws {Phase2PayloadValidationError} when the inner payload fails
 *   the schema check registered for `schemaVersion`.
 */
export async function buildPhase2Push(
  input: BuildPhase2PushInput,
): Promise<Phase2PushTokens> {
  const { schemaVersion, customerId, accountId, payload } = input;

  // ── Aimer integration setup ──────────────────────────────────
  const setup = await getAimerIntegrationSetup();
  if (!setup.aiceId || !setup.bridgeUrl || !setup.hasActiveSigningKey) {
    throw new Phase2OrchestrationError(
      "aimer_integration_not_configured",
      "Aimer integration is not fully configured (aice_id / bridge URL / signing key).",
    );
  }

  // ── Resolve customer external_key (cross-DB) ─────────────────
  const externalKey = await resolveExternalKey(customerId);

  // ── Validate payload (with resolved external_key threaded in) ─
  //
  // The helper overwrites any caller-supplied `external_key` on the
  // payload so the wire-level value cannot disagree with the context
  // token's `customer_ids`. Per-push customer scope (RFC 0002 §6.1)
  // requires the two to match; aimer-web rejects mismatches with a
  // `payload_customer_not_authorized` 403, so resolving early is the
  // friendlier failure surface.
  const augmentedPayload = injectExternalKey(payload, externalKey);
  const validatedPayload = validatePhase2Payload(
    schemaVersion,
    augmentedPayload,
  );

  // ── Serialize payload (canonical wire bytes) ────────────────
  const eventsDataString = JSON.stringify(validatedPayload);
  const eventsDataBytes = new TextEncoder().encode(eventsDataString);

  // ── Sign tokens ──────────────────────────────────────────────
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + CONTEXT_TOKEN_TTL_SECONDS;
  const jti = generateContextTokenJti();
  const customerIds = [externalKey];
  const eventCount = computeEventCount(schemaVersion, validatedPayload);

  const [contextTokenJws, eventsEnvelopeJws] = await Promise.all([
    signContextToken({
      iss: setup.aiceId,
      aud: AIMER_CONTEXT_TOKEN_AUDIENCE,
      sub: accountId,
      aice_id: setup.aiceId,
      customer_ids: customerIds,
      iat,
      exp,
      jti,
    }),
    signEventsEnvelope(
      {
        iss: setup.aiceId,
        aice_id: setup.aiceId,
        customer_ids: customerIds,
        schema_version: schemaVersion,
        event_count: eventCount,
        iat,
        exp,
        context_jti: jti,
      },
      eventsDataBytes,
    ),
  ]);

  return {
    context_token: contextTokenJws,
    events_envelope: eventsEnvelopeJws,
    events_data: eventsDataString,
    context_jti: jti,
  };
}

// ── Internals ──────────────────────────────────────────────────────

async function resolveExternalKey(customerId: number): Promise<string> {
  const { rows } = await query<{ id: number; external_key: string | null }>(
    "SELECT id, external_key FROM customers WHERE id = $1",
    [customerId],
  );
  if (rows.length === 0) {
    throw new Phase2OrchestrationError(
      "customer_not_found",
      `Customer not found: ${customerId}`,
    );
  }
  const externalKey = rows[0].external_key?.trim() ?? "";
  if (externalKey.length === 0) {
    throw new Phase2OrchestrationError(
      "customer_external_key_missing",
      `Customer ${customerId} has no external_key configured.`,
    );
  }
  return externalKey;
}

function injectExternalKey(payload: unknown, externalKey: string): unknown {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    // Pass through unchanged — schema validation will reject this as
    // not-an-object and emit a meaningful error.
    return payload;
  }
  return { ...(payload as Record<string, unknown>), external_key: externalKey };
}

/**
 * Per RFC 0002 §6.1 "`event_count` definition".
 *
 * The orchestration helper is the only place that knows both the
 * schema_version and the validated payload, so it computes the value
 * once and surfaces it on the envelope.
 */
function computeEventCount(
  schemaVersion: Phase2SchemaVersion,
  payload: unknown,
): number {
  // The payload has already passed schema validation, so the
  // structural assumptions below hold. Defensive `?? 0` guards keep
  // the function pure-numeric in the face of any future schema
  // relaxation.
  const p = payload as Record<string, unknown>;
  switch (schemaVersion) {
    case "phase2.baseline.v1":
    case "phase2.policy_run.v1":
      return (p.events as unknown[] | undefined)?.length ?? 0;
    case "phase2.story.v1":
      return (p.stories as unknown[] | undefined)?.length ?? 0;
    case "phase2.refresh_window.v1":
    case "phase2.backfill.v1": {
      const window = p.window as { kind?: string } | undefined;
      if (window?.kind === "story") {
        return (p.stories as unknown[] | undefined)?.length ?? 0;
      }
      return (p.events as unknown[] | undefined)?.length ?? 0;
    }
    case "phase2.withdraw.v1": {
      const items = (p.withdrawals as unknown[] | undefined) ?? [];
      let total = 0;
      for (const item of items) {
        const w = item as { event_keys?: unknown[] };
        if (Array.isArray(w.event_keys)) {
          total += w.event_keys.length;
        } else {
          // single-item withdrawal (story / policy_run)
          total += 1;
        }
      }
      return total;
    }
  }
}

// Re-export the validation error for callers that want to catch it
// without importing `./schemas` directly.
export { Phase2PayloadValidationError } from "./schemas";
