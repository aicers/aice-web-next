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
const mockApplyRecover = vi.hoisted(() => vi.fn());
const mockEmitRecoverAudit = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/triage/exclusion/recovery", () => ({
  applyRecover: vi.fn((...args: unknown[]) => mockApplyRecover(...args)),
  emitRecoverAudit: vi.fn((...args: unknown[]) =>
    mockEmitRecoverAudit(...args),
  ),
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

const VALID_ID = "00000000-0000-0000-0000-000000000020";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/triage/exclusions/global/[id]/recover", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockApplyRecover.mockReset();
    mockEmitRecoverAudit.mockReset().mockResolvedValue(undefined);
  });

  it("returns 400 on malformed UUID", async () => {
    const { POST } = await import(
      "@/app/api/triage/exclusions/global/[id]/recover/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/global/not-a-uuid/recover?all_failed=1",
      { method: "POST" },
    );
    const res = await POST(req, makeContext("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither customer_id nor all_failed is supplied", async () => {
    const { POST } = await import(
      "@/app/api/triage/exclusions/global/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}/recover`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(400);
    expect(mockApplyRecover).not.toHaveBeenCalled();
  });

  it("returns 403 when the permission check fails", async () => {
    mockHasPermission.mockReset().mockResolvedValue(false);
    const { POST } = await import(
      "@/app/api/triage/exclusions/global/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}/recover?all_failed=1`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(403);
  });

  it("dispatches all_failed=1 to the kind='global_all_failed' helper", async () => {
    mockApplyRecover.mockResolvedValue({ reset: 5, kind: "global_all_failed" });
    const { POST } = await import(
      "@/app/api/triage/exclusions/global/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}/recover?all_failed=1`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(200);
    expect(mockApplyRecover).toHaveBeenCalledWith({
      kind: "global_all_failed",
      exclusionId: VALID_ID,
    });
    expect(mockEmitRecoverAudit).toHaveBeenCalledWith(
      { kind: "global_all_failed", exclusionId: VALID_ID },
      "admin-1",
      5,
      expect.objectContaining({ ip: "127.0.0.1", sid: "session-1" }),
    );
  });

  it("dispatches customer_id<int> to kind='global' for single-row pinpoint", async () => {
    mockApplyRecover.mockResolvedValue({ reset: 1, kind: "global" });
    const { POST } = await import(
      "@/app/api/triage/exclusions/global/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}/recover?customer_id=7`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(200);
    expect(mockApplyRecover).toHaveBeenCalledWith({
      kind: "global",
      exclusionId: VALID_ID,
      customerId: 7,
    });
  });

  it("returns 400 when customer_id is non-numeric", async () => {
    const { POST } = await import(
      "@/app/api/triage/exclusions/global/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}/recover?customer_id=not-a-number`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no failed rows match", async () => {
    mockApplyRecover.mockResolvedValue({ reset: 0, kind: "global_all_failed" });
    const { POST } = await import(
      "@/app/api/triage/exclusions/global/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/global/${VALID_ID}/recover?all_failed=1`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(404);
    expect(mockEmitRecoverAudit).not.toHaveBeenCalled();
  });
});
