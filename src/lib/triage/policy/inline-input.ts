/**
 * Translator from the stored TriagePolicy shape to review-web's
 * GraphQL inline policy input enum names.
 *
 * The downstream `eventListWithTriage` path described in #447 §2.1
 * passes a stored policy inline as `PacketAttrInput` /
 * `ConfidenceInput` / `ResponseInput`. The byte-array encoding of
 * `firstValue` / `secondValue` (`[Int!]!` in GraphQL) is owned by the
 * inline-policy boundary that lives outside this `triage/policy/`
 * deprecatability namespace, so this module only handles the enum
 * name translation. The accompanying test
 * (`__tests__/lib/triage/policy/inline-input.test.ts`) iterates every
 * literal in `VALUE_KINDS` / `CMP_KINDS` / `RESPONSE_KINDS` /
 * `THREAT_CATEGORIES` and confirms the mapping is total — i.e. the
 * stored schema cannot persist a kind the GraphQL contract has no
 * name for.
 */

import type {
  CmpKind,
  RawEventKind,
  ResponseKind,
  ThreatCategory,
  ValueKind,
} from "./types";

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
