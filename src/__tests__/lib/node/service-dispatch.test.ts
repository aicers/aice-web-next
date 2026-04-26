import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DispatchContext } from "@/lib/node/dispatch-context";

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

const ctx: DispatchContext = {
  role: "Tenant Administrator",
  customerIds: [1],
};

beforeEach(() => {
  mockHasPermission.mockReset();
  mockHasPermission.mockResolvedValue(true);
  mockResolveEffectiveCustomerIds.mockReset();
  mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
  mockGraphqlRequest.mockReset();
  mockGigantoClient.mockReset();
  mockTivanClient.mockReset();
});

/** A node carrying every service kind the BFF cares about. */
const nodeWithAllServices = {
  id: "n-1",
  name: "n",
  nameDraft: null,
  profile: { customerId: "1", description: "", hostname: "h" },
  profileDraft: null,
  agents: [
    {
      node: 1,
      key: "k",
      kind: "UNSUPERVISED" as const,
      status: "ENABLED" as const,
      config: "applied-unsupervised",
      draft: "draft-unsupervised",
    },
    {
      node: 1,
      key: "k",
      kind: "SEMI_SUPERVISED" as const,
      status: "ENABLED" as const,
      config: "applied-semi",
      draft: "draft-semi",
    },
    {
      node: 1,
      key: "k",
      kind: "SENSOR" as const,
      status: "ENABLED" as const,
      config: "applied-sensor",
      draft: "draft-sensor",
    },
    {
      node: 1,
      key: "k",
      kind: "TIME_SERIES_GENERATOR" as const,
      status: "ENABLED" as const,
      config: "applied-tsg",
      draft: "draft-tsg",
    },
  ],
  externalServices: [
    {
      node: 1,
      key: "k",
      kind: "DATA_STORE" as const,
      status: "ENABLED" as const,
      draft: "draft-giganto",
    },
    {
      node: 1,
      key: "k",
      kind: "TI_CONTAINER" as const,
      status: "ENABLED" as const,
      draft: "draft-tivan",
    },
  ],
};

describe("service-dispatch — type routing across all seven services", () => {
  it("getApplied for every agent kind reads the agent's config off the Node payload (no network call)", async () => {
    const { getApplied } = await import("@/lib/node/service-dispatch");
    expect(await getApplied(ctx, nodeWithAllServices, "UNSUPERVISED")).toBe(
      "applied-unsupervised",
    );
    expect(await getApplied(ctx, nodeWithAllServices, "SEMI_SUPERVISED")).toBe(
      "applied-semi",
    );
    expect(await getApplied(ctx, nodeWithAllServices, "SENSOR")).toBe(
      "applied-sensor",
    );
    expect(
      await getApplied(ctx, nodeWithAllServices, "TIME_SERIES_GENERATOR"),
    ).toBe("applied-tsg");
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("getApplied for DATA_STORE dispatches via gigantoClient with the supplied DispatchContext (never re-derives scope)", async () => {
    mockGigantoClient.mockResolvedValue({
      config: {
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
      },
    });
    const { getApplied } = await import("@/lib/node/service-dispatch");
    await getApplied(ctx, nodeWithAllServices, "DATA_STORE");
    expect(mockGigantoClient).toHaveBeenCalledTimes(1);
    expect(mockGigantoClient.mock.calls[0]?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockTivanClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    // Helper must not pull tenant scope or a permission check from
    // somewhere other than the supplied context.
    expect(mockResolveEffectiveCustomerIds).not.toHaveBeenCalled();
    expect(mockHasPermission).not.toHaveBeenCalled();
  });

  it("getApplied for TI_CONTAINER dispatches via tivanClient with the supplied DispatchContext", async () => {
    mockTivanClient.mockResolvedValue({
      config: {
        graphqlSrvAddr: ":1",
        translateMitre: "x",
        excelData: null,
        originMitre: null,
      },
    });
    const { getApplied } = await import("@/lib/node/service-dispatch");
    await getApplied(ctx, nodeWithAllServices, "TI_CONTAINER");
    expect(mockTivanClient).toHaveBeenCalledTimes(1);
    expect(mockTivanClient.mock.calls[0]?.[2]).toEqual({
      role: "Tenant Administrator",
      customerIds: [1],
    });
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockResolveEffectiveCustomerIds).not.toHaveBeenCalled();
    expect(mockHasPermission).not.toHaveBeenCalled();
  });

  it("getApplied for MANAGER routes to review-web (the Node payload) and returns null in v1", async () => {
    const { getApplied } = await import("@/lib/node/service-dispatch");
    // v1 review-web does not expose a per-node manager config; the
    // call resolves to null without dispatching to any backend.
    expect(await getApplied(ctx, nodeWithAllServices, "MANAGER")).toBeNull();
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it("getDraft for every kind (including MANAGER) reads off the Node payload (manager-side, no network call)", async () => {
    const { getDraft } = await import("@/lib/node/service-dispatch");
    expect(getDraft(ctx, nodeWithAllServices, "UNSUPERVISED")).toBe(
      "draft-unsupervised",
    );
    expect(getDraft(ctx, nodeWithAllServices, "SEMI_SUPERVISED")).toBe(
      "draft-semi",
    );
    expect(getDraft(ctx, nodeWithAllServices, "SENSOR")).toBe("draft-sensor");
    expect(getDraft(ctx, nodeWithAllServices, "TIME_SERIES_GENERATOR")).toBe(
      "draft-tsg",
    );
    expect(getDraft(ctx, nodeWithAllServices, "DATA_STORE")).toBe(
      "draft-giganto",
    );
    expect(getDraft(ctx, nodeWithAllServices, "TI_CONTAINER")).toBe(
      "draft-tivan",
    );
    expect(getDraft(ctx, nodeWithAllServices, "MANAGER")).toBeNull();
    expect(mockGigantoClient).not.toHaveBeenCalled();
    expect(mockTivanClient).not.toHaveBeenCalled();
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});
