import {
  agentPendingState,
  type ExternalConfigSnapshot,
  externalServicePendingState,
} from "@/lib/node/pending-state";
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
  | "configured-here-unknown"
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
  // Whether the initial `nodeStatusList` snapshot included this row.
  // Distinct from `ping`: a node that returned a status row but is
  // currently dead has `hasStatus: true` and `ping: null`. Without this
  // separation an all-dead snapshot would leave the alive/dead chips
  // disabled even though the data did arrive.
  hasStatus: boolean;
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
  externalConfigSnapshot: ExternalConfigSnapshot = {},
): NodeRow[] {
  const statusById = new Map(
    statusConn.edges.map((edge) => [edge.node.id, edge.node]),
  );

  return nodeConn.edges.map(({ node }) => {
    const cells = emptyServiceCells();

    for (const agent of node.agents) {
      const column = AGENT_TO_COLUMN[agent.kind];
      if (!column) continue;
      // Comparison model (#333 Decision 9, threaded by #551). Delegate
      // to the shared `agentPendingState` helper so the list row, the
      // detail page, and `nodePendingState` cannot disagree — most
      // notably for delete intent (`draft = null`, `config = Some(...)`)
      // and the applied-manual sentinel (`config = ""`, `draft = null`).
      const hasDraft = agentPendingState(agent) === "pending";
      // `decisions/node-field-catalog.md` §60-63: Configure Manually mode
      // for Piglet / Hog / Crusher is encoded as `draft = Some("")` and,
      // after apply, `config = ""`. Reading the *effective* state (draft
      // when present, otherwise applied) classifies both applied-manual
      // (`config: ""`, `draft: null`) and pending-manual (non-empty
      // applied with `draft: ""`) as the Manual cell — the issue's
      // "Configure Manually services render as Manual" requirement.
      const effective = agent.draft !== null ? agent.draft : agent.config;
      const isManualConfig = effective === null || effective === "";
      const state = ALWAYS_MANUAL_COLUMNS.has(column)
        ? "manual"
        : isManualConfig
          ? "manual"
          : hasDraft
            ? "configured-here-pending"
            : "configured-here";
      cells[column] = { state, hasDraft };
    }

    for (const ext of node.externalServices) {
      const column = EXTERNAL_TO_COLUMN[ext.kind];
      if (!column) continue;
      const pendingState = externalServicePendingState(
        ext,
        externalConfigSnapshot,
      );
      const hasDraft = pendingState === "pending";
      const state: ServiceCellState =
        pendingState === "pending"
          ? "configured-here-pending"
          : pendingState === "unknown"
            ? "configured-here-unknown"
            : "configured-here";
      cells[column] = { state, hasDraft };
    }

    const nameDraftDiffers =
      node.nameDraft !== null && node.nameDraft !== node.name;
    const profileDraftDiffers = profilesDiffer(node.profile, node.profileDraft);
    const anyAgentDraft = node.agents.some(
      (agent) => agentPendingState(agent) === "pending",
    );
    // Match `nodePendingState` semantics: an external whose page-load
    // snapshot is `"unavailable"` contributes to the row-level pending
    // signal regardless of draft intent. For non-delete intent it is
    // an Apply-blocking unknown; for delete intent it is a real pending
    // manager-DB change that stays applyable even with the external
    // down. Counting only `"pending"` would drop the delete-intent case
    // and let the list / detail aggregates disagree for the same node.
    const anyExternalPending = node.externalServices.some(
      (ext) =>
        externalServicePendingState(ext, externalConfigSnapshot) !==
        "not-pending",
    );

    const hasPending =
      nameDraftDiffers ||
      profileDraftDiffers ||
      anyAgentDraft ||
      anyExternalPending;

    const status = statusById.get(node.id);
    const hasStatus = status !== undefined;

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
      hasStatus,
    };
  });
}
