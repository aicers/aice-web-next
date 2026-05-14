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

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
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

const VALID_ID = "00000000-0000-0000-0000-000000000010";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/triage/exclusions/[id]/recover", () => {
  beforeEach(() => {
    currentSession = adminSession;
    mockHasPermission.mockReset().mockResolvedValue(true);
    mockApplyRecover.mockReset();
    mockEmitRecoverAudit.mockReset().mockResolvedValue(undefined);
    mockQuery.mockReset();
  });

  it("returns 400 when customer_id is missing", async () => {
    const { POST } = await import(
      "@/app/api/triage/exclusions/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}/recover`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(400);
    expect(mockApplyRecover).not.toHaveBeenCalled();
  });

  it("returns 400 when customer_id is not a positive integer", async () => {
    const { POST } = await import(
      "@/app/api/triage/exclusions/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}/recover?customer_id=0`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(400);
  });

  it("returns 400 on a malformed UUID", async () => {
    mockHasPermission.mockResolvedValue(true);
    const { POST } = await import(
      "@/app/api/triage/exclusions/[id]/recover/route"
    );
    const req = new NextRequest(
      "http://localhost:3000/api/triage/exclusions/not-a-uuid/recover?customer_id=42",
      { method: "POST" },
    );
    const res = await POST(req, makeContext("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(mockApplyRecover).not.toHaveBeenCalled();
  });

  it("returns 403 when the permission check fails", async () => {
    mockHasPermission.mockReset().mockResolvedValue(false);
    const { POST } = await import(
      "@/app/api/triage/exclusions/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}/recover?customer_id=42`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller's scope excludes the requested customer", async () => {
    mockHasPermission
      .mockReset()
      .mockImplementation(async (_roles: string[], perm: string) => {
        // triage:exclusion:write is satisfied; customers:access-all is not.
        if (perm === "customers:access-all") return false;
        return true;
      });
    // No row in account_customer for this customer.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { POST } = await import(
      "@/app/api/triage/exclusions/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}/recover?customer_id=42`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(403);
    expect(mockApplyRecover).not.toHaveBeenCalled();
  });

  it("returns 404 when no failed sentinel matches", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockApplyRecover.mockResolvedValue({ reset: 0, kind: "customer" });
    const { POST } = await import(
      "@/app/api/triage/exclusions/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}/recover?customer_id=42`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(404);
    expect(mockEmitRecoverAudit).not.toHaveBeenCalled();
  });

  it("resets the sentinel and emits customer_recover audit on success", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockApplyRecover.mockResolvedValue({ reset: 1, kind: "customer" });
    const { POST } = await import(
      "@/app/api/triage/exclusions/[id]/recover/route"
    );
    const req = new NextRequest(
      `http://localhost:3000/api/triage/exclusions/${VALID_ID}/recover?customer_id=42`,
      { method: "POST" },
    );
    const res = await POST(req, makeContext(VALID_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: VALID_ID, reset: 1 });
    expect(mockApplyRecover).toHaveBeenCalledWith({
      kind: "customer",
      exclusionId: VALID_ID,
      customerId: 42,
    });
    expect(mockEmitRecoverAudit).toHaveBeenCalledWith(
      { kind: "customer", exclusionId: VALID_ID, customerId: 42 },
      "admin-1",
      1,
      expect.objectContaining({ sid: "session-1", ip: "127.0.0.1" }),
    );
  });
});
