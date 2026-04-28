/**
 * Per-service status mapping for the Node Status surfaces (Phase Node-7,
 * #313). Maps the raw `storedStatus` returned by `nodeStatusList` and
 * the result of an external `status` GraphQL probe into the unified
 * **off / on / idle** UI vocabulary used by the Status tab service
 * cells and the detail-page service cards.
 *
 * The Manager badge is **not** covered here — the Status tab and detail
 * page derive it from `NodeStatus.manager` directly (Phase Node-6).
 * The hook built on top of this module exposes only the six agent /
 * external services and never a `manager` entry.
 *
 * This module is pure (no GraphQL, no I/O) so the same mapping table
 * runs in unit tests, in the polling-driven hook on the client, and in
 * any future SSR consumer.
 */

import type {
  AgentKind,
  AgentStatus,
  ExternalServiceKind,
  ExternalServiceStatus,
} from "./types";

/**
 * Unified UI vocabulary. Every per-service cell on the Status tab and
 * every service card on the detail page renders one of these three
 * states:
 *
 * - `on`   — the service is reporting healthy.
 * - `off`  — the service is disabled, unreachable, or the node is dead.
 * - `idle` — the agent has reported a transient failure that is not a
 *            full off (currently `RELOAD_FAILED`); not used for external
 *            services in v1.
 */
export type ServiceStatus = "off" | "on" | "idle";

/**
 * Per-row column key used by the Status tab and the detail-page
 * service cards. Mirrors `ServiceColumnKey` in `node-list-types.ts`
 * but is duplicated here because that module pulls in server-only
 * types via the connection helpers.
 */
export type ServiceKind =
  | "sensor"
  | "unsupervised"
  | "semiSupervised"
  | "timeSeries"
  | "dataStore"
  | "tiContainer";

/** Compile-time inverse of {@link AGENT_KIND_TO_SERVICE}. */
export type AgentServiceKind =
  | "sensor"
  | "unsupervised"
  | "semiSupervised"
  | "timeSeries";

export type ExternalServiceKindKey = "dataStore" | "tiContainer";

export const AGENT_KIND_TO_SERVICE: Record<AgentKind, AgentServiceKind> = {
  SENSOR: "sensor",
  UNSUPERVISED: "unsupervised",
  SEMI_SUPERVISED: "semiSupervised",
  TIME_SERIES_GENERATOR: "timeSeries",
};

export const EXTERNAL_KIND_TO_SERVICE: Record<
  ExternalServiceKind,
  ExternalServiceKindKey
> = {
  DATA_STORE: "dataStore",
  TI_CONTAINER: "tiContainer",
};

/**
 * Outcome of the most recent external `status` GraphQL probe. The hook
 * keeps one of these per global external service; an `"unknown"`
 * placeholder is exposed before the first probe lands so consumers can
 * distinguish "never checked" from "checked and confirmed off".
 *
 * Once a real probe lands, the value is `"on"` (success) or `"off"`
 * (any error). The mapping function below treats `"unknown"` as `"off"`
 * — the conservative choice for v1 since a node configured to use the
 * external service has no other signal to render.
 */
export type ExternalProbeOutcome = "on" | "off" | "unknown";

/**
 * Map an agent's `storedStatus` to the unified UI vocabulary.
 *
 * Per the Phase Node-7 contract:
 *   - DISABLED      → off
 *   - UNKNOWN       → off
 *   - ENABLED       → on
 *   - RELOAD_FAILED → idle
 */
export function mapAgentStatus(stored: AgentStatus): ServiceStatus {
  switch (stored) {
    case "ENABLED":
      return "on";
    case "RELOAD_FAILED":
      return "idle";
    case "DISABLED":
    case "UNKNOWN":
      return "off";
  }
}

/**
 * Map an external service's probe outcome to the unified UI vocabulary.
 *
 * External services have no `idle` state in v1: the only signal is
 * whether the global probe (Giganto / Tivan `status` GraphQL) succeeded.
 * `"unknown"` is treated as `"off"` so a row never sits indefinitely
 * in a third visual state while waiting for the first probe to land.
 */
export function mapExternalStatus(
  outcome: ExternalProbeOutcome,
): ServiceStatus {
  return outcome === "on" ? "on" : "off";
}

/**
 * The Status tab and detail page also surface external services via the
 * manager-side `storedStatus` enum (returned by `nodeStatusList` on
 * `externalServices[].storedStatus`). v1 ignores this in favour of the
 * live probe, but the helper is kept so a future phase can fall back
 * to the stored value when the live probe is paused (e.g. session goes
 * idle and the polling loop sleeps).
 */
export function mapExternalStoredStatus(
  stored: ExternalServiceStatus,
): ServiceStatus {
  switch (stored) {
    case "ENABLED":
      return "on";
    case "RELOAD_FAILED":
    case "DISABLED":
    case "UNKNOWN":
      return "off";
  }
}

/**
 * Apply the dead-node override: when the node's ping is `null` (the
 * node has not answered the manager's most recent probe), every per-
 * service cell collapses to `"off"` regardless of the raw signal.
 *
 * The Manager column does its own pinging via `NodeStatus.manager`, so
 * this override only applies to the six agent / external services
 * exposed by `useServiceStatus`.
 */
export function applyDeadNodeOverride(
  ping: number | null,
  status: ServiceStatus,
): ServiceStatus {
  return ping === null ? "off" : status;
}

/**
 * Diagnostic raw-signal hint shown in the per-cell tooltip. The hook
 * threads one of these alongside each unified status so the operator
 * can see *why* the cell rendered `off` / `idle` without having to
 * open the detail page.
 *
 * Agent variants mirror `AgentStatus`; the external variants cover the
 * three probe outcomes plus a dead-node carve-out.
 */
export type ServiceStatusReason =
  | { kind: "agent"; storedStatus: AgentStatus }
  | { kind: "external"; outcome: ExternalProbeOutcome }
  | { kind: "deadNode" }
  | { kind: "absent" };

export interface ServiceStatusEntry {
  status: ServiceStatus;
  reason: ServiceStatusReason;
}

/**
 * The six service kinds exposed by {@link useServiceStatus}. Frozen
 * arrays — exported so callers can iterate without re-stating the
 * order. The Status tab uses {@link SERVICE_COLUMN_ORDER} from
 * `node-list-types.ts`, which matches this list 1:1.
 */
export const AGENT_SERVICE_KINDS: readonly AgentServiceKind[] = [
  "sensor",
  "unsupervised",
  "semiSupervised",
  "timeSeries",
] as const;

export const EXTERNAL_SERVICE_KINDS: readonly ExternalServiceKindKey[] = [
  "dataStore",
  "tiContainer",
] as const;

export const ALL_SERVICE_KINDS: readonly ServiceKind[] = [
  ...AGENT_SERVICE_KINDS,
  ...EXTERNAL_SERVICE_KINDS,
] as const;

// ── Composition (pure) ────────────────────────────────────────────

export interface ComposeServiceStatusInput {
  /**
   * Per-node live snapshot from `useNodeStatusPolling`. `null` means
   * the node has never appeared in a poll yet (or has been pruned from
   * the latest poll); the result map collapses to all-`absent` entries.
   */
  live: {
    ping: number | null;
    agents: ReadonlyArray<{ kind: AgentKind; storedStatus: AgentStatus }>;
    externalServices: ReadonlyArray<{ kind: ExternalServiceKind }>;
  } | null;
  /**
   * Most recent probe outcome for each global external service. The
   * mapping uses `"unknown"` (treated as `"off"`) until the first probe
   * lands.
   */
  externalProbes: Record<ExternalServiceKindKey, ExternalProbeOutcome>;
}

export type ServiceStatusEntryMap = Record<ServiceKind, ServiceStatusEntry>;

function emptyEntries(): ServiceStatusEntryMap {
  const absent: ServiceStatusEntry = {
    status: "off",
    reason: { kind: "absent" },
  };
  return {
    sensor: absent,
    unsupervised: absent,
    semiSupervised: absent,
    timeSeries: absent,
    dataStore: absent,
    tiContainer: absent,
  };
}

/**
 * Pure projection of one node's live snapshot + the global external
 * probe outcomes into the per-cell entry map. Lives next to the
 * mapping helpers so unit tests cover the full agent + external +
 * dead-node composition without spinning up React.
 *
 * Behaviour:
 *  - `live === null` → every cell is `absent` (pre-first-poll, or the
 *    node has dropped out of the latest snapshot).
 *  - For each agent in `live.agents`, the matching column carries
 *    `mapAgentStatus(storedStatus)` clamped by the dead-node override.
 *  - For each external service in `live.externalServices`, the matching
 *    column carries `mapExternalStatus(outcome)` clamped by the
 *    dead-node override.
 *  - When `live.ping === null` (dead node), the reason is reported as
 *    `{ kind: "deadNode" }` so the tooltip explains the override.
 */
export function composeServiceStatusEntries(
  input: ComposeServiceStatusInput,
): ServiceStatusEntryMap {
  const entries = emptyEntries();
  const live = input.live;
  if (!live) return entries;
  const ping = live.ping;
  for (const agent of live.agents) {
    const key = AGENT_KIND_TO_SERVICE[agent.kind];
    if (!key) continue;
    const raw = mapAgentStatus(agent.storedStatus);
    const status = applyDeadNodeOverride(ping, raw);
    entries[key] = {
      status,
      reason:
        ping === null
          ? { kind: "deadNode" }
          : { kind: "agent", storedStatus: agent.storedStatus },
    };
  }
  for (const ext of live.externalServices) {
    const key = EXTERNAL_KIND_TO_SERVICE[ext.kind];
    if (!key) continue;
    const outcome = input.externalProbes[key];
    const raw = mapExternalStatus(outcome);
    const status = applyDeadNodeOverride(ping, raw);
    entries[key] = {
      status,
      reason:
        ping === null ? { kind: "deadNode" } : { kind: "external", outcome },
    };
  }
  return entries;
}

export function entriesToStatusMap(
  entries: ServiceStatusEntryMap,
): Record<ServiceKind, ServiceStatus> {
  return {
    sensor: entries.sensor.status,
    unsupervised: entries.unsupervised.status,
    semiSupervised: entries.semiSupervised.status,
    timeSeries: entries.timeSeries.status,
    dataStore: entries.dataStore.status,
    tiContainer: entries.tiContainer.status,
  };
}
