import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockPoolQuery = vi.hoisted(() => vi.fn());

// Make withAuth a pass-through that directly calls the handler with a
// controllable session object.
let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn) => {
    return async (request: NextRequest, context: unknown) => {
      return handler(request, context, currentSession);
    };
  }),
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

describe("GET /api/auth/me", () => {
  const now = Math.floor(Date.now() / 1000);

  const validSession: AuthSession = {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["admin"],
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
    return new NextRequest("http://localhost:3000/api/auth/me");
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  it("returns user info with correct JSON structure", async () => {
    currentSession = validSession;
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ username: "alice", display_name: "Alice Kim" }],
    });

    const { GET } = await import("@/app/api/auth/me/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      accountId: "account-1",
      username: "alice",
      displayName: "Alice Kim",
      roles: ["admin"],
      mustChangePassword: false,
    });
  });

  it("queries accounts table with correct accountId", async () => {
    currentSession = validSession;
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ username: "alice", display_name: null }],
    });

    const { GET } = await import("@/app/api/auth/me/route");
    await GET(makeRequest(), makeContext());

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT username, display_name FROM accounts"),
      ["account-1"],
    );
  });

  it("returns 404 when account is not found", async () => {
    currentSession = validSession;
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const { GET } = await import("@/app/api/auth/me/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Account not found");
  });

  it("handles null display_name", async () => {
    currentSession = validSession;
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ username: "bob", display_name: null }],
    });

    const { GET } = await import("@/app/api/auth/me/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.displayName).toBeNull();
  });

  it("reflects mustChangePassword from session", async () => {
    currentSession = { ...validSession, mustChangePassword: true };
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ username: "alice", display_name: "Alice" }],
    });

    const { GET } = await import("@/app/api/auth/me/route");
    const response = await GET(makeRequest(), makeContext());
    const body = await response.json();

    expect(body.mustChangePassword).toBe(true);
  });
});
