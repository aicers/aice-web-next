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

describe("GET /api/triage/exclusions/global/cleanup-status", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockQuery.mockReset();
  });

  it("returns 403 when caller lacks triage:read", async () => {
    mockHasPermission.mockReset().mockResolvedValue(false);
    const { GET } = await import(
      "@/app/api/triage/exclusions/global/cleanup-status/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global/cleanup-status",
    );
    const res = await GET(req, makeContext());
    expect(res.status).toBe(403);
  });

  it("returns the deduplicated set of global exclusion ids with failed rows", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ global_exclusion_id: "g-1" }, { global_exclusion_id: "g-2" }],
      rowCount: 2,
    });
    const { GET } = await import(
      "@/app/api/triage/exclusions/global/cleanup-status/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global/cleanup-status",
    );
    const res = await GET(req, makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toEqual(["g-1", "g-2"]);
    // SELECT DISTINCT to keep the response shape stable when one
    // exclusion has many failed customers.
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("SELECT DISTINCT global_exclusion_id");
    expect(sql).toContain("global_exclusion_id IS NOT NULL");
    expect(sql).toContain("status = 'failed'");
  });

  it("returns an empty array when no failures exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { GET } = await import(
      "@/app/api/triage/exclusions/global/cleanup-status/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global/cleanup-status",
    );
    const res = await GET(req, makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toEqual([]);
  });
});
