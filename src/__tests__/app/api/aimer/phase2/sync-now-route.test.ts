import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: (handler: HandlerFn) => async (req: NextRequest, ctx: unknown) =>
    handler(req, ctx, currentSession),
}));

const mockIsSystemAdministrator = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/role-guard", () => ({
  isSystemAdministrator: mockIsSystemAdministrator,
}));

const mockResolveScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveScope,
}));

const mockAuditRecord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

const mockExtractIp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: mockExtractIp,
}));

const now = Math.floor(Date.now() / 1000);
function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0",
    sessionBrowserFingerprint: "Mozilla/5.0",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
    ...overrides,
  };
}

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/aimer/phase2/sync-now", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({}) };

describe("POST /api/aimer/phase2/sync-now", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockIsSystemAdministrator.mockReset().mockReturnValue(true);
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockExtractIp.mockReset().mockReturnValue("127.0.0.1");
  });

  it("returns 403 when not a System Administrator", async () => {
    mockIsSystemAdministrator.mockReturnValueOnce(false);
    const { POST } = await import("@/app/api/aimer/phase2/sync-now/route");
    const res = await POST(makeReq({ customer_id: 42 }), ctx);
    expect(res.status).toBe(403);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid customer_id", async () => {
    const { POST } = await import("@/app/api/aimer/phase2/sync-now/route");
    const res = await POST(makeReq({ customer_id: 0 }), ctx);
    expect(res.status).toBe(400);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("returns 404 when the customer is out of scope", async () => {
    mockResolveScope.mockResolvedValueOnce([1, 2]);
    const { POST } = await import("@/app/api/aimer/phase2/sync-now/route");
    const res = await POST(makeReq({ customer_id: 42 }), ctx);
    expect(res.status).toBe(404);
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });

  it("records the audit row and returns 204", async () => {
    const { POST } = await import("@/app/api/aimer/phase2/sync-now/route");
    const res = await POST(makeReq({ customer_id: 42 }), ctx);
    expect(res.status).toBe(204);
    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    const arg = mockAuditRecord.mock.calls[0][0];
    expect(arg.action).toBe("aimer_phase2.sync_now");
    expect(arg.customerId).toBe(42);
    expect(arg.actor).toBe("account-1");
    expect(arg.details.triggeredKinds).toEqual([
      "baseline_event",
      "story",
      "policy_event",
    ]);
  });
});
