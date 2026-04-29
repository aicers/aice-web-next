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
const mockCreateNodeWithAudit = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/node/node-create-update", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/node/node-create-update")
  >("@/lib/node/node-create-update");
  return {
    ...actual,
    createNodeWithAudit: vi.fn((...args: unknown[]) =>
      mockCreateNodeWithAudit(...args),
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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  name: "node-alpha",
  customerId: "1",
  description: "",
  hostname: "alpha.local",
  agents: [],
  externalServices: [],
};

describe("POST /api/nodes", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockCreateNodeWithAudit.mockReset();
    mockHasPermission.mockReset().mockResolvedValue(true);
  });

  it("returns the new id on success", async () => {
    mockCreateNodeWithAudit.mockResolvedValue("node-42");
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "node-42" });
    expect(mockCreateNodeWithAudit).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when the caller lacks nodes:write", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "nodes:write",
    );
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(403);
    expect(mockCreateNodeWithAudit).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks services:write", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], perm: string) => perm !== "services:write",
    );
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(403);
    expect(mockCreateNodeWithAudit).not.toHaveBeenCalled();
  });

  it("maps a hostname-unique conflict to 409 with field: hostname", async () => {
    mockCreateNodeWithAudit.mockRejectedValue(
      new Error("hostname alpha.local already in use"),
    );
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "hostname alpha.local already in use",
      field: "hostname",
    });
  });

  it("maps a name-unique conflict to 409 with field: name", async () => {
    mockCreateNodeWithAudit.mockRejectedValue(
      new Error("the node's name already exists"),
    );
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "the node's name already exists",
      field: "name",
    });
  });

  it("falls through to a structured 502 for an unmatched GraphQL upstream error", async () => {
    // graphql-request `ClientError` shape carrying an undocumented
    // upstream message — must surface as { error, field: null } so the
    // dialog footer banner can render the real message instead of the
    // generic 500 fallback.
    const upstream = Object.assign(new Error("upstream-aggregate"), {
      response: {
        errors: [{ message: "review-web rejected the mutation: oops" }],
      },
    });
    mockCreateNodeWithAudit.mockRejectedValue(upstream);
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "review-web rejected the mutation: oops",
      field: null,
    });
  });

  it("rethrows non-GraphQL errors so genuine bugs surface as 500", async () => {
    mockCreateNodeWithAudit.mockRejectedValue(
      new TypeError("boom — programming bug"),
    );
    const { POST } = await import("@/app/api/nodes/route");

    await expect(
      POST(makeRequest(validBody), { params: Promise.resolve({}) }),
    ).rejects.toThrow(/boom/);
  });

  it("returns 503 when the manager is unreachable", async () => {
    const { ManagerUnavailableError } = await import("@/lib/node/errors");
    mockCreateNodeWithAudit.mockRejectedValue(
      new ManagerUnavailableError("manager offline"),
    );
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest(validBody), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(503);
  });

  it("rejects an invalid JSON body with 400", async () => {
    const request = new NextRequest("http://localhost:3000/api/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(request, { params: Promise.resolve({}) });

    expect(response.status).toBe(400);
    expect(mockCreateNodeWithAudit).not.toHaveBeenCalled();
  });

  it("rejects a body missing required fields with 400", async () => {
    const { POST } = await import("@/app/api/nodes/route");

    const response = await POST(makeRequest({ name: "x" }), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(400);
    expect(mockCreateNodeWithAudit).not.toHaveBeenCalled();
  });
});
