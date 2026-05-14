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
  it("marks steady-state rows (draft == config) as non-pending and surfaces no draft cells", () => {
    // Comparison-based detection (#333 Decision 9, #551): a row with
    // every agent at `draft == config` and every external at
    // `draft == endpoint.config` reads as not-pending. The agent
    // mirrors its applied config in `draft`, and the external is
    // `draft: null` against an absent snapshot entry (also steady).
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
                draft: "[s]",
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

  it("marks an agent delete intent (config: Some, draft: null) as pending (#551)", () => {
    // Reviewer Round 5 (#551): the list row aggregate must use the
    // comparison helper, not the legacy `draft !== null` predicate.
    // An agent with non-empty `config` and `draft: null` is delete
    // intent — it is pending and the service cell must surface the
    // pending dot. The applied-manual sentinel (`config: ""`,
    // `draft: null`) is covered by a separate test below and stays
    // not pending.
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "agent-delete-intent",
            name: "n",
            nameDraft: null,
            profile: { customerId: "1", description: "", hostname: "n.lan" },
            profileDraft: null,
            agents: [
              {
                node: 1,
                key: "n-sensor",
                kind: "SENSOR",
                status: "ENABLED",
                config: "[s]",
                draft: null,
              },
            ],
            externalServices: [],
          },
        },
      ]),
      statusConnection([]),
    );

    expect(rows[0].hasPending).toBe(true);
    expect(rows[0].serviceCells.sensor).toEqual({
      state: "configured-here-pending",
      hasDraft: true,
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

  it("classifies an applied-manual Sensor (config: '', draft: null) as Manual", () => {
    // Per `decisions/node-field-catalog.md` §60-63, Configure Manually
    // mode for Piglet / Hog / Crusher is encoded as the empty TOML
    // string. After apply, the same sentinel can land on `config`.
    // The cell must render as Manual — not Configured-here.
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "applied-manual-1",
            name: "n",
            nameDraft: null,
            profile: { customerId: "1", description: "", hostname: "h.lan" },
            profileDraft: null,
            agents: [
              {
                node: 1,
                key: "n-sensor",
                kind: "SENSOR",
                status: "ENABLED",
                config: "",
                draft: null,
              },
            ],
            externalServices: [],
          },
        },
      ]),
      statusConnection([]),
    );

    expect(rows[0].serviceCells.sensor.state).toBe("manual");
    expect(rows[0].hasPending).toBe(false);
  });

  it("classifies a pending switch to manual (draft: '') as Manual", () => {
    // Pending mode flip from Configured-here to Manual: the user has
    // a non-empty applied config but the draft is the empty sentinel.
    // The cell must render as Manual (no draft / apply affordance) —
    // not Configured-here · Pending. The row-level pending badge still
    // fires because `hasPending` derives from any agent draft diverging
    // from applied state, regardless of cell classification.
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "pending-manual-1",
            name: "n",
            nameDraft: null,
            profile: { customerId: "1", description: "", hostname: "h.lan" },
            profileDraft: null,
            agents: [
              {
                node: 1,
                key: "n-sensor",
                kind: "SENSOR",
                status: "ENABLED",
                config: "[piglet] retention = '7d'",
                draft: "",
              },
            ],
            externalServices: [],
          },
        },
      ]),
      statusConnection([]),
    );

    expect(rows[0].serviceCells.sensor.state).toBe("manual");
    expect(rows[0].hasPending).toBe(true);
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
    expect(rows[0].hasStatus).toBe(true);
    expect(rows[1].manager).toBeNull();
    expect(rows[1].ping).toBeNull();
    expect(rows[1].hasStatus).toBe(false);
  });

  it("marks delete-intent unavailable external as pending and renders the unknown cell (#551)", () => {
    // Issue #551: list-row aggregate must match `nodePendingState`
    // semantics. A delete-intent external (`draft === null`) with an
    // unavailable page-load snapshot is a real pending manager-DB
    // change that stays applyable even when the external is down.
    // Counting only the `"pending"` state would drop this case and
    // let the list and detail aggregates disagree for the same node.
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "delete-intent-unavailable",
            name: "n",
            nameDraft: null,
            profile: { customerId: "1", description: "", hostname: "n.lan" },
            profileDraft: null,
            agents: [],
            externalServices: [
              {
                node: 1,
                key: "n-store",
                kind: "DATA_STORE",
                status: "ENABLED",
                draft: null,
              },
            ],
          },
        },
      ]),
      statusConnection([]),
      { DATA_STORE: "unavailable" },
    );

    expect(rows[0].hasPending).toBe(true);
    expect(rows[0].serviceCells.dataStore).toEqual({
      state: "configured-here-unknown",
      hasDraft: false,
    });
  });

  it("marks non-delete unavailable external as pending and renders the unknown cell (#551)", () => {
    // Apply-blocking unknown: `nodePendingState` returns `"unknown"`
    // for this combination so the per-node Apply button is disabled
    // with the unknown tooltip. The list row must still surface a
    // pending signal so the row badge / pending filter / pending
    // summary count behave consistently with the detail page.
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "non-delete-unavailable",
            name: "n",
            nameDraft: null,
            profile: { customerId: "1", description: "", hostname: "n.lan" },
            profileDraft: null,
            agents: [],
            externalServices: [
              {
                node: 1,
                key: "n-store",
                kind: "DATA_STORE",
                status: "ENABLED",
                draft: "[store] retention = '7d'",
              },
            ],
          },
        },
      ]),
      statusConnection([]),
      { DATA_STORE: "unavailable" },
    );

    expect(rows[0].hasPending).toBe(true);
    expect(rows[0].serviceCells.dataStore).toEqual({
      state: "configured-here-unknown",
      hasDraft: false,
    });
  });

  it("marks hasStatus true even when ping is null (dead node)", () => {
    // The alive/dead chips read `hasStatus` to decide availability,
    // not `ping !== null`. A node that returns a status row with
    // `ping: null` is data — the chips must enable the dead facet
    // for it. Without this distinction an all-dead snapshot would
    // disable both chips and hide its own data.
    const rows = buildNodeRows(
      nodeConnection([
        {
          node: {
            id: "7",
            name: "eta",
            nameDraft: null,
            profile: { customerId: "1", description: "", hostname: "h.lan" },
            profileDraft: null,
            agents: [],
            externalServices: [],
          },
        },
      ]),
      statusConnection([
        {
          node: {
            id: "7",
            name: "eta",
            nameDraft: null,
            profile: null,
            profileDraft: null,
            cpuUsage: null,
            totalMemory: null,
            usedMemory: null,
            totalDiskSpace: null,
            usedDiskSpace: null,
            manager: false,
            agents: [],
            externalServices: [],
            ping: null,
          },
        },
      ]),
    );

    expect(rows[0].ping).toBeNull();
    expect(rows[0].hasStatus).toBe(true);
  });
});
