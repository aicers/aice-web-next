import type { AgentDraftInput, AgentInput, AgentKind } from "../types";

/**
 * Agent kinds whose accordion exposes a Configure-Here / Manually
 * switch. Mirrors the registry entries marked `mode: "both"` in
 * `service-registry.ts`. Kept in this React-free module so server-only
 * code (`node-create-update.ts`) can derive `service.set_mode` audit
 * events from persisted state without importing the React-laden
 * registry.
 *
 * `defaultMode` is the Configure-Here / Manually selection the dialog
 * presents when a service is freshly enabled. Today every both-mode
 * service defaults to `configure-here`, so a `service.set_mode` event
 * fires when the persisted draft string flips to/from empty (which is
 * the wire encoding of the user's mode choice).
 */
export interface BothModeAgentDescriptor {
  /** Registry kind (kebab-case, used in audit event details). */
  serviceKind: string;
  /** Wire `Agent.kind` enum value. */
  agentKind: AgentKind;
  /** Default Configure-Here / Manually selection on a fresh enable. */
  defaultMode: "configure-here" | "configure-manually";
}

export const BOTH_MODE_AGENT_KINDS: readonly BothModeAgentDescriptor[] = [
  {
    serviceKind: "sensor",
    agentKind: "SENSOR",
    defaultMode: "configure-here",
  },
  {
    serviceKind: "semi-supervised",
    agentKind: "SEMI_SUPERVISED",
    defaultMode: "configure-here",
  },
  {
    serviceKind: "time-series",
    agentKind: "TIME_SERIES_GENERATOR",
    defaultMode: "configure-here",
  },
];

/**
 * Encode the persisted state of an old (already-applied) agent as a
 * Configure-Here / Manually selection. Old agents carry both `draft`
 * and `config`; the *effective* state is the pending draft when set,
 * else the applied config. An effective string that is empty or null
 * is the wire encoding of Manually mode for both-mode services; any
 * non-empty effective string is Configure-Here. This mirrors the dialog
 * seed in `seedMembershipFromNode`, so an applied-only agent
 * (`draft: null`, `config: "<toml>"`) reads as Configure-Here on both
 * surfaces — which keeps `service.set_mode` derivation honest for the
 * common edit path where Sensor/Hog/Crusher have applied config but no
 * pending draft.
 */
function modeForOldAgent(
  agent: AgentInput,
): "configure-here" | "configure-manually" {
  const effective = agent.draft !== null ? agent.draft : agent.config;
  return effective === null || effective === ""
    ? "configure-manually"
    : "configure-here";
}

/**
 * Encode a new agent draft as a Configure-Here / Manually selection,
 * or `no-pending-draft` when the wire payload carries `draft: null`.
 *
 * `null` and `""` are *not* the same here: `""` is the explicit
 * Manually-mode encoding (the user picked Manually, so there is no
 * TOML to persist), while `null` means the user did not stage any
 * pending draft for this section. The dialog emits `draft: null` on
 * an untouched applied-only agent in a metadata-only save, and on a
 * touched Configure-Here section whose serialised value matches the
 * applied config (the Keep-editing reconcile no-op). In both cases
 * the persisted Configure-Here / Manually selection is unchanged from
 * the applied state, so the audit derivation must report
 * `no-pending-draft` and let the caller suppress the event — treating
 * `null` as Manually would manufacture a phantom here→manually flip
 * for every applied-only agent on a metadata-only save.
 */
function modeForNewAgent(
  agent: AgentDraftInput,
): "configure-here" | "configure-manually" | "no-pending-draft" {
  if (agent.draft === null) return "no-pending-draft";
  return agent.draft === "" ? "configure-manually" : "configure-here";
}

/**
 * Derive the `service.set_mode` audit events implied by the persisted
 * before/after agent state for a single Save. Only both-mode agents
 * contribute events; an event fires when the resulting Configure-Here /
 * Manually selection differs from what was there before.
 *
 * - **Create** (`oldAgents` is `null`): the "before" baseline is the
 *   registry default for each both-mode kind. A new agent persisted in
 *   non-default mode emits one event.
 * - **Update**: an agent absent from one side and present on the other
 *   compares against the registry default for that kind. An agent that
 *   was removed (present in old, absent in new) emits no event — the
 *   user's intent there is "disable membership", not "toggle mode".
 *
 * `(kind, key)` identity matches the Phase Node-9 draft diff. Multiple
 * agents of the same kind on a single node emit at most one event per
 * `(kind, key)` pair that actually changed mode.
 */
export function deriveServiceModeChanges(
  oldAgents: readonly AgentInput[] | null,
  newAgents: readonly AgentDraftInput[],
): { serviceKind: string; mode: "configure-here" | "configure-manually" }[] {
  const out: {
    serviceKind: string;
    mode: "configure-here" | "configure-manually";
  }[] = [];

  for (const desc of BOTH_MODE_AGENT_KINDS) {
    const oldByKey = new Map<string, AgentInput>();
    if (oldAgents) {
      for (const a of oldAgents) {
        if (a.kind === desc.agentKind) oldByKey.set(a.key, a);
      }
    }
    const newByKey = new Map<string, AgentDraftInput>();
    for (const a of newAgents) {
      if (a.kind === desc.agentKind) newByKey.set(a.key, a);
    }

    const keys = new Set<string>([...oldByKey.keys(), ...newByKey.keys()]);
    for (const key of keys) {
      const oldEntry = oldByKey.get(key);
      const newEntry = newByKey.get(key);
      if (!newEntry) {
        // Removed → user disabled membership; not a mode toggle.
        continue;
      }
      const newMode = modeForNewAgent(newEntry);
      if (newMode === "no-pending-draft") {
        // No draft staged for this agent → the persisted selection is
        // whatever was applied, so there's no Configure-Here / Manually
        // toggle to audit. This covers metadata-only saves on
        // applied-only agents (untouched, draft round-trips as null)
        // and Keep-editing reconcile no-ops (touched section collapses
        // back to draft:null because its serialised value matches the
        // applied config).
        continue;
      }
      const oldMode = oldEntry ? modeForOldAgent(oldEntry) : desc.defaultMode;
      if (oldMode !== newMode) {
        out.push({ serviceKind: desc.serviceKind, mode: newMode });
      }
    }
  }

  return out;
}
