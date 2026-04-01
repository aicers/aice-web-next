import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockGetRecoveryCodeCount = vi.hoisted(() => vi.fn());
const mockWithAuth = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: mockWithAuth.mockImplementation(
    (handler: HandlerFn, _options?: unknown) => {
      return async (request: NextRequest, context: unknown) => {
        return handler(request, context, currentSession);
      };
    },
  ),
}));

vi.mock("@/lib/auth/recovery-codes", () => ({
  getRecoveryCodeCount: vi.fn((...args: unknown[]) =>
    mockGetRecoveryCodeCount(...args),
  ),
}));

vi.mock("server-only", () => ({}));

describe("GET /api/auth/mfa/recovery/count", () => {
  const now = Math.floor(Date.now() / 1000);

  const validSession: AuthSession = {
    accountId: "acc-1",
    sessionId: "sess-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0 Chrome/131",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };

  function makeRequest() {
    return new NextRequest(
      "http://localhost:3000/api/auth/mfa/recovery/count",
      {
        method: "GET",
        headers: {
          "user-agent": "Mozilla/5.0 Chrome/131",
        },
      },
    );
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  afterEach(() => {
    mockGetRecoveryCodeCount.mockReset();
  });

  // ── withAuth options ───────────────────────────────────────────

  it("calls withAuth without special options", async () => {
    await import("@/app/api/auth/mfa/recovery/count/route");

    expect(mockWithAuth).toHaveBeenCalledWith(expect.any(Function));
  });

  // ── Successful count ───────────────────────────────────────────

  it("returns remaining and total counts", async () => {
    currentSession = validSession;
    mockGetRecoveryCodeCount.mockResolvedValue({ remaining: 8, total: 10 });

    const { GET } = await import("@/app/api/auth/mfa/recovery/count/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ remaining: 8, total: 10 });
  });

  it("calls getRecoveryCodeCount with session accountId", async () => {
    currentSession = validSession;
    mockGetRecoveryCodeCount.mockResolvedValue({ remaining: 10, total: 10 });

    const { GET } = await import("@/app/api/auth/mfa/recovery/count/route");
    await GET(makeRequest(), makeContext());

    expect(mockGetRecoveryCodeCount).toHaveBeenCalledWith("acc-1");
  });

  it("returns zero remaining when all codes are used", async () => {
    currentSession = validSession;
    mockGetRecoveryCodeCount.mockResolvedValue({ remaining: 0, total: 10 });

    const { GET } = await import("@/app/api/auth/mfa/recovery/count/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(body.remaining).toBe(0);
    expect(body.total).toBe(10);
  });

  it("returns zero total when no codes exist", async () => {
    currentSession = validSession;
    mockGetRecoveryCodeCount.mockResolvedValue({ remaining: 0, total: 0 });

    const { GET } = await import("@/app/api/auth/mfa/recovery/count/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(body.remaining).toBe(0);
    expect(body.total).toBe(0);
  });
});
