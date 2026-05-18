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

const mockState = vi.hoisted(() => ({
  getAimerPushState: vi.fn(),
  setOpportunisticEnabled: vi.fn(),
}));
vi.mock("@/lib/aimer/phase2/state", () => mockState);

const now = Math.floor(Date.now() / 1000);
function makeSession(): AuthSession {
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
  };
}

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/aimer/phase2/pause-toggle", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({}) };

describe("POST /api/aimer/phase2/pause-toggle", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockIsSystemAdministrator.mockReset().mockReturnValue(true);
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockExtractIp.mockReset().mockReturnValue("127.0.0.1");
    mockState.getAimerPushState.mockReset().mockResolvedValue({
      kind: "baseline_event",
      last_pushed_event_time: null,
      last_pushed_event_key: null,
      last_synced_at: null,
      last_error: null,
      opportunistic_enabled: true,
      paused_at: null,
      paused_by: null,
      streaming_activated_at: null,
    });
    mockState.setOpportunisticEnabled.mockReset().mockResolvedValue(undefined);
  });

  it("returns 403 when not a System Administrator", async () => {
    mockIsSystemAdministrator.mockReturnValueOnce(false);
    const { POST } = await import("@/app/api/aimer/phase2/pause-toggle/route");
    const res = await POST(
      makeReq({ customer_id: 42, kind: "baseline_event", enabled: false }),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on an unsupported kind", async () => {
    const { POST } = await import("@/app/api/aimer/phase2/pause-toggle/route");
    const res = await POST(
      makeReq({ customer_id: 42, kind: "policy_event", enabled: false }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("emits opportunistic_paused when disabling", async () => {
    const { POST } = await import("@/app/api/aimer/phase2/pause-toggle/route");
    const res = await POST(
      makeReq({ customer_id: 42, kind: "baseline_event", enabled: false }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(mockState.setOpportunisticEnabled).toHaveBeenCalledWith(
      42,
      "baseline_event",
      false,
      "account-1",
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_phase2.opportunistic_paused",
        customerId: 42,
        details: { kind: "baseline_event" },
      }),
    );
  });

  it("emits opportunistic_resumed with pausedDurationSeconds when re-enabling", async () => {
    const pausedAt = new Date(Date.now() - 300_000);
    mockState.getAimerPushState.mockResolvedValueOnce({
      kind: "story",
      last_pushed_event_time: null,
      last_pushed_event_key: null,
      last_synced_at: null,
      last_error: null,
      opportunistic_enabled: false,
      paused_at: pausedAt,
      paused_by: "account-2",
      streaming_activated_at: null,
    });
    const { POST } = await import("@/app/api/aimer/phase2/pause-toggle/route");
    const res = await POST(
      makeReq({ customer_id: 42, kind: "story", enabled: true }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = mockAuditRecord.mock.calls[0][0];
    expect(arg.action).toBe("aimer_phase2.opportunistic_resumed");
    expect(arg.details.kind).toBe("story");
    expect(arg.details.pausedDurationSeconds).toBeGreaterThanOrEqual(300);
  });
});
