/**
 * Phase 2 wire-format types (RFC 0002 §6).
 *
 * This module is intentionally **not** server-only — both the
 * server-side orchestration helper and the browser-side transport
 * helper import the same literals from here so the wire contract has
 * a single source of truth.
 *
 * Anything that needs `import "server-only"` (DB access, signing,
 * setup-status reads) lives in {@link ./orchestrate} or
 * {@link ./state}. Anything in this file must remain importable from
 * a `*.client.ts` module under the Next.js client/server boundary.
 */

// ── Schema versions ────────────────────────────────────────────────

/**
 * Phase 2 `schema_version` literals. Each value maps to one
 * inner-payload schema and (downstream) one aimer-web endpoint.
 */
export const PHASE2_SCHEMA_VERSIONS = [
  "phase2.baseline.v1",
  "phase2.story.v1",
  "phase2.policy_run.v1",
  "phase2.withdraw.v1",
  "phase2.refresh_window.v1",
  "phase2.backfill.v1",
] as const;

export type Phase2SchemaVersion = (typeof PHASE2_SCHEMA_VERSIONS)[number];

// ── Multipart tokens ───────────────────────────────────────────────

/**
 * The three multipart components produced by Phase 2 orchestration,
 * plus the `context_jti` minted for the push. The drain helper groups
 * the flat token fields from the `next-batch` response into this
 * shape before handing it to {@link postPhase2Multipart}.
 */
export interface Phase2PushTokens {
  /** ES256 JWS — the `context_token` multipart part. */
  context_token: string;
  /** ES256 JWS — the `events_envelope` multipart part. */
  events_envelope: string;
  /** Canonical UTF-8 bytes — the `events_data` multipart part. */
  events_data: string;
  /** `jti` minted for this push. */
  context_jti: string;
}

// ── next-batch response ────────────────────────────────────────────

/**
 * Body returned by `POST /api/aimer/phase2/<kind>/next-batch` per RFC
 * 0002 §7 "Browser-driven drain loop". The fields are flat (not
 * nested under `tokens`) and all string fields are `null` when the
 * response is empty / paused.
 */
export interface Phase2NextBatchResponse {
  has_more: boolean;
  context_token: string | null;
  events_envelope: string | null;
  events_data: string | null;
  context_jti: string | null;
  /** Relative path on aimer-web. Retained for logging / debugging. */
  aimer_endpoint_path: string | null;
  /**
   * Fully-composed `https://...` URL the browser should POST to. The
   * server composes this from `setup.bridgeUrl + aimer_endpoint_path`
   * so the browser does not need to read the bridge URL itself
   * (which would violate the #440 minimum-disclosure rule).
   */
  aimer_endpoint_url: string | null;
  /** Alias of {@link context_jti}. */
  batch_jti: string | null;
  /**
   * Wire `schema_version` of the envelope. Null on empty / paused.
   * Drives the discriminated ack shape in
   * {@link Phase2PushResult}.
   */
  schema_version: Phase2SchemaVersion | null;
  /**
   * RFC 0002 §7 pause signal — true when the Foundation
   * `opportunistic_enabled` flag is off for this customer/kind. The
   * drain helper surfaces this as `stoppedReason: "paused"`.
   */
  paused?: boolean;
}
