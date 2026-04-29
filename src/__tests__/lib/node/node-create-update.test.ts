import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type { NodeDraftInput, NodeInput } from "@/lib/node/types";

// Captured stale-conflict fixture; shared with `draft.test.ts` so the
// replay-recogniser stays in lockstep with `conflict-patterns.ts`.
const STALE_CONFLICT_FIXTURE = (() => {
  const raw = readFileSync(
    path.join(
      process.cwd(),
      "src",
      "__tests__",
      "lib",
      "node",
      "fixtures",
      "conflict-messages",
      "stale-conflict.txt",
    ),
    "utf8",
  );
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
})();

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/graphql/client", () => ({
  graphqlRequest: mockGraphqlRequest,
}));

vi.mock("@/lib/graphql/external-client", () => ({
  gigantoClient: vi.fn(),
  tivanClient: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

import {
  createNodeWithAudit,
  diffMetadataFields,
  updateNodeWithAudit,
} from "@/lib/node/node-create-update";

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Tenant Administrator"],
    tokenVersion: 1,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: 0,
    exp: 0,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "test",
    sessionBrowserFingerprint: "test",
    needsReauth: false,
    sessionCreatedAt: new Date(0),
    sessionLastActiveAt: new Date(0),
    ...overrides,
  } as AuthSession;
}

function makeOldNode(overrides: Partial<NodeInput> = {}): NodeInput {
  return {
    name: "node-alpha",
    nameDraft: null,
    profile: { customerId: "1", description: "", hostname: "alpha.local" },
    profileDraft: null,
    agents: [],
    externalServices: [],
    ...overrides,
  };
}

function makeNewDraft(overrides: Partial<NodeDraftInput> = {}): NodeDraftInput {
  return {
    nameDraft: "node-alpha",
    profileDraft: {
      customerId: "1",
      description: "",
      hostname: "alpha.local",
    },
    agents: null,
    externalServices: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockHasPermission.mockReset();
  mockResolveEffectiveCustomerIds.mockReset();
  mockGraphqlRequest.mockReset();
  mockAuditRecord.mockReset();
  mockHasPermission.mockResolvedValue(true);
  mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
});

describe("createNodeWithAudit", () => {
  it("emits node.create on successful create", async () => {
    mockGraphqlRequest.mockResolvedValueOnce({ insertNode: "node-42" });

    const id = await createNodeWithAudit(makeSession(), {
      name: "node-alpha",
      customerId: "1",
      description: "",
      hostname: "alpha.local",
      agents: [],
      externalServices: [],
    });

    expect(id).toBe("node-42");
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord.mock.calls[0]?.[0]).toMatchObject({
      action: "node.create",
      target: "node",
      targetId: "node-42",
      details: { name: "node-alpha", hostname: "alpha.local", customerId: "1" },
      customerId: 1,
    });
  });

  it("derives a service.set_mode entry from a manually-mode agent on create", async () => {
    // Server-side derivation: a both-mode agent (Sensor) defaults to
    // `configure-here`, so a persisted draft of "" encodes the user
    // having toggled to Manually — the BFF emits one
    // `service.set_mode` event without the request body carrying any
    // client-supplied mode diff.
    mockGraphqlRequest.mockResolvedValueOnce({ insertNode: "node-43" });
    await createNodeWithAudit(makeSession(), {
      name: "node-alpha",
      customerId: "1",
      description: "",
      hostname: "alpha.local",
      agents: [{ kind: "SENSOR", key: "piglet", status: "UNKNOWN", draft: "" }],
      externalServices: [],
    });
    expect(mockAuditRecord).toHaveBeenCalledTimes(2);
    expect(mockAuditRecord.mock.calls[1]?.[0]).toMatchObject({
      action: "service.set_mode",
      target: "service",
      targetId: "node-43:sensor",
      details: {
        serviceKind: "sensor",
        mode: "configure-manually",
        nodeId: "node-43",
      },
    });
  });

  it("emits no service.set_mode when create persists a both-mode agent in default Configure-Here mode", async () => {
    // Default mode for both-mode services is `configure-here`, so a
    // non-empty draft on a fresh create matches the default and emits
    // no `service.set_mode` row — only `node.create`.
    mockGraphqlRequest.mockResolvedValueOnce({ insertNode: "node-44" });
    await createNodeWithAudit(makeSession(), {
      name: "node-alpha",
      customerId: "1",
      description: "",
      hostname: "alpha.local",
      agents: [
        {
          kind: "SENSOR",
          key: "piglet",
          status: "UNKNOWN",
          draft: 'src_mac = "00:00:00:00:00:00"\n',
        },
      ],
      externalServices: [],
    });
    const setModeAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "service.set_mode");
    expect(setModeAudits).toHaveLength(0);
  });

  it("forwards a Sensor + Data Store payload to the upstream insertNode", async () => {
    // Approximates the dialog's "create with Sensor + Data Store
    // enabled" path: the dialog assembles `agents` + `externalServices`
    // from the per-service form modules and hands them to the BFF.
    // This test confirms the BFF passes them straight through to
    // review-web's `insertNode` mutation without dropping or reshaping
    // either list.
    mockGraphqlRequest.mockResolvedValueOnce({ insertNode: "node-100" });
    const sensorDraft =
      'dpdk_args = ""\ndpdk_inputs = []\ndpdk_outputs = []\nsrc_mac = "00:00:00:00:00:00"\n';
    const dataStoreDraft =
      'ingest_srv_addr = "10.0.0.1:38370"\npublish_srv_addr = "10.0.0.1:38371"\n';
    await createNodeWithAudit(makeSession(), {
      name: "node-mix",
      customerId: "1",
      description: "",
      hostname: "mix.local",
      agents: [
        {
          kind: "SENSOR",
          key: "piglet",
          status: "UNKNOWN",
          draft: sensorDraft,
        },
      ],
      externalServices: [
        {
          kind: "DATA_STORE",
          key: "giganto",
          status: "UNKNOWN",
          draft: dataStoreDraft,
        },
      ],
    });
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const dispatchedVars = mockGraphqlRequest.mock.calls[0]?.[1] as {
      agents: unknown;
      externalServices: unknown;
    };
    expect(dispatchedVars.agents).toEqual([
      { kind: "SENSOR", key: "piglet", status: "UNKNOWN", draft: sensorDraft },
    ]);
    expect(dispatchedVars.externalServices).toEqual([
      {
        kind: "DATA_STORE",
        key: "giganto",
        status: "UNKNOWN",
        draft: dataStoreDraft,
      },
    ]);
  });

  it("emits no audit when the upstream create rejects", async () => {
    mockGraphqlRequest.mockRejectedValueOnce(new Error("boom"));
    await expect(
      createNodeWithAudit(makeSession(), {
        name: "node-alpha",
        customerId: "1",
        description: "",
        hostname: "alpha.local",
        agents: [],
        externalServices: [],
      }),
    ).rejects.toThrow();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

describe("updateNodeWithAudit", () => {
  it("emits node.update only when metadata fields changed", async () => {
    // Canonical-node fetch (saveDraft → updateNodeDraft → assertCanonicalNodeInScope).
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    // updateNodeDraft mutation.
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "node-1" });

    await updateNodeWithAudit(
      makeSession(),
      "node-1",
      makeOldNode(),
      makeNewDraft({
        profileDraft: {
          customerId: "1",
          description: "edited",
          hostname: "alpha.local",
        },
      }),
    );

    const audits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter(
        (e: { action?: string }) =>
          e.action === "node.update" || e.action === "service.draft_save",
      );
    const updateAudits = audits.filter(
      (a: { action?: string }) => a.action === "node.update",
    );
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0]).toMatchObject({
      action: "node.update",
      target: "node",
      targetId: "node-1",
      details: { changedFields: ["description"] },
    });
  });

  it("emits no node.update when only service drafts changed", async () => {
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [
          {
            node: 1,
            kind: "SENSOR",
            key: "piglet",
            status: "UNKNOWN",
            config: null,
            draft: null,
          },
        ],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "node-1" });

    await updateNodeWithAudit(
      makeSession(),
      "node-1",
      makeOldNode({
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "UNKNOWN",
            config: null,
            draft: null,
          },
        ],
      }),
      makeNewDraft({
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "UNKNOWN",
            draft: "ack=1",
          },
        ],
      }),
    );

    const updateAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "node.update");
    expect(updateAudits).toHaveLength(0);

    const draftSaveAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "service.draft_save");
    expect(draftSaveAudits).toHaveLength(1);
  });

  it("emits both node.update and service.draft_save on a mixed save", async () => {
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [
          {
            node: 1,
            kind: "SENSOR",
            key: "piglet",
            status: "UNKNOWN",
            config: null,
            draft: null,
          },
        ],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "node-1" });

    await updateNodeWithAudit(
      makeSession(),
      "node-1",
      makeOldNode({
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "UNKNOWN",
            config: null,
            draft: null,
          },
        ],
      }),
      makeNewDraft({
        nameDraft: "node-renamed",
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "UNKNOWN",
            draft: "ack=1",
          },
        ],
      }),
    );

    const allAudits = mockAuditRecord.mock.calls.map((c) => c[0]);
    const updateAudits = allAudits.filter(
      (a: { action?: string }) => a.action === "node.update",
    );
    const draftAudits = allAudits.filter(
      (a: { action?: string }) => a.action === "service.draft_save",
    );
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0]).toMatchObject({
      details: { changedFields: ["name"] },
    });
    expect(draftAudits).toHaveLength(1);
  });

  it("emits no service.set_mode on a metadata-only save against an applied-only both-mode agent", async () => {
    // Regression: `buildDraftSubmission` round-trips an untouched
    // applied-only agent as `draft: null` (preserves the wire shape so
    // the manager doesn't see a phantom pending draft). The audit
    // derivation must read `draft: null` as "no pending draft" — not
    // Manually mode — otherwise a metadata-only save on any node with
    // applied Sensor / Hog / Crusher manufactures a here→manually flip.
    const sensorAppliedConfig = 'src_mac = "00:00:00:00:00:00"\n';
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [
          {
            node: 1,
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            config: sensorAppliedConfig,
            draft: null,
          },
        ],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "node-1" });

    await updateNodeWithAudit(
      makeSession(),
      "node-1",
      makeOldNode({
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            config: sensorAppliedConfig,
            draft: null,
          },
        ],
      }),
      makeNewDraft({
        profileDraft: {
          customerId: "1",
          description: "edited",
          hostname: "alpha.local",
        },
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            draft: null,
          },
        ],
      }),
    );

    const updateAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "node.update");
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0]).toMatchObject({
      details: { changedFields: ["description"] },
    });
    const setModeAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "service.set_mode");
    expect(setModeAudits).toHaveLength(0);
  });

  it("emits no service.set_mode on a Keep-editing reconcile no-op (touched section collapses to draft:null)", async () => {
    // Regression: when the user's edits resolve to the applied config
    // byte-for-byte, `buildDraftSubmission` collapses the touched
    // section to `draft: null`. Old has both `draft` and `config` set
    // to the same applied TOML — effective Configure-Here. New has
    // `draft: null` — no pending change. No mode toggle, no event.
    const sensorAppliedConfig = 'src_mac = "00:00:00:00:00:00"\n';
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [
          {
            node: 1,
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            config: sensorAppliedConfig,
            draft: sensorAppliedConfig,
          },
        ],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "node-1" });

    await updateNodeWithAudit(
      makeSession(),
      "node-1",
      makeOldNode({
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            config: sensorAppliedConfig,
            draft: sensorAppliedConfig,
          },
        ],
      }),
      makeNewDraft({
        nameDraft: "node-renamed",
        agents: [
          {
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            draft: null,
          },
        ],
      }),
    );

    const setModeAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "service.set_mode");
    expect(setModeAudits).toHaveLength(0);
  });

  it("emits no node.update or service.set_mode when saveDraft's replay path short-circuits as a no-op", async () => {
    // Scenario: a concurrent writer (or an idempotent retry of this
    // same request) already applied the user's intent before this
    // call's mutation reached the manager. `saveDraft` correctly
    // detects that the rebased draft matches fresh server state and
    // returns `persisted: false` without dispatching the replay
    // mutation. The contract says audit rows fire only when the
    // change is persisted, so this layer must not record
    // `node.update` or `service.set_mode` for a request that wrote
    // nothing — even though the caller-supplied (oldNode, newDraft)
    // diff would otherwise look like a real metadata + mode change.
    //
    // Mock sequence (single saveDraft call, replay path):
    //   1. canonical-fetch on the original updateNodeDraft (success)
    //   2. mutation #1 rejects with a stale-conflict
    //   3. replay re-fetch: fresh state already matches the user's
    //      proposed name + description and the proposed Sensor
    //      Manually toggle (draft = ""), so isNoOpAgainstFresh()
    //      returns true and the replay mutation is skipped.
    const proposedSensorDraft = "";
    const sensorAgent = {
      node: 1,
      kind: "SENSOR",
      key: "piglet",
      status: "ENABLED",
      config: 'src_mac = "00:00:00:00:00:00"\n',
      draft: proposedSensorDraft,
    };
    // 1. canonical-fetch on the first updateNodeDraft.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: "node-renamed",
        profile: {
          customerId: "1",
          description: "edited",
          hostname: "alpha.local",
        },
        profileDraft: null,
        agents: [sensorAgent],
        externalServices: [],
      },
    });
    // 2. mutation #1 stale-conflicts.
    const staleErr = Object.assign(new Error("stale"), {
      response: { errors: [{ message: STALE_CONFLICT_FIXTURE }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    // 3. replay re-fetch returns the same canonical state — fresh
    //    already carries the proposed nameDraft / description /
    //    sensor draft="". `rebaseDraftOnFresh` produces a draft that
    //    matches fresh byte-for-byte → no-op short-circuit.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: "node-renamed",
        profile: {
          customerId: "1",
          description: "edited",
          hostname: "alpha.local",
        },
        profileDraft: null,
        agents: [sensorAgent],
        externalServices: [],
      },
    });

    const callerOldNode: NodeInput = {
      name: "node-alpha",
      nameDraft: null,
      profile: {
        customerId: "1",
        description: "",
        hostname: "alpha.local",
      },
      profileDraft: null,
      agents: [
        {
          kind: "SENSOR",
          key: "piglet",
          status: "ENABLED",
          config: 'src_mac = "00:00:00:00:00:00"\n',
          draft: 'src_mac = "00:00:00:00:00:00"\n',
        },
      ],
      externalServices: [],
    };
    const callerNewDraft: NodeDraftInput = {
      nameDraft: "node-renamed",
      profileDraft: {
        customerId: "1",
        description: "edited",
        hostname: "alpha.local",
      },
      agents: [
        {
          kind: "SENSOR",
          key: "piglet",
          status: "ENABLED",
          draft: proposedSensorDraft,
        },
      ],
      externalServices: null,
    };

    const id = await updateNodeWithAudit(
      makeSession(),
      "node-1",
      callerOldNode,
      callerNewDraft,
    );

    expect(id).toBe("node-1");
    // Exactly the three GraphQL calls described above; no replay
    // mutation, no extra dispatches.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(3);
    // No audit rows of any kind: `service.draft_save` is owned by
    // saveDraft and is also gated on the persisted dispatch, and the
    // outer layer's `node.update` / `service.set_mode` rows are now
    // gated on the persisted flag too.
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("derives node.update / service.set_mode from the rebased (replayOld, rebased) pair when the replay path persists a partial subset", async () => {
    // Scenario: the user proposes three changes in one Save —
    //   * description (metadata) — "" → "edited"
    //   * customerId  (metadata) — "1" → "2"
    //   * Sensor mode (service)  — Configure-Here → Manually
    // A concurrent writer applies the customerId + Sensor-mode change
    // before this call's mutation reaches the manager. The first
    // mutation stale-conflicts; the replay re-reads the fresh
    // canonical node, rebases the user's intent onto it, and persists
    // *only* the description change — every other proposed change
    // already matches fresh state byte-for-byte.
    //
    // The audit contract requires this layer to record only what was
    // actually persisted by THIS call:
    //   * `node.update.details.changedFields` must be ["description"],
    //     not ["customerId", "description"].
    //   * No `service.set_mode` row, because the rebased Sensor draft
    //     equals fresh — the mode flip was persisted by the concurrent
    //     writer, not by this call.
    //   * Audit `customerId` must be the rebased value (2 — the user's
    //     intent the concurrent writer already applied), so the row is
    //     scoped to the correct customer rather than the user's stale
    //     pre-conflict snapshot of "1" or "2".
    const sensorOldDraft = 'src_mac = "00:00:00:00:00:00"\n';
    const sensorManuallyDraft = "";

    // 1. canonical-fetch on the first updateNodeDraft. Returns
    //    pre-conflict state (matches the user's `oldNode`) so the
    //    canonical scope check passes; the actual stale conflict is
    //    surfaced by the mutation, not the canonical fetch.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [
          {
            node: 1,
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            config: sensorOldDraft,
            draft: sensorOldDraft,
          },
        ],
        externalServices: [],
      },
    });
    // 2. mutation #1 stale-conflicts.
    const staleErr = Object.assign(new Error("stale"), {
      response: { errors: [{ message: STALE_CONFLICT_FIXTURE }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    // 3. replay re-fetch (fetchNodeForReplay) — concurrent writer has
    //    already applied customerId="2" and Sensor-mode Manually
    //    (draft=""), but description is still "" upstream.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "2", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [
          {
            node: 1,
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            config: sensorOldDraft,
            draft: sensorManuallyDraft,
          },
        ],
        externalServices: [],
      },
    });
    // 4. canonical-fetch on the second updateNodeDraft (replay).
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "node-alpha",
        nameDraft: null,
        profile: { customerId: "2", description: "", hostname: "alpha.local" },
        profileDraft: null,
        agents: [
          {
            node: 1,
            kind: "SENSOR",
            key: "piglet",
            status: "ENABLED",
            config: sensorOldDraft,
            draft: sensorManuallyDraft,
          },
        ],
        externalServices: [],
      },
    });
    // 5. replay mutation succeeds.
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "node-1" });

    const callerOldNode: NodeInput = {
      name: "node-alpha",
      nameDraft: null,
      profile: { customerId: "1", description: "", hostname: "alpha.local" },
      profileDraft: null,
      agents: [
        {
          kind: "SENSOR",
          key: "piglet",
          status: "ENABLED",
          config: sensorOldDraft,
          draft: sensorOldDraft,
        },
      ],
      externalServices: [],
    };
    const callerNewDraft: NodeDraftInput = {
      nameDraft: "node-alpha",
      profileDraft: {
        customerId: "2",
        description: "edited",
        hostname: "alpha.local",
      },
      agents: [
        {
          kind: "SENSOR",
          key: "piglet",
          status: "ENABLED",
          draft: sensorManuallyDraft,
        },
      ],
      externalServices: null,
    };

    const id = await updateNodeWithAudit(
      makeSession(),
      "node-1",
      callerOldNode,
      callerNewDraft,
    );
    expect(id).toBe("node-1");
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(5);

    const updateAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "node.update");
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0]).toMatchObject({
      action: "node.update",
      target: "node",
      targetId: "node-1",
      details: { changedFields: ["description"] },
      // The audit row is scoped to the rebased customer (2), not the
      // caller's stale snapshot. Without the fix this would be 1.
      customerId: 2,
    });

    const setModeAudits = mockAuditRecord.mock.calls
      .map((c) => c[0])
      .filter((a: { action?: string }) => a.action === "service.set_mode");
    expect(setModeAudits).toHaveLength(0);
  });
});

describe("diffMetadataFields", () => {
  it("detects a name change", () => {
    expect(
      diffMetadataFields(makeOldNode(), makeNewDraft({ nameDraft: "new" })),
    ).toEqual(["name"]);
  });

  it("returns the canonical order for multiple changes", () => {
    expect(
      diffMetadataFields(
        makeOldNode(),
        makeNewDraft({
          nameDraft: "new",
          profileDraft: {
            customerId: "2",
            description: "edited",
            hostname: "beta.local",
          },
        }),
      ),
    ).toEqual(["name", "customerId", "description", "hostname"]);
  });

  it("returns empty for an unchanged metadata payload", () => {
    expect(diffMetadataFields(makeOldNode(), makeNewDraft())).toEqual([]);
  });
});
