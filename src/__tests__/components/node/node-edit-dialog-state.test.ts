/**
 * Unit coverage for `node-edit-dialog-state.ts`.
 *
 * Pins the two contracts the Phase Node-4 Round 2 review flagged:
 *
 *  1. `seedMembershipFromNode` reads the *effective* state
 *     (`agent.draft ?? agent.config`), so an applied-only Configure-Here
 *     agent opens in Configure-Here mode populated with the applied
 *     config — not in Manually mode.
 *  2. `buildDraftSubmission` preserves the original wire-level draft
 *     (including `null`) for any service the user did not touch since
 *     the dialog opened. A metadata-only edit on a node with applied
 *     services no longer round-trips to a fresh draft string for every
 *     enabled section.
 */
import { describe, expect, it } from "vitest";

import {
  buildDraftSubmission,
  type DirtyMap,
  pruneSensorsAgainstPool,
  type ServiceMembershipState,
  seedMembershipFromNode,
  serviceTouchedByUser,
} from "@/components/node/node-edit-dialog-state";
import type { Node as ManagerNode } from "@/lib/node/types";

const APPLIED_SENSOR_TOML = '[sensor]\nname = "alpha"\n';
const APPLIED_SEMI_TOML = "[semi]\n";

function buildNode(overrides: Partial<ManagerNode> = {}): ManagerNode {
  return {
    id: "11",
    name: "alpha-node",
    nameDraft: null,
    profile: {
      customerId: "1",
      description: "primary",
      hostname: "alpha.lan",
    },
    profileDraft: null,
    agents: [],
    externalServices: [],
    ...overrides,
  };
}

const stubSerialise = (
  registryKind: string,
  values: unknown,
  _pool: readonly string[],
): string => {
  void values;
  return `<serialised:${registryKind}>`;
};

describe("seedMembershipFromNode", () => {
  it("returns disabled membership for every kind when given no node", () => {
    const { membership, draftByKind } = seedMembershipFromNode(null);
    expect(membership.sensor).toEqual({
      enabled: false,
      configMode: "configure-here",
    });
    expect(membership.unsupervised).toEqual({
      enabled: false,
      configMode: "configure-manually",
    });
    expect(draftByKind).toEqual({});
  });

  it("seeds an applied-only Configure-Here agent in Configure-Here mode with the effective config", () => {
    // `config: "<toml>"`, `draft: null` is the wire shape for "applied,
    // no pending change". The dialog must open in Configure-Here mode
    // populated with the applied config — opening in Manually mode and
    // saving used to flip `draft = null` to `draft = ""`, persisting a
    // bogus mode change after the user simply edited metadata.
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: APPLIED_SENSOR_TOML,
          draft: null,
        },
      ],
    });
    const { membership, draftByKind } = seedMembershipFromNode(node);
    expect(membership.sensor).toEqual({
      enabled: true,
      configMode: "configure-here",
    });
    expect(draftByKind.sensor).toBe(APPLIED_SENSOR_TOML);
  });

  it("seeds an applied-only Manually agent in Manually mode", () => {
    // `config: ""`, `draft: null` is the wire shape for "applied as
    // Manually, no pending change". Effective is "" → Manually mode.
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: "",
          draft: null,
        },
      ],
    });
    const { membership, draftByKind } = seedMembershipFromNode(node);
    expect(membership.sensor).toEqual({
      enabled: true,
      configMode: "configure-manually",
    });
    expect(draftByKind.sensor).toBe("");
  });

  it("prefers the pending draft over applied config when both are present", () => {
    // `config: "<toml-applied>"`, `draft: "<toml-pending>"`: effective
    // is the pending draft, so the form opens populated with what the
    // user previously saved — not the applied baseline.
    const pending = '[sensor]\nname = "alpha-pending"\n';
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: APPLIED_SENSOR_TOML,
          draft: pending,
        },
      ],
    });
    const { draftByKind } = seedMembershipFromNode(node);
    expect(draftByKind.sensor).toBe(pending);
  });

  it("seeds an external service from its draft (applied config is not on the payload)", () => {
    const node = buildNode({
      externalServices: [
        {
          node: 11,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: "[giganto]\n",
        },
      ],
    });
    const { membership, draftByKind } = seedMembershipFromNode(node);
    expect(membership["data-store"]).toEqual({
      enabled: true,
      configMode: "configure-here",
    });
    expect(draftByKind["data-store"]).toBe("[giganto]\n");
  });

  it("falls back to the page-supplied applied draft when an external has no pending draft", () => {
    // Reviewer's Round 3 case: the node hosts Data Store with
    // `draft: null` and the Settings page projected the applied
    // GigantoConfig to TOML and passed it in. The dialog must seed
    // from that projection so the Configure-Here form opens populated
    // with real applied state — not blank-IP defaults that would
    // block any save under `dialogSchema.superRefine`'s IP rule.
    const node = buildNode({
      externalServices: [
        {
          node: 11,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: null,
        },
      ],
    });
    const { draftByKind } = seedMembershipFromNode(node, {
      "data-store": 'ingest_srv_addr = "1.2.3.4:38370"\n',
    });
    expect(draftByKind["data-store"]).toBe(
      'ingest_srv_addr = "1.2.3.4:38370"\n',
    );
  });

  it("prefers a pending external draft over the page-supplied applied projection", () => {
    const node = buildNode({
      externalServices: [
        {
          node: 11,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: "[pending-draft]\n",
        },
      ],
    });
    const { draftByKind } = seedMembershipFromNode(node, {
      "data-store": "[applied-projection]\n",
    });
    expect(draftByKind["data-store"]).toBe("[pending-draft]\n");
  });

  it("falls back to empty when neither the draft nor an applied projection is available", () => {
    // Applied fetch failed (Giganto offline) — the dialog still opens,
    // and the form falls back to registry defaults. The user can
    // re-enter values explicitly; preserve-untouched in
    // `buildDraftSubmission` keeps an unchanged section's draft `null`
    // on Save so this fallback never silently posts a phantom draft.
    const node = buildNode({
      externalServices: [
        {
          node: 11,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: null,
        },
      ],
    });
    const { draftByKind } = seedMembershipFromNode(node, {});
    expect(draftByKind["data-store"]).toBe("");
  });
});

describe("serviceTouchedByUser", () => {
  it("returns false when neither membership nor the form bag is dirty", () => {
    expect(serviceTouchedByUser("sensor", {})).toBe(false);
  });

  it("returns true when membership.<kind> has any dirty descendant", () => {
    const dirty: DirtyMap = { membership: { sensor: { enabled: true } } };
    expect(serviceTouchedByUser("sensor", dirty)).toBe(true);
  });

  it("returns true when the per-service form bag is dirty", () => {
    const dirty: DirtyMap = {
      // RHF marks the prefix truthy whenever any descendant input
      // changed. We accept anything truthy under the prefix to keep
      // the helper version-agnostic.
      sensor: { receiveIp: true } as unknown,
    };
    expect(serviceTouchedByUser("sensor", dirty)).toBe(true);
  });

  it("returns false when RHF leaves an empty object under the form bag", () => {
    const dirty: DirtyMap = {
      sensor: {} as unknown,
    };
    expect(serviceTouchedByUser("sensor", dirty)).toBe(false);
  });
});

describe("buildDraftSubmission", () => {
  function membershipFor(
    overrides: Record<string, ServiceMembershipState> = {},
  ): Record<string, ServiceMembershipState> {
    const base: Record<string, ServiceMembershipState> = {
      sensor: { enabled: false, configMode: "configure-here" },
      "data-store": { enabled: false, configMode: "configure-here" },
      "ti-container": { enabled: false, configMode: "configure-here" },
      "semi-supervised": { enabled: false, configMode: "configure-here" },
      "time-series": { enabled: false, configMode: "configure-here" },
      unsupervised: { enabled: false, configMode: "configure-manually" },
    };
    return { ...base, ...overrides };
  }

  it("preserves an untouched applied agent's original draft (null) on edit", () => {
    // The reviewer's central failure case: a metadata-only edit on a
    // node with applied Sensor config used to dispatch
    // `draft: ""` (blank serialisation of empty defaults), flipping
    // the agent into Manually mode. With the preserve-untouched
    // contract the helper emits the original `draft: null` exactly.
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: APPLIED_SENSOR_TOML,
          draft: null,
        },
      ],
    });
    const { agents } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          sensor: { enabled: true, configMode: "configure-here" },
        }),
        sensor: { name: "alpha" },
      },
      dirtyFields: {},
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents).toEqual([
      {
        kind: "SENSOR",
        key: "piglet",
        // Edit must preserve the original runtime status — overwriting
        // with `UNKNOWN` would mutate Phase Node-8's per-service runtime
        // state through this dialog's write surface (see
        // `decisions/node-permissions.md`).
        status: "ENABLED",
        draft: null,
      },
    ]);
  });

  it("preserves an untouched external service's original draft on edit", () => {
    // External services do not carry applied config on the Node
    // payload, so a zero-touch edit Save would otherwise post a fresh
    // serialised draft from empty defaults — a phantom pending draft
    // the user never authored.
    const node = buildNode({
      externalServices: [
        {
          node: 11,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: null,
        },
      ],
    });
    const { externalServices } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          "data-store": { enabled: true, configMode: "configure-here" },
        }),
        dataStore: {},
      },
      dirtyFields: {},
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(externalServices).toEqual([
      {
        kind: "DATA_STORE",
        key: "giganto",
        // Same preserve-original-status rule as agents above.
        status: "ENABLED",
        draft: null,
      },
    ]);
  });

  it("re-serialises a touched service from the current form values", () => {
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: APPLIED_SENSOR_TOML,
          draft: null,
        },
      ],
    });
    const { agents } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          sensor: { enabled: true, configMode: "configure-here" },
        }),
        sensor: { name: "alpha" },
      },
      dirtyFields: {
        sensor: { name: true } as unknown,
      },
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents[0]?.draft).toBe("<serialised:sensor>");
  });

  it('emits the wire encoding ("") when the user toggles Configure-Here → Manually', () => {
    // Mode flip is membership-dirty → touched → manual branch fires.
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: APPLIED_SENSOR_TOML,
          draft: null,
        },
      ],
    });
    const { agents } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          sensor: { enabled: true, configMode: "configure-manually" },
        }),
        sensor: {},
      },
      dirtyFields: {
        membership: { sensor: { configMode: true } },
      },
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents[0]?.draft).toBe("");
  });

  it("omits a service the user disabled", () => {
    // membership.enabled = false → service skipped entirely. Phase
    // Node-9's `saveDraft` removes the agent / external when it falls
    // out of the submitted list.
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: APPLIED_SENSOR_TOML,
          draft: null,
        },
      ],
    });
    const { agents } = buildDraftSubmission({
      values: {
        membership: membershipFor(),
        sensor: {},
      },
      dirtyFields: {
        membership: { sensor: { enabled: true } },
      },
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents).toEqual([]);
  });

  it("always serialises in create mode, regardless of dirty state", () => {
    const { agents } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          sensor: { enabled: true, configMode: "configure-here" },
        }),
        sensor: { name: "alpha" },
      },
      dirtyFields: {},
      mode: "create",
      node: null,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents[0]?.draft).toBe("<serialised:sensor>");
  });

  it("preserves the original runtime status on edit for every status variant", () => {
    // Round 6 reviewer's case: a metadata-only Save was emitting
    // `status: "UNKNOWN"` for every enabled service, overwriting
    // `ENABLED` / `DISABLED` / `RELOAD_FAILED` — and the stale-replay
    // path in `mergeAgentEntry` would then *prefer* the user-supplied
    // `UNKNOWN` over the fresh status because it treats `status` as an
    // editable field. Pin that the dialog forwards the original status
    // verbatim regardless of which non-UNKNOWN value it had.
    for (const status of ["ENABLED", "DISABLED", "RELOAD_FAILED"] as const) {
      const node = buildNode({
        agents: [
          {
            node: 11,
            key: "alpha-sensor",
            kind: "SENSOR",
            status,
            config: APPLIED_SENSOR_TOML,
            draft: null,
          },
        ],
        externalServices: [
          {
            node: 11,
            key: "alpha-data-store",
            kind: "DATA_STORE",
            status,
            draft: null,
          },
        ],
      });
      const { agents, externalServices } = buildDraftSubmission({
        values: {
          membership: membershipFor({
            sensor: { enabled: true, configMode: "configure-here" },
            "data-store": { enabled: true, configMode: "configure-here" },
          }),
          sensor: {},
          dataStore: {},
        },
        dirtyFields: {},
        mode: "edit",
        node,
        sensorPool: [],
        serialise: stubSerialise,
      });
      expect(agents[0]?.status).toBe(status);
      expect(externalServices[0]?.status).toBe(status);
    }
  });

  it("uses UNKNOWN for a freshly-added service in edit mode (no prior runtime state)", () => {
    // A new membership the user just enabled has no `original` to
    // copy from, so the catalog rule applies and the wire status is
    // `UNKNOWN`. This also covers the create path implicitly.
    const node = buildNode({ agents: [], externalServices: [] });
    const { agents, externalServices } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          sensor: { enabled: true, configMode: "configure-here" },
          "data-store": { enabled: true, configMode: "configure-here" },
        }),
        sensor: { name: "alpha" },
        dataStore: {},
      },
      dirtyFields: {
        membership: {
          sensor: { enabled: true },
          "data-store": { enabled: true },
        },
      },
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents[0]?.status).toBe("UNKNOWN");
    expect(externalServices[0]?.status).toBe("UNKNOWN");
  });

  it("emits the serialised baseline for a touched agent whose form value round-trips to the applied config", async () => {
    // Round 7 reviewer's #551 follow-up: under #333 Decision 9 the
    // steady-state encoding is `draft == config`, not `draft == null`.
    // A touched section that re-serialises to the applied config must
    // therefore land as `draft = serialised` so the post-save node is
    // steady under `agentPendingState`. Emitting `null` here would be
    // delete intent against a non-null config and a subsequent Apply
    // would `MANAGER_DB`-delete the agent instead of being a no-op.
    const applied = "<serialised:sensor>";
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-sensor",
          kind: "SENSOR",
          status: "ENABLED",
          config: applied,
          draft: null,
        },
      ],
    });
    const { agents } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          sensor: { enabled: true, configMode: "configure-here" },
        }),
        sensor: { name: "alpha" },
      },
      // Touched: any dirty bit on the section's bag flips
      // `serviceTouchedByUser` to true.
      dirtyFields: {
        sensor: { name: true } as unknown,
      },
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents[0]?.draft).toBe(applied);
    // Status preservation contract still holds.
    expect(agents[0]?.status).toBe("ENABLED");

    // Regression: post-save state is steady under the comparison rule
    // and does not plan a delete-style manager-only apply.
    const { agentPendingState } = await import("@/lib/node/pending-state");
    expect(
      agentPendingState({ config: applied, draft: agents[0]?.draft ?? null }),
    ).toBe("not-pending");
  });

  it("emits the serialised baseline for a touched external service whose form value round-trips to the applied baseline", async () => {
    // Round 7 reviewer's #551 follow-up (external mirror of the agent
    // case above). External steady state is
    // `manager.draft == endpoint.config`, so a touched section whose
    // serialised value equals the page-load baseline must persist that
    // value as the draft — not `null`. `null` against a non-null
    // endpoint config is delete intent and
    // `buildPlannedDispatches` would plan a `MANAGER_DB`-only removal.
    const applied = "<serialised:data-store>";
    const node = buildNode({
      externalServices: [
        {
          node: 11,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: null,
        },
      ],
    });
    const { externalServices } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          "data-store": { enabled: true, configMode: "configure-here" },
        }),
        dataStore: { ingestIp: "10.0.0.1" },
      },
      dirtyFields: {
        dataStore: { ingestIp: true } as unknown,
      },
      mode: "edit",
      node,
      sensorPool: [],
      appliedExternalDrafts: { "data-store": applied },
      serialise: stubSerialise,
    });
    expect(externalServices[0]?.draft).toBe(applied);
    expect(externalServices[0]?.status).toBe("ENABLED");

    // Regression: against the page-load snapshot recording the same
    // applied baseline, the post-save external reads as steady — not
    // as a delete-intent dispatch waiting for the next Apply. Use a
    // valid TOML scalar so `diffServiceConfig` round-trips through
    // `fromToml`.
    const baselineToml = 'ingest_ip = "10.0.0.1"\n';
    const { externalServices: externalServicesToml } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          "data-store": { enabled: true, configMode: "configure-here" },
        }),
        dataStore: {},
      },
      dirtyFields: {
        dataStore: { ingestIp: true } as unknown,
      },
      mode: "edit",
      node,
      sensorPool: [],
      serialise: (_kind, _values, _pool) => baselineToml,
    });
    const { externalServicePendingState } = await import(
      "@/lib/node/pending-state"
    );
    expect(
      externalServicePendingState(
        {
          kind: "DATA_STORE",
          draft: externalServicesToml[0]?.draft ?? null,
        },
        { DATA_STORE: baselineToml },
      ),
    ).toBe("not-pending");
  });

  it("seeds a pending Configure-Here agent and preserves its draft when untouched", () => {
    // Round-trip stability: opening edit on a node with a pending
    // Configure-Here draft, then saving without touching, must leave
    // the persisted draft byte-for-byte unchanged.
    const pending = '[semi]\nactive_sensors = ["a"]\n';
    const node = buildNode({
      agents: [
        {
          node: 11,
          key: "alpha-semi",
          kind: "SEMI_SUPERVISED",
          status: "ENABLED",
          config: APPLIED_SEMI_TOML,
          draft: pending,
        },
      ],
    });
    const { agents } = buildDraftSubmission({
      values: {
        membership: membershipFor({
          "semi-supervised": { enabled: true, configMode: "configure-here" },
        }),
        semiSupervised: {},
      },
      dirtyFields: {},
      mode: "edit",
      node,
      sensorPool: [],
      serialise: stubSerialise,
    });
    expect(agents[0]?.draft).toBe(pending);
  });
});

describe("pruneSensorsAgainstPool", () => {
  it("drops Hog active_sensors selections missing from the refreshed pool", () => {
    // Round 19 reviewer's stale-hidden-state case: Keep editing
    // preserves the dirty `semiSupervised.sensors` array verbatim, so a
    // selected sensor id that disappeared from the pool between dialog
    // open and the retry stays in form state but vanishes from the UI.
    // The next save would then re-emit it via `serialiseSemiSupervised`'s
    // explicit `Some([...])` branch. The prune drops ids no longer in
    // the pool so the wire matches what the user is looking at.
    expect(pruneSensorsAgainstPool(["a", "b"], ["a"])).toEqual(["a"]);
    expect(pruneSensorsAgainstPool(["b"], ["a"])).toEqual([]);
  });

  it("returns null when every selected id is still in the pool (caller skips setValue)", () => {
    // The helper signals "no change" with `null`. The dialog uses that
    // to avoid a spurious `setValue` and the dirty flag it would attach.
    expect(pruneSensorsAgainstPool(["a", "b"], ["a", "b", "c"])).toBeNull();
    expect(pruneSensorsAgainstPool([], ["a"])).toBeNull();
    expect(pruneSensorsAgainstPool(undefined, ["a"])).toBeNull();
    expect(pruneSensorsAgainstPool(null, ["a"])).toBeNull();
  });

  it("filters out non-string ids defensively", () => {
    // `form.getValues` is loosely typed; if a non-string slips through
    // it must not be forwarded to the wire as if it were a sensor id.
    expect(
      pruneSensorsAgainstPool(["a", 1, null, undefined] as readonly unknown[], [
        "a",
      ]),
    ).toEqual(["a"]);
  });
});
