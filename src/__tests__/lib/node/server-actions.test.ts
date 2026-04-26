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
});

describe("external service server actions — happy path", () => {
  it("getGigantoStatus dispatches via gigantoClient", async () => {
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

  it("rejects a tenant admin scoped to customer 5 from applying a node into customer 7", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([5]);

    const { applyNode, NodePermissionError } = await import(
      "@/lib/node/server-actions"
    );
    await expect(
      applyNode(makeSession(), "n-1", {
        name: "x",
        nameDraft: null,
        profile: { customerId: "7", description: "", hostname: "h" },
        profileDraft: null,
        agents: [],
        externalServices: [],
      }),
    ).rejects.toBeInstanceOf(NodePermissionError);
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
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
