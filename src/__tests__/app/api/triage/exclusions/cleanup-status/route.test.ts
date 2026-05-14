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
const mockQuery = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

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

function makeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /api/triage/exclusions/cleanup-status", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockQuery.mockReset();
  });

  it("returns 400 when customer_id is missing", async () => {
    const { GET } = await import(
      "@/app/api/triage/exclusions/cleanup-status/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/cleanup-status",
    );
    const res = await GET(req, makeContext());
    expect(res.status).toBe(400);
  });

  it("returns 400 when customer_id is non-numeric", async () => {
    const { GET } = await import(
      "@/app/api/triage/exclusions/cleanup-status/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/cleanup-status?customer_id=abc",
    );
    const res = await GET(req, makeContext());
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller's scope excludes the requested customer", async () => {
    mockHasPermission
      .mockReset()
      .mockImplementation(async (_roles: string[], perm: string) => {
        if (perm === "customers:access-all") return false;
        return true;
      });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { GET } = await import(
      "@/app/api/triage/exclusions/cleanup-status/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/cleanup-status?customer_id=42",
    );
    const res = await GET(req, makeContext());
    expect(res.status).toBe(403);
  });

  it("returns the failed ids for the customer", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({
      rows: [
        { customer_only_exclusion_id: "exc-1" },
        { customer_only_exclusion_id: "exc-2" },
      ],
      rowCount: 2,
    });
    const { GET } = await import(
      "@/app/api/triage/exclusions/cleanup-status/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/cleanup-status?customer_id=42",
    );
    const res = await GET(req, makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toEqual(["exc-1", "exc-2"]);
    // SELECT was customer-scoped and partial-index aware.
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("customer_id = $1");
    expect(sql).toContain("customer_only_exclusion_id IS NOT NULL");
    expect(sql).toContain("status = 'failed'");
    expect(params).toEqual([42]);
  });
});
