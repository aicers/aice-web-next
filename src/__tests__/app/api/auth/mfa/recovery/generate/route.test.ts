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
const mockGenerateRecoveryCodes = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockCheckSensitiveOpRateLimit = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/auth/recovery-codes", () => ({
  generateRecoveryCodes: vi.fn((...args: unknown[]) =>
    mockGenerateRecoveryCodes(...args),
  ),
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/auth/ip", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/rate-limit/limiter", () => ({
  checkSensitiveOpRateLimit: vi.fn((...args: unknown[]) =>
    mockCheckSensitiveOpRateLimit(...args),
  ),
}));

vi.mock("server-only", () => ({}));

describe("POST /api/auth/mfa/recovery/generate", () => {
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

  function makeRequest(body?: unknown) {
    return new NextRequest(
      "http://localhost:3000/api/auth/mfa/recovery/generate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 Chrome/131",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
    );
  }

  function makeContext() {
    return { params: Promise.resolve({}) };
  }

  afterEach(() => {
    mockQuery.mockReset();
    mockVerifyPassword.mockReset();
    mockGenerateRecoveryCodes.mockReset();
    mockAuditRecord.mockReset();
    mockCheckSensitiveOpRateLimit.mockReset();
  });

  // ── withAuth options ───────────────────────────────────────────

  it("calls withAuth with skipMfaEnrollCheck", async () => {
    await import("@/app/api/auth/mfa/recovery/generate/route");

    expect(mockWithAuth).toHaveBeenCalledWith(expect.any(Function), {
      skipMfaEnrollCheck: true,
    });
  });

  // ── Body parsing ───────────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    currentSession = validSession;

    const request = new NextRequest(
      "http://localhost:3000/api/auth/mfa/recovery/generate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{{",
      },
    );

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid request body");
  });

  it("returns 400 when password is missing", async () => {
    currentSession = validSession;

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    const response = await POST(makeRequest({}), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Password is required");
  });

  // ── Rate limiting ──────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    currentSession = validSession;
    mockCheckSensitiveOpRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 60,
    });

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    const response = await POST(
      makeRequest({ password: "Test1234!" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error).toBe("Too many attempts");
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  // ── Account not found ─────────────────────────────────────────

  it("returns 404 when account is not found", async () => {
    currentSession = validSession;
    mockCheckSensitiveOpRateLimit.mockResolvedValue({ limited: false });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    const response = await POST(
      makeRequest({ password: "Test1234!" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Account not found");
  });

  // ── Incorrect password ─────────────────────────────────────────

  it("returns 401 when password is incorrect", async () => {
    currentSession = validSession;
    mockCheckSensitiveOpRateLimit.mockResolvedValue({ limited: false });
    mockQuery.mockResolvedValueOnce({
      rows: [{ password_hash: "$argon2id$hash" }],
      rowCount: 1,
    });
    mockVerifyPassword.mockResolvedValue(false);

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    const response = await POST(
      makeRequest({ password: "WrongPassword!" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Incorrect password");
    expect(body.code).toBe("INCORRECT_PASSWORD");
  });

  // ── Successful generation ──────────────────────────────────────

  it("returns codes on success", async () => {
    currentSession = validSession;
    mockCheckSensitiveOpRateLimit.mockResolvedValue({ limited: false });
    mockQuery.mockResolvedValueOnce({
      rows: [{ password_hash: "$argon2id$hash" }],
      rowCount: 1,
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockGenerateRecoveryCodes.mockResolvedValue(["A1B2-C3D4", "E5F6-G7H8"]);
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    const response = await POST(
      makeRequest({ password: "Correct1234!" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.codes).toEqual(["A1B2-C3D4", "E5F6-G7H8"]);
  });

  it("records audit log on successful generation", async () => {
    currentSession = validSession;
    mockCheckSensitiveOpRateLimit.mockResolvedValue({ limited: false });
    mockQuery.mockResolvedValueOnce({
      rows: [{ password_hash: "$argon2id$hash" }],
      rowCount: 1,
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockGenerateRecoveryCodes.mockResolvedValue(["A1B2-C3D4"]);
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    await POST(makeRequest({ password: "Correct1234!" }), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "mfa.recovery.generate",
      target: "mfa",
      targetId: "acc-1",
      ip: "127.0.0.1",
      sid: "sess-1",
    });
  });

  it("calls generateRecoveryCodes with the session accountId", async () => {
    currentSession = validSession;
    mockCheckSensitiveOpRateLimit.mockResolvedValue({ limited: false });
    mockQuery.mockResolvedValueOnce({
      rows: [{ password_hash: "$argon2id$hash" }],
      rowCount: 1,
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockGenerateRecoveryCodes.mockResolvedValue([]);
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/auth/mfa/recovery/generate/route");
    await POST(makeRequest({ password: "Correct1234!" }), makeContext());

    expect(mockGenerateRecoveryCodes).toHaveBeenCalledWith("acc-1");
  });
});
