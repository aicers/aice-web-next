import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockLoadMfaPolicy = vi.hoisted(() => vi.fn());
const mockGetTotpCredential = vi.hoisted(() => vi.fn());
const mockVerifyTotpCode = vi.hoisted(() => vi.fn());
const mockActivateTotp = vi.hoisted(() => vi.fn());
const mockGetRecoveryCodeCount = vi.hoisted(() => vi.fn());
const mockGenerateRecoveryCodes = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/auth/mfa-policy", () => ({
  loadMfaPolicy: vi.fn((...args: unknown[]) => mockLoadMfaPolicy(...args)),
}));

vi.mock("@/lib/auth/totp", () => ({
  getTotpCredential: vi.fn((...args: unknown[]) =>
    mockGetTotpCredential(...args),
  ),
  verifyTotpCode: vi.fn((...args: unknown[]) => mockVerifyTotpCode(...args)),
  activateTotp: vi.fn((...args: unknown[]) => mockActivateTotp(...args)),
}));

vi.mock("@/lib/auth/recovery-codes", () => ({
  getRecoveryCodeCount: vi.fn((...args: unknown[]) =>
    mockGetRecoveryCodeCount(...args),
  ),
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

vi.mock("server-only", () => ({}));

describe("POST /api/auth/mfa/totp/verify-setup", () => {
  const now = Math.floor(Date.now() / 1000);

  const validSession: AuthSession = {
    accountId: "acc-1",
    sessionId: "sess-1",
    roles: ["System Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: true,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0 Chrome/131",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };

  const pendingCredential = {
    id: "cred-1",
    accountId: "acc-1",
    secret: "JBSWY3DPEHPK3PXP",
    verified: false,
    createdAt: new Date(),
  };

  function makeRequest(body?: unknown) {
    return new NextRequest(
      "http://localhost:3000/api/auth/mfa/totp/verify-setup",
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
    mockLoadMfaPolicy.mockReset();
    mockGetTotpCredential.mockReset();
    mockVerifyTotpCode.mockReset();
    mockActivateTotp.mockReset();
    mockGetRecoveryCodeCount.mockReset();
    mockGenerateRecoveryCodes.mockReset();
    mockAuditRecord.mockReset();
  });

  // ── withAuth options ───────────────────────────────────────────

  it("calls withAuth with skipMfaEnrollCheck", async () => {
    await import("@/app/api/auth/mfa/totp/verify-setup/route");

    expect(mockWithAuth).toHaveBeenCalledWith(expect.any(Function), {
      skipMfaEnrollCheck: true,
    });
  });

  // ── Body parsing ───────────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });

    const request = new NextRequest(
      "http://localhost:3000/api/auth/mfa/totp/verify-setup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{{",
      },
    );

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 when code is missing", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({}), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Missing required field: code");
  });

  // ── MFA policy ────────────────────────────────────────────────

  it("returns 405 when TOTP is not allowed by policy", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({ allowedMethods: ["webauthn"] });

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "123456" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.code).toBe("TOTP_NOT_ALLOWED");
  });

  // ── No pending setup ──────────────────────────────────────────

  it("returns 404 when no pending TOTP setup exists", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(null);

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "123456" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("TOTP_NOT_FOUND");
  });

  it("returns 404 when credential is already verified", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue({
      ...pendingCredential,
      verified: true,
    });

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "123456" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("TOTP_NOT_FOUND");
  });

  // ── Invalid code ──────────────────────────────────────────────

  it("returns 401 when TOTP code is invalid", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(pendingCredential);
    mockVerifyTotpCode.mockReturnValue(false);

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "000000" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe("INVALID_CODE");
  });

  // ── Successful verification ───────────────────────────────────

  it("returns 200 on successful verification", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(pendingCredential);
    mockVerifyTotpCode.mockReturnValue(true);
    mockActivateTotp.mockResolvedValue(true);
    mockAuditRecord.mockResolvedValue(undefined);
    mockGetRecoveryCodeCount.mockResolvedValue({ total: 5 });

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "123456" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.recoveryCodes).toBeUndefined();
  });

  it("records audit log on successful setup", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(pendingCredential);
    mockVerifyTotpCode.mockReturnValue(true);
    mockActivateTotp.mockResolvedValue(true);
    mockAuditRecord.mockResolvedValue(undefined);
    mockGetRecoveryCodeCount.mockResolvedValue({ total: 5 });

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    await POST(makeRequest({ code: "123456" }), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "mfa.totp.enroll",
      target: "mfa",
      targetId: "acc-1",
      ip: "127.0.0.1",
      sid: "sess-1",
    });
  });

  // ── Recovery code auto-generation ─────────────────────────────

  it("returns recoveryCodes when no existing recovery codes", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(pendingCredential);
    mockVerifyTotpCode.mockReturnValue(true);
    mockActivateTotp.mockResolvedValue(true);
    mockAuditRecord.mockResolvedValue(undefined);
    mockGetRecoveryCodeCount.mockResolvedValue({ total: 0 });
    mockGenerateRecoveryCodes.mockResolvedValue(["A1B2-C3D4", "E5F6-G7H8"]);

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "123456" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.recoveryCodes).toEqual(["A1B2-C3D4", "E5F6-G7H8"]);
  });

  it("logs audit for auto recovery code generation", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(pendingCredential);
    mockVerifyTotpCode.mockReturnValue(true);
    mockActivateTotp.mockResolvedValue(true);
    mockAuditRecord.mockResolvedValue(undefined);
    mockGetRecoveryCodeCount.mockResolvedValue({ total: 0 });
    mockGenerateRecoveryCodes.mockResolvedValue(["A1B2-C3D4"]);

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    await POST(makeRequest({ code: "123456" }), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "mfa.recovery.generate",
      target: "mfa",
      targetId: "acc-1",
      ip: "127.0.0.1",
      sid: "sess-1",
      details: { reason: "auto_first_enrollment" },
    });
  });

  it("does not return recoveryCodes when codes already exist", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(pendingCredential);
    mockVerifyTotpCode.mockReturnValue(true);
    mockActivateTotp.mockResolvedValue(true);
    mockAuditRecord.mockResolvedValue(undefined);
    mockGetRecoveryCodeCount.mockResolvedValue({ total: 8 });

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "123456" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.recoveryCodes).toBeUndefined();
    expect(mockGenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  // ── Activation race condition ─────────────────────────────────

  it("returns 404 when activateTotp fails (race condition)", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockGetTotpCredential.mockResolvedValue(pendingCredential);
    mockVerifyTotpCode.mockReturnValue(true);
    mockActivateTotp.mockResolvedValue(false);

    const { POST } = await import("@/app/api/auth/mfa/totp/verify-setup/route");
    const response = await POST(makeRequest({ code: "123456" }), makeContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("TOTP_NOT_FOUND");
  });
});
