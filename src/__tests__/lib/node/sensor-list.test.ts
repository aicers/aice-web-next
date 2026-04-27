import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import { collectSensorNodes, listSensorNodes } from "@/lib/node/sensor-list";
import type { Node as ManagerNode } from "@/lib/node/types";

const mockListAllNodes = vi.fn();

vi.mock("@/lib/node/server-actions", () => ({
  listAllNodes: (...args: unknown[]) => mockListAllNodes(...args),
}));

function makeNode(overrides: Partial<ManagerNode>): ManagerNode {
  return {
    id: overrides.id ?? "node-1",
    name: overrides.name ?? "node-1",
    nameDraft: overrides.nameDraft ?? null,
    profile: overrides.profile ?? null,
    profileDraft: overrides.profileDraft ?? null,
    agents: overrides.agents ?? [],
    externalServices: overrides.externalServices ?? [],
  };
}

describe("collectSensorNodes", () => {
  it("includes only nodes whose agents include a SENSOR kind", () => {
    const nodes = [
      makeNode({
        id: "n1",
        agents: [
          {
            node: 1,
            key: "piglet",
            kind: "SENSOR",
            status: "ENABLED",
            config: null,
            draft: null,
          },
        ],
      }),
      makeNode({
        id: "n2",
        agents: [
          {
            node: 2,
            key: "hog",
            kind: "SEMI_SUPERVISED",
            status: "ENABLED",
            config: null,
            draft: null,
          },
        ],
      }),
    ];
    const result = collectSensorNodes(nodes);
    expect(result.map((r) => r.id)).toEqual(["n1"]);
  });

  it("aggregates sensor nodes from every page (de-duplicated)", () => {
    // Simulate three pages of sensor-bearing nodes accumulated by
    // listAllNodes; the helper should produce one row per unique id.
    const pages = [
      makeNode({
        id: "n1",
        agents: [
          {
            node: 1,
            key: "piglet",
            kind: "SENSOR",
            status: "ENABLED",
            config: null,
            draft: null,
          },
        ],
      }),
      makeNode({
        id: "n2",
        agents: [
          {
            node: 2,
            key: "piglet",
            kind: "SENSOR",
            status: "ENABLED",
            config: null,
            draft: null,
          },
        ],
      }),
      makeNode({
        id: "n3",
        agents: [
          {
            node: 3,
            key: "piglet",
            kind: "SENSOR",
            status: "ENABLED",
            config: null,
            draft: null,
          },
        ],
      }),
      makeNode({
        id: "n1",
        agents: [
          {
            node: 1,
            key: "piglet",
            kind: "SENSOR",
            status: "ENABLED",
            config: null,
            draft: null,
          },
        ],
      }),
    ];
    const result = collectSensorNodes(pages);
    expect(result.map((r) => r.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("prefers the draft hostname when both profiles exist", () => {
    const node = makeNode({
      id: "n1",
      profile: { customerId: "1", description: "", hostname: "applied" },
      profileDraft: {
        customerId: "1",
        description: "",
        hostname: "draft",
      },
      agents: [
        {
          node: 1,
          key: "piglet",
          kind: "SENSOR",
          status: "ENABLED",
          config: null,
          draft: null,
        },
      ],
    });
    expect(collectSensorNodes([node])[0]?.hostname).toBe("draft");
  });
});

describe("listSensorNodes", () => {
  beforeEach(() => {
    mockListAllNodes.mockReset();
  });

  function session(): AuthSession {
    const now = Math.floor(Date.now() / 1000);
    return {
      accountId: "admin-1",
      sessionId: "session-1",
      roles: ["System Administrator"],
      tokenVersion: 0,
      mustChangePassword: false,
      mustEnrollMfa: false,
      iat: now,
      exp: now + 900,
      jti: "jti-1",
    } as unknown as AuthSession;
  }

  function sensorAgent(node: number, key = "piglet") {
    return {
      node,
      key,
      kind: "SENSOR" as const,
      status: "ENABLED" as const,
      config: null,
      draft: null,
    };
  }

  it("aggregates sensor-bearing nodes from a 3-page nodeList walk and deduplicates ids", async () => {
    // The underlying cursor walk lives in `listAllNodes` (covered by
    // server-actions.test.ts). Here we hand the wrapper a multi-page
    // aggregate to lock down the contract that `listSensorNodes`
    //  (a) does not truncate any page,
    //  (b) filters to SENSOR-kind agents,
    //  (c) de-duplicates by node id when the same id surfaces twice.
    const page1 = [
      makeNode({ id: "n1", agents: [sensorAgent(1)] }),
      makeNode({
        id: "n2",
        agents: [
          {
            node: 2,
            key: "hog",
            kind: "SEMI_SUPERVISED",
            status: "ENABLED",
            config: null,
            draft: null,
          },
        ],
      }),
    ];
    const page2 = [
      makeNode({ id: "n3", agents: [sensorAgent(3)] }),
      makeNode({ id: "n4", agents: [sensorAgent(4)] }),
    ];
    const page3 = [
      makeNode({ id: "n5", agents: [sensorAgent(5)] }),
      // Duplicate from page 1 — must be deduped.
      makeNode({ id: "n1", agents: [sensorAgent(1)] }),
    ];
    const aggregated = [...page1, ...page2, ...page3];

    mockListAllNodes.mockResolvedValue({
      edges: aggregated.map((node) => ({ node })),
      totalCount: String(aggregated.length),
      pageInfo: {
        hasPreviousPage: false,
        hasNextPage: false,
        startCursor: null,
        endCursor: null,
      },
    });

    const result = await listSensorNodes(session());
    expect(result.map((r) => r.id)).toEqual(["n1", "n3", "n4", "n5"]);
    expect(mockListAllNodes).toHaveBeenCalledTimes(1);
  });
});
