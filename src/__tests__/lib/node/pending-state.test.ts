import { describe, expect, it } from "vitest";

import { tivanConfigToToml } from "@/lib/node/applied-config-toml";
import {
  agentPendingState,
  type ExternalConfigSnapshot,
  externalServicePendingState,
  nodePendingState,
} from "@/lib/node/pending-state";
import {
  serialiseTiContainer,
  TIVAN_HARDCODED,
} from "@/lib/node/services/ti-container";

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

  it("reads a serialiseTiContainer(...) draft as steady state against a matching TivanConfig snapshot", () => {
    // Regression for #551 Round 2: tivanConfigToToml must project every
    // field serialiseTiContainer emits (including the three
    // TIVAN_HARDCODED paths). Omitting them would leave a phantom
    // three-field diff between the draft and the projected snapshot,
    // breaking the post-apply steady-state contract.
    const draft = serialiseTiContainer({ webIp: "10.0.0.2", webPort: 8444 });
    const snapshot: ExternalConfigSnapshot = {
      TI_CONTAINER: tivanConfigToToml({
        graphqlSrvAddr: "10.0.0.2:8444",
        translateMitre: TIVAN_HARDCODED.translateMitre,
        excelData: TIVAN_HARDCODED.excelData,
        originMitre: TIVAN_HARDCODED.originMitre,
      }),
    };
    expect(
      externalServicePendingState({ kind: "TI_CONTAINER", draft }, snapshot),
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

  it("returns unknown when a known-pending source exists alongside an unavailable non-delete external", () => {
    // Apply-blocking unknown wins: createApplyAttempt would reject with
    // ExternalServiceUnavailableError before persisting an apply_attempts
    // row, so the aggregate must not invite the operator into Apply.
    expect(
      nodePendingState(
        {
          ...baseNode,
          nameDraft: "different",
          externalServices: [{ kind: "DATA_STORE", draft: "x" }],
        },
        { DATA_STORE: "unavailable" },
      ),
    ).toBe("unknown");
  });

  it("returns pending when a known-pending source exists alongside a delete-intent unavailable external", () => {
    // Delete intent skips the request-time endpoint read; Apply will
    // succeed against MANAGER_DB alone, so the unavailable external does
    // not block the aggregate.
    expect(
      nodePendingState(
        {
          ...baseNode,
          nameDraft: "different",
          externalServices: [{ kind: "DATA_STORE", draft: null }],
        },
        { DATA_STORE: "unavailable" },
      ),
    ).toBe("pending");
  });

  it("returns pending when a delete-intent unavailable external is the only signal", () => {
    expect(
      nodePendingState(
        {
          ...baseNode,
          externalServices: [{ kind: "DATA_STORE", draft: null }],
        },
        { DATA_STORE: "unavailable" },
      ),
    ).toBe("pending");
  });
});
