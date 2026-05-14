/**
 * Comparison-based pending-detection model for the Node management
 * surface (#333 Decision 9, threaded by #551).
 *
 * `draft` is operator *intent*. Pending state is the *difference*
 * between intent and applied state. The legacy `draft !== null` check
 * conflated the two — once the apply path stops clearing drafts on
 * promotion (Decision 4 verbatim builder), an agent or external whose
 * draft equals its applied state still has `draft != null` and the old
 * check would loop forever.
 *
 *   - Agents: pending iff `agent.draft != agent.config`. Both nullable
 *     — `null != Some(x)` is delete intent, `Some(x) != null` is
 *     brand-new insert, equal values (incl. both `null`) are steady
 *     state.
 *   - Externals: pending iff `manager.draft != external_endpoint.config`.
 *     The endpoint config lives outside the manager DB; pages fetch a
 *     snapshot at load time and pass it through props.
 */

import { diffServiceConfig } from "./diff";
import type { ExternalServiceKind } from "./types";

/**
 * Per-external snapshot of each external endpoint's applied `config`,
 * fetched server-side at page-load. Missing keys mean the page-load
 * did not fetch that kind (no node hosts it). `"unavailable"` records
 * a failed read — the comparison cannot be answered, so the UI shows
 * an explicit unknown / offline state instead of silently treating it
 * as not-pending.
 */
export type ExternalConfigSnapshot = Readonly<
  Partial<Record<ExternalServiceKind, string | "unavailable">>
>;

export type ExternalPendingState = "pending" | "not-pending" | "unknown";

/**
 * Plain object form of `ExternalConfigSnapshot` so server components
 * can build the snapshot incrementally before freezing it as a prop.
 */
export type MutableExternalConfigSnapshot = Partial<
  Record<ExternalServiceKind, string | "unavailable">
>;

export function snapshotApplied(
  snapshot: ExternalConfigSnapshot,
  kind: ExternalServiceKind,
): string | null {
  const entry = snapshot[kind];
  return entry === undefined || entry === "unavailable" ? null : entry;
}

export function snapshotIsUnavailable(
  snapshot: ExternalConfigSnapshot,
  kind: ExternalServiceKind,
): boolean {
  return snapshot[kind] === "unavailable";
}

/**
 * Pending state for an agent on the node payload. Pure string equality
 * — both sides are manager-canonical, so a draft that round-trips the
 * applied value reads as steady state without going through the TOML
 * parser.
 */
export function agentPendingState(agent: {
  config: string | null;
  draft: string | null;
}): "pending" | "not-pending" {
  return agent.draft === agent.config ? "not-pending" : "pending";
}

/**
 * Pending state for an external service. The applied side comes from
 * the page-load `ExternalConfigSnapshot`; comparison is structural via
 * `diffServiceConfig` so a TOML draft whose field order or whitespace
 * differs from the canonical applied serialisation still reads as
 * steady state. `"unavailable"` snapshot entries surface as `unknown`.
 */
export function externalServicePendingState(
  service: { kind: ExternalServiceKind; draft: string | null },
  snapshot: ExternalConfigSnapshot,
): ExternalPendingState {
  if (snapshotIsUnavailable(snapshot, service.kind)) return "unknown";
  const applied = snapshotApplied(snapshot, service.kind);
  if (service.draft === null) {
    return applied === null ? "not-pending" : "pending";
  }
  if (applied === null) return "pending";
  return diffServiceConfig(applied, service.draft).length === 0
    ? "not-pending"
    : "pending";
}

/**
 * Aggregate pending state for a node — name / profile / agents /
 * externals. Returns `"unknown"` when at least one external is
 * unavailable AND no other pending source has fired; if a separately
 * known source (name draft, agent draft, external change) already says
 * pending the aggregate is `"pending"` regardless of the unknown
 * external, because the Apply button still has work to do.
 */
export function nodePendingState(
  node: {
    name: string;
    nameDraft: string | null;
    profile: {
      customerId: string;
      description: string;
      hostname: string;
    } | null;
    profileDraft: {
      customerId: string;
      description: string;
      hostname: string;
    } | null;
    agents: ReadonlyArray<{ config: string | null; draft: string | null }>;
    externalServices: ReadonlyArray<{
      kind: ExternalServiceKind;
      draft: string | null;
    }>;
  },
  snapshot: ExternalConfigSnapshot,
): "pending" | "not-pending" | "unknown" {
  let knownPending = false;
  if (node.nameDraft !== null && node.nameDraft !== node.name) {
    knownPending = true;
  }
  if (!knownPending && node.profileDraft !== null) {
    const a = node.profile;
    const d = node.profileDraft;
    if (
      a === null ||
      a.customerId !== d.customerId ||
      a.description !== d.description ||
      a.hostname !== d.hostname
    ) {
      knownPending = true;
    }
  }
  if (!knownPending) {
    for (const agent of node.agents) {
      if (agentPendingState(agent) === "pending") {
        knownPending = true;
        break;
      }
    }
  }
  let anyUnknown = false;
  for (const ext of node.externalServices) {
    const state = externalServicePendingState(ext, snapshot);
    if (state === "pending") return "pending";
    if (state === "unknown") anyUnknown = true;
  }
  if (knownPending) return "pending";
  return anyUnknown ? "unknown" : "not-pending";
}
