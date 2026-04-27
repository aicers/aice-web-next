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

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockRestartNode = vi.hoisted(() => vi.fn());
const mockShutdownNode = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/node/status", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/node/errors")>(
      "@/lib/node/errors",
    );
  return {
    ...actual,
    restartNode: vi.fn((...args: unknown[]) => mockRestartNode(...args)),
    shutdownNode: vi.fn((...args: unknown[]) => mockShutdownNode(...args)),
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

function makeRequest(id = "42", action: "restart" | "shutdown" = "restart") {
  return new NextRequest(`http://localhost:3000/api/nodes/${id}/${action}`, {
    method: "POST",
  });
}

function makeContext(id = "42") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/nodes/[id]/restart", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockRestartNode.mockReset();
    mockShutdownNode.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
  });

  it("returns 200 and calls restartNode on success", async () => {
    mockRestartNode.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/nodes/[id]/restart/route");
    const response = await POST(makeRequest("42", "restart"), makeContext());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockRestartNode).toHaveBeenCalledWith(adminSession, "42", {
      ip: "127.0.0.1",
    });
  });

  it("returns 403 when the caller lacks nodes:write", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "nodes:write",
    );
    const { POST } = await import("@/app/api/nodes/[id]/restart/route");
    const response = await POST(makeRequest("42", "restart"), makeContext());
    expect(response.status).toBe(403);
    expect(mockRestartNode).not.toHaveBeenCalled();
  });

  it("maps NodeNotFoundError to 404", async () => {
    const { NodeNotFoundError } = await import("@/lib/node/errors");
    mockRestartNode.mockRejectedValue(new NodeNotFoundError("missing"));
    const { POST } = await import("@/app/api/nodes/[id]/restart/route");
    const response = await POST(
      makeRequest("999", "restart"),
      makeContext("999"),
    );
    expect(response.status).toBe(404);
  });

  it("maps ManagerUnavailableError to 503", async () => {
    const { ManagerUnavailableError } = await import("@/lib/node/errors");
    mockRestartNode.mockRejectedValue(
      new ManagerUnavailableError("manager offline"),
    );
    const { POST } = await import("@/app/api/nodes/[id]/restart/route");
    const response = await POST(makeRequest("42", "restart"), makeContext());
    expect(response.status).toBe(503);
  });

  it("maps NodePermissionError to 403", async () => {
    const { NodePermissionError } = await import("@/lib/node/errors");
    mockRestartNode.mockRejectedValue(new NodePermissionError("denied"));
    const { POST } = await import("@/app/api/nodes/[id]/restart/route");
    const response = await POST(makeRequest("42", "restart"), makeContext());
    expect(response.status).toBe(403);
  });
});

describe("POST /api/nodes/[id]/shutdown", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockShutdownNode.mockReset();
    mockRestartNode.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
  });

  it("returns 200 and calls shutdownNode on success", async () => {
    mockShutdownNode.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/nodes/[id]/shutdown/route");
    const response = await POST(makeRequest("42", "shutdown"), makeContext());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockShutdownNode).toHaveBeenCalledWith(adminSession, "42", {
      ip: "127.0.0.1",
    });
  });

  it("returns 403 when the caller lacks nodes:write", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "nodes:write",
    );
    const { POST } = await import("@/app/api/nodes/[id]/shutdown/route");
    const response = await POST(makeRequest("42", "shutdown"), makeContext());
    expect(response.status).toBe(403);
    expect(mockShutdownNode).not.toHaveBeenCalled();
  });
});
