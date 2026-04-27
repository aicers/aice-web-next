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
    agents: unknown[];
    externalServices: unknown[];
    profile: { customerId: string; description: string; hostname: string };
  }> = {},
): unknown {
  return {
    node: {
      id: nodeId,
      name: "n",
      nameDraft: null,
      profile:
        overrides.profile === undefined
          ? { customerId, description: "", hostname: "h" }
          : overrides.profile,
      profileDraft: null,
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
  it("rejects a tenant admin scoped to customer 5 from saving against a node owned by customer 7", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // Canonical-node fetch returns a node belonging to customer 7.
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-7", "7"));

    const { saveDraft } = await import("@/lib/node/draft");
    const { NodePermissionError } = await import("@/lib/node/errors");

    await expect(
      saveDraft(makeSession(), "n-7", makeOldNode(), makeNewDraft()),
    ).rejects.toBeInstanceOf(NodePermissionError);

    // The mutation must not have been dispatched — only the canonical fetch.
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
  it("a second saveDraft with the same payload after a successful first call replays against the fresh state and emits zero additional audits when the diff is empty", async () => {
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
    // state (which already has the proposed draft) and re-applies. The
    // diff between the fresh `old` and `newDraft` is empty, so no
    // additional audit row is emitted.
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    const staleErr = Object.assign(new Error("stale"), {
      response: {
        errors: [{ message: "the node was modified by another writer" }],
      },
    });
    mockGraphqlRequest.mockRejectedValueOnce(staleErr);
    // Replay re-fetch — the fresh node already carries the proposed
    // SENSOR draft, so the diff against newDraft is empty.
    mockGraphqlRequest.mockResolvedValueOnce(
      canonicalNodePayload("n-5", "5", {
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
    mockGraphqlRequest.mockResolvedValueOnce(canonicalNodePayload("n-5", "5"));
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    await saveDraft(makeSession(), "n-5", oldNode, newDraft);
    // Still only the original audit row from the first call.
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
  });
});
