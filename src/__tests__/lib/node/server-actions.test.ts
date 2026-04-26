import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGraphqlRequest = vi.hoisted(() => vi.fn());
const mockGigantoClient = vi.hoisted(() => vi.fn());
const mockTivanClient = vi.hoisted(() => vi.fn());

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

/**
 * Build a stub `hasPermission` that reflects an arbitrary permission
 * grant set. Use this to drive split-role tests (e.g. holding
 * `nodes:read` but not `services:read`).
 */
function grantOnly(
  ...granted: string[]
): (roles: string[], permission: string) => Promise<boolean> {
  return async (_roles, permission) => granted.includes(permission);
}

beforeEach(() => {
  mockHasPermission.mockReset();
  mockResolveEffectiveCustomerIds.mockReset();
  mockGraphqlRequest.mockReset();
  mockGigantoClient.mockReset();
  mockTivanClient.mockReset();
});

// ── Happy paths ────────────────────────────────────────────────────

describe("manager server actions — happy path", () => {
  it("listNodes dispatches via graphqlRequest with materialized scope", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    mockGraphqlRequest.mockResolvedValue({
      nodeList: {
        edges: [],
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: "0",
      },
    });

    const { listNodes } = await import("@/lib/node/server-actions");
    const conn = await listNodes(makeSession(), { first: 10 });

    expect(conn.totalCount).toBe("0");
    const call = mockGraphqlRequest.mock.calls.at(-1);
    expect(call?.[1]).toEqual({
      first: 10,
      after: null,
      last: null,
      before: null,
    });
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1, 2],
    });
  });

  it("getNode permits a tenant admin to read an in-scope node", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue({
      node: {
        id: "n-1",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { getNode } = await import("@/lib/node/server-actions");
    const node = await getNode(makeSession(), "n-1");
    expect(node.id).toBe("n-1");
  });

  it("listNodeStatuses dispatches via graphqlRequest with materialized scope", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    mockGraphqlRequest.mockResolvedValue({
      nodeStatusList: {
        edges: [],
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: "0",
      },
    });

    const { listNodeStatuses } = await import("@/lib/node/server-actions");
    const conn = await listNodeStatuses(makeSession(), {
      last: 5,
      before: "x",
    });

    expect(conn.totalCount).toBe("0");
    const call = mockGraphqlRequest.mock.calls.at(-1);
    expect(call?.[1]).toEqual({
      first: null,
      after: null,
      last: 5,
      before: "x",
    });
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1, 2],
    });
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
  });

  it("insertNode dispatches via graphqlRequest with the supplied payload and returns the new id", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue({ insertNode: "n-new" });

    const args = {
      name: "n",
      customerId: "5",
      description: "d",
      hostname: "h",
      agents: [],
      externalServices: [],
    };
    const { insertNode } = await import("@/lib/node/server-actions");
    const id = await insertNode(makeSession(), args);

    expect(id).toBe("n-new");
    const call = mockGraphqlRequest.mock.calls.at(-1);
    expect(call?.[1]).toEqual(args);
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [5],
    });
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
  });

  it("updateNodeDraft fetches the canonical node, then dispatches the mutation with id/old/new", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // 1st call: canonical-node fetch by id.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-5",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    // 2nd call: updateNodeDraft mutation.
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-5" });

    const oldNode = {
      name: "n",
      nameDraft: null,
      profile: { customerId: "5", description: "", hostname: "h" },
      profileDraft: null,
      agents: [],
      externalServices: [],
    };
    const newDraft = {
      nameDraft: "n2",
      profileDraft: { customerId: "5", description: "d", hostname: "h" },
      agents: null,
      externalServices: null,
    };

    const { updateNodeDraft } = await import("@/lib/node/server-actions");
    const result = await updateNodeDraft(
      makeSession(),
      "n-5",
      oldNode,
      newDraft,
    );

    expect(result).toBe("n-5");
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
    const mutation = mockGraphqlRequest.mock.calls.at(-1);
    expect(mutation?.[1]).toEqual({ id: "n-5", old: oldNode, new: newDraft });
    expect(mutation?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [5],
    });
  });

  it("removeNodes dispatches via graphqlRequest with the id list and returns the manager's id list", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    // Preflight per id (in-scope), then the delete mutation.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-1",
        name: "n",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-2",
        name: "n",
        nameDraft: null,
        profile: { customerId: "1", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({
      removeNodes: ["n-1", "n-2"],
    });

    const { removeNodes } = await import("@/lib/node/server-actions");
    const result = await removeNodes(makeSession(), ["n-1", "n-2"]);

    expect(result).toEqual(["n-1", "n-2"]);
    const mutation = mockGraphqlRequest.mock.calls.at(-1);
    expect(mutation?.[1]).toEqual({ ids: ["n-1", "n-2"] });
    expect(mutation?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
  });

  it("nodeReboot dispatches by hostname (not id) and returns the manager's reply", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockGraphqlRequest.mockResolvedValue({ nodeReboot: "host-1" });

    const { nodeReboot } = await import("@/lib/node/server-actions");
    const result = await nodeReboot(makeSession(), "host-1");

    expect(result).toBe("host-1");
    const call = mockGraphqlRequest.mock.calls.at(-1);
    expect(call?.[1]).toEqual({ hostname: "host-1" });
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
  });

  it("nodeShutdown dispatches by hostname (not id) and returns the manager's reply", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockGraphqlRequest.mockResolvedValue({ nodeShutdown: "host-1" });

    const { nodeShutdown } = await import("@/lib/node/server-actions");
    const result = await nodeShutdown(makeSession(), "host-1");

    expect(result).toBe("host-1");
    const call = mockGraphqlRequest.mock.calls.at(-1);
    expect(call?.[1]).toEqual({ hostname: "host-1" });
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
  });
});

describe("external service server actions — happy path", () => {
  it("getGigantoStatus dispatches via gigantoClient with the materialized scope and no variables", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockGigantoClient.mockResolvedValue({
      status: {
        name: "g",
        cpuUsage: 1,
        totalMemory: 1,
        usedMemory: 1,
        diskUsedBytes: 1,
        diskAvailableBytes: 1,
      },
    });

    const { getGigantoStatus } = await import("@/lib/node/server-actions");
    const status = await getGigantoStatus(makeSession());
    expect(status.name).toBe("g");
    expect(mockGigantoClient).toHaveBeenCalledTimes(1);
    const call = mockGigantoClient.mock.calls[0];
    expect(call?.[1]).toBeUndefined();
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockTivanClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("updateTivanConfig dispatches via tivanClient", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockTivanClient.mockResolvedValue({
      updateConfig: {
        graphqlSrvAddr: ":1",
        translateMitre: "x",
        excelData: null,
        originMitre: null,
      },
    });

    const { updateTivanConfig } = await import("@/lib/node/server-actions");
    const cfg = await updateTivanConfig(makeSession(), "old", "new");
    expect(cfg.graphqlSrvAddr).toBe(":1");
    expect(mockTivanClient).toHaveBeenCalledTimes(1);
    const call = mockTivanClient.mock.calls[0];
    expect(call?.[1]).toEqual({ old: "old", new: "new" });
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("getGigantoConfig dispatches via gigantoClient and returns the unwrapped config", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const config = {
      ingestSrvAddr: "i",
      publishSrvAddr: "p",
      graphqlSrvAddr: "g",
      retention: "1d",
      exportDir: "/e",
      dataDir: "/d",
      maxOpenFiles: 1,
      maxMbOfLevelBase: "1",
      numOfThread: 1,
      maxSubcompactions: "1",
      ackTransmission: 1,
    };
    mockGigantoClient.mockResolvedValue({ config });

    const { getGigantoConfig } = await import("@/lib/node/server-actions");
    expect(await getGigantoConfig(makeSession())).toEqual(config);
    const call = mockGigantoClient.mock.calls[0];
    expect(call?.[1]).toBeUndefined();
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockTivanClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("updateGigantoConfig dispatches via gigantoClient with old/new and returns the unwrapped config", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const config = {
      ingestSrvAddr: "i2",
      publishSrvAddr: "p2",
      graphqlSrvAddr: "g2",
      retention: "2d",
      exportDir: "/e",
      dataDir: "/d",
      maxOpenFiles: 1,
      maxMbOfLevelBase: "1",
      numOfThread: 1,
      maxSubcompactions: "1",
      ackTransmission: 1,
    };
    mockGigantoClient.mockResolvedValue({ updateConfig: config });

    const { updateGigantoConfig } = await import("@/lib/node/server-actions");
    expect(await updateGigantoConfig(makeSession(), "old", "new")).toEqual(
      config,
    );
    const call = mockGigantoClient.mock.calls[0];
    expect(call?.[1]).toEqual({ old: "old", new: "new" });
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockTivanClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("getTivanStatus dispatches via tivanClient and returns the unwrapped status", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const status = {
      name: "t",
      cpuUsage: 1,
      totalMemory: 1,
      usedMemory: 1,
      diskUsedBytes: 1,
      diskAvailableBytes: 1,
    };
    mockTivanClient.mockResolvedValue({ status });

    const { getTivanStatus } = await import("@/lib/node/server-actions");
    expect(await getTivanStatus(makeSession())).toEqual(status);
    const call = mockTivanClient.mock.calls[0];
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("getTivanConfig dispatches via tivanClient and returns the unwrapped config", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const config = {
      graphqlSrvAddr: ":1",
      translateMitre: "x",
      excelData: null,
      originMitre: null,
    };
    mockTivanClient.mockResolvedValue({ config });

    const { getTivanConfig } = await import("@/lib/node/server-actions");
    expect(await getTivanConfig(makeSession())).toEqual(config);
    const call = mockTivanClient.mock.calls[0];
    expect(call?.[1]).toBeUndefined();
    expect(call?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});

// ── Permission boundary ────────────────────────────────────────────

describe("manager server actions — permission boundary", () => {
  it("rejects a caller without nodes:read before dispatching", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { listNodes, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(listNodes(makeSession())).rejects.toBeInstanceOf(
      NodePermissionError,
    );
    expect(mockResolveEffectiveCustomerIds).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("rejects a non-System-Administrator with empty customer_ids before dispatching", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { listNodes, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(listNodes(makeSession())).rejects.toBeInstanceOf(
      NodePermissionError,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});

// ── Combined node + service permission gate (Phase Node-1 page rule) ─

describe("combined node/service permission gate", () => {
  it("listNodes rejects a caller holding nodes:read but missing services:read", async () => {
    mockHasPermission.mockImplementation(grantOnly("nodes:read"));
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { listNodes, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(listNodes(makeSession())).rejects.toBeInstanceOf(
      NodePermissionError,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("getNode rejects a caller holding services:read but missing nodes:read", async () => {
    mockHasPermission.mockImplementation(grantOnly("services:read"));
    const { getNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(getNode(makeSession(), "n-1")).rejects.toBeInstanceOf(
      NodePermissionError,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("listNodeStatuses rejects a caller missing services:read", async () => {
    mockHasPermission.mockImplementation(grantOnly("nodes:read"));
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { listNodeStatuses, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(listNodeStatuses(makeSession())).rejects.toBeInstanceOf(
      NodePermissionError,
    );
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("insertNode rejects a caller holding nodes:write but missing services:write", async () => {
    mockHasPermission.mockImplementation(grantOnly("nodes:write"));
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    const { insertNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      insertNode(makeSession(), {
        name: "x",
        customerId: "5",
        description: "",
        hostname: "h",
        agents: [],
        externalServices: [],
      }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("updateNodeDraft rejects a caller holding services:write but missing nodes:write", async () => {
    mockHasPermission.mockImplementation(grantOnly("services:write"));
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    const { updateNodeDraft, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      updateNodeDraft(
        makeSession(),
        "n-1",
        {
          name: "x",
          nameDraft: null,
          profile: { customerId: "5", description: "", hostname: "h" },
          profileDraft: null,
          agents: [],
          externalServices: [],
        },
        {
          nameDraft: "x",
          profileDraft: { customerId: "5", description: "", hostname: "h" },
          agents: null,
          externalServices: null,
        },
      ),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("applyNode rejects a caller holding nodes:write but missing services:write", async () => {
    mockHasPermission.mockImplementation(grantOnly("nodes:write"));
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    const { applyNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      applyNode(makeSession(), "n-1", {
        name: "x",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});

// ── Tenant scope boundary ──────────────────────────────────────────

describe("tenant scope boundary", () => {
  it("rejects a tenant admin scoped to customer 5 from reading a node owned by customer 7", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue({
      node: {
        id: "n-1",
        name: "n",
        nameDraft: null,
        profile: { customerId: "7", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { getNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(getNode(makeSession(), "n-1")).rejects.toBeInstanceOf(
      NodePermissionError,
    );
  });

  it("rejects a tenant admin scoped to customer 5 from inserting a node into customer 7", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const { insertNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      insertNode(makeSession(), {
        name: "x",
        customerId: "7",
        description: "",
        hostname: "h",
        agents: [],
        externalServices: [],
      }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("rejects a tenant admin scoped to customer 5 from applying a node when the canonical record belongs to customer 7 (forged-payload defence)", async () => {
    // Caller holds the right permissions and is in scope for customer 5.
    // The id `n-7` belongs to customer 7. The forged payload claims to
    // be an in-scope (customer 5) update — the BFF must verify against
    // the canonical record fetched by id, not the payload.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue({
      node: {
        id: "n-7",
        name: "n",
        nameDraft: null,
        profile: { customerId: "7", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { applyNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      applyNode(makeSession(), "n-7", {
        name: "x",
        nameDraft: null,
        // Forged: claims customer 5 to bypass payload-based scope check.
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    // The canonical fetch is allowed, but the apply mutation must not
    // have been dispatched.
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "node" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it("rejects a tenant admin scoped to customer 5 from updating a node draft when the canonical record belongs to customer 7", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValue({
      node: {
        id: "n-7",
        name: "n",
        nameDraft: null,
        profile: { customerId: "7", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { updateNodeDraft, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      updateNodeDraft(
        makeSession(),
        "n-7",
        {
          name: "x",
          nameDraft: null,
          // Forged: claims customer 5 in the `old` payload.
          profile: { customerId: "5", description: "", hostname: "h" },
          profileDraft: null,
          agents: [],
          externalServices: [],
        },
        {
          nameDraft: "x",
          profileDraft: { customerId: "5", description: "", hostname: "h" },
          agents: null,
          externalServices: null,
        },
      ),
    ).rejects.toBeInstanceOf(NodePermissionError);
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it("permits a tenant admin to apply a node that is in their scope", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // First call: canonical-node fetch.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-5",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    // Second call: applyNode mutation result.
    mockGraphqlRequest.mockResolvedValueOnce({ applyNode: "n-5" });

    const { applyNode } = await import("@/lib/node/server-actions");
    const result = await applyNode(makeSession(), "n-5", {
      name: "x",
      nameDraft: null,
      profile: { customerId: "5", description: "", hostname: "h" },
      profileDraft: null,
      agents: [],
      externalServices: [],
    });
    expect(result).toBe("n-5");
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(2);
  });

  it("System Administrator skips the canonical-node fetch on apply (no extra round trip)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce({ applyNode: "n-1" });

    const { applyNode } = await import("@/lib/node/server-actions");
    const result = await applyNode(
      makeSession({ roles: ["System Administrator"] }),
      "n-1",
      {
        name: "x",
        nameDraft: null,
        profile: null,
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    );
    expect(result).toBe("n-1");
    // Only the mutation was dispatched — no canonical-node fetch.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a tenant admin who saves a draft with no proposed customer (profileDraft: null)", async () => {
    // Without this gate, the canonical preflight would pass for an
    // in-scope node, and `updateNodeDraft` would dispatch a draft that
    // blanks out the customer — moving the node into a "customerless"
    // state that this same module treats as System-Administrator-only
    // on read. The write side has to symmetrically refuse.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-5",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { updateNodeDraft, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      updateNodeDraft(
        makeSession(),
        "n-5",
        {
          name: "n",
          nameDraft: null,
          profile: { customerId: "5", description: "", hostname: "h" },
          profileDraft: null,
          agents: [],
          externalServices: [],
        },
        {
          nameDraft: "n2",
          profileDraft: null,
          agents: null,
          externalServices: null,
        },
      ),
    ).rejects.toBeInstanceOf(NodePermissionError);
    // Only the canonical preflight ran; no mutation dispatched.
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "old" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it("permits a System Administrator to save a customerless draft", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce({ updateNodeDraft: "n-1" });

    const { updateNodeDraft } = await import("@/lib/node/server-actions");
    const result = await updateNodeDraft(
      makeSession({ roles: ["System Administrator"] }),
      "n-1",
      {
        name: "n",
        nameDraft: null,
        profile: null,
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
      {
        nameDraft: "n2",
        profileDraft: null,
        agents: null,
        externalServices: null,
      },
    );
    expect(result).toBe("n-1");
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a tenant admin who applies a customerless target (profile: null and profileDraft: null)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-5",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { applyNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      applyNode(makeSession(), "n-5", {
        name: "x",
        nameDraft: null,
        profile: null,
        profileDraft: null,
        agents: [],
        externalServices: [],
      }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "node" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });
});

// ── removeNodes preflight scope ────────────────────────────────────

describe("removeNodes — canonical-id preflight", () => {
  it("rejects a tenant admin scoped to customer 5 from deleting a node owned by customer 7", async () => {
    // Caller holds nodes:delete and is in scope for customer 5; the id
    // `n-7` belongs to customer 7. The BFF must reject before the
    // delete mutation reaches the wire.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-7",
        name: "n",
        nameDraft: null,
        profile: { customerId: "7", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { removeNodes, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(removeNodes(makeSession(), ["n-7"])).rejects.toBeInstanceOf(
      NodePermissionError,
    );
    // No `removeNodes` mutation dispatched.
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "ids" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it("rejects a tenant admin if any single id in a batch is out of scope", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // First id in scope, second id out of scope. The preflight must
    // reject the whole batch — partial deletes silently skipping
    // out-of-scope ids would mask a permission failure.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-5",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-7",
        name: "n",
        nameDraft: null,
        profile: { customerId: "7", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });

    const { removeNodes, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      removeNodes(makeSession(), ["n-5", "n-7"]),
    ).rejects.toBeInstanceOf(NodePermissionError);
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "ids" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it("translates a missing-id during the removeNodes preflight into NodeNotFoundError", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    const notFound = Object.assign(new Error("not found"), {
      response: {
        errors: [
          {
            message: "Node n-missing was not found",
            extensions: { code: "NOT_FOUND" },
          },
        ],
      },
    });
    mockGraphqlRequest.mockRejectedValueOnce(notFound);

    const { removeNodes, NodeNotFoundError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      removeNodes(makeSession(), ["n-missing"]),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "ids" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it("permits a tenant admin to delete in-scope nodes (preflight + mutation)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // Two preflight fetches, one for each id.
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-5a",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({
      node: {
        id: "n-5b",
        name: "n",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      },
    });
    mockGraphqlRequest.mockResolvedValueOnce({
      removeNodes: ["n-5a", "n-5b"],
    });

    const { removeNodes } = await import("@/lib/node/server-actions");
    const result = await removeNodes(makeSession(), ["n-5a", "n-5b"]);
    expect(result).toEqual(["n-5a", "n-5b"]);
    // Two preflights + the one delete mutation.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(3);
  });

  it("System Administrator skips the canonical-node preflight on removeNodes", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    mockGraphqlRequest.mockResolvedValueOnce({
      removeNodes: ["n-1", "n-2"],
    });

    const { removeNodes } = await import("@/lib/node/server-actions");
    const result = await removeNodes(
      makeSession({ roles: ["System Administrator"] }),
      ["n-1", "n-2"],
    );
    expect(result).toEqual(["n-1", "n-2"]);
    // Only the mutation, no preflight round trips.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const call = mockGraphqlRequest.mock.calls[0];
    expect(call?.[1]).toEqual({ ids: ["n-1", "n-2"] });
  });
});

// ── Manager-offline / external-unreachable behaviour ───────────────

describe("graceful-degradation error mapping", () => {
  it("wraps a connection-refused on the manager as ManagerUnavailableError", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const refused: NodeJS.ErrnoException = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:8443"),
      { code: "ECONNREFUSED" },
    );
    mockGraphqlRequest.mockRejectedValue(refused);

    const { listNodes, ManagerUnavailableError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(listNodes(makeSession())).rejects.toBeInstanceOf(
      ManagerUnavailableError,
    );
  });

  it("wraps a TypeError fetch failure on the manager as ManagerUnavailableError", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockGraphqlRequest.mockRejectedValue(new TypeError("fetch failed"));

    const { listNodes, ManagerUnavailableError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(listNodes(makeSession())).rejects.toBeInstanceOf(
      ManagerUnavailableError,
    );
  });

  it("wraps a connection-refused on Giganto as ExternalServiceUnavailableError", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const refused: NodeJS.ErrnoException = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:8443"),
      { code: "ECONNREFUSED" },
    );
    mockGigantoClient.mockRejectedValue(refused);

    const { getGigantoStatus, ExternalServiceUnavailableError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(getGigantoStatus(makeSession())).rejects.toBeInstanceOf(
      ExternalServiceUnavailableError,
    );
  });

  it("wraps a connection-refused on Tivan as ExternalServiceUnavailableError", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const refused: NodeJS.ErrnoException = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:8443"),
      { code: "ECONNREFUSED" },
    );
    mockTivanClient.mockRejectedValue(refused);

    const { getTivanStatus, ExternalServiceUnavailableError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(getTivanStatus(makeSession())).rejects.toBeInstanceOf(
      ExternalServiceUnavailableError,
    );
  });

  it("does not swallow GraphQL validation errors as connection failures", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    // Errors in the GraphQL response payload come back as a regular
    // Error from graphql-request (no `code` property), not a TypeError.
    // These describe a malformed query, not an offline backend, so they
    // must not be remapped to ManagerUnavailableError.
    const validationErr = new Error("Cannot query field 'foo' on type 'Bar'");
    mockGraphqlRequest.mockRejectedValue(validationErr);

    const { listNodes, ManagerUnavailableError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(listNodes(makeSession())).rejects.not.toBeInstanceOf(
      ManagerUnavailableError,
    );
  });

  it("translates a missing-node GraphQL error from getNode into NodeNotFoundError", async () => {
    // review-web declares `node(id: ID!): Node!` as non-nullable; a
    // missing id surfaces as a rejected `graphql-request` promise
    // carrying a `response.errors[]` array — never as `{ node: null }`.
    // The wrapper must translate to the typed 404 so Phase Node-9's
    // stale-conflict replay can detect it.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    const notFound = Object.assign(new Error("Node not found"), {
      response: {
        errors: [
          {
            message: "Node n-missing was not found",
            extensions: { code: "NOT_FOUND" },
          },
        ],
      },
    });
    mockGraphqlRequest.mockRejectedValue(notFound);

    const { getNode, NodeNotFoundError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(getNode(makeSession(), "n-missing")).rejects.toBeInstanceOf(
      NodeNotFoundError,
    );
  });

  it("translates a missing-node error during applyNode's canonical preflight into NodeNotFoundError", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    const notFound = Object.assign(new Error("not found"), {
      response: {
        errors: [{ message: "node does not exist" }],
      },
    });
    mockGraphqlRequest.mockRejectedValue(notFound);

    const { applyNode, NodeNotFoundError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      applyNode(makeSession(), "n-missing", {
        name: "x",
        nameDraft: null,
        profile: { customerId: "5", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    // The mutation must not have been dispatched.
    const mutationCalls = mockGraphqlRequest.mock.calls.filter(
      (c) => c[1] && "node" in (c[1] as Record<string, unknown>),
    );
    expect(mutationCalls).toHaveLength(0);
  });

  it("does not remap a generic GraphQL error from getNode to NodeNotFoundError", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);
    // A generic resolver error (e.g., 500 / authn) carries an errors[]
    // array but no not-found marker. It must NOT be cast as 404.
    const generic = Object.assign(new Error("internal server error"), {
      response: {
        errors: [{ message: "internal server error" }],
      },
    });
    mockGraphqlRequest.mockRejectedValue(generic);

    const { getNode, NodeNotFoundError, ManagerUnavailableError } =
      await import("@/lib/node/server-actions");
    await expect(getNode(makeSession(), "n-1")).rejects.not.toBeInstanceOf(
      NodeNotFoundError,
    );
    await expect(getNode(makeSession(), "n-1")).rejects.not.toBeInstanceOf(
      ManagerUnavailableError,
    );
  });
});

// ── Endpoint routing assertion ────────────────────────────────────

describe("endpoint routing", () => {
  it("getGigantoStatus never reaches the review-web client", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockGigantoClient.mockResolvedValue({
      status: {
        name: "g",
        cpuUsage: 0,
        totalMemory: 0,
        usedMemory: 0,
        diskUsedBytes: 0,
        diskAvailableBytes: 0,
      },
    });
    const { getGigantoStatus } = await import("@/lib/node/server-actions");
    await getGigantoStatus(makeSession());
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
  });

  it("getTivanStatus never reaches the Giganto client or review-web", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    mockTivanClient.mockResolvedValue({
      status: {
        name: "t",
        cpuUsage: 0,
        totalMemory: 0,
        usedMemory: 0,
        diskUsedBytes: 0,
        diskAvailableBytes: 0,
      },
    });
    const { getTivanStatus } = await import("@/lib/node/server-actions");
    await getTivanStatus(makeSession());
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockGigantoClient).not.toHaveBeenCalled();
  });
});
