import { describe, expect, it } from "vitest";

import {
  agentPendingState,
  type ExternalConfigSnapshot,
  externalServicePendingState,
  nodePendingState,
} from "@/lib/node/pending-state";

describe("agentPendingState — Decision 9 comparison rule", () => {
  it("flags change intent: draft != config (both non-null)", () => {
    expect(agentPendingState({ config: "old", draft: "new" })).toBe("pending");
  });

  it("flags delete intent: draft = null, config = Some", () => {
    expect(agentPendingState({ config: "old", draft: null })).toBe("pending");
  });

  it("flags brand-new insert: draft = Some, config = null", () => {
    expect(agentPendingState({ config: null, draft: "new" })).toBe("pending");
  });

  it("returns not-pending at steady state (draft = config)", () => {
    expect(agentPendingState({ config: "x", draft: "x" })).toBe("not-pending");
  });

  it("returns not-pending when both are null (no agent state)", () => {
    expect(agentPendingState({ config: null, draft: null })).toBe(
      "not-pending",
    );
  });
});

describe("externalServicePendingState — Decision 9 comparison rule", () => {
  it("flags change intent: manager.draft != endpoint.config", () => {
    const snapshot: ExternalConfigSnapshot = {
      DATA_STORE: 'ingest_srv_addr = "old"\n',
    };
    expect(
      externalServicePendingState(
        { kind: "DATA_STORE", draft: 'ingest_srv_addr = "new"\n' },
        snapshot,
      ),
    ).toBe("pending");
  });

  it("flags delete intent: manager.draft = null, endpoint.config = Some", () => {
    const snapshot: ExternalConfigSnapshot = {
      DATA_STORE: 'ingest_srv_addr = "old"\n',
    };
    expect(
      externalServicePendingState(
        { kind: "DATA_STORE", draft: null },
        snapshot,
      ),
    ).toBe("pending");
  });

  it("returns not-pending at steady state (structural equality)", () => {
    // Field order differences are tolerated: structural equality is
    // computed via diffServiceConfig, not string equality.
    const snapshot: ExternalConfigSnapshot = {
      DATA_STORE: 'ingest_srv_addr = "x"\nretention = "1d"\n',
    };
    expect(
      externalServicePendingState(
        {
          kind: "DATA_STORE",
          draft: 'retention = "1d"\ningest_srv_addr = "x"\n',
        },
        snapshot,
      ),
    ).toBe("not-pending");
  });

  it("returns unknown when the snapshot records the endpoint as unavailable", () => {
    const snapshot: ExternalConfigSnapshot = { DATA_STORE: "unavailable" };
    expect(
      externalServicePendingState(
        { kind: "DATA_STORE", draft: 'ingest_srv_addr = "x"\n' },
        snapshot,
      ),
    ).toBe("unknown");
  });

  it("returns not-pending when both manager.draft and snapshot are absent", () => {
    expect(
      externalServicePendingState({ kind: "DATA_STORE", draft: null }, {}),
    ).toBe("not-pending");
  });
});

describe("nodePendingState — aggregate", () => {
  const baseNode = {
    name: "n",
    nameDraft: null,
    profile: { customerId: "5", description: "", hostname: "h" },
    profileDraft: null,
    agents: [] as Array<{ config: string | null; draft: string | null }>,
    externalServices: [] as Array<{
      kind: "DATA_STORE" | "TI_CONTAINER";
      draft: string | null;
    }>,
  };

  it("returns not-pending for an unchanged node", () => {
    expect(nodePendingState(baseNode, {})).toBe("not-pending");
  });

  it("returns pending on nameDraft change", () => {
    expect(nodePendingState({ ...baseNode, nameDraft: "different" }, {})).toBe(
      "pending",
    );
  });

  it("returns pending on a changed agent", () => {
    expect(
      nodePendingState(
        {
          ...baseNode,
          agents: [{ config: "a", draft: "b" }],
        },
        {},
      ),
    ).toBe("pending");
  });

  it("returns unknown when the only signal is an unavailable external", () => {
    expect(
      nodePendingState(
        {
          ...baseNode,
          externalServices: [{ kind: "DATA_STORE", draft: "x" }],
        },
        { DATA_STORE: "unavailable" },
      ),
    ).toBe("unknown");
  });

  it("returns pending when a known-pending source exists alongside an unknown external", () => {
    expect(
      nodePendingState(
        {
          ...baseNode,
          nameDraft: "different",
          externalServices: [{ kind: "DATA_STORE", draft: "x" }],
        },
        { DATA_STORE: "unavailable" },
      ),
    ).toBe("pending");
  });
});
