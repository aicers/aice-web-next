import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type { NodeDraftInput, NodeInput } from "@/lib/node/types";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());
const mockGigantoClient = vi.hoisted(() => vi.fn());
const mockTivanClient = vi.hoisted(() => vi.fn());
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
  gigantoClient: mockGigantoClient,
  tivanClient: mockTivanClient,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

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

function grantOnly(
  ...granted: string[]
): (roles: string[], permission: string) => Promise<boolean> {
  return async (_roles, permission) => granted.includes(permission);
}

function canonicalNodePayload(
  nodeId: string,
  customerId: string,
  overrides: Partial<{
    name: string;
    nameDraft: string | null;
    agents: unknown[];
    externalServices: unknown[];
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
  }> = {},
): unknown {
  return {
    node: {
      id: nodeId,
      name: overrides.name ?? "n",
      nameDraft: overrides.nameDraft === undefined ? null : overrides.nameDraft,
      profile:
        overrides.profile === undefined
          ? { customerId, description: "", hostname: "h" }
          : overrides.profile,
      profileDraft:
        overrides.profileDraft === undefined ? null : overrides.profileDraft,
      agents: overrides.agents ?? [],
      externalServices: overrides.externalServices ?? [],
    },
  };
}

function makeOldNode(overrides: Partial<NodeInput> = {}): NodeInput {
  return {
    name: "n",
    nameDraft: null,
    profile: { customerId: "5", description: "", hostname: "h" },
    profileDraft: null,
    agents: [],
    externalServices: [],
    ...overrides,
  };
}

function makeNewDraft(overrides: Partial<NodeDraftInput> = {}): NodeDraftInput {
  return {
    nameDraft: "n2",
    profileDraft: { customerId: "5", description: "d", hostname: "h" },
    agents: null,
    externalServices: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockHasPermission.mockReset();
  mockResolveEffectiveCustomerIds.mockReset();
  mockGraphqlRequest.mockReset();
  mockGigantoClient.mockReset();
  mockTivanClient.mockReset();
  mockAuditRecord.mockReset();
});

// ── Permission boundary ─────────────────────────────────────────────

describe("saveDraft — permission boundary", () => {
  it("rejects a caller holding nodes:write but missing services:write before any GraphQL dispatch", async () => {
    mockHasPermission.mockImplementation(grantOnly("nodes:write"));
    const { saveDraft } = await import("@/lib/node/draft");
    const { NodePermissionError } = await import("@/lib/node/errors");

    await expect(
      saveDraft(makeSession(), "n-1", makeOldNode(), makeNewDraft()),
    ).rejects.toBeInstanceOf(NodePermissionError);

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockResolveEffectiveCustomerIds).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("rejects a caller holding services:write but missing nodes:write before any GraphQL dispatch", async () => {
    mockHasPermission.mockImplementation(grantOnly("services:write"));
    const { saveDraft } = await import("@/lib/node/draft");
    const { NodePermissionError } = await import("@/lib/node/errors");

    await expect(
      saveDraft(makeSession(), "n-1", makeOldNode(), makeNewDraft()),
    ).rejects.toBeInstanceOf(NodePermissionError);

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

// ── Customer scope boundary ─────────────────────────────────────────

describe("saveDraft — customer scope", () => {
  it("surfaces a manager-DB scope rejection as a typed NodeNotFoundError, never as a raw GraphQL error", async () => {
    // The acceptance contract: customer scope is enforced at the manager-
    // DB layer through the JWT context built by `buildDispatchContext`.
    // When review-web's `customer_ids` filter rejects an out-of-scope
    // node, the manager surfaces it as a NOT_FOUND-shaped GraphQL error
    // (review-web does not reveal the existence of out-of-scope rows).
    // The BFF must map that into a typed error so callers can render a
    // 404, not a generic "GraphQL error" toast.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    const scopeReject = Object.assign(new Error("forbidden"), {
      response: {
        errors: [
          {
            message: "node not found",
            extensions: { code: "NOT_FOUND" },
          },
        ],
      },
    });
    mockGraphqlRequest.mockRejectedValueOnce(scopeReject);

    const { saveDraft } = await import("@/lib/node/draft");
    const { NodeNotFoundError } = await import("@/lib/node/errors");

    await expect(
      saveDraft(makeSession(), "n-7", makeOldNode(), makeNewDraft()),
    ).rejects.toBeInstanceOf(NodeNotFoundError);

    // Only the canonical-node fetch ran; no mutation was dispatched.
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("defense-in-depth: rejects with NodePermissionError if review-web ever leaks an out-of-scope node payload", async () => {
    // Belt-and-braces: even if a future review-web build leaked an
    // out-of-scope node through the canonical fetch (instead of the
    // documented NOT_FOUND surfacing), the BFF must still refuse the
    // mutation. This guards the BFF tenant-scope contract independent
    // of the upstream filter.
    //
    // Grant only the write permissions saveDraft needs — explicitly
    // NOT `customers:access-all`, since this defense-in-depth scenario
    // models a tenant-scoped caller (a globally-scoped caller is
    // legitimately allowed to touch any customer, so the leak would
    // not be a leak for them).
    mockHasPermission.mockImplementation(
      grantOnly("nodes:write", "services:write"),
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-7", "7"));

    const { saveDraft } = await import("@/lib/node/draft");
    const { NodePermissionError } = await import("@/lib/node/errors");

    await expect(
      saveDraft(makeSession(), "n-7", makeOldNode(), makeNewDraft()),
    ).rejects.toBeInstanceOf(NodePermissionError);

    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

// ── Per-service audit emission ──────────────────────────────────────

describe("saveDraft — per-service audit emission", () => {
  it("emits one service.draft_save entry per changed service when both an agent and an external service drafts change", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // Canonical fetch + mutation success.
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const oldNode = makeOldNode({
      agents: [
        {
          kind: "SENSOR",
          key: "s1",
          status: "ENABLED",
          config: null,
          draft: "old-sensor",
        },
      ],
      externalServices: [
        {
          kind: "DATA_STORE",
          key: "g1",
          status: "ENABLED",
          draft: "old-giganto",
        },
      ],
    });
    const newDraft = makeNewDraft({
      agents: [
        {
          kind: "SENSOR",
          key: "s1",
          status: "ENABLED",
          draft: "new-sensor",
        },
      ],
      externalServices: [
        {
          kind: "DATA_STORE",
          key: "g1",
          status: "ENABLED",
          draft: "new-giganto",
        },
      ],
    });

    const { saveDraft } = await import("@/lib/node/draft");
    const result = await saveDraft(makeSession(), "n-5", oldNode, newDraft);
    expect(result).toBe("n-5");

    expect(mockAuditRecord).toHaveBeenCalledTimes(2);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "service.draft_save",
        target: "service",
        targetId: "n-5:SENSOR",
        details: { serviceKind: "SENSOR", nodeId: "n-5" },
        actor: "account-1",
        sid: "session-1",
        customerId: 5,
      }),
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "service.draft_save",
        target: "service",
        targetId: "n-5:DATA_STORE",
        details: { serviceKind: "DATA_STORE", nodeId: "n-5" },
      }),
    );
  });

  it("emits zero audit entries when only node-metadata changes (no agent/external-service drafts touched)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    // newDraft.agents and newDraft.externalServices both null → no
    // per-service draft changes regardless of the existing services.
    const result = await saveDraft(
      makeSession(),
      "n-5",
      makeOldNode({
        agents: [
          {
            kind: "SENSOR",
            key: "s1",
            status: "ENABLED",
            config: null,
            draft: "x",
          },
        ],
      }),
      makeNewDraft({ agents: null, externalServices: null }),
    );
    expect(result).toBe("n-5");
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("does not emit an audit for an agent whose draft string is unchanged even when the list is replaced", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const same = "stable-draft";
    const { saveDraft } = await import("@/lib/node/draft");
    await saveDraft(
      makeSession(),
      "n-5",
      makeOldNode({
        agents: [
          {
            kind: "SENSOR",
            key: "s1",
            status: "ENABLED",
            config: null,
            draft: same,
          },
        ],
      }),
      makeNewDraft({
        agents: [{ kind: "SENSOR", key: "s1", status: "ENABLED", draft: same }],
      }),
    );
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

// ── Stale-conflict replay ───────────────────────────────────────────

describe("saveDraft — stale-conflict replay", () => {
  it("on a single stale-conflict, re-reads the node and replays once; emits the audit exactly once", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const oldNode = makeOldNode({
      agents: [
        {
          kind: "SENSOR",
          key: "s1",
          status: "ENABLED",
          config: null,
          draft: "stale-old",
        },
      ],
    });
    const newDraft = makeNewDraft({
      agents: [
        { kind: "SENSOR", key: "s1", status: "ENABLED", draft: "new-sensor" },
      ],
    });

    // Sequence:
    // 1. updateNodeDraft canonical-fetch (success).
    // 2. updateNodeDraft mutation (rejects with stale-conflict).
    // 3. saveDraft's replay re-fetch (returns fresh node with a
    //    different agent draft string).
    // 4. updateNodeDraft canonical-fetch on replay (success).
    // 5. updateNodeDraft mutation on replay (success).
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const staleErr = Object.assign(new Error("stale state on the server"), {
      response: {
        errors: [{ message: "the node was modified concurrently" }],
      },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", {
        agents: [
          {
            kind: "SENSOR",
            key: "s1",
            status: "ENABLED",
            config: null,
            draft: "fresh-draft-from-server",
          },
        ],
      }),
    );
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    const result = await saveDraft(makeSession(), "n-5", oldNode, newDraft);
    expect(result).toBe("n-5");
    // Audit must fire exactly once for the SENSOR service — the replay
    // succeeded, the original attempt failed; we never double-emit.
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "service.draft_save",
        targetId: "n-5:SENSOR",
      }),
    );
  });

  it("on two consecutive stale-conflicts, throws StaleConflictError and emits no audit entry", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const newDraft = makeNewDraft({
      agents: [
        { kind: "SENSOR", key: "s1", status: "ENABLED", draft: "new-sensor" },
      ],
    });

    // Sequence:
    // 1. canonical-fetch (success).
    // 2. mutation #1 (stale-conflict).
    // 3. saveDraft's replay re-fetch (success).
    // 4. canonical-fetch on replay (success).
    // 5. mutation #2 (stale-conflict).
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const staleErr1 = Object.assign(new Error("conflict"), {
      response: { errors: [{ message: "concurrent modification detected" }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr1);
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const staleErr2 = Object.assign(new Error("stale read"), {
      response: { errors: [{ message: "stale view of node draft" }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr2);

    const { saveDraft, StaleConflictError } = await import("@/lib/node/draft");
    await expect(
      saveDraft(makeSession(), "n-5", makeOldNode(), newDraft),
    ).rejects.toBeInstanceOf(StaleConflictError);
    // No audit row for a save that ultimately failed.
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("preserves a concurrent writer's edit on an untouched service when replaying after a stale-conflict", async () => {
    // The user edited only SENSOR A; a concurrent writer changed
    // SENSOR B's draft between dialog-open and Save. The first
    // mutation stale-conflicts on the CAS check. The replay must
    // forward the user's intent for A and the *fresh* value for B —
    // it must not replay the user's stale snapshot of B and clobber
    // the concurrent writer's edit.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const oldNode = makeOldNode({
      agents: [
        {
          kind: "SENSOR",
          key: "a",
          status: "ENABLED",
          config: null,
          draft: "A-old",
        },
        {
          kind: "SENSOR",
          key: "b",
          status: "ENABLED",
          config: null,
          draft: "B-old",
        },
      ],
    });
    const newDraft = makeNewDraft({
      agents: [
        { kind: "SENSOR", key: "a", status: "ENABLED", draft: "A-new-by-user" },
        // User did NOT touch B — they sent B's draft string back unchanged.
        { kind: "SENSOR", key: "b", status: "ENABLED", draft: "B-old" },
      ],
    });

    // 1: canonical-fetch on the first updateNodeDraft (success).
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    // 2: mutation #1 (stale-conflict).
    const staleErr = Object.assign(new Error("conflict"), {
      response: { errors: [{ message: "concurrent modification on node" }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    // 3: replay re-fetch — the canonical state shows that a concurrent
    //    writer changed B from "B-old" to "B-by-other-writer". A is
    //    still at the original "A-old".
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", {
        agents: [
          {
            kind: "SENSOR",
            key: "a",
            status: "ENABLED",
            config: null,
            draft: "A-old",
          },
          {
            kind: "SENSOR",
            key: "b",
            status: "ENABLED",
            config: null,
            draft: "B-by-other-writer",
          },
        ],
      }),
    );
    // 4: canonical-fetch on the replay updateNodeDraft (success).
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", {
        agents: [
          {
            kind: "SENSOR",
            key: "a",
            status: "ENABLED",
            config: null,
            draft: "A-old",
          },
          {
            kind: "SENSOR",
            key: "b",
            status: "ENABLED",
            config: null,
            draft: "B-by-other-writer",
          },
        ],
      }),
    );
    // 5: replay mutation (success). Capture the variables so we can
    //    verify the dispatched payload preserved B-by-other-writer.
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    const result = await saveDraft(makeSession(), "n-5", oldNode, newDraft);
    expect(result).toBe("n-5");

    // The replay mutation is the last graphqlRequest call whose
    // variables carry `old`/`new`.
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    // Two mutation calls: the original (stale-conflict) and the replay.
    expect(mutationCalls).toHaveLength(2);
    const replayVars = mutationCalls[1][1] as {
      new: NodeDraftInput;
    };
    const sentB = replayVars.new.agents?.find((a) => a.key === "b");
    expect(sentB?.draft).toBe("B-by-other-writer");
    const sentA = replayVars.new.agents?.find((a) => a.key === "a");
    // A — which the user did edit — is forwarded at the user's value.
    expect(sentA?.draft).toBe("A-new-by-user");

    // Audit fires once for SENSOR A (the only diff against fresh-old).
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "service.draft_save",
        targetId: "n-5:SENSOR",
        details: { serviceKind: "SENSOR", nodeId: "n-5" },
      }),
    );
  });

  it("preserves a concurrent writer's newly added service (fresh-only key) when replaying after a stale-conflict", async () => {
    // Edge case: between dialog-open and Save, another writer added a
    // brand-new service the user has never seen. Because `agents` is a
    // replacement payload, replaying the user's snapshot would silently
    // delete the newly added service. The replay must walk the fresh
    // list as the base, so the new entry survives.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const oldNode = makeOldNode({
      agents: [
        {
          kind: "SENSOR",
          key: "a",
          status: "ENABLED",
          config: null,
          draft: "A-old",
        },
      ],
    });
    const newDraft = makeNewDraft({
      agents: [
        { kind: "SENSOR", key: "a", status: "ENABLED", draft: "A-new-by-user" },
      ],
    });

    // 1: canonical-fetch on first updateNodeDraft.
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    // 2: mutation #1 (stale-conflict).
    const staleErr = Object.assign(new Error("conflict"), {
      response: { errors: [{ message: "concurrent modification on node" }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    // 3: replay re-fetch — concurrent writer added SENSOR c.
    const freshAgents = [
      {
        kind: "SENSOR",
        key: "a",
        status: "ENABLED",
        config: null,
        draft: "A-old",
      },
      {
        kind: "SENSOR",
        key: "c",
        status: "ENABLED",
        config: null,
        draft: "C-by-other-writer",
      },
    ];
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", { agents: freshAgents }),
    );
    // 4: canonical-fetch on the replay updateNodeDraft.
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", { agents: freshAgents }),
    );
    // 5: replay mutation success.
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    const result = await saveDraft(makeSession(), "n-5", oldNode, newDraft);
    expect(result).toBe("n-5");

    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(2);
    const replayVars = mutationCalls[1][1] as { new: NodeDraftInput };
    const sentAgents = replayVars.new.agents ?? [];
    // The fresh-only SENSOR c is included with the concurrent writer's
    // value; SENSOR a still carries the user's edit.
    const sentC = sentAgents.find((a) => a.key === "c");
    expect(sentC?.draft).toBe("C-by-other-writer");
    const sentA = sentAgents.find((a) => a.key === "a");
    expect(sentA?.draft).toBe("A-new-by-user");
    expect(sentAgents).toHaveLength(2);

    // Audit fires once for SENSOR (only A's draft changed against fresh).
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "service.draft_save",
        targetId: "n-5:SENSOR",
      }),
    );
  });

  it("preserves a concurrent writer's status flip on an untouched service when replaying", async () => {
    // Edge case: another writer flipped SENSOR b's status from ENABLED
    // to DISABLED between dialog-open and Save. The user did not touch
    // B (same status, same draft as originalOld). The replay must
    // forward the *fresh* status for B, not the user's stale snapshot.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const oldNode = makeOldNode({
      agents: [
        {
          kind: "SENSOR",
          key: "a",
          status: "ENABLED",
          config: null,
          draft: "A-old",
        },
        {
          kind: "SENSOR",
          key: "b",
          status: "ENABLED",
          config: null,
          draft: "B-old",
        },
      ],
    });
    const newDraft = makeNewDraft({
      agents: [
        { kind: "SENSOR", key: "a", status: "ENABLED", draft: "A-new" },
        // User did not touch B — same status, same draft.
        { kind: "SENSOR", key: "b", status: "ENABLED", draft: "B-old" },
      ],
    });

    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const staleErr = Object.assign(new Error("conflict"), {
      response: { errors: [{ message: "concurrent modification on node" }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    const freshAgents = [
      {
        kind: "SENSOR",
        key: "a",
        status: "ENABLED",
        config: null,
        draft: "A-old",
      },
      {
        kind: "SENSOR",
        key: "b",
        status: "DISABLED",
        config: null,
        draft: "B-old",
      },
    ];
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", { agents: freshAgents }),
    );
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", { agents: freshAgents }),
    );
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    const result = await saveDraft(makeSession(), "n-5", oldNode, newDraft);
    expect(result).toBe("n-5");

    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(2);
    const replayVars = mutationCalls[1][1] as { new: NodeDraftInput };
    const sentAgents = replayVars.new.agents ?? [];
    const sentB = sentAgents.find((a) => a.key === "b");
    expect(sentB?.status).toBe("DISABLED");
    expect(sentB?.draft).toBe("B-old");
    const sentA = sentAgents.find((a) => a.key === "a");
    expect(sentA?.status).toBe("ENABLED");
    expect(sentA?.draft).toBe("A-new");
  });

  it("merges profile subfields per-field on replay: user edits description only, concurrent writer edits hostname", async () => {
    // Field-granular profile rebase. The user changed only
    // `profileDraft.description`; a concurrent writer changed only
    // `profileDraft.hostname`. The replay must forward the user's
    // description and the fresh hostname — not replay the user's
    // whole stale `profileDraft`, which would clobber the concurrent
    // hostname change.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const oldNode = makeOldNode({
      profile: { customerId: "5", description: "old-desc", hostname: "h1" },
    });
    const newDraft = makeNewDraft({
      // Only description differs from oldNode.profile (the user's baseline).
      profileDraft: {
        customerId: "5",
        description: "user-new-desc",
        hostname: "h1",
      },
    });

    // 1: canonical-fetch on first updateNodeDraft.
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    // 2: mutation #1 (stale-conflict).
    const staleErr = Object.assign(new Error("conflict"), {
      response: { errors: [{ message: "concurrent modification on node" }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    // 3: replay re-fetch — fresh hostname is "h2-by-other-writer";
    //    description is still "old-desc" (concurrent writer left it).
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", {
        profile: {
          customerId: "5",
          description: "old-desc",
          hostname: "h2-by-other-writer",
        },
      }),
    );
    // 4: canonical-fetch on the replay updateNodeDraft.
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", {
        profile: {
          customerId: "5",
          description: "old-desc",
          hostname: "h2-by-other-writer",
        },
      }),
    );
    // 5: replay mutation success.
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    await saveDraft(makeSession(), "n-5", oldNode, newDraft);

    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(2);
    const replayVars = mutationCalls[1][1] as { new: NodeDraftInput };
    // The replay sends the user's description AND the fresh hostname.
    expect(replayVars.new.profileDraft).toEqual({
      customerId: "5",
      description: "user-new-desc",
      hostname: "h2-by-other-writer",
    });
  });

  it("merges service subfields per-field on replay: user edits draft only, concurrent writer flips status on the same entry", async () => {
    // Field-granular service rebase. The user changed only the
    // SENSOR `a` draft string; a concurrent writer flipped that same
    // SENSOR `a` from ENABLED to DISABLED. The replay must forward
    // the user's draft AND the fresh status — not replay the user's
    // whole stale row, which would re-enable the concurrent writer's
    // disablement.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const oldNode = makeOldNode({
      agents: [
        {
          kind: "SENSOR",
          key: "a",
          status: "ENABLED",
          config: null,
          draft: "A-old",
        },
      ],
    });
    const newDraft = makeNewDraft({
      agents: [
        // User changed draft only; status forwarded unchanged.
        { kind: "SENSOR", key: "a", status: "ENABLED", draft: "A-new-by-user" },
      ],
    });

    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const staleErr = Object.assign(new Error("conflict"), {
      response: { errors: [{ message: "concurrent modification on node" }] },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    const freshAgents = [
      // Concurrent writer flipped status only; draft unchanged.
      {
        kind: "SENSOR",
        key: "a",
        status: "DISABLED",
        config: null,
        draft: "A-old",
      },
    ];
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", { agents: freshAgents }),
    );
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", { agents: freshAgents }),
    );
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    await saveDraft(makeSession(), "n-5", oldNode, newDraft);

    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(2);
    const replayVars = mutationCalls[1][1] as { new: NodeDraftInput };
    const sentA = replayVars.new.agents?.find((a) => a.key === "a");
    expect(sentA?.status).toBe("DISABLED");
    expect(sentA?.draft).toBe("A-new-by-user");

    // Audit fires once for SENSOR (the user's draft change vs. fresh).
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "service.draft_save",
        targetId: "n-5:SENSOR",
      }),
    );
  });

  it("does not retry a non-stale GraphQL error (e.g. validation) — propagates the original error and emits no audit", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const validation = new Error("Cannot query field 'foo' on type 'Bar'");
    mockGraphqlRequest.mockRejectedValueOnce(validation);

    const { saveDraft, StaleConflictError } = await import("@/lib/node/draft");
    // Original validation error escapes (not StaleConflictError).
    await expect(
      saveDraft(makeSession(), "n-5", makeOldNode(), makeNewDraft()),
    ).rejects.not.toBeInstanceOf(StaleConflictError);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

// ── Idempotence ────────────────────────────────────────────────────

describe("saveDraft — idempotence on redundant retry", () => {
  it("a second saveDraft with the same payload after a successful first call dispatches no replay mutation and emits zero additional audits", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const oldNode = makeOldNode({
      agents: [
        {
          kind: "SENSOR",
          key: "s1",
          status: "ENABLED",
          config: null,
          draft: "old",
        },
      ],
    });
    const newDraft = makeNewDraft({
      agents: [{ kind: "SENSOR", key: "s1", status: "ENABLED", draft: "new" }],
    });

    // First saveDraft: canonical-fetch + mutation success → 1 audit.
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const { saveDraft } = await import("@/lib/node/draft");
    await saveDraft(makeSession(), "n-5", oldNode, newDraft);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);

    // Second saveDraft with the same payload: server now has the new
    // draft applied, so the user-supplied `old` no longer matches. The
    // first attempt stale-conflicts; the replay re-reads the fresh
    // state (which already has the proposed SENSOR draft and the
    // proposed nameDraft / profileDraft). Rebasing the user's intent
    // onto fresh produces a no-op, so the replay path short-circuits
    // — no second mutation, no extra audit.
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const staleErr = Object.assign(new Error("stale"), {
      response: {
        errors: [{ message: "the node was modified by another writer" }],
      },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    // Replay re-fetch — fresh state matches the proposed save in full.
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", {
        nameDraft: "n2",
        profileDraft: { customerId: "5", description: "d", hostname: "h" },
        agents: [
          {
            kind: "SENSOR",
            key: "s1",
            status: "ENABLED",
            config: null,
            draft: "new",
          },
        ],
      }),
    );

    const callsBeforeRetry = mockGraphqlRequest.mock.calls.length;

    await saveDraft(makeSession(), "n-5", oldNode, newDraft);

    // The retry consumed the canonical-fetch (1) + the stale-conflict
    // mutation (2) + the replay re-fetch (3) — but NO replay mutation.
    const callsAfter = mockGraphqlRequest.mock.calls.length;
    expect(callsAfter - callsBeforeRetry).toBe(3);
    // Still only the original audit row from the first call.
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
  });
});
