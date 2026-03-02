import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetAccessTokenCookie = vi.hoisted(() => vi.fn());
const mockVerifyJwtFull = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/cookies", () => ({
  getAccessTokenCookie: mockGetAccessTokenCookie,
}));

vi.mock("@/lib/auth/jwt", () => ({
  verifyJwtFull: mockVerifyJwtFull,
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockPoolQuery(...args)),
}));

describe("withAuth", () => {
  let guard: typeof import("@/lib/auth/guard");

  const validSession: AuthSession = {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["admin"],
    tokenVersion: 0,
    mustChangePassword: false,
  };

  function makeRequest(url = "http://localhost:3000/api/test") {
    return new NextRequest(url);
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  beforeEach(async () => {
    mockGetAccessTokenCookie.mockReset();
    mockVerifyJwtFull.mockReset();
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });

    guard = await import("@/lib/auth/guard");
  });

  it("returns 401 when no cookie is present", async () => {
    mockGetAccessTokenCookie.mockResolvedValue(undefined);

    const handler = vi.fn();
    const wrapped = guard.withAuth(handler);
    const response = await wrapped(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Authentication required");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 when token verification fails", async () => {
    mockGetAccessTokenCookie.mockResolvedValue("bad-token");
    mockVerifyJwtFull.mockRejectedValue(new Error("Invalid token"));

    const handler = vi.fn();
    const wrapped = guard.withAuth(handler);
    const response = await wrapped(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Invalid or expired token");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 403 when mustChangePassword is true", async () => {
    mockGetAccessTokenCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue({
      ...validSession,
      mustChangePassword: true,
    });

    const handler = vi.fn();
    const wrapped = guard.withAuth(handler);
    const response = await wrapped(makeRequest(), makeContext());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Password change required");
    expect(body.redirect).toBe("/change-password");
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls handler with session on valid token", async () => {
    mockGetAccessTokenCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(validSession);

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = guard.withAuth(handler);
    const request = makeRequest();
    const context = makeContext();

    const response = await wrapped(request, context);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith(request, context, validSession);
  });

  it("updates last_active_at in the database", async () => {
    mockGetAccessTokenCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(validSession);

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = guard.withAuth(handler);
    await wrapped(makeRequest(), makeContext());

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE sessions SET last_active_at"),
      ["session-1"],
    );
  });

  it("updates last_active_at before calling the handler", async () => {
    mockGetAccessTokenCookie.mockResolvedValue("valid-token");
    mockVerifyJwtFull.mockResolvedValue(validSession);

    const callOrder: string[] = [];

    mockPoolQuery.mockImplementation(async () => {
      callOrder.push("db-update");
      return { rows: [], rowCount: 0 };
    });

    const handler = vi.fn().mockImplementation(async () => {
      callOrder.push("handler");
      return NextResponse.json({ ok: true });
    });

    const wrapped = guard.withAuth(handler);
    await wrapped(makeRequest(), makeContext());

    expect(callOrder).toEqual(["db-update", "handler"]);
  });
});
