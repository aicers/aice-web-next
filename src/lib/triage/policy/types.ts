/**
 * TriagePolicy domain types and Zod schemas for CRUD validation.
 *
 * Lives under the `triage/policy/` namespace per the deprecatability
 * seam in #447 §6 — shared modules must not import from this
 * subdirectory; deletion of the directory removes the feature.
 *
 * The stored shape mirrors review-web's GraphQL `PacketAttrInput` /
 * `ConfidenceInput` / `ResponseInput` enums (lower_snake_case here vs.
 * SCREAMING_SNAKE_CASE in `schemas/review.graphql`) so a row stored
 * under this schema can be passed inline to the future scoring engine
 * input without any kind-by-kind reinterpretation. The byte-array
 * encoding of `first_value` / `second_value` for the GraphQL
 * `[Int!]!` shape happens at that boundary; we keep human-readable
 * strings here for storage and UI editing. See `inline-input.ts` for
 * the enum-name translator and round-trip test.
 *
 * No `server-only` import: this module is also consumed by the form
 * components for client-side input shape parity.
 */

import { z } from "zod";

// ── Enum-like literal sets ────────────────────────────────────────
//
// Each set mirrors the matching GraphQL enum in `schemas/review.graphql`.
// `inline-input.ts` proves the round-trip mapping; if you edit a list
// here, update that translator and its test together.

export const VALUE_KINDS = [
  "string",
  "integer",
  "u_integer",
  "vector",
  "float",
  "ipaddr",
  "bool",
] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export const CMP_KINDS = [
  "less",
  "equal",
  "greater",
  "less_or_equal",
  "greater_or_equal",
  "contain",
  "open_range",
  "close_range",
  "left_open_range",
  "right_open_range",
  "not_equal",
  "not_contain",
  "not_open_range",
  "not_close_range",
  "not_left_open_range",
  "not_right_open_range",
] as const;
export type CmpKind = (typeof CMP_KINDS)[number];

// Range cmp kinds require a non-empty `second_value` so the engine has
// both ends of the interval. Listed here so `validation.ts` and the
// inline-input translator can share a single source of truth.
export const RANGE_CMP_KINDS = new Set<CmpKind>([
  "open_range",
  "close_range",
  "left_open_range",
  "right_open_range",
  "not_open_range",
  "not_close_range",
  "not_left_open_range",
  "not_right_open_range",
]);

export const RESPONSE_KINDS = ["manual", "blacklist", "whitelist"] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

export const RAW_EVENT_KINDS = [
  "bootp",
  "conn",
  "dhcp",
  "dns",
  "ftp",
  "http",
  "kerberos",
  "ldap",
  "log",
  "mqtt",
  "network",
  "nfs",
  "ntlm",
  "radius",
  "rdp",
  "smb",
  "smtp",
  "ssh",
  "tls",
  "window",
] as const;
export type RawEventKind = (typeof RAW_EVENT_KINDS)[number];

export const THREAT_CATEGORIES = [
  "reconnaissance",
  "initial_access",
  "execution",
  "credential_access",
  "discovery",
  "lateral_movement",
  "command_and_control",
  "exfiltration",
  "impact",
  "collection",
  "defense_evasion",
  "persistence",
  "privilege_escalation",
  "resource_development",
] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];

// ── Rule schemas ─────────────────────────────────────────────────

export const packetAttrSchema = z.object({
  raw_event_kind: z.enum(RAW_EVENT_KINDS),
  attr_name: z.string().min(1).max(128),
  value_kind: z.enum(VALUE_KINDS),
  cmp_kind: z.enum(CMP_KINDS),
  first_value: z.string().min(1).max(2048),
  second_value: z.string().max(2048).optional().nullable(),
  weight: z.number().finite().optional().nullable(),
});

export type PacketAttr = z.infer<typeof packetAttrSchema>;

export const confidenceSchema = z.object({
  threat_category: z.enum(THREAT_CATEGORIES),
  threat_kind: z.string().min(1).max(128),
  confidence: z.number().min(0).max(1),
  weight: z.number().finite().optional().nullable(),
});

export type Confidence = z.infer<typeof confidenceSchema>;

export const responseSchema = z.object({
  minimum_score: z.number().finite(),
  kind: z.enum(RESPONSE_KINDS),
});

export type Response = z.infer<typeof responseSchema>;

// ── Policy schemas ───────────────────────────────────────────────

export const policyBaseSchema = z.object({
  name: z.string().min(1).max(255),
  packet_attr: z.array(packetAttrSchema).default([]),
  confidence: z.array(confidenceSchema).default([]),
  response: z.array(responseSchema).default([]),
});

// `.strict()` makes typos like `{ "packet_attrs": [...] }` or
// `{ "respnose": [...] }` fail with 400 rather than be silently
// stripped and persisted as an empty-rule policy. Without it, Zod's
// default behavior would drop the unknown key and the rule-array
// `.default([])` would fill in `[]`, so a POST with a typo'd field
// would succeed with the intended rules missing.
export const policyCreateSchema = policyBaseSchema.strict();

// `policyBaseSchema.partial()` would keep the `.default([])` on the
// rule-array fields, so a PATCH body that omits those keys would still
// resolve to empty arrays and the route would clear every list on
// disk. The update schema therefore re-declares those fields as
// optional (no defaults) so an absent key remains `undefined` and the
// repository skips it.
//
// `.strict()` makes typos like `{ "respnose": [...] }` fail with 400
// rather than parse to `{}` and silently no-op (which would still emit
// a misleading audit row). The route additionally rejects bodies that
// parse to no recognized fields so empty objects don't no-op.
export const policyUpdateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    packet_attr: z.array(packetAttrSchema).optional(),
    confidence: z.array(confidenceSchema).optional(),
    response: z.array(responseSchema).optional(),
  })
  .strict();

export type PolicyCreateInput = z.infer<typeof policyCreateSchema>;
export type PolicyUpdateInput = z.infer<typeof policyUpdateSchema>;

export interface TriagePolicyRow {
  id: number;
  name: string;
  packet_attr: PacketAttr[];
  confidence: Confidence[];
  response: Response[];
  created_at: string;
  updated_at: string;
}
