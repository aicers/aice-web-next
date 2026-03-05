import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockQuery = vi.hoisted(() => vi.fn());
const mockVerifyPassword = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockExtractClientIp = vi.hoisted(() => vi.fn());
const mockExtractBrowserFingerprint = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: vi.fn((...args: unknown[]) => mockVerifyPassword(...args)),
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn((...args: unknown[]) => mockExtractClientIp(...args)),
}));

vi.mock("@/lib/auth/ua-parser", () => ({
  extractBrowserFingerprint: vi.fn((...args: unknown[]) =>
    mockExtractBrowserFingerprint(...args),
  ),
}));

describe("POST /api/auth/reauth", () => {
  const now = Math.floor(Date.now() / 1000);

  const validSession: AuthSession = {
    accountId: "acc-1",
    sessionId: "sess-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0 Chrome/131",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: true,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };

  function makeRequest(body?: unknown) {
    return new NextRequest("http://localhost:3000/api/auth/reauth", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 Chrome/132",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  afterEach(() => {
    vi.resetModules();
    mockQuery.mockReset();
    mockVerifyPassword.mockReset();
    mockAuditRecord.mockReset();
    mockExtractClientIp.mockReset();
    mockExtractBrowserFingerprint.mockReset();
  });

  // ── withAuth options ───────────────────────────────────────────

  it("calls withAuth with skipPasswordCheck and skipSessionPolicy", async () => {
    await import("@/app/api/auth/reauth/route");

    expect(mockWithAuth).toHaveBeenCalledWith(expect.any(Function), {
      skipPasswordCheck: true,
      skipSessionPolicy: true,
    });
  });

  // ── Body parsing ───────────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    currentSession = validSession;

    const request = new NextRequest("http://localhost:3000/api/auth/reauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });

    const { POST } = await import("@/app/api/auth/reauth/route");
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid request body");
  });

  it("returns 400 when password is missing", async () => {
    currentSession = validSession;

    const { POST } = await import("@/app/api/auth/reauth/route");
    const response = await POST(makeRequest({}), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Password is required");
  });

  it("returns 400 when password is empty string", async () => {
    currentSession = validSession;

    const { POST } = await import("@/app/api/auth/reauth/route");
    const response = await POST(makeRequest({ password: "" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Password is required");
  });

  // ── Account not found ──────────────────────────────────────────

  it("returns 404 when account not found in DB", async () => {
    currentSession = validSession;
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { POST } = await import("@/app/api/auth/reauth/route");
    const response = await POST(
      makeRequest({ password: "Test1234!" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Account not found");
  });

  // ── Password verification failure ─────────────────────────────

  it("returns 401 when password is invalid", async () => {
    currentSession = validSession;
    mockQuery.mockResolvedValueOnce({
      rows: [{ password_hash: "$argon2id$v=19$hash" }],
      rowCount: 1,
    });
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(false);
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/reauth/route");
    const response = await POST(
      makeRequest({ password: "WrongPassword!" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Invalid password");
  });

  it("records audit log on password failure", async () => {
    currentSession = validSession;
    mockQuery.mockResolvedValueOnce({
      rows: [{ password_hash: "$argon2id$v=19$hash" }],
      rowCount: 1,
    });
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(false);
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/reauth/route");
    await POST(makeRequest({ password: "WrongPassword!" }), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "session.reauth_failure",
      target: "session",
      targetId: "sess-1",
      ip: "10.0.0.1",
      sid: "sess-1",
      details: { reason: "invalid_password" },
    });
  });

  // ── Successful re-authentication ──────────────────────────────

  it("returns 200 { ok: true } on successful re-auth", async () => {
    currentSession = validSession;
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ password_hash: "$argon2id$v=19$hash" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(true);
    mockExtractBrowserFingerprint.mockReturnValue("Chrome/132");
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/reauth/route");
    const response = await POST(
      makeRequest({ password: "Correct1234!" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("clears needs_reauth and updates IP/UA/fingerprint in DB", async () => {
    currentSession = validSession;
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ password_hash: "$argon2id$v=19$hash" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(true);
    mockExtractBrowserFingerprint.mockReturnValue("Chrome/132");
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/reauth/route");
    await POST(makeRequest({ password: "Correct1234!" }), makeContext());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE sessions"),
      ["sess-1", "10.0.0.1", "Mozilla/5.0 Chrome/132", "Chrome/132"],
    );
  });

  it("records audit log on successful re-auth", async () => {
    currentSession = validSession;
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ password_hash: "$argon2id$v=19$hash" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(true);
    mockExtractBrowserFingerprint.mockReturnValue("Chrome/132");
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/reauth/route");
    await POST(makeRequest({ password: "Correct1234!" }), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "session.reauth_success",
      target: "session",
      targetId: "sess-1",
      ip: "10.0.0.1",
      sid: "sess-1",
    });
  });

  it("passes correct args to verifyPassword", async () => {
    currentSession = validSession;
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ password_hash: "$argon2id$hash$here" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(true);
    mockExtractBrowserFingerprint.mockReturnValue("Chrome/132");
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/reauth/route");
    await POST(makeRequest({ password: "MyPassword123!" }), makeContext());

    expect(mockVerifyPassword).toHaveBeenCalledWith(
      "$argon2id$hash$here",
      "MyPassword123!",
    );
  });

  it("extracts browser fingerprint from user-agent header", async () => {
    currentSession = validSession;
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ password_hash: "$argon2id$v=19$hash" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(true);
    mockExtractBrowserFingerprint.mockReturnValue("Chrome/132");
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/reauth/route");
    await POST(makeRequest({ password: "Correct1234!" }), makeContext());

    expect(mockExtractBrowserFingerprint).toHaveBeenCalledWith(
      "Mozilla/5.0 Chrome/132",
    );
  });

  it("uses empty string when user-agent header is missing", async () => {
    currentSession = validSession;
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ password_hash: "$argon2id$v=19$hash" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockExtractClientIp.mockReturnValue("10.0.0.1");
    mockVerifyPassword.mockResolvedValue(true);
    mockExtractBrowserFingerprint.mockReturnValue("Unknown/0");
    mockAuditRecord.mockResolvedValue(undefined);

    // Request without user-agent header
    const request = new NextRequest("http://localhost:3000/api/auth/reauth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "Correct1234!" }),
    });

    const { POST } = await import("@/app/api/auth/reauth/route");
    await POST(request, makeContext());

    expect(mockExtractBrowserFingerprint).toHaveBeenCalledWith("");
  });
});
