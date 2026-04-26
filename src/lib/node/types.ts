import "server-only";

/**
 * Hand-written types for the Node management dispatch layer. Phase
 * Node-1's permission table and the umbrella issue (#306) describe the
 * shape; the vendored `schemas/review.graphql`, `schemas/giganto.graphql`,
 * and `schemas/tivan.graphql` are the source of truth — every type
 * below mirrors a section of one of those SDLs.
 *
 * If we need codegen across the three schemas later, these definitions
 * will be the migration target.
 */

// ── Manager (review-web) types ─────────────────────────────────────

export type AgentKind =
  | "UNSUPERVISED"
  | "SENSOR"
  | "SEMI_SUPERVISED"
  | "TIME_SERIES_GENERATOR";

export type AgentStatus = "DISABLED" | "ENABLED" | "RELOAD_FAILED" | "UNKNOWN";

export type ExternalServiceKind = "DATA_STORE" | "TI_CONTAINER";

export type ExternalServiceStatus =
  | "DISABLED"
  | "ENABLED"
  | "RELOAD_FAILED"
  | "UNKNOWN";

export interface NodeProfile {
  customerId: string;
  description: string;
  hostname: string;
}

export interface Agent {
  node: number;
  key: string;
  kind: AgentKind;
  status: AgentStatus;
  config: string | null;
  draft: string | null;
}

export interface ExternalService {
  node: number;
  key: string;
  kind: ExternalServiceKind;
  status: ExternalServiceStatus;
  draft: string | null;
}

export interface Node {
  id: string;
  name: string;
  nameDraft: string | null;
  profile: NodeProfile | null;
  profileDraft: NodeProfile | null;
  agents: Agent[];
  externalServices: ExternalService[];
}

export interface AgentSnapshot {
  kind: AgentKind;
  storedStatus: AgentStatus;
  config: string | null;
  draft: string | null;
}

export interface ExternalServiceSnapshot {
  kind: ExternalServiceKind;
  storedStatus: ExternalServiceStatus;
  draft: string | null;
}

export interface NodeStatus {
  id: string;
  name: string;
  nameDraft: string | null;
  profile: NodeProfile | null;
  profileDraft: NodeProfile | null;
  cpuUsage: number | null;
  totalMemory: string | null;
  usedMemory: string | null;
  totalDiskSpace: string | null;
  usedDiskSpace: string | null;
  manager: boolean;
  agents: AgentSnapshot[];
  externalServices: ExternalServiceSnapshot[];
  ping: number | null;
}

export interface PageInfo {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface NodeEdge {
  node: Node;
}

export interface NodeStatusEdge {
  node: NodeStatus;
}

export interface NodeConnection {
  edges: NodeEdge[];
  pageInfo: PageInfo;
  totalCount: string;
}

export interface NodeStatusConnection {
  edges: NodeStatusEdge[];
  pageInfo: PageInfo;
  totalCount: string;
}

export interface AgentDraftInput {
  kind: AgentKind;
  key: string;
  status: AgentStatus;
  draft: string | null;
}

export interface AgentInput {
  kind: AgentKind;
  key: string;
  status: AgentStatus;
  config: string | null;
  draft: string | null;
}

export interface ExternalServiceInput {
  kind: ExternalServiceKind;
  key: string;
  status: ExternalServiceStatus;
  draft: string | null;
}

export interface NodeProfileInput {
  customerId: string;
  description: string;
  hostname: string;
}

export interface NodeInput {
  name: string;
  nameDraft: string | null;
  profile: NodeProfileInput | null;
  profileDraft: NodeProfileInput | null;
  agents: AgentInput[];
  externalServices: ExternalServiceInput[];
}

export interface NodeDraftInput {
  nameDraft: string;
  profileDraft: NodeProfileInput | null;
  agents: AgentDraftInput[] | null;
  externalServices: ExternalServiceInput[] | null;
}

// ── External-service types (Giganto + Tivan, the small surface
// the Node layer dispatches today) ─────────────────────────────────

export interface ServiceStatus {
  name: string;
  cpuUsage: number;
  totalMemory: number;
  usedMemory: number;
  diskUsedBytes: number;
  diskAvailableBytes: number;
}

export interface GigantoConfig {
  ingestSrvAddr: string;
  publishSrvAddr: string;
  graphqlSrvAddr: string;
  retention: string;
  exportDir: string;
  dataDir: string;
  maxOpenFiles: number;
  maxMbOfLevelBase: string;
  numOfThread: number;
  maxSubcompactions: string;
  ackTransmission: number;
}

export interface TivanConfig {
  graphqlSrvAddr: string;
  translateMitre: string;
  excelData: string | null;
  originMitre: string | null;
}

// ── Operation result envelopes ────────────────────────────────────

export interface NodeListResult {
  nodeList: NodeConnection;
}

export interface NodeDetailResult {
  node: Node;
}

export interface NodeStatusListResult {
  nodeStatusList: NodeStatusConnection;
}

export interface InsertNodeResult {
  insertNode: string;
}

export interface UpdateNodeDraftResult {
  updateNodeDraft: string;
}

export interface RemoveNodesResult {
  removeNodes: string[];
}

export interface ApplyNodeResult {
  applyNode: string;
}

export interface NodeRebootResult {
  nodeReboot: string;
}

export interface NodeShutdownResult {
  nodeShutdown: string;
}

export interface GigantoStatusResult {
  status: ServiceStatus;
}

export interface GigantoConfigResult {
  config: GigantoConfig;
}

export interface GigantoUpdateConfigResult {
  updateConfig: GigantoConfig;
}

export interface TivanStatusResult {
  status: ServiceStatus;
}

export interface TivanConfigResult {
  config: TivanConfig;
}

export interface TivanUpdateConfigResult {
  updateConfig: TivanConfig;
}
