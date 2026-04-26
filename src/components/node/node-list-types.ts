import type {
  AgentKind,
  ExternalServiceKind,
  NodeConnection,
  NodeStatusConnection,
} from "@/lib/node/types";

export type ServiceCellState =
  | "absent"
  | "configured-here"
  | "configured-here-pending"
  | "manual";

export interface ServiceCell {
  state: ServiceCellState;
  hasDraft: boolean;
}

export interface NodeRow {
  id: string;
  appliedName: string;
  draftName: string | null;
  appliedHostname: string;
  draftHostname: string | null;
  appliedDescription: string;
  draftDescription: string | null;
  appliedCustomerId: string | null;
  draftCustomerId: string | null;
  hasPending: boolean;
  serviceCells: Record<ServiceColumnKey, ServiceCell>;
  manager: boolean | null;
  ping: number | null;
}

export type ServiceColumnKey =
  | "sensor"
  | "dataStore"
  | "tiContainer"
  | "unsupervised"
  | "semiSupervised"
  | "timeSeries";

const AGENT_TO_COLUMN: Record<AgentKind, ServiceColumnKey> = {
  SENSOR: "sensor",
  UNSUPERVISED: "unsupervised",
  SEMI_SUPERVISED: "semiSupervised",
  TIME_SERIES_GENERATOR: "timeSeries",
};

const EXTERNAL_TO_COLUMN: Record<ExternalServiceKind, ServiceColumnKey> = {
  DATA_STORE: "dataStore",
  TI_CONTAINER: "tiContainer",
};

export const SERVICE_COLUMN_ORDER: ServiceColumnKey[] = [
  "sensor",
  "dataStore",
  "tiContainer",
  "unsupervised",
  "semiSupervised",
  "timeSeries",
];

const ALWAYS_MANUAL_COLUMNS: ReadonlySet<ServiceColumnKey> = new Set([
  "unsupervised",
]);

function emptyServiceCells(): Record<ServiceColumnKey, ServiceCell> {
  return {
    sensor: { state: "absent", hasDraft: false },
    dataStore: { state: "absent", hasDraft: false },
    tiContainer: { state: "absent", hasDraft: false },
    unsupervised: { state: "absent", hasDraft: false },
    semiSupervised: { state: "absent", hasDraft: false },
    timeSeries: { state: "absent", hasDraft: false },
  };
}

function profilesDiffer(
  applied: { customerId: string; description: string; hostname: string } | null,
  draft: { customerId: string; description: string; hostname: string } | null,
): boolean {
  if (draft === null) return false;
  if (applied === null) return true;
  return (
    applied.customerId !== draft.customerId ||
    applied.description !== draft.description ||
    applied.hostname !== draft.hostname
  );
}

export function buildNodeRows(
  nodeConn: NodeConnection,
  statusConn: NodeStatusConnection,
): NodeRow[] {
  const statusById = new Map(
    statusConn.edges.map((edge) => [edge.node.id, edge.node]),
  );

  return nodeConn.edges.map(({ node }) => {
    const cells = emptyServiceCells();

    for (const agent of node.agents) {
      const column = AGENT_TO_COLUMN[agent.kind];
      if (!column) continue;
      const hasDraft = agent.draft !== null && agent.draft !== agent.config;
      const state = ALWAYS_MANUAL_COLUMNS.has(column)
        ? "manual"
        : agent.config !== null
          ? hasDraft
            ? "configured-here-pending"
            : "configured-here"
          : "manual";
      cells[column] = { state, hasDraft };
    }

    for (const ext of node.externalServices) {
      const column = EXTERNAL_TO_COLUMN[ext.kind];
      if (!column) continue;
      const hasDraft = ext.draft !== null;
      const state = hasDraft ? "configured-here-pending" : "configured-here";
      cells[column] = { state, hasDraft };
    }

    const nameDraftDiffers =
      node.nameDraft !== null && node.nameDraft !== node.name;
    const profileDraftDiffers = profilesDiffer(node.profile, node.profileDraft);
    const anyAgentDraft = node.agents.some(
      (agent) => agent.draft !== null && agent.draft !== agent.config,
    );
    const anyExternalDraft = node.externalServices.some(
      (ext) => ext.draft !== null,
    );

    const hasPending =
      nameDraftDiffers ||
      profileDraftDiffers ||
      anyAgentDraft ||
      anyExternalDraft;

    const status = statusById.get(node.id);

    return {
      id: node.id,
      appliedName: node.name,
      draftName: nameDraftDiffers ? (node.nameDraft as string) : null,
      appliedHostname: node.profile?.hostname ?? "",
      draftHostname:
        profileDraftDiffers &&
        node.profileDraft !== null &&
        node.profileDraft.hostname !== (node.profile?.hostname ?? "")
          ? node.profileDraft.hostname
          : null,
      appliedDescription: node.profile?.description ?? "",
      draftDescription:
        profileDraftDiffers &&
        node.profileDraft !== null &&
        node.profileDraft.description !== (node.profile?.description ?? "")
          ? node.profileDraft.description
          : null,
      appliedCustomerId: node.profile?.customerId ?? null,
      draftCustomerId:
        profileDraftDiffers &&
        node.profileDraft !== null &&
        node.profileDraft.customerId !== (node.profile?.customerId ?? null)
          ? node.profileDraft.customerId
          : null,
      hasPending,
      serviceCells: cells,
      manager: status?.manager ?? null,
      ping: status?.ping ?? null,
    };
  });
}
