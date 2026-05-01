import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());
const mockGigantoClient = vi.hoisted(() => vi.fn());
const mockTivanClient = vi.hoisted(() => vi.fn());
const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockInternalConfirm = vi.hoisted(() => vi.fn());
const mockInternalRetry = vi.hoisted(() => vi.fn());
const mockClaimAuditSlot = vi.hoisted(() => vi.fn());
const mockMarkAuditCompleted = vi.hoisted(() => vi.fn());
const mockReleaseAuditSlot = vi.hoisted(() => vi.fn());
const mockReadApplyAttempt = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
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

vi.mock("@/lib/node/apply-attempt-lifecycle", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/node/apply-attempt-lifecycle")
  >("@/lib/node/apply-attempt-lifecycle");
  return {
    ...actual,
    _internal_confirmApplyAttempt: mockInternalConfirm,
    _internal_retryDispatch: mockInternalRetry,
  };
});

vi.mock("@/lib/node/apply-attempt-cleanup", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/node/apply-attempt-cleanup")
  >("@/lib/node/apply-attempt-cleanup");
  return {
    ...actual,
    claimNodeApplyAuditSlot: mockClaimAuditSlot,
    markNodeApplyAuditCompleted: mockMarkAuditCompleted,
    releaseNodeApplyAuditSlot: mockReleaseAuditSlot,
    readApplyAttempt: mockReadApplyAttempt,
  };
});

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "00000000-0000-0000-0000-000000000001",
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

function tenantScopedPermissions(
  _roles: string[],
  permission: string,
): Promise<boolean> {
  return Promise.resolve(permission !== "customers:access-all");
}

function makeRow(
  status: string,
  overrides: Record<string, unknown> = {},
): import("@/lib/node/apply-attempt-types").ApplyAttemptRow {
  return {
    attemptId: "att-1",
    nodeId: "node-1",
    draftFingerprint: Buffer.alloc(32),
    plannedDispatches: [
      {
        dispatchId: "d-mgr",
        kind: "MANAGER",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
      },
      {
        dispatchId: "d-ds",
        kind: "DATA_STORE",
        state: "succeeded",
        attemptCount: 1,
        lastError: null,
        new: "{a}",
      },
    ],
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    executingLock: null,
    claimStartedAt: null,
    status:
      status as import("@/lib/node/apply-attempt-types").ApplyAttemptStatus,
    customerId: 5,
    ...overrides,
  };
}

beforeEach(() => {
  mockHasPermission.mockReset();
  mockResolveEffectiveCustomerIds.mockReset();
  mockGraphqlRequest.mockReset();
  mockGigantoClient.mockReset();
  mockTivanClient.mockReset();
  mockGetCurrentSession.mockReset();
  mockAuditRecord.mockReset();
  mockInternalConfirm.mockReset();
  mockInternalRetry.mockReset();
  mockClaimAuditSlot.mockReset();
  mockMarkAuditCompleted.mockReset();
  mockReleaseAuditSlot.mockReset();
  mockReadApplyAttempt.mockReset();
  // Default behaviour: every call wins the audit-emission slot. Tests
  // that exercise the concurrent-loser path override per-call.
  mockClaimAuditSlot.mockResolvedValue(true);
  mockMarkAuditCompleted.mockResolvedValue(true);
  mockReleaseAuditSlot.mockResolvedValue(true);
  // Default attempt row: owned by the test session, scoped to
  // customer 5 — matches `mockResolveEffectiveCustomerIds` defaults
  // in the success-path tests below.
  mockReadApplyAttempt.mockResolvedValue({
    attemptId: "att-1",
    nodeId: "node-1",
    draftFingerprint: Buffer.alloc(32),
    plannedDispatches: [],
    createdBy: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    executingLock: null,
    claimStartedAt: null,
    status: "pending",
    customerId: 5,
  });
  mockGetCurrentSession.mockResolvedValue(makeSession());
  // Default: every wrapper-level canonical-node read resolves to an
  // in-scope node so the round-7 existence/scope check passes for
  // the audit-emission and lifecycle tests. Tests that exercise
  // missing/out-of-scope/deleted-node branches override with
  // `mockResolvedValueOnce` (the first call is always the wrapper's
  // canonical-node read; subsequent calls are whatever the test
  // wires).
  mockGraphqlRequest.mockResolvedValue({
    node: {
      id: "node-1",
      name: "n",
      nameDraft: null,
      profile: { customerId: "5", description: "", hostname: "h" },
      profileDraft: null,
      agents: [],
      externalServices: [],
    },
  });
});

describe("public surface", () => {
  it("exports confirmApplyAttempt and retryDispatch as the only server actions", async () => {
    const mod = await import("@/lib/node/apply-actions");
    const exported = Object.entries(mod)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual(["confirmApplyAttempt", "retryDispatch"]);
  });
});

describe("permission and scope rechecks at every call", () => {
  it("confirmApplyAttempt rejects unauthenticated callers before any DB or GraphQL", async () => {
    mockGetCurrentSession.mockResolvedValueOnce(null);
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockInternalConfirm).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("confirmApplyAttempt rejects when nodes:write is missing", async () => {
    mockHasPermission.mockImplementation(
      async (_r, p) => p === "services:write",
    );
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockInternalConfirm).not.toHaveBeenCalled();
  });

  it("confirmApplyAttempt rejects when services:write is missing", async () => {
    mockHasPermission.mockImplementation(async (_r, p) => p === "nodes:write");
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockInternalConfirm).not.toHaveBeenCalled();
  });

  it("confirmApplyAttempt rejects when customer scope resolves empty for a tenant-scoped caller", async () => {
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockInternalConfirm).not.toHaveBeenCalled();
  });

  it("retryDispatch routes through the same permission and scope rechecks", async () => {
    mockHasPermission.mockImplementation(
      async (_r, p) => p === "services:write",
    );
    const { retryDispatch } = await import("@/lib/node/apply-actions");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      retryDispatch({ attemptId: "att-1", dispatchId: "d-ds" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockInternalRetry).not.toHaveBeenCalled();
  });
});

describe("real dispatcher binding (counts outbound GraphQL via recorder)", () => {
  it("confirmApplyAttempt invokes the real GraphQL dispatcher: applyNode + per-external updateConfig", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockImplementation(async (args) => {
      // Drive the dispatcher and reader the wrapper supplied. The
      // recorder below counts the outbound GraphQL calls those
      // bindings emit.
      await args.dispatcher.manager({
        attemptId: "att-1",
        nodeId: "node-1",
        nodeInput: {
          name: "n",
          nameDraft: null,
          profile: { customerId: "5", description: "", hostname: "h" },
          profileDraft: null,
          agents: [],
          externalServices: [],
        },
      });
      await args.dispatcher.external("DATA_STORE", {
        attemptId: "att-1",
        dispatchId: "d-ds",
        oldConfig: "",
        newConfig: "{frozen}",
      });
      return makeRow("succeeded");
    });
    // First manager graphqlRequest = canonical-node preflight (applyNode helper),
    // second = applyNode mutation. Set both up.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "node-1",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({ applyNode: "node-1" });
    // External: a config read followed by an updateConfig mutation.
    mockGigantoClient.mockResolvedValueOnce({
      config: {
        ackTransmission: 0,
        dataDir: "/d",
        exportDir: "/e",
        graphqlSrvAddr: "g",
        ingestSrvAddr: "i",
        maxMbOfLevelBase: "0",
        maxOpenFiles: 0,
        maxSubcompactions: "0",
        numOfThread: 0,
        publishSrvAddr: "p",
        retention: "1d",
      },
    });
    mockGigantoClient.mockResolvedValueOnce({ updateConfig: {} });

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const result = await confirmApplyAttempt({ attemptId: "att-1" });
    expect(result.status).toBe("succeeded");

    const managerCalls = mockGraphqlRequest.mock.calls.filter((c) => {
      const v = c[1] as Record<string, unknown> | undefined;
      return v !== undefined && "node" in v;
    });
    expect(managerCalls).toHaveLength(1);
    // applyNode mutation arguments
    expect((managerCalls[0][1] as { id: string }).id).toBe("node-1");

    // gigantoClient called twice: config read (no variables) +
    // updateConfig mutation (`old`/`new`).
    expect(mockGigantoClient).toHaveBeenCalledTimes(2);
    const updateCall = mockGigantoClient.mock.calls.find(
      (c) =>
        c[1] !== undefined &&
        (c[1] as Record<string, unknown>).new === "{frozen}",
    );
    expect(updateCall).toBeDefined();
  });

  it("retryDispatch reaches the dispatcher under the same wiring", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalRetry.mockImplementation(async (args) => {
      await args.dispatcher.external("TI_CONTAINER", {
        attemptId: "att-1",
        dispatchId: "d-tc",
        oldConfig: "",
        newConfig: "{retried}",
      });
      return makeRow("succeeded");
    });
    mockTivanClient.mockResolvedValueOnce({
      config: {
        excelData: null,
        graphqlSrvAddr: "g",
        originMitre: null,
        translateMitre: "t",
      },
    });
    mockTivanClient.mockResolvedValueOnce({ updateConfig: {} });
    const { retryDispatch } = await import("@/lib/node/apply-actions");
    const result = await retryDispatch({
      attemptId: "att-1",
      dispatchId: "d-tc",
    });
    expect(result.status).toBe("succeeded");
    expect(mockTivanClient).toHaveBeenCalledTimes(2);
    expect(mockTivanClient.mock.calls[1]?.[1]).toEqual({
      old: JSON.stringify({
        excelData: null,
        graphqlSrvAddr: "g",
        originMitre: null,
        translateMitre: "t",
      }),
      new: "{retried}",
    });
  });
});

describe("node.apply audit emission — exactly once per attempt that reaches succeeded", () => {
  it("emits node.apply once when confirmApplyAttempt drives the row from pending → succeeded", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await confirmApplyAttempt({ attemptId: "att-1" });
    expect(mockClaimAuditSlot).toHaveBeenCalledTimes(1);
    expect(mockClaimAuditSlot).toHaveBeenCalledWith("att-1");
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const event = mockAuditRecord.mock.calls[0][0];
    expect(event.action).toBe("node.apply");
    expect(event.target).toBe("node");
    expect(event.targetId).toBe("node-1");
    expect(event.details).toEqual({
      appliedServices: ["DATA_STORE"],
    });
    // Round 3: the wrapper passes the attempt UUID as `correlationId`
    // so the partial unique index on
    // `audit_logs(correlation_id) WHERE action = 'node.apply'` makes a
    // second insert for the same attempt physically impossible.
    expect(event.correlationId).toBe("att-1");
    // #387: customerId snapshotted on the apply-attempt row is now
    // forwarded to the audit emission so the audit-log viewer (#386)
    // surfaces the row to the tenant operator under
    // `audit_logs.customer_id IN (...)` scope.
    expect(event.customerId).toBe(5);
  });

  it("omits customerId from the audit when the apply-attempt row's customer_id is NULL (#387)", async () => {
    // A node with no `customerId` on either profile is reachable only
    // by a globally-scoped caller (see `enforceNodeScope`). For those
    // attempts the persisted `apply_attempts.customer_id` is NULL and
    // the audit row's `customer_id` should stay NULL — there is no
    // owning customer to scope against.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(
      makeRow("succeeded", { customerId: null }),
    );
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await confirmApplyAttempt({ attemptId: "att-1" });
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const event = mockAuditRecord.mock.calls[0][0];
    expect(event.action).toBe("node.apply");
    expect(
      "customerId" in event ? event.customerId : undefined,
    ).toBeUndefined();
  });

  it("does NOT emit on idempotent re-confirm of an already-succeeded row (slot already claimed)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    // The persisted column is non-NULL because the original
    // call already emitted; the atomic UPDATE matches zero rows.
    mockClaimAuditSlot.mockResolvedValue(false);
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await confirmApplyAttempt({ attemptId: "att-1" });
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("does NOT emit when the result is failed_retryable (claim slot never consulted)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("failed_retryable"));
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await confirmApplyAttempt({ attemptId: "att-1" });
    expect(mockClaimAuditSlot).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("retryDispatch emits node.apply when its call drives the row from failed_retryable → succeeded", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalRetry.mockResolvedValue(makeRow("succeeded"));
    const { retryDispatch } = await import("@/lib/node/apply-actions");
    await retryDispatch({ attemptId: "att-1", dispatchId: "d-ds" });
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const event = mockAuditRecord.mock.calls[0][0];
    expect(event.action).toBe("node.apply");
    expect(event.targetId).toBe("node-1");
  });

  it("two concurrent wrappers seeing the same succeeded row only emit once (persisted slot dedup)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    // Simulate the post-claim race the lifecycle's atomic claim
    // serialises only at the row-flip moment: both wrappers observe
    // a `succeeded` result, but the SQL guard only lets one win the
    // audit-emission slot.
    mockClaimAuditSlot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await Promise.all([
      confirmApplyAttempt({ attemptId: "att-1" }),
      confirmApplyAttempt({ attemptId: "att-1" }),
    ]);
    expect(mockClaimAuditSlot).toHaveBeenCalledTimes(2);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
  });
});

describe("wrapper-level node-scope recheck (round 2)", () => {
  // Acceptance for the round-2 reviewer finding: every confirm and
  // every retry must re-derive the attempt's node-specific customer
  // scope from the manager DB, NOT just trust the dispatch context's
  // tenant scope. Without this, an external retry would reach
  // `dispatcher.external()` (deployment-global Giganto / Tivan
  // endpoints) without any per-node scope check — the manager-side
  // guard inside `_internal_applyNodeViaManager` only fires on
  // manager dispatches.

  function nodeOutOfScope() {
    return {
      node: {
        id: "node-1",
        name: "n",
        nameDraft: null,
        // Customer 5 is NOT in the test session's customer scope ([10]).
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    };
  }

  it("confirmApplyAttempt rejects when the attempt's node is no longer in the caller's customer scope", async () => {
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([10]);
    mockGraphqlRequest.mockResolvedValueOnce(nodeOutOfScope());
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    // Lifecycle never ran; no dispatch reached the wire.
    expect(mockInternalConfirm).not.toHaveBeenCalled();
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
  });

  it("retryDispatch rejects when the attempt's node is no longer in the caller's customer scope", async () => {
    // The critical case: an external retry path would otherwise drive
    // `dispatcher.external()` without ever consulting the per-node
    // scope guard inside the manager helper. The wrapper-level check
    // is what closes that gap.
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([10]);
    // Round 8: retry only runs the canonical-node read for
    // `failed_retryable` rows (the only retry-side status that can
    // still reach the dispatcher). Override the default `pending` row.
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "failed_retryable",
    });
    mockGraphqlRequest.mockResolvedValueOnce(nodeOutOfScope());
    const { retryDispatch } = await import("@/lib/node/apply-actions");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      retryDispatch({ attemptId: "att-1", dispatchId: "d-ds" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockInternalRetry).not.toHaveBeenCalled();
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
  });

  it("remaps a tenant-scoped filtered-null read to NodePermissionError (round 3)", async () => {
    // Common review-web behavior: a tenant-scoped caller whose customer
    // scope does not include the node's customer sees the upstream
    // node(id) read filtered to `{ node: null }` (not a leaked
    // out-of-scope payload). `fetchCanonicalNode` surfaces that as
    // `NodeNotFoundError`, but the wrapper-level acceptance for
    // confirm/retry requires `NodePermissionError`. Without the round-3
    // remap, a scope-shrunk caller would see the wrong error class
    // and the BFF would leak "this node exists but you cannot see it"
    // semantics back to the operator.
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([10]);
    mockGraphqlRequest.mockResolvedValueOnce({ node: null });
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { NodePermissionError, NodeNotFoundError } = await import(
      "@/lib/node/errors"
    );
    const settled = await confirmApplyAttempt({ attemptId: "att-1" }).catch(
      (e: unknown) => e,
    );
    expect(settled).toBeInstanceOf(NodePermissionError);
    expect(settled).not.toBeInstanceOf(NodeNotFoundError);
    expect(mockInternalConfirm).not.toHaveBeenCalled();
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("remaps a tenant-scoped upstream NOT_FOUND to NodePermissionError (round 3)", async () => {
    // Other side of the same coin: review-web's resolver throws a
    // NOT_FOUND GraphQL error rather than returning null. The
    // `withNodeNotFoundMapping` helper turns that into
    // `NodeNotFoundError`, which the round-3 remap then converts to
    // `NodePermissionError` for tenant-scoped callers — same surface
    // as the filtered-null branch above.
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([10]);
    // Round 8: retry's canonical-node read only fires for
    // `failed_retryable`. Override the default `pending` row so this
    // retry actually exercises the recheck.
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "failed_retryable",
    });
    const notFoundErr = Object.assign(new Error("Node not found"), {
      response: {
        errors: [
          { message: "Node not found", extensions: { code: "NOT_FOUND" } },
        ],
      },
    });
    mockGraphqlRequest.mockRejectedValueOnce(notFoundErr);
    const { retryDispatch } = await import("@/lib/node/apply-actions");
    const { NodePermissionError, NodeNotFoundError } = await import(
      "@/lib/node/errors"
    );
    const settled = await retryDispatch({
      attemptId: "att-1",
      dispatchId: "d-ds",
    }).catch((e: unknown) => e);
    expect(settled).toBeInstanceOf(NodePermissionError);
    expect(settled).not.toBeInstanceOf(NodeNotFoundError);
    expect(mockInternalRetry).not.toHaveBeenCalled();
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });

  it("rejects with ApplyAttemptNotFoundError when a different actor presents the attemptId", async () => {
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // Row owned by someone else.
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "another-actor",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "pending",
    });
    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { ApplyAttemptNotFoundError } = await import("@/lib/node/errors");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(ApplyAttemptNotFoundError);
    expect(mockInternalConfirm).not.toHaveBeenCalled();
    // No canonical-node read happens — the actor check rejects first
    // (the BFF must not leak that the row exists for a foreign actor).
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});

describe("audit emission recovery — clear-on-failure (round 2)", () => {
  it("releases the slot when auditLog.record throws so a follow-up call can re-emit", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    mockAuditRecord.mockRejectedValueOnce(new Error("audit DB unavailable"));

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await expect(confirmApplyAttempt({ attemptId: "att-1" })).rejects.toThrow(
      "audit DB unavailable",
    );
    expect(mockClaimAuditSlot).toHaveBeenCalledTimes(1);
    expect(mockMarkAuditCompleted).not.toHaveBeenCalled();
    expect(mockReleaseAuditSlot).toHaveBeenCalledTimes(1);
    expect(mockReleaseAuditSlot).toHaveBeenCalledWith("att-1");
  });

  it("marks the slot completed when the audit write succeeds", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await confirmApplyAttempt({ attemptId: "att-1" });
    expect(mockClaimAuditSlot).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockMarkAuditCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkAuditCompleted).toHaveBeenCalledWith("att-1");
    expect(mockReleaseAuditSlot).not.toHaveBeenCalled();
  });

  it("a release that itself throws does NOT mask the original audit error", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    mockAuditRecord.mockRejectedValueOnce(new Error("audit DB unavailable"));
    mockReleaseAuditSlot.mockRejectedValueOnce(
      new Error("release DB also unavailable"),
    );

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await expect(confirmApplyAttempt({ attemptId: "att-1" })).rejects.toThrow(
      "audit DB unavailable",
    );
  });
});

describe("audit emission idempotency — schema unique-violation handoff (round 3)", () => {
  // Round-3 acceptance: the slot machinery is best-effort coordination
  // on top of the schema-level guarantee added in
  // `migrations/audit/0003_node_apply_correlation_unique.sql`. A
  // `unique_violation` (PG SQLSTATE 23505) on the audit insert means
  // the row already landed (recovery sweep, a partially-failed prior
  // call, etc.) — the wrapper MUST NOT release the slot in that case
  // (that would invite yet another emit→reject loop), and the
  // wrapper-level call MUST NOT propagate the duplicate-violation as
  // an error to the user (the audit IS durable, the contract held).

  function uniqueViolation(): Error {
    const err = new Error(
      'duplicate key value violates unique constraint "audit_logs_node_apply_correlation_unique"',
    );
    (err as Error & { code?: string }).code = "23505";
    return err;
  }

  it("treats a unique_violation as success: marks completed, does NOT release, does NOT throw", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    mockAuditRecord.mockRejectedValueOnce(uniqueViolation());

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    // Returns the persisted row; the audit is already durable from
    // whoever inserted first (recovery sweep, concurrent caller).
    const result = await confirmApplyAttempt({ attemptId: "att-1" });
    expect(result.status).toBe("succeeded");
    expect(mockClaimAuditSlot).toHaveBeenCalledTimes(1);
    expect(mockMarkAuditCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkAuditCompleted).toHaveBeenCalledWith("att-1");
    // Critical: NO release — releasing on a duplicate would reopen the
    // slot and let yet another caller try to insert and get rejected
    // again, which is the loop round 3 closes.
    expect(mockReleaseAuditSlot).not.toHaveBeenCalled();
  });

  it("non-23505 audit errors keep the original release-and-throw path", async () => {
    // Defense-in-depth that the round-3 narrowing did not silently
    // swallow other audit DB failures (e.g. connection refused,
    // serialization failure). Those still need the slot released so a
    // follow-up call can re-attempt.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    const err = new Error("connection refused") as Error & { code?: string };
    err.code = "08006";
    mockAuditRecord.mockRejectedValueOnce(err);

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await expect(confirmApplyAttempt({ attemptId: "att-1" })).rejects.toThrow(
      "connection refused",
    );
    expect(mockReleaseAuditSlot).toHaveBeenCalledTimes(1);
    expect(mockMarkAuditCompleted).not.toHaveBeenCalled();
  });

  it("if markCompleted fails after a successful audit insert, does NOT release (audit is already durable)", async () => {
    // The original round-2 code released on any post-insert failure,
    // which would let a follow-up call try to re-insert. Round 3
    // narrows: once the audit row is durable, the slot stays claimed
    // and the cleanup sweep recovers via the duplicate-violation path
    // on its next pass.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    mockMarkAuditCompleted.mockRejectedValueOnce(
      new Error("apply DB unavailable"),
    );

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    // The caller does NOT see the mark failure — the audit is durable,
    // and the contract is "exactly once per attempt that reaches
    // succeeded", which is satisfied.
    const result = await confirmApplyAttempt({ attemptId: "att-1" });
    expect(result.status).toBe("succeeded");
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockReleaseAuditSlot).not.toHaveBeenCalled();
  });
});

describe("manager dispatcher — globally-scoped privileged path", () => {
  it("a non-System-Administrator role with customers:access-all can apply a customerless node", async () => {
    // Custom global role: not literally "System Administrator", but
    // carries `customers:access-all`. The wrapper-level recheck and
    // the manager-side guard MUST both key off `hasGlobalScope`,
    // not the audit-only role string.
    mockGetCurrentSession.mockResolvedValue(
      makeSession({ roles: ["Cluster Operator"] }),
    );
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockInternalConfirm.mockImplementation(async (args) => {
      // Customerless `nodeInput` (no `profile.customerId` and no
      // `profileDraft.customerId`). The wrapper-level existence
      // recheck reads the canonical node but skips scope enforcement
      // for global callers, and the per-input guard inside the
      // manager helper similarly bypasses scope.
      await args.dispatcher.manager({
        attemptId: "att-1",
        nodeId: "node-1",
        nodeInput: {
          name: "n",
          nameDraft: null,
          profile: null,
          profileDraft: null,
          agents: [],
          externalServices: [],
        },
      });
      return makeRow("succeeded");
    });
    // Two outbound graphql calls: the wrapper-level existence
    // recheck (round 7) reads the canonical node first, then the
    // applyNode mutation runs. The customerless-node case still
    // succeeds because the wrapper now only enforces *existence*
    // for global callers, not customer scope.
    mockGraphqlRequest
      .mockResolvedValueOnce({
        node: {
          id: "node-1",
          name: "n",
          nameDraft: null,
          profile: null,
          profileDraft: null,
          agents: [],
          externalServices: [],
        },
      })
      .mockResolvedValueOnce({ applyNode: "node-1" });

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const result = await confirmApplyAttempt({ attemptId: "att-1" });
    expect(result.status).toBe("succeeded");
    // Two outbound graphql calls now: wrapper-level existence read,
    // then applyNode. The customerless-node case is preserved because
    // the wrapper skips scope enforcement (not the read) for global
    // callers.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
    const existenceVars = mockGraphqlRequest.mock.calls[0][1] as
      | Record<string, unknown>
      | undefined;
    expect(existenceVars).toBeDefined();
    expect((existenceVars as { id: string }).id).toBe("node-1");
    const applyVars = mockGraphqlRequest.mock.calls[1][1] as
      | Record<string, unknown>
      | undefined;
    expect(applyVars).toBeDefined();
    expect((applyVars as { id: string }).id).toBe("node-1");
  });

  it("retryDispatch on a deleted node rejects with NodeNotFoundError for a globally-scoped caller (round 7)", async () => {
    // Round-7 reviewer finding: without a wrapper-level existence
    // check for global callers, an external retry would skip the
    // manager step entirely (the manager dispatch already succeeded)
    // and drive `updateConfig` against deployment-global Giganto /
    // Tivan endpoints for a node that has since been deleted —
    // ultimately emitting `node.apply` for a missing node. The
    // wrapper now reads the canonical node on every confirm/retry
    // (existence-only for global callers, scope-enforcing for tenant
    // callers) so deletion is caught before any external dispatch.
    mockGetCurrentSession.mockResolvedValue(
      makeSession({ roles: ["Cluster Operator"] }),
    );
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    // Manager-dispatch already succeeded; only the external dispatch
    // is being retried — so the lifecycle would normally jump
    // straight to dispatcher.external() with no node lookup.
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "failed_retryable",
    });
    // review-web returns `{ node: null }` when the node has been
    // deleted (or filtered, but for global scope this can only mean
    // genuinely deleted).
    mockGraphqlRequest.mockResolvedValueOnce({ node: null });

    const { retryDispatch } = await import("@/lib/node/apply-actions");
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    await expect(
      retryDispatch({ attemptId: "att-1", dispatchId: "d-ds" }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    // No external dispatch reached the wire; the lifecycle never ran.
    expect(mockInternalRetry).not.toHaveBeenCalled();
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
    // No audit emission for a non-succeeded outcome.
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("confirmApplyAttempt on a deleted node rejects with NodeNotFoundError for a globally-scoped caller (round 7)", async () => {
    mockGetCurrentSession.mockResolvedValue(
      makeSession({ roles: ["Cluster Operator"] }),
    );
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce({ node: null });

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    expect(mockInternalConfirm).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});

describe("idempotent terminal-status paths skip the canonical-node read (round 8)", () => {
  // Round-8 reviewer finding: round 7's wrapper-level recheck was
  // unconditional, which blanket-rejected an already-`succeeded`
  // confirm/retry once the node was later deleted. The lifecycle
  // returns the persisted row idempotently for those statuses (no
  // dispatcher invoked), and that idempotent path is also what lets
  // a follow-up confirm/retry finish a still-pending `node.apply`
  // emission. The wrapper now gates the canonical-node read on
  // status: confirm reads only for `pending`, retry reads only for
  // `failed_retryable`. Other statuses fall straight to the
  // lifecycle / audit-emission path.

  it("confirmApplyAttempt against a `succeeded` row returns the persisted row without a canonical-node read", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // Row is already succeeded — lifecycle returns idempotently.
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "succeeded",
    });
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    // Audit slot already completed — no second emission.
    mockClaimAuditSlot.mockResolvedValue(false);

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const result = await confirmApplyAttempt({ attemptId: "att-1" });
    expect(result.status).toBe("succeeded");
    // Critical: the wrapper did NOT read the canonical node — gating
    // an idempotent `succeeded` confirm on a node existence read
    // would wrongly throw `NodeNotFoundError` once the node is later
    // deleted, breaking the lifecycle's idempotent-return contract.
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockInternalConfirm).toHaveBeenCalledTimes(1);
  });

  it("retryDispatch against a `succeeded` row returns the persisted row without a canonical-node read", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "succeeded",
    });
    mockInternalRetry.mockResolvedValue(makeRow("succeeded"));
    mockClaimAuditSlot.mockResolvedValue(false);

    const { retryDispatch } = await import("@/lib/node/apply-actions");
    const result = await retryDispatch({
      attemptId: "att-1",
      dispatchId: "d-ds",
    });
    expect(result.status).toBe("succeeded");
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockInternalRetry).toHaveBeenCalledTimes(1);
  });

  it("a follow-up confirm finishes a pending node.apply audit even after the node has been deleted", async () => {
    // The audit-recovery happy path: a row reaches `succeeded` but
    // the audit emission did not complete (e.g. process death between
    // claim and the audit-DB INSERT). A user-driven follow-up confirm
    // must finish the emission, even if the node has since been
    // deleted — otherwise the umbrella's "exactly once per attempt
    // that reaches succeeded" contract degrades to "exactly once per
    // attempt whose node still exists".
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "succeeded",
    });
    mockInternalConfirm.mockResolvedValue(makeRow("succeeded"));
    // Slot was unclaimed — this caller wins and emits.
    mockClaimAuditSlot.mockResolvedValue(true);
    // Wire the canonical-node read to fail (simulating a node that
    // was deleted between the success commit and this follow-up).
    // We do NOT expect this to be called; if the wrapper still issued
    // the read, the test would fail at the `not.toHaveBeenCalled`
    // assertion below or via the rejection.
    mockGraphqlRequest.mockResolvedValue({ node: null });

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    const result = await confirmApplyAttempt({ attemptId: "att-1" });
    expect(result.status).toBe("succeeded");
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockClaimAuditSlot).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockMarkAuditCompleted).toHaveBeenCalledTimes(1);
  });

  it("confirmApplyAttempt against a `failed_terminal` row skips the canonical-node read (lifecycle rejects)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockReadApplyAttempt.mockResolvedValue({
      attemptId: "att-1",
      nodeId: "node-1",
      draftFingerprint: Buffer.alloc(32),
      plannedDispatches: [],
      createdBy: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      executingLock: null,
      claimStartedAt: null,
      status: "failed_terminal",
    });
    const { ApplyAttemptTerminalError } = await import("@/lib/node/errors");
    mockInternalConfirm.mockRejectedValue(
      new ApplyAttemptTerminalError("att-1 is failed_terminal"),
    );

    const { confirmApplyAttempt } = await import("@/lib/node/apply-actions");
    await expect(
      confirmApplyAttempt({ attemptId: "att-1" }),
    ).rejects.toBeInstanceOf(ApplyAttemptTerminalError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});
