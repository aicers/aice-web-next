import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockValidateMfaChallenge = vi.hoisted(() => vi.fn());
const mockVerifyRecoveryCode = vi.hoisted(() => vi.fn());
const mockCreateSessionAndIssueTokens = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());
const mockGenerateCorrelationId = vi.hoisted(() =>
  vi.fn(() => "corr-test-123"),
);
const mockWithCorrelationId = vi.hoisted(() =>
  vi.fn((_id: string, fn: () => Promise<NextResponse>) => fn()),
);

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/mfa-challenge", () => ({
  validateMfaChallenge: vi.fn((...args: unknown[]) =>
    mockValidateMfaChallenge(...args),
  ),
}));

vi.mock("@/lib/auth/recovery-codes", () => ({
  verifyRecoveryCode: vi.fn((...args: unknown[]) =>
    mockVerifyRecoveryCode(...args),
  ),
}));

vi.mock("@/lib/auth/sign-in", () => ({
  createSessionAndIssueTokens: vi.fn((...args: unknown[]) =>
    mockCreateSessionAndIssueTokens(...args),
  ),
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/audit/logger", () => ({
  auditLog: {
    record: vi.fn((...args: unknown[]) => mockAuditRecord(...args)),
  },
}));

vi.mock("@/lib/audit/correlation", () => ({
  generateCorrelationId: mockGenerateCorrelationId,
  withCorrelationId: mockWithCorrelationId,
}));

describe("POST /api/auth/mfa/recovery/challenge", () => {
  const validContext = {
    accountId: "acc-1",
    jti: "jti-abc",
    roles: ["System Administrator"],
    tokenVersion: 0,
    account: {
      id: "acc-1",
      status: "active",
      token_version: 0,
      must_change_password: false,
      max_sessions: null,
      allowed_ips: null,
      role_name: "System Administrator",
      locale: "en",
    },
    ip: "10.0.0.1",
  };

  function makeRequest(body?: unknown) {
    return new NextRequest(
      "http://localhost:3000/api/auth/mfa/recovery/challenge",
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

  afterEach(() => {
    mockValidateMfaChallenge.mockReset();
    mockVerifyRecoveryCode.mockReset();
    mockCreateSessionAndIssueTokens.mockReset();
    mockQuery.mockReset();
    mockAuditRecord.mockReset();
  });

  // ── Body parsing ───────────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/auth/mfa/recovery/challenge",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{{",
      },
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid request body");
  });

  it("returns 400 when mfaToken is missing", async () => {
    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    const response = await POST(makeRequest({ code: "A1B2-C3D4" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("mfaToken and code are required");
  });

  it("returns 400 when code is missing", async () => {
    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    const response = await POST(makeRequest({ mfaToken: "token-123" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("mfaToken and code are required");
  });

  // ── MFA challenge validation failure ───────────────────────────

  it("returns error response when validateMfaChallenge fails", async () => {
    mockValidateMfaChallenge.mockResolvedValue(
      NextResponse.json(
        { error: "Invalid or expired MFA token", code: "MFA_TOKEN_INVALID" },
        { status: 401 },
      ),
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    const response = await POST(
      makeRequest({ mfaToken: "bad-token", code: "A1B2-C3D4" }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe("MFA_TOKEN_INVALID");
  });

  // ── Invalid recovery code ─────────────────────────────────────

  it("returns 401 when recovery code is invalid", async () => {
    mockValidateMfaChallenge.mockResolvedValue(validContext);
    mockVerifyRecoveryCode.mockResolvedValue(false);
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    const response = await POST(
      makeRequest({ mfaToken: "valid-token", code: "XXXX-YYYY" }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Invalid recovery code");
    expect(body.code).toBe("INVALID_MFA_CODE");
  });

  it("records audit log on invalid recovery code", async () => {
    mockValidateMfaChallenge.mockResolvedValue(validContext);
    mockVerifyRecoveryCode.mockResolvedValue(false);
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    await POST(makeRequest({ mfaToken: "valid-token", code: "XXXX-YYYY" }));

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "mfa.recovery.use",
      target: "mfa",
      targetId: "acc-1",
      ip: "10.0.0.1",
      details: { success: false },
    });
  });

  // ── Token already used ────────────────────────────────────────

  it("returns 401 when MFA token was already consumed", async () => {
    mockValidateMfaChallenge.mockResolvedValue(validContext);
    mockVerifyRecoveryCode.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE returns no rows
    mockAuditRecord.mockResolvedValue(undefined);

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    const response = await POST(
      makeRequest({ mfaToken: "valid-token", code: "A1B2-C3D4" }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Token already used");
    expect(body.code).toBe("MFA_TOKEN_INVALID");
  });

  // ── Successful challenge ───────────────────────────────────────

  it("creates session on successful recovery code verification", async () => {
    mockValidateMfaChallenge.mockResolvedValue(validContext);
    mockVerifyRecoveryCode.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [{ jti: "jti-abc" }] });
    mockAuditRecord.mockResolvedValue(undefined);
    mockCreateSessionAndIssueTokens.mockResolvedValue(
      NextResponse.json({ ok: true }),
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    const response = await POST(
      makeRequest({ mfaToken: "valid-token", code: "A1B2-C3D4" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("calls createSessionAndIssueTokens with correct params", async () => {
    mockValidateMfaChallenge.mockResolvedValue(validContext);
    mockVerifyRecoveryCode.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [{ jti: "jti-abc" }] });
    mockAuditRecord.mockResolvedValue(undefined);
    mockCreateSessionAndIssueTokens.mockResolvedValue(
      NextResponse.json({ ok: true }),
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    await POST(makeRequest({ mfaToken: "valid-token", code: "A1B2-C3D4" }));

    expect(mockCreateSessionAndIssueTokens).toHaveBeenCalledWith({
      accountId: "acc-1",
      roleName: "System Administrator",
      tokenVersion: 0,
      mustChangePassword: false,
      locale: "en",
      ip: "10.0.0.1",
      userAgent: "Mozilla/5.0 Chrome/131",
    });
  });

  it("records audit log on successful recovery code use", async () => {
    mockValidateMfaChallenge.mockResolvedValue(validContext);
    mockVerifyRecoveryCode.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [{ jti: "jti-abc" }] });
    mockAuditRecord.mockResolvedValue(undefined);
    mockCreateSessionAndIssueTokens.mockResolvedValue(
      NextResponse.json({ ok: true }),
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    await POST(makeRequest({ mfaToken: "valid-token", code: "A1B2-C3D4" }));

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "mfa.recovery.use",
      target: "mfa",
      targetId: "acc-1",
      ip: "10.0.0.1",
      details: { success: true },
    });
  });

  it("atomically consumes the MFA challenge token", async () => {
    mockValidateMfaChallenge.mockResolvedValue(validContext);
    mockVerifyRecoveryCode.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [{ jti: "jti-abc" }] });
    mockAuditRecord.mockResolvedValue(undefined);
    mockCreateSessionAndIssueTokens.mockResolvedValue(
      NextResponse.json({ ok: true }),
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/recovery/challenge/route"
    );
    await POST(makeRequest({ mfaToken: "valid-token", code: "A1B2-C3D4" }));

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE mfa_challenges SET used = true"),
      ["jti-abc"],
    );
  });
});
