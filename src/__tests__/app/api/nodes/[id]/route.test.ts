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
const mockGetNodeAuditMetadata = vi.hoisted(() => vi.fn());
const mockRemoveNodes = vi.hoisted(() => vi.fn());

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
    getNodeAuditMetadata: vi.fn((...args: unknown[]) =>
      mockGetNodeAuditMetadata(...args),
    ),
    removeNodes: vi.fn((...args: unknown[]) => mockRemoveNodes(...args)),
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
