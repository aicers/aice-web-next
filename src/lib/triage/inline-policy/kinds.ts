/**
 * Wire-side enum literal sets for the inline triage policy boundary.
 *
 * Each set mirrors the matching GraphQL enum in `schemas/review.graphql`
 * (lower_snake_case here vs. SCREAMING_SNAKE_CASE in the schema). The
 * round-trip test in `__tests__/lib/triage/inline-policy/graphql-names.test.ts`
 * iterates every literal and asserts the mapping in `./graphql-names.ts`
 * stays total — i.e. the stored schema cannot persist a kind the
 * GraphQL contract has no name for.
 *
 * Lives in `triage/inline-policy/` (the inline-policy seam shared with
 * every inline-policy caller) so the byte encoder can compile without
 * importing from `triage/policy/`. The storage namespace at
 * `src/lib/triage/policy/` re-exports these for its Zod schemas, so
 * `triage/policy/ → triage/inline-policy/` is the only dependency
 * direction the §6 seam allows.
 */

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
// both ends of the interval. Single source of truth shared by the
// encoder (`./encode.ts`) and storage-side semantic validation
// (`src/lib/triage/policy/validation.ts`).
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
