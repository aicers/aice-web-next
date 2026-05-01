import { listServices } from "@/lib/node/service-registry";
import type {
  AgentDraftInput,
  AgentInput,
  AgentKind,
  ExternalService,
  ExternalServiceInput,
  ExternalServiceKind,
  Node as ManagerNode,
} from "@/lib/node/types";

/**
 * Pure helpers shared by `node-edit-dialog.tsx` and its unit tests.
 *
 * Kept React-free so a Vitest run can pin the dialog's draft-build
 * contract — Phase Node-4 acceptance asks that "editing a node
 * preserves server-side unchanged fields", which is not testable from a
 * static-markup render and would otherwise rely on whole-pipeline e2e
 * runs.
 */

export type ConfigMode = "configure-here" | "configure-manually";

export interface ServiceMembershipState {
  enabled: boolean;
  configMode: ConfigMode;
}

export const PREFIX_BY_REGISTRY_KIND: Record<string, string> = {
  sensor: "sensor",
  "data-store": "dataStore",
  "ti-container": "tiContainer",
  "semi-supervised": "semiSupervised",
  "time-series": "timeSeries",
  unsupervised: "unsupervised",
};

export const AGENT_KIND_BY_REGISTRY_KIND: Record<string, AgentKind> = {
  sensor: "SENSOR",
  unsupervised: "UNSUPERVISED",
  "semi-supervised": "SEMI_SUPERVISED",
  "time-series": "TIME_SERIES_GENERATOR",
};

export const EXTERNAL_KIND_BY_REGISTRY_KIND: Record<
  string,
  ExternalServiceKind
> = {
  "data-store": "DATA_STORE",
  "ti-container": "TI_CONTAINER",
};

export function isAgentRegistryKind(kind: string): boolean {
  return Object.hasOwn(AGENT_KIND_BY_REGISTRY_KIND, kind);
}

export function isExternalRegistryKind(kind: string): boolean {
  return Object.hasOwn(EXTERNAL_KIND_BY_REGISTRY_KIND, kind);
}

export function registryKindForAgentKind(kind: string): string | null {
  for (const [reg, agentKind] of Object.entries(AGENT_KIND_BY_REGISTRY_KIND)) {
    if (agentKind === kind) return reg;
  }
  return null;
}

export function registryKindForExternalKind(kind: string): string | null {
  for (const [reg, extKind] of Object.entries(EXTERNAL_KIND_BY_REGISTRY_KIND)) {
    if (extKind === kind) return reg;
  }
  return null;
}

/**
 * Compute the membership state (enabled + Configure-Here/Manually) and
 * the per-kind draft seed string from a canonical node payload. **The
 * seed reads the agent's effective state — `draft ?? config` —** so an
 * agent with applied config but no pending draft (`draft: null`,
 * `config: "<toml>"`) opens in Configure-Here mode populated with the
 * applied state, not in Manually mode populated with empty defaults.
 *
 * `node-list-types.ts` uses the same `effective = draft ?? config` rule
 * for the list cell renderer, so both surfaces agree on what
 * "applied + no pending draft" looks like.
 *
 * Externals carry only `draft` on the node payload — applied config
 * lives on Giganto / Tivan. The Settings page fetches it server-side
 * via `getGigantoConfig` / `getTivanConfig`, projects it to TOML via
 * `applied-config-toml.ts`, and threads the per-kind map in here as
 * `appliedExternalDrafts`. That way an external with `draft: null` but
 * applied config available opens populated with the applied state, so
 * `dialogSchema.superRefine`'s IP rules don't block a metadata-only
 * Save and the user editing the external section starts from the
 * actual applied baseline rather than blank defaults. When the map
 * carries no entry for a kind (applied fetch failed, never applied,
 * or new membership) the seed falls back to `""` and the dialog
 * shows the registry defaults. Preserving an untouched external
 * `draft` exactly remains the responsibility of
 * {@link buildDraftSubmission} below.
 */
export function seedMembershipFromNode(
  node: ManagerNode | null | undefined,
  appliedExternalDrafts: Readonly<Record<string, string>> = {},
): {
  membership: Record<string, ServiceMembershipState>;
  draftByKind: Record<string, string>;
} {
  const membership: Record<string, ServiceMembershipState> = {};
  const draftByKind: Record<string, string> = {};
  for (const entry of listServices()) {
    membership[entry.kind] = {
      enabled: false,
      configMode:
        entry.mode === "configure-manually"
          ? "configure-manually"
          : "configure-here",
    };
  }
  if (!node) return { membership, draftByKind };
  for (const agent of node.agents) {
    const kind = registryKindForAgentKind(agent.kind);
    if (!kind || !membership[kind]) continue;
    membership[kind].enabled = true;
    const entry = listServices().find((e) => e.kind === kind);
    // Effective state: pending draft when set, else applied config.
    // Mirrors `node-list-types.ts` so the dialog and the cell renderer
    // never disagree on "applied-but-no-draft" semantics.
    const effective = agent.draft !== null ? agent.draft : agent.config;
    if (effective === null || effective === "") {
      // Empty effective string = Manually-mode wire encoding for the
      // both-mode kinds, or a never-configured pure-Manual kind
      // (Unsupervised). Either way, no Configure-Here draft to seed.
      membership[kind].configMode =
        entry?.mode === "configure-here"
          ? "configure-here"
          : "configure-manually";
      draftByKind[kind] = "";
    } else {
      membership[kind].configMode = "configure-here";
      draftByKind[kind] = effective;
    }
  }
  for (const ext of node.externalServices) {
    const kind = registryKindForExternalKind(ext.kind);
    if (!kind || !membership[kind]) continue;
    membership[kind].enabled = true;
    membership[kind].configMode = "configure-here";
    // Pending draft wins; otherwise fall back to the applied-config
    // projection the page passed in; otherwise empty string (registry
    // defaults). Externals don't have a Manually mode, so an empty
    // seed just means "no baseline" rather than encoding a mode flip.
    if (ext.draft !== null) {
      draftByKind[kind] = ext.draft;
    } else if (appliedExternalDrafts[kind]) {
      draftByKind[kind] = appliedExternalDrafts[kind] ?? "";
    } else {
      draftByKind[kind] = "";
    }
  }
  return { membership, draftByKind };
}

/**
 * Shape of `formState.dirtyFields` slice the helper consumes. We accept
 * a partial map to keep the helper independent of the exact RHF version
 * — `dirtyFields[prefix]` is truthy whenever any descendant input is
 * dirty, which is all we need.
 */
export interface DirtyMap {
  membership?: Record<
    string,
    Partial<Record<keyof ServiceMembershipState, unknown>> | undefined
  >;
  [serviceKey: string]: unknown;
}

/**
 * Returns true when the user altered anything that affects this
 * service's submitted shape since the dialog opened — either the
 * membership/mode (`membership.<kind>.*` is dirty) or any field inside
 * the per-service form bag (`<prefix>` itself is dirty).
 */
export function serviceTouchedByUser(
  registryKind: string,
  dirtyFields: DirtyMap,
): boolean {
  const membershipDirty = dirtyFields.membership?.[registryKind];
  if (membershipDirty && Object.keys(membershipDirty).length > 0) return true;
  const prefix = PREFIX_BY_REGISTRY_KIND[registryKind];
  if (!prefix) return false;
  const formDirty = dirtyFields[prefix];
  if (!formDirty) return false;
  if (typeof formDirty === "object") {
    return Object.keys(formDirty).length > 0;
  }
  return true;
}

/**
 * Filter a Hog `active_sensors` selection against the current pool,
 * dropping any ids that are not present. The reconcile path's
 * `form.reset(fresh, { keepDirtyValues: true })` preserves a touched
 * sensor list verbatim — including ids whose sensor agents disappeared
 * from the pool between dialog open and the retry. Without this prune
 * the rendered checklist (driven by the refreshed pool) shows the
 * pruned subset, but `serialiseSemiSupervised` re-emits the stale ids
 * in the explicit `Some([...])` case and the PATCH body carries an
 * `active_sensors` list the user can no longer see — silently selecting
 * sensors against the user's intent.
 *
 * Returns `null` when the input is `undefined`/`null` (no value to
 * prune) or every id in the input is in the pool (nothing changed) —
 * the caller skips `setValue` in that case to avoid spuriously dirtying
 * the form. Otherwise returns the filtered array.
 */
export function pruneSensorsAgainstPool(
  selected: readonly unknown[] | null | undefined,
  pool: readonly string[],
): readonly string[] | null {
  if (!Array.isArray(selected)) return null;
  const validIds = new Set(pool);
  const pruned = (selected as readonly unknown[]).filter(
    (id): id is string => typeof id === "string" && validIds.has(id),
  );
  return pruned.length === selected.length ? null : pruned;
}

interface BuildDraftArgs {
  /** Current form values keyed by canonical prefixes. */
  values: {
    membership: Record<string, ServiceMembershipState>;
    [prefix: string]: unknown;
  };
  /** Subtree of `formState.dirtyFields` reflecting user edits. */
  dirtyFields: DirtyMap;
  /** "create" or "edit" — only edit mode preserves untouched drafts. */
  mode: "create" | "edit";
  /** Original canonical node, present in edit mode. */
  node: ManagerNode | null | undefined;
  /** Sensor pool to thread into per-service serialise calls (Hog). */
  sensorPool: readonly string[];
  /**
   * Applied-config baseline for external services, keyed by registry kind
   * (`data-store`, `ti-container`). Used to detect a touched external
   * section whose serialised value already matches the applied baseline
   * — that case is a no-op and must emit `draft: null` rather than a
   * fresh serialised string, otherwise a Keep-editing reconcile (where
   * the user's form values match what a concurrent writer just applied)
   * persists a phantom pending draft. Optional: when omitted the
   * comparison is skipped and the helper falls back to the prior
   * "always re-serialise on touch" behaviour.
   */
  appliedExternalDrafts?: Readonly<Record<string, string>>;
  /** Registry adapter, injected so unit tests can stub serialise. */
  serialise: (
    registryKind: string,
    values: unknown,
    sensorPool: readonly string[],
  ) => string;
}

/**
 * Build the `(agents, externalServices)` payload the dialog dispatches
 * to `POST /api/nodes` (create) or `PATCH /api/nodes/[id]` (edit).
 *
 * **Preservation contract**: in edit mode, services the user did not
 * touch since the dialog opened are emitted with their *original*
 * wire-level draft string (which may be `null`) — the form values are
 * not reserialised. This protects two failure modes the previous
 * implementation hit:
 *
 *  - An agent persisted as Configure-Here-applied (`draft: null`,
 *    `config: "<toml>"`) used to round-trip to `draft: ""` on a
 *    metadata-only Save, flipping the agent into Manually mode.
 *  - An external service with `draft: null` used to round-trip to a
 *    fresh serialised draft from empty defaults, posting a phantom
 *    pending draft.
 *
 * Touched services serialise from the current form values; new
 * memberships (was disabled, now enabled) always serialise. Disabled
 * memberships (was enabled, now unchecked) drop out of both lists, so
 * `saveDraft` removes them. Create mode always serialises (no
 * preservation baseline).
 */
export function buildDraftSubmission(args: BuildDraftArgs): {
  agents: AgentDraftInput[];
  externalServices: ExternalServiceInput[];
} {
  const {
    values,
    dirtyFields,
    mode,
    node,
    sensorPool,
    appliedExternalDrafts,
    serialise,
  } = args;
  const agents: AgentDraftInput[] = [];
  const externalServices: ExternalServiceInput[] = [];

  for (const entry of listServices()) {
    const state = values.membership[entry.kind];
    if (!state?.enabled) continue;
    const prefix = PREFIX_BY_REGISTRY_KIND[entry.kind];
    if (!prefix) continue;
    const isManual =
      entry.mode === "configure-manually" ||
      state.configMode === "configure-manually";
    const touched = serviceTouchedByUser(entry.kind, dirtyFields);

    if (isAgentRegistryKind(entry.kind)) {
      const agentKind = AGENT_KIND_BY_REGISTRY_KIND[entry.kind];
      if (!agentKind) continue;
      // Preserve the original wire-level draft (incl. `null`) when the
      // user did not touch this service. Without this, a metadata-only
      // edit on a node with applied agents would forcibly persist a
      // fresh draft string for every enabled agent, flipping
      // `Configure-Here-applied` into `Configure-Here-pending` (or
      // worse: into Manually when serialise produced "" for an
      // empty-defaults form).
      const original = node?.agents.find((a) => a.kind === agentKind);
      let draft: string | null;
      if (mode === "edit" && !touched && original) {
        draft = original.draft;
      } else if (isManual) {
        draft = "";
      } else {
        const serialised = serialise(entry.kind, values[prefix], sensorPool);
        // Applied-baseline no-op: a touched Configure-Here section whose
        // serialised value byte-for-byte matches the canonical applied
        // config is a no-op vs. the persisted state. Emit `draft: null`
        // (no pending change) instead of the fresh string so the manager
        // does not record a phantom pending draft and `diffChangedServices`
        // does not emit a spurious `service.draft_save` audit. This
        // covers the Keep-editing reconcile path: the user's edits and
        // a concurrent writer's edits resolve to the same TOML, so once
        // the dialog refreshes the baseline the touched section's
        // re-serialised value equals `original.config` and the save
        // should be a no-op for that section.
        if (
          mode === "edit" &&
          touched &&
          original &&
          original.config !== null &&
          serialised === original.config
        ) {
          draft = null;
        } else {
          draft = serialised;
        }
      }
      // Status is per-service runtime state owned by Phase Node-8, not
      // by this dialog. On create the agent has no prior status, so the
      // catalog rule (decisions/node-field-catalog.md:45) sends
      // `UNKNOWN`. On edit the original status must be preserved
      // verbatim — otherwise a metadata-only Save would overwrite a
      // service that is `ENABLED` / `DISABLED` / `RELOAD_FAILED` with
      // `UNKNOWN`, mutating runtime state through this write surface
      // (and the stale-replay path in `mergeAgentEntry` would prefer
      // the user-supplied `UNKNOWN` over the fresh status because it
      // treats `status` as an editable field).
      const status = mode === "edit" && original ? original.status : "UNKNOWN";
      const agentInput: AgentDraftInput = {
        kind: agentKind,
        key: entry.serviceKey,
        status,
        draft,
      };
      agents.push(agentInput);
    } else if (isExternalRegistryKind(entry.kind)) {
      const extKind = EXTERNAL_KIND_BY_REGISTRY_KIND[entry.kind];
      if (!extKind) continue;
      const original: ExternalService | undefined = node?.externalServices.find(
        (e) => e.kind === extKind,
      );
      let draft: string | null;
      if (mode === "edit" && !touched && original) {
        draft = original.draft;
      } else {
        const serialised = serialise(entry.kind, values[prefix], sensorPool);
        // External applied-baseline no-op (mirrors the agent branch
        // above). Externals don't carry `config` on the Node payload —
        // their applied baseline is fetched server-side from
        // Giganto / Tivan and threaded in here as `appliedExternalDrafts`.
        // When the touched section's serialised value equals that
        // baseline, emit `draft: null` so the save round-trips as a
        // no-op for this section instead of persisting a phantom pending
        // draft.
        const appliedBaseline = appliedExternalDrafts?.[entry.kind];
        if (
          mode === "edit" &&
          touched &&
          original &&
          appliedBaseline !== undefined &&
          serialised === appliedBaseline
        ) {
          draft = null;
        } else {
          draft = serialised;
        }
      }
      // Same rule as agents above: preserve the existing runtime
      // status on edit; only freshly-added services (no `original`)
      // submit `UNKNOWN`.
      const status = mode === "edit" && original ? original.status : "UNKNOWN";
      const extInput: ExternalServiceInput = {
        kind: extKind,
        key: entry.serviceKey,
        status,
        draft,
      };
      externalServices.push(extInput);
    }
  }
  return { agents, externalServices };
}

/**
 * Type guard echo from `node-create-update.ts`. Re-exported here as a
 * convenience for tests that pin the helper's output against the
 * server-side audit derivation.
 */
export type { AgentInput };
