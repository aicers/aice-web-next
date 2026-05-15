/**
 * Phase 2 events-envelope payload schemas (RFC 0002 §6).
 *
 * One Zod schema per `schema_version` literal. The orchestration helper
 * (`buildPhase2Push`) runs the matching schema over the caller-supplied
 * payload before signing, so malformed payloads are refused on the
 * sender side rather than discovered after aimer-web rejects them.
 *
 * The schemas validate the outer shape that the contract pins down
 * (required identifiers, array-of-items structure, discriminator
 * values). The inner per-row content (e.g. baseline `raw_event`,
 * `summary_payload`, `policy_triage_snapshot`) is deliberately left
 * permissive — aimer-web is the canonical validator of inner content
 * and the wire format may grow new fields without bumping the
 * `schema_version`.
 */

import { z } from "zod";

// ── Common primitives ──────────────────────────────────────────────

const nonEmptyString = z.string().min(1);
const decimalString = z
  .string()
  .min(1)
  .regex(/^\d+$/, "must be a decimal-digit string");
const isoTimestamp = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "must be an ISO-8601 timestamp",
  });

const halfOpenWindow = z
  .object({
    from: isoTimestamp,
    to: isoTimestamp,
  })
  .refine((w) => Date.parse(w.from) < Date.parse(w.to), {
    message: "window.from must be strictly before window.to",
  });

// `raw_event` / `summary_payload` / `policy_triage_snapshot` are
// pass-through JSON blobs — keep them open so the sender does not need
// to mirror aimer-web's row-level validation here.
const jsonObject = z.record(z.string(), z.unknown());

// ── phase2.baseline.v1 ─────────────────────────────────────────────

const baselineEvent = z
  .object({
    event_key: decimalString,
    event_time: isoTimestamp,
    kind: nonEmptyString,
  })
  .passthrough();

export const baselineV1Schema = z.object({
  external_key: nonEmptyString,
  source_aice_id: nonEmptyString,
  baseline_version: nonEmptyString,
  events: z.array(baselineEvent),
});

// ── phase2.story.v1 ────────────────────────────────────────────────

const storyMember = z
  .object({
    event_key: decimalString,
    role: nonEmptyString,
  })
  .passthrough();

const storyItem = z
  .object({
    story_id: decimalString,
    story_version: nonEmptyString,
    kind: nonEmptyString,
    members: z.array(storyMember),
  })
  .passthrough();

export const storyV1Schema = z.object({
  external_key: nonEmptyString,
  source_aice_id: nonEmptyString,
  stories: z.array(storyItem),
});

// ── phase2.policy_run.v1 ───────────────────────────────────────────

const policyRunBody = z
  .object({
    run_id: decimalString,
    owner_account_id: nonEmptyString,
    period_start: isoTimestamp,
    period_end: isoTimestamp,
    created_at: isoTimestamp,
    finalized_at: isoTimestamp,
    baseline_version: nonEmptyString,
    policies_fingerprint: nonEmptyString,
    exclusions_fingerprint: nonEmptyString,
    status: z.enum(["ready", "superseded"]),
    replaces: decimalString.optional(),
    summary_stats: jsonObject.optional(),
  })
  .passthrough();

const policyEvent = z
  .object({
    event_key: decimalString,
    event_time: isoTimestamp,
    kind: nonEmptyString,
    policy_triage_snapshot: z.array(jsonObject),
  })
  .passthrough();

export const policyRunV1Schema = z.object({
  external_key: nonEmptyString,
  source_aice_id: nonEmptyString,
  run: policyRunBody,
  events: z.array(policyEvent),
});

// ── phase2.withdraw.v1 ─────────────────────────────────────────────

const withdrawBaselineEvent = z.object({
  kind: z.literal("baseline_event"),
  baseline_version: nonEmptyString,
  event_keys: z.array(decimalString).min(1),
});

const withdrawStory = z.object({
  kind: z.literal("story"),
  story_id: decimalString,
  story_version: nonEmptyString,
});

const withdrawPolicyEvent = z.object({
  kind: z.literal("policy_event"),
  run_id: decimalString,
  event_keys: z.array(decimalString).min(1),
});

const withdrawPolicyRun = z.object({
  kind: z.literal("policy_run"),
  run_id: decimalString,
});

const withdrawItem = z.discriminatedUnion("kind", [
  withdrawBaselineEvent,
  withdrawStory,
  withdrawPolicyEvent,
  withdrawPolicyRun,
]);

export const withdrawV1Schema = z.object({
  external_key: nonEmptyString,
  withdrawals: z.array(withdrawItem).min(1),
});

// ── phase2.refresh_window.v1 / phase2.backfill.v1 ──────────────────
//
// Refresh-window and backfill share an identical payload shape (RFC
// 0002 §6, "Structurally identical to refresh-window"). The two are
// distinguished only by `schema_version` (and audit action on the
// receiver). One Zod schema serves both.

const refreshBaselineWindow = z
  .object({
    external_key: nonEmptyString,
    window: halfOpenWindow.extend({ kind: z.literal("baseline_event") }),
    baseline_version: nonEmptyString,
    events: z.array(baselineEvent),
  })
  .strict();

const refreshStoryWindow = z
  .object({
    external_key: nonEmptyString,
    window: halfOpenWindow.extend({ kind: z.literal("story") }),
    stories: z.array(storyItem),
  })
  .strict();

export const refreshWindowV1Schema = z.union([
  refreshBaselineWindow,
  refreshStoryWindow,
]);

export const backfillV1Schema = refreshWindowV1Schema;

// ── Registry ───────────────────────────────────────────────────────

/**
 * Phase 2 `schema_version` literals. Each value maps to one inner-payload
 * schema and (downstream) one aimer-web endpoint.
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

export const phase2SchemaVersionEnum = z.enum(PHASE2_SCHEMA_VERSIONS);

export const PHASE2_PAYLOAD_SCHEMAS = {
  "phase2.baseline.v1": baselineV1Schema,
  "phase2.story.v1": storyV1Schema,
  "phase2.policy_run.v1": policyRunV1Schema,
  "phase2.withdraw.v1": withdrawV1Schema,
  "phase2.refresh_window.v1": refreshWindowV1Schema,
  "phase2.backfill.v1": backfillV1Schema,
} as const satisfies Record<Phase2SchemaVersion, z.ZodTypeAny>;

export function isPhase2SchemaVersion(
  value: unknown,
): value is Phase2SchemaVersion {
  return (
    typeof value === "string" &&
    (PHASE2_SCHEMA_VERSIONS as readonly string[]).includes(value)
  );
}

export class Phase2PayloadValidationError extends Error {
  readonly schemaVersion: Phase2SchemaVersion;
  readonly issues: z.core.$ZodIssue[];

  constructor(schemaVersion: Phase2SchemaVersion, issues: z.core.$ZodIssue[]) {
    super(
      `Phase 2 payload failed validation for ${schemaVersion}: ${
        issues[0]?.message ?? "unknown error"
      }`,
    );
    this.name = "Phase2PayloadValidationError";
    this.schemaVersion = schemaVersion;
    this.issues = issues;
  }
}

/**
 * Validate `payload` against the schema registered for `schemaVersion`.
 *
 * Throws {@link Phase2PayloadValidationError} on shape failures so the
 * caller can refuse to sign — aimer-web would reject the malformed
 * envelope anyway, but a sender-side check avoids minting (and burning)
 * a fresh `jti` on something we already know is bad.
 */
export function validatePhase2Payload(
  schemaVersion: Phase2SchemaVersion,
  payload: unknown,
): unknown {
  const schema = PHASE2_PAYLOAD_SCHEMAS[schemaVersion];
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Phase2PayloadValidationError(schemaVersion, result.error.issues);
  }
  return result.data;
}
