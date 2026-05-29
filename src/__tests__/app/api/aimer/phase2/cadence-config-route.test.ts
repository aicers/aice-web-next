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

const mockBuildConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/status", () => ({
  buildPhase2CadenceConfig: mockBuildConfig,
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

function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/aimer/phase2/cadence-config");
}

const ctx = { params: Promise.resolve({}) };

describe("GET /api/aimer/phase2/cadence-config", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockIsSystemAdministrator.mockReset().mockReturnValue(true);
    mockResolveScope.mockReset().mockResolvedValue([7, 42]);
    mockBuildConfig.mockReset().mockResolvedValue({
      customers: [{ customer_id: 42, cadence_enabled: true }],
    });
  });

  it("returns 403 when not a System Administrator", async () => {
    mockIsSystemAdministrator.mockReturnValueOnce(false);
    const { GET } = await import("@/app/api/aimer/phase2/cadence-config/route");
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBe(403);
    expect(mockBuildConfig).not.toHaveBeenCalled();
  });

  it("returns the opted-in customers for the effective scope", async () => {
    const { GET } = await import("@/app/api/aimer/phase2/cadence-config/route");
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBe(200);
    expect(mockBuildConfig).toHaveBeenCalledWith([7, 42]);
    const body = (await res.json()) as {
      customers: { customer_id: number; cadence_enabled: boolean }[];
    };
    expect(body.customers).toEqual([
      { customer_id: 42, cadence_enabled: true },
    ]);
  });

  it("returns 500 when the config build fails", async () => {
    mockBuildConfig.mockRejectedValueOnce(new Error("pool down"));
    const { GET } = await import("@/app/api/aimer/phase2/cadence-config/route");
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBe(500);
  });
});
