// AUTO-GENERATED FROM schemas/review.graphql. DO NOT EDIT.
//
// Regenerate with: pnpm codegen:detection
//
// The generator walks a curated set of roots (see
// scripts/codegen-detection-types.mjs) and emits every
// transitively-referenced type. CI re-runs generation and
// diffs the result against this file, so a schema bump that
// is not reflected here fails fast.

// ── Scalars ──

/** `DateTime` scalar; REview serializes it as an ISO-8601 string. */
export type DateTimeScalar = string;

/** `StringNumber` scalar; REview serializes 64-bit counts as strings to avoid JavaScript number precision loss. Never cast to `number`. */
export type StringNumberScalar = string;

/** `ID` scalar. */
export type IDScalar = string;

// ── Enums ──

export type FlowKind = "INBOUND" | "OUTBOUND" | "INTERNAL";

export type LearningMethod = "UNSUPERVISED" | "SEMI_SUPERVISED";

export type ThreatCategory =
  | "RECONNAISSANCE"
  | "INITIAL_ACCESS"
  | "EXECUTION"
  | "CREDENTIAL_ACCESS"
  | "DISCOVERY"
  | "LATERAL_MOVEMENT"
  | "COMMAND_AND_CONTROL"
  | "EXFILTRATION"
  | "IMPACT"
  | "COLLECTION"
  | "DEFENSE_EVASION"
  | "PERSISTENCE"
  | "PRIVILEGE_ESCALATION"
  | "RESOURCE_DEVELOPMENT";

export type ThreatLevel = "LOW" | "MEDIUM" | "HIGH";

export type TrafficDirection = "FROM" | "TO";

// ── Inputs ──

export interface EndpointInput {
  direction?: TrafficDirection | null;
  predefined?: IDScalar | null;
  custom?: HostNetworkGroupInput | null;
}

export interface EventListFilterInput {
  start?: DateTimeScalar | null;
  end?: DateTimeScalar | null;
  customers?: IDScalar[] | null;
  endpoints?: EndpointInput[] | null;
  directions?: FlowKind[] | null;
  source?: string | null;
  destination?: string | null;
  keywords?: string[] | null;
  networkTags?: IDScalar[] | null;
  sensors?: IDScalar[] | null;
  os?: IDScalar[] | null;
  devices?: IDScalar[] | null;
  hostnames?: string[] | null;
  userIds?: string[] | null;
  userNames?: string[] | null;
  userDepartments?: string[] | null;
  countries?: string[] | null;
  categories?: (number | null)[] | null;
  levels?: number[] | null;
  kinds?: string[] | null;
  learningMethods?: LearningMethod[] | null;
  confidenceMin?: number | null;
  confidenceMax?: number | null;
  triagePolicies?: IDScalar[] | null;
}

export interface HostNetworkGroupInput {
  hosts: string[];
  networks: string[];
  ranges: IpRangeInput[];
}

export interface IpRangeInput {
  start: string;
  end: string;
}

// ── Interfaces (common fields) ──

export interface EventBase {
  __typename: string;
  time: DateTimeScalar;
  sensor: string;
  confidence: number;
  category: ThreatCategory | null;
  level: ThreatLevel;
  triageScores: TriageScore[] | null;
}

// ── Object types ──

export interface EventConnection {
  pageInfo: PageInfo;
  edges: EventEdge[];
  nodes: EventBase[];
  totalCount: StringNumberScalar;
}

export interface EventEdge {
  node: EventBase;
  cursor: string;
}

export interface PageInfo {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface StringEventCounter {
  values: string[];
  counts: number[];
}

export interface TriageScore {
  policyId: IDScalar;
  score: number;
}

export interface U8EventCounter {
  values: number[];
  counts: number[];
}
