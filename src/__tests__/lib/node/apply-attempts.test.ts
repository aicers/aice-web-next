import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockBuildExternalConfigSnapshot = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
  withTransaction: vi.fn(),
}));

vi.mock("@/lib/node/external-config-snapshot", () => ({
  buildExternalConfigSnapshot: vi.fn(),
  buildExternalConfigSnapshotForApply: mockBuildExternalConfigSnapshot,
  externalKindsOnNode: vi.fn(),
  externalKindsOnNodes: vi.fn(),
}));

/**
 * Default `hasPermission` for a tenant-scoped caller: grants the
 * Node-management write verbs, denies `customers:access-all`. Tests
 * that need a globally-scoped caller (system administrator path)
 * override with `mockHasPermission.mockResolvedValue(true)` or a
 * permission-aware implementation.
 */
const tenantScopedPermissions = async (
  _roles: string[],
  permission: string,
): Promise<boolean> => permission !== "customers:access-all";

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

function nodePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node: {
      id: "node-1",
      name: "n",
      nameDraft: "n-draft",
      profile: { customerId: "5", description: "", hostname: "h" },
      profileDraft: null,
      agents: [],
      externalServices: [],
      ...overrides,
    },
  };
}

beforeEach(() => {
  mockHasPermission.mockReset();
  mockResolveEffectiveCustomerIds.mockReset();
  mockGraphqlRequest.mockReset();
  mockQuery.mockReset();
  mockGetCurrentSession.mockReset();
  mockGetCurrentSession.mockReset();
  mockGetCurrentSession.mockResolvedValue(makeSession());
  mockBuildExternalConfigSnapshot.mockReset();
  // Default: every external read succeeded with "unavailable"-shaped
  // miss (no entry), so the comparison-based plan builder treats the
  // applied side as absent and emits the dispatch (change intent).
  // Tests asserting the steady-state / unavailable paths override.
  mockBuildExternalConfigSnapshot.mockResolvedValue({});
});

describe("createApplyAttempt — happy path", () => {
  it("persists a new pending row with frozen external dispatches and the manager dispatch (no frozen `new`)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        externalServices: [
          {
            kind: "DATA_STORE",
            key: "k1",
            status: "ENABLED",
            draft: "{cfg:1}",
          },
          {
            kind: "TI_CONTAINER",
            key: "k2",
            status: "ENABLED",
            draft: "{cfg:2}",
          },
        ],
      }),
    );
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    mockQuery.mockResolvedValue({
      rows: [{ created_at: new Date(), expires_at: expiresAt }],
      rowCount: 1,
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const result = await createApplyAttempt({
      nodeId: "node-1",
    });

    expect(result.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.draftFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt).toBe(expiresAt.toISOString());

    // Plan shape: MANAGER_DB + MANAGER_NOTIFY + 2 external; manager
    // rows have no `new` (Phase Node-12, #333).
    expect(result.plannedDispatches).toHaveLength(4);
    const managerDb = result.plannedDispatches[0];
    expect(managerDb.kind).toBe("MANAGER_DB");
    expect("new" in managerDb).toBe(false);
    expect(managerDb.state).toBe("queued");
    expect(managerDb.attemptCount).toBe(0);

    const managerNotify = result.plannedDispatches[1];
    expect(managerNotify.kind).toBe("MANAGER_NOTIFY");
    expect("new" in managerNotify).toBe(false);
    expect(managerNotify.state).toBe("queued");

    const ext1 = result.plannedDispatches[2];
    expect(ext1.kind).toBe("DATA_STORE");
    expect("new" in ext1).toBe(true);
    if (ext1.kind === "DATA_STORE" || ext1.kind === "TI_CONTAINER") {
      expect(ext1.new).toBe("{cfg:1}");
    }

    const ext2 = result.plannedDispatches[3];
    expect(ext2.kind).toBe("TI_CONTAINER");
    if (ext2.kind === "DATA_STORE" || ext2.kind === "TI_CONTAINER") {
      expect(ext2.new).toBe("{cfg:2}");
    }

    // INSERT was called with the right column shape.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO apply_attempts/);
    expect(sql).toMatch(/customer_id/);
    expect(params?.[0]).toBe(result.attemptId);
    expect(params?.[1]).toBe("node-1");
    expect(params?.[4]).toBe("00000000-0000-0000-0000-000000000001");
    // #387: customer_id is snapshotted from the canonical node so the
    // node.apply audit emission can populate audit_logs.customer_id.
    expect(params?.[5]).toBe(5);

    // Manager mutation MUST NOT be invoked during create.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
  });

  it("plans no TI_CONTAINER dispatch when the draft matches the projected snapshot (#551 Round 2)", async () => {
    // Regression for #551 Round 2: the Tivan snapshot projection must
    // emit every field serialiseTiContainer writes (including the
    // TIVAN_HARDCODED paths) so the comparison-based plan builder
    // recognises steady state and skips the redundant external dispatch.
    const { serialiseTiContainer, TIVAN_HARDCODED } = await import(
      "@/lib/node/services/ti-container"
    );
    const { tivanConfigToToml } = await import(
      "@/lib/node/applied-config-toml"
    );
    const tiDraft = serialiseTiContainer({ webIp: "10.0.0.2", webPort: 8444 });
    mockBuildExternalConfigSnapshot.mockResolvedValue({
      TI_CONTAINER: tivanConfigToToml({
        graphqlSrvAddr: "10.0.0.2:8444",
        translateMitre: TIVAN_HARDCODED.translateMitre,
        excelData: TIVAN_HARDCODED.excelData,
        originMitre: TIVAN_HARDCODED.originMitre,
      }),
    });
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        externalServices: [
          {
            kind: "TI_CONTAINER",
            key: "k1",
            status: "ENABLED",
            draft: tiDraft,
          },
        ],
      }),
    );
    mockQuery.mockResolvedValue({
      rows: [{ created_at: new Date(), expires_at: new Date() }],
      rowCount: 1,
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const result = await createApplyAttempt({ nodeId: "node-1" });

    expect(result.plannedDispatches).toHaveLength(2);
    expect(result.plannedDispatches[0].kind).toBe("MANAGER_DB");
    expect(result.plannedDispatches[1].kind).toBe("MANAGER_NOTIFY");
    expect(
      result.plannedDispatches.some((d) => d.kind === "TI_CONTAINER"),
    ).toBe(false);
  });

  it("excludes external services with no draft from the plan", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        externalServices: [
          { kind: "DATA_STORE", key: "k1", status: "ENABLED", draft: null },
          { kind: "TI_CONTAINER", key: "k2", status: "ENABLED", draft: "{x}" },
        ],
      }),
    );
    mockQuery.mockResolvedValue({
      rows: [{ created_at: new Date(), expires_at: new Date() }],
      rowCount: 1,
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const result = await createApplyAttempt({
      nodeId: "node-1",
    });

    expect(result.plannedDispatches).toHaveLength(3);
    expect(result.plannedDispatches[0].kind).toBe("MANAGER_DB");
    expect(result.plannedDispatches[1].kind).toBe("MANAGER_NOTIFY");
    expect(result.plannedDispatches[2].kind).toBe("TI_CONTAINER");
  });
});

describe("createApplyAttempt — permission boundary", () => {
  it("rejects a caller missing nodes:write before any DB or GraphQL call", async () => {
    mockHasPermission.mockImplementation(
      async (_roles, perm) => perm === "services:write",
    );
    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    await expect(createApplyAttempt({ nodeId: "node-1" })).rejects.toThrow(
      /nodes:write/,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a caller missing services:write before any DB or GraphQL call", async () => {
    mockHasPermission.mockImplementation(
      async (_roles, perm) => perm === "nodes:write",
    );
    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    await expect(createApplyAttempt({ nodeId: "node-1" })).rejects.toThrow(
      /services:write/,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("plans normally when the caller lacks services:read but holds nodes:write + services:write (#551 Round 6)", async () => {
    // Regression for #551 Round 6: createApplyAttempt's documented gate
    // is `nodes:write + services:write` (decisions/node-permissions.md).
    // The request-time plan-build endpoint read must not silently widen
    // that to also require `services:read` — a write-only custom role
    // would otherwise lose the ability to apply change-intent externals
    // while still being able to apply delete-intent externals (no read).
    mockHasPermission.mockImplementation(
      async (_roles, perm) =>
        perm === "nodes:write" || perm === "services:write",
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockBuildExternalConfigSnapshot.mockResolvedValue({
      // Change-intent: applied side present but unequal to the draft.
      DATA_STORE: 'applied = "old"',
    });
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        externalServices: [
          {
            kind: "DATA_STORE",
            key: "k1",
            status: "ENABLED",
            draft: 'applied = "new"',
          },
        ],
      }),
    );
    mockQuery.mockResolvedValue({
      rows: [{ created_at: new Date(), expires_at: new Date() }],
      rowCount: 1,
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const result = await createApplyAttempt({ nodeId: "node-1" });

    expect(result.plannedDispatches).toHaveLength(3);
    expect(result.plannedDispatches[0].kind).toBe("MANAGER_DB");
    expect(result.plannedDispatches[1].kind).toBe("MANAGER_NOTIFY");
    expect(result.plannedDispatches[2].kind).toBe("DATA_STORE");
    // The plan-build read must not have re-run a `services:read` gate.
    const checkedPerms = mockHasPermission.mock.calls.map(
      (call: unknown[]) => call[1] as string,
    );
    expect(checkedPerms).not.toContain("services:read");
  });

  it("rejects when customer scope excludes the node (BFF defense-in-depth: upstream returned the out-of-scope payload)", async () => {
    // Tenant-scoped caller: grants nodes/services:write but NOT
    // customers:access-all, so the post-read scope check is exercised.
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([99]);
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        profile: { customerId: "5", description: "", hostname: "h" },
      }),
    );
    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    await expect(createApplyAttempt({ nodeId: "node-1" })).rejects.toThrow(
      /scope/,
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects with NodePermissionError when review-web filters the out-of-scope node to null", async () => {
    // Production review-web filters `node(id)` reads against the
    // caller's `customer_ids` from the Context JWT; an out-of-scope
    // node comes back as `{ node: null }`. The umbrella's
    // createApplyAttempt acceptance requires this to surface as
    // NodePermissionError, not NodeNotFoundError, so the same scope-
    // exclusion class produces the same error type regardless of
    // whether review-web filtered upstream or the BFF caught it
    // post-read.
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([99]);
    mockGraphqlRequest.mockResolvedValue({ node: null });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      createApplyAttempt({ nodeId: "node-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects with NodePermissionError when review-web throws a NOT_FOUND GraphQL error for the filtered node", async () => {
    // The other production shape: review-web's resolver throws when
    // the `node(id): Node!` non-nullable resolves to nothing under
    // the caller's filter. `withNodeNotFoundMapping` surfaces that as
    // `NodeNotFoundError`; we remap to `NodePermissionError` for
    // createApplyAttempt because the BFF cannot distinguish "doesn't
    // exist" from "filtered for scope" without privilege escalation,
    // and the umbrella requires scope exclusion to be a permission
    // boundary on this entrypoint.
    mockHasPermission.mockImplementation(tenantScopedPermissions);
    mockResolveEffectiveCustomerIds.mockResolvedValue([99]);
    const upstreamError = Object.assign(new Error("node not found"), {
      response: {
        errors: [
          {
            message: "node not found",
            extensions: { code: "NOT_FOUND" },
          },
        ],
      },
    });
    mockGraphqlRequest.mockRejectedValue(upstreamError);

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      createApplyAttempt({ nodeId: "node-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("preserves NodeNotFoundError for globally-scoped callers when review-web returns null (no scope boundary)", async () => {
    // A globally-scoped caller (carrying `customers:access-all`) has
    // no tenant-scope boundary to collapse missing-vs-filtered into. A
    // genuinely missing node (deleted / typoed id) should keep its
    // not-found semantics rather than being weakened into a 403-shaped
    // permission error. This mirrors `getNode`'s behaviour for the
    // same caller. The bypass is keyed off the effective permission,
    // not the audit-only role string — so a multi-role account where
    // "System Administrator" is not the first role (or any custom
    // role granting `customers:access-all`) takes the same path.
    mockGetCurrentSession.mockResolvedValue(
      makeSession({ roles: ["Custom Auditor", "System Administrator"] }),
    );
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValue({ node: null });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    await expect(
      createApplyAttempt({ nodeId: "node-1" }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("preserves NodeNotFoundError for globally-scoped callers when review-web throws NOT_FOUND (no scope boundary)", async () => {
    // The other shape — upstream throws — must also retain its real
    // not-found outcome for globally-scoped callers.
    mockGetCurrentSession.mockResolvedValue(
      makeSession({ roles: ["System Administrator"] }),
    );
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const upstreamError = Object.assign(new Error("node not found"), {
      response: {
        errors: [
          {
            message: "node not found",
            extensions: { code: "NOT_FOUND" },
          },
        ],
      },
    });
    mockGraphqlRequest.mockRejectedValue(upstreamError);

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    await expect(
      createApplyAttempt({ nodeId: "node-1" }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before any DB or GraphQL call", async () => {
    // The action MUST resolve the session inside the server boundary
    // — never trust a caller-supplied session blob. A client-side
    // forgery that sends a roles array would otherwise widen the
    // permission/scope checks. Verified by an unauthenticated session
    // (cookie missing or invalid) producing `NodePermissionError`
    // before any read or write.
    mockGetCurrentSession.mockResolvedValue(null);

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const { NodePermissionError } = await import("@/lib/node/errors");
    await expect(
      createApplyAttempt({ nodeId: "node-1" }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockHasPermission).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("createApplyAttempt — Decision 9 comparison-based dispatch planning", () => {
  it("omits the external dispatch when manager.draft structurally equals endpoint.config (steady state)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        externalServices: [
          {
            kind: "DATA_STORE",
            key: "k1",
            status: "ENABLED",
            draft: 'ingest_srv_addr = "x"\nretention = "1d"\n',
          },
        ],
      }),
    );
    mockBuildExternalConfigSnapshot.mockResolvedValue({
      // Same content, different key order — structural equality
      // must collapse it to steady state.
      DATA_STORE: 'retention = "1d"\ningest_srv_addr = "x"\n',
    });
    mockQuery.mockResolvedValue({
      rows: [{ created_at: new Date(), expires_at: new Date() }],
      rowCount: 1,
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const result = await createApplyAttempt({ nodeId: "node-1" });

    // Only MANAGER_DB + MANAGER_NOTIFY — no external dispatch.
    expect(result.plannedDispatches.map((d) => d.kind)).toEqual([
      "MANAGER_DB",
      "MANAGER_NOTIFY",
    ]);
  });

  it("rejects with ExternalServiceUnavailableError when a non-delete-intent endpoint read fails", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        externalServices: [
          {
            kind: "DATA_STORE",
            key: "k1",
            status: "ENABLED",
            draft: 'ingest_srv_addr = "x"\n',
          },
        ],
      }),
    );
    mockBuildExternalConfigSnapshot.mockResolvedValue({
      DATA_STORE: "unavailable",
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const { ExternalServiceUnavailableError } = await import(
      "@/lib/node/errors"
    );
    await expect(
      createApplyAttempt({ nodeId: "node-1" }),
    ).rejects.toBeInstanceOf(ExternalServiceUnavailableError);
    // No row was persisted.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("does not read endpoint config for delete-intent externals (draft = null)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue(
      nodePayload({
        externalServices: [
          {
            kind: "DATA_STORE",
            key: "k1",
            status: "ENABLED",
            draft: null,
          },
        ],
      }),
    );
    mockQuery.mockResolvedValue({
      rows: [{ created_at: new Date(), expires_at: new Date() }],
      rowCount: 1,
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    const result = await createApplyAttempt({ nodeId: "node-1" });

    // Plan has only manager-side dispatches; no external dispatch is
    // emitted for the delete-intent row (MANAGER_DB removes it).
    expect(result.plannedDispatches.map((d) => d.kind)).toEqual([
      "MANAGER_DB",
      "MANAGER_NOTIFY",
    ]);
    // Crucially, the endpoint snapshot was NOT consulted — the kind
    // set passed in is empty, because the only external is delete
    // intent. This keeps the apply succeeding even when the
    // unreachable endpoint would otherwise block it.
    expect(mockBuildExternalConfigSnapshot).toHaveBeenCalledTimes(0);
  });
});

describe("createApplyAttempt — read path uses the production GraphQL transport", () => {
  it("hits graphqlRequest from @/lib/graphql/client (not a swapped-in reader)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue(nodePayload());
    mockQuery.mockResolvedValue({
      rows: [{ created_at: new Date(), expires_at: new Date() }],
      rowCount: 1,
    });

    const { createApplyAttempt } = await import("@/lib/node/apply-attempts");
    await createApplyAttempt({ nodeId: "node-1" });

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    // Same call shape as getNode: variables `{ id }`, context `{ role, customerIds }`.
    const call = mockGraphqlRequest.mock.calls[0];
    expect(call[1]).toEqual({ id: "node-1" });
    expect(call[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [5],
    });
  });
});
