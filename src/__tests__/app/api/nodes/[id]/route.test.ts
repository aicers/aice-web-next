import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
  session: AuthSession,
) => Promise<Response>;

interface WithAuthOptions {
  requiredPermissions?: string[];
}

const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());
const mockGetNode = vi.hoisted(() => vi.fn());
const mockGetNodeAuditMetadata = vi.hoisted(() => vi.fn());
const mockGetGigantoConfig = vi.hoisted(() => vi.fn());
const mockGetTivanConfig = vi.hoisted(() => vi.fn());
const mockListAllNodes = vi.hoisted(() => vi.fn());
const mockRemoveNodes = vi.hoisted(() => vi.fn());
const mockUpdateNodeWithAudit = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;

vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn, options?: WithAuthOptions) => {
    return async (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> },
    ) => {
      if (options?.requiredPermissions) {
        for (const perm of options.requiredPermissions) {
          if (!(await mockHasPermission(currentSession.roles, perm))) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
        }
      }
      return handler(request, context, currentSession);
    };
  }),
}));

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/node/server-actions", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/node/errors")>(
      "@/lib/node/errors",
    );
  return {
    ...actual,
    getNode: vi.fn((...args: unknown[]) => mockGetNode(...args)),
    getNodeAuditMetadata: vi.fn((...args: unknown[]) =>
      mockGetNodeAuditMetadata(...args),
    ),
    getGigantoConfig: vi.fn((...args: unknown[]) =>
      mockGetGigantoConfig(...args),
    ),
    getTivanConfig: vi.fn((...args: unknown[]) => mockGetTivanConfig(...args)),
    listAllNodes: vi.fn((...args: unknown[]) => mockListAllNodes(...args)),
    removeNodes: vi.fn((...args: unknown[]) => mockRemoveNodes(...args)),
  };
});

vi.mock("@/lib/node/applied-config-toml", () => ({
  // Surface deterministic strings so the test asserts only on the
  // BFF-level routing, not the toml projection (covered separately).
  gigantoConfigToToml: vi.fn(
    (config: { receiveAddress: string; webAddress: string }) =>
      `receive_address = "${config.receiveAddress}"\nweb_address = "${config.webAddress}"`,
  ),
  tivanConfigToToml: vi.fn(
    (config: { sourceAddress: string; sinkAddress: string }) =>
      `source_address = "${config.sourceAddress}"\nsink_address = "${config.sinkAddress}"`,
  ),
}));

vi.mock("@/lib/node/node-create-update", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/node/node-create-update")
  >("@/lib/node/node-create-update");
  return {
    ...actual,
    updateNodeWithAudit: vi.fn((...args: unknown[]) =>
      mockUpdateNodeWithAudit(...args),
    ),
  };
});

const now = Math.floor(Date.now() / 1000);

const adminSession: AuthSession = {
  accountId: "admin-1",
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: now,
  exp: now + 900,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "Mozilla/5.0",
  sessionBrowserFingerprint: "Chrome/131",
  needsReauth: false,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
};

const sampleNode = {
  id: "42",
  name: "alpha-node",
  nameDraft: null,
  profile: {
    customerId: "7",
    description: "primary",
    hostname: "alpha.lan",
  },
  profileDraft: null,
  agents: [],
  externalServices: [],
};

function makeRequest(id = "42"): NextRequest {
  return new NextRequest(`http://localhost:3000/api/nodes/${id}`, {
    method: "DELETE",
  });
}

function makeContext(id = "42") {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/nodes/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockAuditRecord.mockReset();
    mockGetNodeAuditMetadata.mockReset();
    mockRemoveNodes.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
  });

  it("emits one node.delete audit entry on success", async () => {
    mockGetNodeAuditMetadata.mockResolvedValue(sampleNode);
    mockRemoveNodes.mockResolvedValue([sampleNode.id]);

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: adminSession.accountId,
        action: "node.delete",
        target: "node",
        targetId: sampleNode.id,
        details: { hostname: sampleNode.profile.hostname },
        sid: adminSession.sessionId,
        customerId: 7,
      }),
    );
  });

  it("returns 404 and emits no audit entry when the node is gone before delete", async () => {
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    mockGetNodeAuditMetadata.mockRejectedValue(
      new NodeNotFoundError("missing"),
    );

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest("999"), makeContext("999"));

    expect(response.status).toBe(404);
    expect(mockRemoveNodes).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 503 and emits no audit entry when the manager is unreachable", async () => {
    const { ManagerUnavailableError } = await import("@/lib/node/errors");
    mockGetNodeAuditMetadata.mockResolvedValue(sampleNode);
    mockRemoveNodes.mockRejectedValue(
      new ManagerUnavailableError("manager offline"),
    );

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());

    expect(response.status).toBe(503);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 403 when the upstream rejects on permission grounds", async () => {
    const { NodePermissionError } = await import("@/lib/node/errors");
    mockGetNodeAuditMetadata.mockResolvedValue(sampleNode);
    mockRemoveNodes.mockRejectedValue(new NodePermissionError("out of scope"));

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks nodes:delete", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "nodes:delete",
    );

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockGetNodeAuditMetadata).not.toHaveBeenCalled();
    expect(mockRemoveNodes).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("emits no audit entry and returns 409 when removeNodes returns no deleted ids", async () => {
    // Phase Node-3 acceptance: failed deletes must not emit audit
    // events. The manager mutation can resolve cleanly but report an
    // empty / subset deleted-id list (e.g., the node disappeared
    // between getNode and the delete, or the manager refused it
    // post-scope-check). Treat absence from the deleted list as a
    // failure — no audit, non-success status.
    mockGetNodeAuditMetadata.mockResolvedValue(sampleNode);
    mockRemoveNodes.mockResolvedValue([]);

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());

    expect(response.status).toBe(409);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("emits no audit entry when removeNodes returns a different id", async () => {
    mockGetNodeAuditMetadata.mockResolvedValue(sampleNode);
    mockRemoveNodes.mockResolvedValue(["some-other-id"]);

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());

    expect(response.status).toBe(409);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("succeeds for a caller holding nodes:delete only (no nodes:read or services:read)", async () => {
    // Round 4 finding: the audit metadata pre-fetch must not force the
    // caller to hold `nodes:read` + `services:read` in addition to
    // `nodes:delete`. With the route now routing through
    // `getNodeAuditMetadata` (gated on `nodes:delete` only),
    // a custom role with just `nodes:delete` reaches the delete and
    // emits exactly one audit entry on success.
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm === "nodes:delete",
    );
    mockGetNodeAuditMetadata.mockResolvedValue(sampleNode);
    mockRemoveNodes.mockResolvedValue([sampleNode.id]);

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(mockGetNodeAuditMetadata).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
  });

  it("falls back to the draft hostname when no profile is committed", async () => {
    mockGetNodeAuditMetadata.mockResolvedValue({
      ...sampleNode,
      profile: null,
      profileDraft: {
        customerId: "9",
        description: "draft only",
        hostname: "draft.lan",
      },
    });
    mockRemoveNodes.mockResolvedValue([sampleNode.id]);

    const { DELETE } = await import("@/app/api/nodes/[id]/route");
    const response = await DELETE(makeRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "node.delete",
        details: { hostname: "draft.lan" },
        customerId: 9,
      }),
    );
  });
});

const validPatchBody = {
  old: {
    name: "alpha-node",
    nameDraft: null,
    profile: {
      customerId: "7",
      description: "primary",
      hostname: "alpha.lan",
    },
    profileDraft: null,
    agents: [],
    externalServices: [],
  },
  new: {
    nameDraft: "alpha-node",
    profileDraft: {
      customerId: "7",
      description: "edited",
      hostname: "alpha.lan",
    },
    agents: null,
    externalServices: null,
  },
};

function makePatchRequest(id = "42", body: unknown = validPatchBody) {
  return new NextRequest(`http://localhost:3000/api/nodes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/nodes/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockAuditRecord.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockUpdateNodeWithAudit.mockReset();
  });

  it("returns 200 when the upstream save succeeds", async () => {
    mockUpdateNodeWithAudit.mockResolvedValue("42");

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockUpdateNodeWithAudit).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when the caller lacks nodes:write", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "nodes:write",
    );

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockUpdateNodeWithAudit).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks services:write", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "services:write",
    );

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockUpdateNodeWithAudit).not.toHaveBeenCalled();
  });

  it("surfaces a stale conflict as 409 with field: null", async () => {
    const { StaleConflictError } = await import("@/lib/node/draft");
    mockUpdateNodeWithAudit.mockRejectedValue(
      new StaleConflictError("the node was modified concurrently"),
    );

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest(), makeContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "the node was modified concurrently",
      field: null,
    });
  });

  it("maps a hostname conflict to 409 with field: hostname", async () => {
    mockUpdateNodeWithAudit.mockRejectedValue(
      new Error("hostname alpha.lan already in use"),
    );

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest(), makeContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "hostname alpha.lan already in use",
      field: "hostname",
    });
  });

  it("rejects an invalid JSON body with 400", async () => {
    const request = new NextRequest("http://localhost:3000/api/nodes/42", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(request, makeContext());

    expect(response.status).toBe(400);
    expect(mockUpdateNodeWithAudit).not.toHaveBeenCalled();
  });

  it("rejects a body missing old/new with 400", async () => {
    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest("42", {}), makeContext());

    expect(response.status).toBe(400);
    expect(mockUpdateNodeWithAudit).not.toHaveBeenCalled();
  });

  it("returns 404 when the node was removed before the save", async () => {
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    mockUpdateNodeWithAudit.mockRejectedValue(new NodeNotFoundError("missing"));

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest("999"), makeContext("999"));

    expect(response.status).toBe(404);
  });

  it("returns 503 when the manager is unreachable", async () => {
    const { ManagerUnavailableError } = await import("@/lib/node/errors");
    mockUpdateNodeWithAudit.mockRejectedValue(
      new ManagerUnavailableError("manager offline"),
    );

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest(), makeContext());

    expect(response.status).toBe(503);
  });

  it("falls through to a structured 502 for an unmatched GraphQL upstream error", async () => {
    // Same shape graphql-request would throw — the PATCH route must
    // return JSON `{ error, field: null }` so the dialog footer banner
    // can render the upstream message instead of falling through to
    // the framework's 500 HTML and `errors.generic`.
    const upstream = Object.assign(new Error("upstream-aggregate"), {
      response: {
        errors: [
          { message: "review-web rejected the patch: undocumented case" },
        ],
      },
    });
    mockUpdateNodeWithAudit.mockRejectedValue(upstream);

    const { PATCH } = await import("@/app/api/nodes/[id]/route");
    const response = await PATCH(makePatchRequest(), makeContext());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "review-web rejected the patch: undocumented case",
      field: null,
    });
  });

  it("rethrows non-GraphQL errors so genuine bugs surface as 500", async () => {
    mockUpdateNodeWithAudit.mockRejectedValue(
      new TypeError("boom — programming bug"),
    );

    const { PATCH } = await import("@/app/api/nodes/[id]/route");

    await expect(PATCH(makePatchRequest(), makeContext())).rejects.toThrow(
      /boom/,
    );
  });
});

function makeGetRequest(id = "42") {
  return new NextRequest(`http://localhost:3000/api/nodes/${id}`, {
    method: "GET",
  });
}

describe("GET /api/nodes/[id]", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockGetNode.mockReset();
    mockGetGigantoConfig.mockReset();
    mockGetTivanConfig.mockReset();
    mockListAllNodes.mockReset().mockResolvedValue({ edges: [] });
  });

  it("returns the canonical node for the stale-conflict refresh path", async () => {
    mockGetNode.mockResolvedValue(sampleNode);

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
    // No external services on `sampleNode`, so the BFF returns an
    // empty applied-external-drafts map alongside the node. The
    // sensor pool is also returned so the dialog can rebuild Hog
    // defaults / serialise `active_sensors` against the *current*
    // pool — without this the asymmetric "all checked → None" rule in
    // `serialiseSemiSupervised` could collapse the user's selection
    // against the original (pre-refresh) pool, silently broadening
    // the persisted set to whatever sensors had been added since.
    expect(await response.json()).toEqual({
      node: sampleNode,
      appliedExternalDrafts: {},
      sensorOptions: [],
    });
    expect(mockGetNode).toHaveBeenCalledWith(adminSession, "42");
    expect(mockListAllNodes).toHaveBeenCalledWith(adminSession);
  });

  it("returns a fresh sensor pool walked from the manager's current node list", async () => {
    // Reviewer Round 18: the sensor pool can drift between dialog
    // open and the stale-conflict refresh (e.g. a concurrent writer
    // adds a SENSOR-bearing node elsewhere). The refresh has to walk
    // `listAllNodes` and project the same SENSOR-kind filter the SSR
    // page applies, so the dialog rebuilds Hog defaults against the
    // current pool. Without this, the dialog still serialises against
    // the original pool and `serialiseSemiSupervised` can omit
    // `active_sensors` (set-equality with stale pool), which the
    // manager reads as the *current* pool — silently selecting
    // sensors the user never saw on the form.
    mockGetNode.mockResolvedValue(sampleNode);
    mockListAllNodes.mockResolvedValue({
      edges: [
        {
          node: {
            id: "1",
            name: "alpha-sensor",
            nameDraft: null,
            profile: { customerId: "7", description: null, hostname: "a.lan" },
            profileDraft: null,
            agents: [
              {
                node: 1,
                key: "alpha-sensor",
                kind: "SENSOR",
                status: "ENABLED",
                config: null,
                draft: null,
              },
            ],
            externalServices: [],
          },
        },
        {
          node: {
            id: "2",
            name: "beta-sensor",
            nameDraft: null,
            profile: { customerId: "7", description: null, hostname: "b.lan" },
            profileDraft: null,
            agents: [
              {
                node: 2,
                key: "beta-sensor",
                kind: "SENSOR",
                status: "ENABLED",
                config: null,
                draft: null,
              },
            ],
            externalServices: [],
          },
        },
        {
          // Non-sensor node should be filtered out by the same
          // `collectSensorNodes` rule the SSR page uses.
          node: {
            id: "3",
            name: "no-sensor",
            nameDraft: null,
            profile: { customerId: "7", description: null, hostname: "c.lan" },
            profileDraft: null,
            agents: [],
            externalServices: [],
          },
        },
      ],
    });

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sensorOptions: Array<{ id: string; name: string; hostname: string }>;
    };
    expect(body.sensorOptions).toEqual([
      { id: "1", name: "alpha-sensor", hostname: "a.lan" },
      { id: "2", name: "beta-sensor", hostname: "b.lan" },
    ]);
  });

  it("refetches Giganto / Tivan applied config for externals with draft: null", async () => {
    // Reviewer Round 12: the stale-conflict refresh path has to
    // re-project the external applied baseline on every retry, not
    // just on the SSR open. The BFF returns the same `data-store` /
    // `ti-container` keys the dialog seeds from on first mount, so
    // the Edit dialog can rebuild defaults from a live snapshot when
    // the user picks Discard or Keep editing on the prompt.
    const nodeWithExternals = {
      ...sampleNode,
      externalServices: [
        {
          node: 42,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          config: null,
          draft: null,
        },
        {
          node: 42,
          key: "alpha-ti-container",
          kind: "TI_CONTAINER",
          status: "ENABLED",
          config: null,
          draft: null,
        },
      ],
    };
    mockGetNode.mockResolvedValue(nodeWithExternals);
    mockGetGigantoConfig.mockResolvedValue({
      receiveAddress: "10.0.0.1:38370",
      webAddress: "10.0.0.1:8443",
      retention: "30d",
    });
    mockGetTivanConfig.mockResolvedValue({
      sourceAddress: "10.0.0.2:38371",
      sinkAddress: "10.0.0.3:38372",
    });

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      node: unknown;
      appliedExternalDrafts: Record<string, string>;
    };
    expect(body.node).toEqual(nodeWithExternals);
    expect(typeof body.appliedExternalDrafts["data-store"]).toBe("string");
    expect(body.appliedExternalDrafts["data-store"]).toContain(
      "10.0.0.1:38370",
    );
    expect(typeof body.appliedExternalDrafts["ti-container"]).toBe("string");
    expect(body.appliedExternalDrafts["ti-container"]).toContain(
      "10.0.0.2:38371",
    );
    expect(mockGetGigantoConfig).toHaveBeenCalledTimes(1);
    expect(mockGetTivanConfig).toHaveBeenCalledTimes(1);
  });

  it("falls through silently when an external applied fetch is unavailable", async () => {
    // Same gating rule as the SSR Settings page: a transient
    // Giganto/Tivan outage must not fail the whole refresh. The
    // dialog can decide whether to keep its existing seed for the
    // affected section; what it cannot do is recover from a 503 on
    // the reconciliation path.
    const nodeWithExternals = {
      ...sampleNode,
      externalServices: [
        {
          node: 42,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          config: null,
          draft: null,
        },
      ],
    };
    mockGetNode.mockResolvedValue(nodeWithExternals);
    const { ExternalServiceUnavailableError } = await import(
      "@/lib/node/errors"
    );
    mockGetGigantoConfig.mockRejectedValue(
      new ExternalServiceUnavailableError("DATA_STORE", "offline"),
    );

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      appliedExternalDrafts: Record<string, string>;
    };
    expect(body.appliedExternalDrafts).toEqual({});
  });

  it("skips the external fetch when the external has a pending draft", async () => {
    // The seed already covers this path on the SSR page: a non-null
    // `draft` means the dialog opens populated from the draft, not
    // from applied. The refresh has to mirror that gate so a node
    // with a pending external draft does not pull a brand-new
    // applied snapshot the user never asked to see.
    const nodeWithDraft = {
      ...sampleNode,
      externalServices: [
        {
          node: 42,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          config: null,
          draft: 'receive_address = "10.0.0.9:38370"',
        },
      ],
    };
    mockGetNode.mockResolvedValue(nodeWithDraft);

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(200);
    expect(mockGetGigantoConfig).not.toHaveBeenCalled();
    expect(mockGetTivanConfig).not.toHaveBeenCalled();
    const body = (await response.json()) as {
      appliedExternalDrafts: Record<string, string>;
    };
    expect(body.appliedExternalDrafts).toEqual({});
  });

  it("returns 403 when the caller lacks nodes:read", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "nodes:read",
    );

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockGetNode).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks services:read", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "services:read",
    );

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(403);
    expect(mockGetNode).not.toHaveBeenCalled();
  });

  it("returns 404 when the node was removed before the refresh", async () => {
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    mockGetNode.mockRejectedValue(new NodeNotFoundError("missing"));

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest("999"), makeContext("999"));

    expect(response.status).toBe(404);
  });

  it("returns 503 when the manager is unreachable", async () => {
    const { ManagerUnavailableError } = await import("@/lib/node/errors");
    mockGetNode.mockRejectedValue(new ManagerUnavailableError("offline"));

    const { GET } = await import("@/app/api/nodes/[id]/route");
    const response = await GET(makeGetRequest(), makeContext());

    expect(response.status).toBe(503);
  });
});
