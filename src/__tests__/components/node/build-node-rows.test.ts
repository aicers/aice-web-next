import { describe, expect, it } from "vitest";

import { buildNodeRows } from "@/components/node/node-list-types";
import type { NodeConnection, NodeStatusConnection } from "@/lib/node/types";

const PAGE_INFO = {
  hasPreviousPage: false,
  hasNextPage: false,
  startCursor: null,
  endCursor: null,
};

function nodeConnection(
  edges: NodeConnection["edges"],
  totalCount = String(edges.length),
): NodeConnection {
  return { edges, pageInfo: PAGE_INFO, totalCount };
}

function statusConnection(
  edges: NodeStatusConnection["edges"],
  totalCount = String(edges.length),
): NodeStatusConnection {
  return { edges, pageInfo: PAGE_INFO, totalCount };
}

describe("buildNodeRows", () => {
  it("marks rows with no draft as non-pending and surfaces no draft cells", () => {
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "1",
            name: "alpha",
            nameDraft: null,
            profile: {
              customerId: "1",
              description: "primary",
              hostname: "alpha.lan",
            },
            profileDraft: null,
            agents: [
              {
                node: 1,
                key: "a-sensor",
                kind: "SENSOR",
                status: "ENABLED",
                config: "[s]",
                draft: null,
              },
            ],
            externalServices: [
              {
                node: 1,
                key: "a-store",
                kind: "DATA_STORE",
                status: "ENABLED",
                draft: null,
              },
            ],
          },
        },
      ]),
      statusConnection([]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].hasPending).toBe(false);
    expect(rows[0].draftName).toBeNull();
    expect(rows[0].draftHostname).toBeNull();
    expect(rows[0].serviceCells.sensor).toEqual({
      state: "configured-here",
      hasDraft: false,
    });
    expect(rows[0].serviceCells.dataStore).toEqual({
      state: "configured-here",
      hasDraft: false,
    });
  });

  it("flags name and profile drafts that diverge from applied state", () => {
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "2",
            name: "beta",
            nameDraft: "beta-renamed",
            profile: {
              customerId: "1",
              description: "old",
              hostname: "beta.lan",
            },
            profileDraft: {
              customerId: "1",
              description: "old",
              hostname: "beta-new.lan",
            },
            agents: [],
            externalServices: [],
          },
        },
      ]),
      statusConnection([]),
    );

    expect(rows[0].hasPending).toBe(true);
    expect(rows[0].draftName).toBe("beta-renamed");
    expect(rows[0].draftHostname).toBe("beta-new.lan");
    expect(rows[0].draftDescription).toBeNull();
    expect(rows[0].draftCustomerId).toBeNull();
  });

  it("renders Unsupervised as Manual regardless of agent presence", () => {
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "3",
            name: "gamma",
            nameDraft: null,
            profile: {
              customerId: "1",
              description: "",
              hostname: "gamma.lan",
            },
            profileDraft: null,
            agents: [
              {
                node: 3,
                key: "g-uns",
                kind: "UNSUPERVISED",
                status: "ENABLED",
                config: "[u]",
                draft: null,
              },
            ],
            externalServices: [],
          },
        },
      ]),
      statusConnection([]),
    );

    expect(rows[0].serviceCells.unsupervised.state).toBe("manual");
  });

  it("flags an external-service draft as configured-here-pending", () => {
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "4",
            name: "delta",
            nameDraft: null,
            profile: {
              customerId: "1",
              description: "",
              hostname: "delta.lan",
            },
            profileDraft: null,
            agents: [],
            externalServices: [
              {
                node: 4,
                key: "d-ti",
                kind: "TI_CONTAINER",
                status: "ENABLED",
                draft: "[ti] something",
              },
            ],
          },
        },
      ]),
      statusConnection([]),
    );

    expect(rows[0].hasPending).toBe(true);
    expect(rows[0].serviceCells.tiContainer.state).toBe(
      "configured-here-pending",
    );
    expect(rows[0].serviceCells.tiContainer.hasDraft).toBe(true);
  });

  it("joins manager status by node id; missing status leaves manager null", () => {
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "5",
            name: "epsilon",
            nameDraft: null,
            profile: {
              customerId: "1",
              description: "",
              hostname: "e.lan",
            },
            profileDraft: null,
            agents: [],
            externalServices: [],
          },
        },
        {
          node: {
            id: "6",
            name: "zeta",
            nameDraft: null,
            profile: {
              customerId: "1",
              description: "",
              hostname: "z.lan",
            },
            profileDraft: null,
            agents: [],
            externalServices: [],
          },
        },
      ]),
      statusConnection([
        {
          node: {
            id: "5",
            name: "epsilon",
            nameDraft: null,
            profile: null,
            profileDraft: null,
            cpuUsage: null,
            totalMemory: null,
            usedMemory: null,
            totalDiskSpace: null,
            usedDiskSpace: null,
            manager: true,
            agents: [],
            externalServices: [],
            ping: 5.5,
          },
        },
      ]),
    );

    expect(rows[0].manager).toBe(true);
    expect(rows[0].ping).toBe(5.5);
    expect(rows[1].manager).toBeNull();
    expect(rows[1].ping).toBeNull();
  });
});
