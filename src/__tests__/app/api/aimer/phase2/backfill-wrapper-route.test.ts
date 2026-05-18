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

const mockRunBackfill = vi.hoisted(() => vi.fn());
class StubMultiVersionError extends Error {
  baselineVersions: string[];
  constructor(versions: string[]) {
    super(`multi versions: ${versions.join(", ")}`);
    this.name = "Phase2BackfillMultiVersionError";
    this.baselineVersions = versions;
  }
}
vi.mock("@/lib/aimer/phase2/backfill", () => ({
  runPhase2Backfill: mockRunBackfill,
  Phase2BackfillMultiVersionError: StubMultiVersionError,
}));

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
  return new NextRequest("http://localhost/api/aimer/phase2/backfill", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({}) };

const okWindow = () => ({
  from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  to: new Date(Date.now() - 60 * 1000).toISOString(),
});

describe("POST /api/aimer/phase2/backfill", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockIsSystemAdministrator.mockReset().mockReturnValue(true);
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
    mockExtractIp.mockReset().mockReturnValue("127.0.0.1");
    mockRunBackfill.mockReset().mockResolvedValue({
      enqueuedNoticeIds: ["n1", "n2"],
    });
  });

  it("returns 403 when not a System Administrator", async () => {
    mockIsSystemAdministrator.mockReturnValueOnce(false);
    const { POST } = await import("@/app/api/aimer/phase2/backfill/route");
    const res = await POST(
      makeReq({ customer_id: 42, kind: "baseline_event", ...okWindow() }),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("rejects inverted windows", async () => {
    const { POST } = await import("@/app/api/aimer/phase2/backfill/route");
    const res = await POST(
      makeReq({
        customer_id: 42,
        kind: "baseline_event",
        from: "2030-01-02T00:00:00Z",
        to: "2030-01-01T00:00:00Z",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects windows extending into the future", async () => {
    const { POST } = await import("@/app/api/aimer/phase2/backfill/route");
    const res = await POST(
      makeReq({
        customer_id: 42,
        kind: "story",
        from: new Date().toISOString(),
        to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns enqueued ids and emits the audit row on success", async () => {
    const { POST } = await import("@/app/api/aimer/phase2/backfill/route");
    const window = okWindow();
    const res = await POST(
      makeReq({ customer_id: 42, kind: "baseline_event", ...window }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enqueued_notice_ids).toEqual(["n1", "n2"]);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "aimer_phase2.backfill",
        customerId: 42,
        details: expect.objectContaining({
          kind: "baseline_event",
          from: window.from,
          to: window.to,
          enqueuedNoticeCount: 2,
        }),
      }),
    );
  });

  it("maps Phase2BackfillMultiVersionError to 400", async () => {
    mockRunBackfill.mockRejectedValueOnce(
      new StubMultiVersionError(["v1", "v2"]),
    );
    const { POST } = await import("@/app/api/aimer/phase2/backfill/route");
    const res = await POST(
      makeReq({ customer_id: 42, kind: "baseline_event", ...okWindow() }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
