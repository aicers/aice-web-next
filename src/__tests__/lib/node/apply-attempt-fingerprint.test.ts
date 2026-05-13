import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  buildNodeInputForApplyDraft,
  computeDraftFingerprint,
  type NodeDraftSnapshot,
} from "@/lib/node/apply-attempt-lifecycle";

function snapshot(
  overrides: Partial<NodeDraftSnapshot> = {},
): NodeDraftSnapshot {
  return {
    id: "n",
    name: "node-name",
    nameDraft: null,
    profile: { customerId: "5", description: "", hostname: "h" },
    profileDraft: null,
    agents: [],
    externalServices: [],
    ...overrides,
  };
}

describe("computeDraftFingerprint", () => {
  it("produces a 32-byte / 64-hex-char SHA-256 digest", () => {
    const { bytes, hex } = computeDraftFingerprint(snapshot());
    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes.length).toBe(32);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is invariant to agents[] / externalServices[] ordering", () => {
    const a = snapshot({
      agents: [
        {
          kind: "SENSOR",
          key: "k1",
          status: "ENABLED",
          config: null,
          draft: "x",
        },
        {
          kind: "UNSUPERVISED",
          key: "k2",
          status: "ENABLED",
          config: null,
          draft: "y",
        },
      ],
    });
    const b = snapshot({
      agents: [
        {
          kind: "UNSUPERVISED",
          key: "k2",
          status: "ENABLED",
          config: null,
          draft: "y",
        },
        {
          kind: "SENSOR",
          key: "k1",
          status: "ENABLED",
          config: null,
          draft: "x",
        },
      ],
    });
    expect(computeDraftFingerprint(a).hex).toBe(computeDraftFingerprint(b).hex);
  });

  it("changes when a draft string changes", () => {
    const a = snapshot({
      externalServices: [
        { kind: "DATA_STORE", key: "k", status: "ENABLED", draft: "x" },
      ],
    });
    const b = snapshot({
      externalServices: [
        { kind: "DATA_STORE", key: "k", status: "ENABLED", draft: "y" },
      ],
    });
    expect(computeDraftFingerprint(a).hex).not.toBe(
      computeDraftFingerprint(b).hex,
    );
  });

  it("treats null vs missing the same once projected through the snapshot type", () => {
    const a = snapshot({ profileDraft: null });
    const b = snapshot({ profileDraft: null });
    expect(computeDraftFingerprint(a).hex).toBe(computeDraftFingerprint(b).hex);
  });
});

describe("buildNodeInputForApplyDraft", () => {
  it("passes nameDraft / profileDraft and every agent / external draft verbatim (Decision 4, #333)", () => {
    const node = snapshot({
      name: "old",
      nameDraft: "new",
      profile: { customerId: "5", description: "old desc", hostname: "old-h" },
      profileDraft: {
        customerId: "5",
        description: "new desc",
        hostname: "new-h",
      },
      agents: [
        {
          kind: "SENSOR",
          key: "k",
          status: "ENABLED",
          config: "old-cfg",
          draft: "new-cfg",
        },
      ],
      externalServices: [
        { kind: "DATA_STORE", key: "k", status: "ENABLED", draft: "ds-draft" },
      ],
    });
    const result = buildNodeInputForApplyDraft(node) as Record<string, unknown>;
    expect(result.name).toBe("new");
    // Per Decision 4 the builder MUST NOT clobber nameDraft / profileDraft
    // or agents[i].draft / externalServices[i].draft. The drafts are
    // carried verbatim so upstream `update_db` can honour operator
    // intent (including `null` = delete intent).
    expect(result.nameDraft).toBe("new");
    expect((result.profileDraft as { description: string }).description).toBe(
      "new desc",
    );
    const agents = result.agents as Array<{
      config: string | null;
      draft: string | null;
    }>;
    expect(agents[0].config).toBe("old-cfg");
    expect(agents[0].draft).toBe("new-cfg");
    const ext = result.externalServices as Array<{ draft: string | null }>;
    expect(ext[0].draft).toBe("ds-draft");
  });

  it("preserves agent / external delete intent (draft = null) verbatim", () => {
    const node = snapshot({
      name: "n",
      nameDraft: null,
      profile: { customerId: "5", description: "d", hostname: "h" },
      profileDraft: null,
      agents: [
        {
          kind: "SENSOR",
          key: "k",
          status: "ENABLED",
          config: "applied",
          draft: null,
        },
      ],
      externalServices: [
        { kind: "DATA_STORE", key: "k", status: "ENABLED", draft: null },
      ],
    });
    const result = buildNodeInputForApplyDraft(node) as Record<string, unknown>;
    expect(result.name).toBe("n");
    expect(result.nameDraft).toBeNull();
    const agents = result.agents as Array<{
      config: string | null;
      draft: string | null;
    }>;
    expect(agents[0].config).toBe("applied");
    expect(agents[0].draft).toBeNull();
    const ext = result.externalServices as Array<{ draft: string | null }>;
    expect(ext[0].draft).toBeNull();
  });

  it("preserves direct-setup magic-string drafts (draft = '') verbatim", () => {
    const node = snapshot({
      agents: [
        {
          kind: "SENSOR",
          key: "k",
          status: "ENABLED",
          config: "old",
          draft: "",
        },
      ],
    });
    const result = buildNodeInputForApplyDraft(node) as Record<string, unknown>;
    const agents = result.agents as Array<{ draft: string | null }>;
    expect(agents[0].draft).toBe("");
  });
});
