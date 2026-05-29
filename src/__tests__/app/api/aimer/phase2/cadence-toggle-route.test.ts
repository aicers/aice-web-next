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

const mockState = vi.hoisted(() => ({
  setCadenceEnabled: vi.fn(),
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
  return new NextRequest("http://localhost/api/aimer/phase2/cadence-toggle", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({}) };

describe("POST /api/aimer/phase2/cadence-toggle", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockIsSystemAdministrator.mockReset().mockReturnValue(true);
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockState.setCadenceEnabled.mockReset().mockResolvedValue(undefined);
  });

  it("returns 403 when not a System Administrator", async () => {
    mockIsSystemAdministrator.mockReturnValueOnce(false);
    const { POST } = await import(
      "@/app/api/aimer/phase2/cadence-toggle/route"
    );
    const res = await POST(makeReq({ customer_id: 42, enabled: true }), ctx);
    expect(res.status).toBe(403);
    expect(mockState.setCadenceEnabled).not.toHaveBeenCalled();
  });

  it("returns 400 when customer_id is not a positive integer", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/cadence-toggle/route"
    );
    const res = await POST(makeReq({ customer_id: 0, enabled: true }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when enabled is not a boolean", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/cadence-toggle/route"
    );
    const res = await POST(makeReq({ customer_id: 42, enabled: "yes" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the customer is out of scope", async () => {
    mockResolveScope.mockResolvedValueOnce([7]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/cadence-toggle/route"
    );
    const res = await POST(makeReq({ customer_id: 42, enabled: true }), ctx);
    expect(res.status).toBe(404);
    expect(mockState.setCadenceEnabled).not.toHaveBeenCalled();
  });

  it("sets cadence_enabled and returns 204", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/cadence-toggle/route"
    );
    const res = await POST(makeReq({ customer_id: 42, enabled: true }), ctx);
    expect(res.status).toBe(204);
    expect(mockState.setCadenceEnabled).toHaveBeenCalledWith(42, true);
  });

  it("forwards a false flag to disable the cadence", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/cadence-toggle/route"
    );
    const res = await POST(makeReq({ customer_id: 42, enabled: false }), ctx);
    expect(res.status).toBe(204);
    expect(mockState.setCadenceEnabled).toHaveBeenCalledWith(42, false);
  });
});
