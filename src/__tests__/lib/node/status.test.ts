import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import {
  clampPollIntervalMs,
  NODE_STATUS_POLL_MS_DEFAULT,
  NODE_STATUS_POLL_MS_MAX,
  NODE_STATUS_POLL_MS_MIN,
  NODE_STATUS_SPARKLINE_SAMPLES,
} from "@/lib/node/status";

const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockGetNodeControlMetadata = vi.hoisted(() => vi.fn());
const mockNodeReboot = vi.hoisted(() => vi.fn());
const mockNodeShutdown = vi.hoisted(() => vi.fn());
const mockListAllNodeStatuses = vi.hoisted(() => vi.fn());

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/node/server-actions", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/node/errors")>(
      "@/lib/node/errors",
    );
  return {
    ...actual,
    // The control path uses the slim metadata helper (gated on
    // `nodes:write` only), not `getNode` (which enforces the combined
    // `nodes:read + services:read` gate over the full mixed-surface
    // payload). Mock the helper the production path actually calls so
    // the permission semantics match the contract under test.
    getNodeControlMetadata: vi.fn((...args: unknown[]) =>
      mockGetNodeControlMetadata(...args),
    ),
    nodeReboot: vi.fn((...args: unknown[]) => mockNodeReboot(...args)),
    nodeShutdown: vi.fn((...args: unknown[]) => mockNodeShutdown(...args)),
    listAllNodeStatuses: vi.fn((...args: unknown[]) =>
      mockListAllNodeStatuses(...args),
    ),
  };
});

const now = Math.floor(Date.now() / 1000);
const session: AuthSession = {
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
  profile: { customerId: "7", description: "primary", hostname: "alpha.lan" },
  profileDraft: null,
  agents: [],
  externalServices: [],
};

describe("clampPollIntervalMs", () => {
  it("returns the default when value is missing or non-numeric", () => {
    expect(clampPollIntervalMs(undefined)).toBe(NODE_STATUS_POLL_MS_DEFAULT);
    expect(clampPollIntervalMs("bad")).toBe(NODE_STATUS_POLL_MS_DEFAULT);
    expect(clampPollIntervalMs(NaN)).toBe(NODE_STATUS_POLL_MS_DEFAULT);
  });

  it("clamps below the minimum", () => {
    expect(clampPollIntervalMs(100)).toBe(NODE_STATUS_POLL_MS_MIN);
  });

  it("clamps above the maximum", () => {
    expect(clampPollIntervalMs(10_000_000)).toBe(NODE_STATUS_POLL_MS_MAX);
  });

  it("passes valid values through", () => {
    expect(clampPollIntervalMs(15_000)).toBe(15_000);
    expect(clampPollIntervalMs("30000")).toBe(30_000);
  });
});

describe("NODE_STATUS_SPARKLINE_SAMPLES", () => {
  it("is the documented buffer length of 60", () => {
    expect(NODE_STATUS_SPARKLINE_SAMPLES).toBe(60);
  });
});

describe("restartNode / shutdownNode", () => {
  beforeEach(() => {
    mockAuditRecord.mockReset();
    mockGetNodeControlMetadata.mockReset();
    mockNodeReboot.mockReset();
    mockNodeShutdown.mockReset();
  });

  it("restartNode resolves hostname server-side and emits one node.restart audit entry", async () => {
    mockGetNodeControlMetadata.mockResolvedValue(sampleNode);
    mockNodeReboot.mockResolvedValue("ok");

    const { restartNode } = await import("@/lib/node/status");
    await restartNode(session, "42", { ip: "10.0.0.1" });

    expect(mockGetNodeControlMetadata).toHaveBeenCalledWith(
      session,
      "42",
      undefined,
    );
    expect(mockNodeReboot).toHaveBeenCalledWith(
      session,
      "alpha.lan",
      undefined,
    );
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: session.accountId,
        action: "node.restart",
        target: "node",
        targetId: "42",
        details: { hostname: "alpha.lan" },
        ip: "10.0.0.1",
        sid: session.sessionId,
        customerId: 7,
      }),
    );
  });

  it("shutdownNode emits one node.shutdown audit entry on success", async () => {
    mockGetNodeControlMetadata.mockResolvedValue(sampleNode);
    mockNodeShutdown.mockResolvedValue("ok");

    const { shutdownNode } = await import("@/lib/node/status");
    await shutdownNode(session, "42", { ip: "10.0.0.2" });

    expect(mockNodeShutdown).toHaveBeenCalledWith(
      session,
      "alpha.lan",
      undefined,
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "node.shutdown",
        target: "node",
        targetId: "42",
        details: { hostname: "alpha.lan" },
        ip: "10.0.0.2",
        customerId: 7,
      }),
    );
  });

  it("emits no audit entry when the manager mutation fails", async () => {
    const { ManagerUnavailableError } = await import("@/lib/node/errors");
    mockGetNodeControlMetadata.mockResolvedValue(sampleNode);
    mockNodeReboot.mockRejectedValue(
      new ManagerUnavailableError("manager offline"),
    );

    const { restartNode } = await import("@/lib/node/status");
    await expect(restartNode(session, "42")).rejects.toBeInstanceOf(
      ManagerUnavailableError,
    );
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("emits no audit entry when the caller is denied at the permission gate", async () => {
    const { NodePermissionError } = await import("@/lib/node/errors");
    mockGetNodeControlMetadata.mockRejectedValue(
      new NodePermissionError("forbidden"),
    );

    const { restartNode } = await import("@/lib/node/status");
    await expect(restartNode(session, "42")).rejects.toBeInstanceOf(
      NodePermissionError,
    );
    expect(mockNodeReboot).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("falls back to the draft hostname when no profile is committed", async () => {
    mockGetNodeControlMetadata.mockResolvedValue({
      ...sampleNode,
      profile: null,
      profileDraft: {
        customerId: "9",
        description: "draft only",
        hostname: "draft.lan",
      },
    });
    mockNodeReboot.mockResolvedValue("ok");

    const { restartNode } = await import("@/lib/node/status");
    await restartNode(session, "42");

    expect(mockNodeReboot).toHaveBeenCalledWith(
      session,
      "draft.lan",
      undefined,
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { hostname: "draft.lan" },
        customerId: 9,
      }),
    );
  });
});

describe("getNodeStatusList", () => {
  beforeEach(() => {
    mockListAllNodeStatuses.mockReset();
  });

  it("returns a point-in-time snapshot with capturedAt and per-node edges", async () => {
    mockListAllNodeStatuses.mockResolvedValue({
      edges: [
        { node: { id: "1", name: "a" } },
        { node: { id: "2", name: "b" } },
      ],
      totalCount: "2",
      pageInfo: {
        hasPreviousPage: false,
        hasNextPage: false,
        startCursor: null,
        endCursor: null,
      },
    });

    const { getNodeStatusList } = await import("@/lib/node/status");
    const result = await getNodeStatusList(session);

    expect(result.edges).toHaveLength(2);
    expect(result.edges[0]?.id).toBe("1");
    expect(result.edges[1]?.id).toBe("2");
    expect(typeof result.capturedAt).toBe("string");
    // capturedAt is ISO-formatted.
    expect(() => new Date(result.capturedAt).toISOString()).not.toThrow();
  });
});
