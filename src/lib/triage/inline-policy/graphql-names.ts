/**
 * lower_snake_case → GraphQL SCREAMING_SNAKE_CASE enum-name translator
 * for the inline triage policy boundary.
 *
 * Every kind defined in `./kinds.ts` maps to its review-web GraphQL
 * enum member here. The accompanying test
 * (`__tests__/lib/triage/inline-policy/graphql-names.test.ts`) iterates
 * every literal in `VALUE_KINDS` / `CMP_KINDS` / `RESPONSE_KINDS` /
 * `RAW_EVENT_KINDS` / `THREAT_CATEGORIES` and confirms the mapping is
 * total — i.e. no kind that storage accepts is silently dropped by the
 * inline-policy encoder.
 *
 * Lives in `triage/inline-policy/` so callers other than corpus B can
 * reach the translator without depending on `triage/policy/`. The
 * storage namespace at `src/lib/triage/policy/inline-input.ts`
 * re-exports these for backwards compatibility with internal callers
 * that pre-date the split.
 */

import type {
  CmpKind,
  RawEventKind,
  ResponseKind,
  ThreatCategory,
  ValueKind,
} from "./kinds";

/**
 * Mirror of `enum ValueKind` in `schemas/review.graphql:8095`.
 */
const VALUE_KIND_TO_GRAPHQL: Record<ValueKind, string> = {
  string: "STRING",
  integer: "INTEGER",
  u_integer: "U_INTEGER",
  vector: "VECTOR",
  float: "FLOAT",
  ipaddr: "IP_ADDR",
  bool: "BOOL",
};

/**
 * Mirror of `enum AttrCmpKind` in `schemas/review.graphql:110`.
 */
const CMP_KIND_TO_GRAPHQL: Record<CmpKind, string> = {
  less: "LESS",
  equal: "EQUAL",
  greater: "GREATER",
  less_or_equal: "LESS_OR_EQUAL",
  greater_or_equal: "GREATER_OR_EQUAL",
  contain: "CONTAIN",
  open_range: "OPEN_RANGE",
  close_range: "CLOSE_RANGE",
  left_open_range: "LEFT_OPEN_RANGE",
  right_open_range: "RIGHT_OPEN_RANGE",
  not_equal: "NOT_EQUAL",
  not_contain: "NOT_CONTAIN",
  not_open_range: "NOT_OPEN_RANGE",
  not_close_range: "NOT_CLOSE_RANGE",
  not_left_open_range: "NOT_LEFT_OPEN_RANGE",
  not_right_open_range: "NOT_RIGHT_OPEN_RANGE",
};

/**
 * Mirror of `enum ResponseKind` in `schemas/review.graphql:6876`.
 */
const RESPONSE_KIND_TO_GRAPHQL: Record<ResponseKind, string> = {
  manual: "MANUAL",
  blacklist: "BLACKLIST",
  whitelist: "WHITELIST",
};

/**
 * Mirror of `enum ThreatCategory` in `schemas/review.graphql:7346`.
 */
const THREAT_CATEGORY_TO_GRAPHQL: Record<ThreatCategory, string> = {
  reconnaissance: "RECONNAISSANCE",
  initial_access: "INITIAL_ACCESS",
  execution: "EXECUTION",
  credential_access: "CREDENTIAL_ACCESS",
  discovery: "DISCOVERY",
  lateral_movement: "LATERAL_MOVEMENT",
  command_and_control: "COMMAND_AND_CONTROL",
  exfiltration: "EXFILTRATION",
  impact: "IMPACT",
  collection: "COLLECTION",
  defense_evasion: "DEFENSE_EVASION",
  persistence: "PERSISTENCE",
  privilege_escalation: "PRIVILEGE_ESCALATION",
  resource_development: "RESOURCE_DEVELOPMENT",
};

/**
 * Mirror of `enum RawEventKind` in `schemas/review.graphql:6675`.
 */
const RAW_EVENT_KIND_TO_GRAPHQL: Record<RawEventKind, string> = {
  bootp: "BOOTP",
  conn: "CONN",
  dhcp: "DHCP",
  dns: "DNS",
  ftp: "FTP",
  http: "HTTP",
  kerberos: "KERBEROS",
  ldap: "LDAP",
  log: "LOG",
  mqtt: "MQTT",
  network: "NETWORK",
  nfs: "NFS",
  ntlm: "NTLM",
  radius: "RADIUS",
  rdp: "RDP",
  smb: "SMB",
  smtp: "SMTP",
  ssh: "SSH",
  tls: "TLS",
  window: "WINDOW",
};

export function rawEventKindToGraphql(kind: RawEventKind): string {
  return RAW_EVENT_KIND_TO_GRAPHQL[kind];
}

export function valueKindToGraphql(kind: ValueKind): string {
  return VALUE_KIND_TO_GRAPHQL[kind];
}

export function cmpKindToGraphql(kind: CmpKind): string {
  return CMP_KIND_TO_GRAPHQL[kind];
}

export function responseKindToGraphql(kind: ResponseKind): string {
  return RESPONSE_KIND_TO_GRAPHQL[kind];
}

export function threatCategoryToGraphql(kind: ThreatCategory): string {
  return THREAT_CATEGORY_TO_GRAPHQL[kind];
}
