import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

const mockWithAuth = vi.hoisted(() => vi.fn());
const mockLoadMfaPolicy = vi.hoisted(() => vi.fn());
const mockConsumeRegistrationChallenge = vi.hoisted(() => vi.fn());
const mockGetRelyingParty = vi.hoisted(() => vi.fn());
const mockStoreWebAuthnCredential = vi.hoisted(() => vi.fn());
const mockBase64urlToUint8Array = vi.hoisted(() => vi.fn());
const mockVerifyRegistrationResponse = vi.hoisted(() => vi.fn());
const mockGetRecoveryCodeCount = vi.hoisted(() => vi.fn());
const mockGenerateRecoveryCodes = vi.hoisted(() => vi.fn());
const mockAuditRecord = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/auth/webauthn", () => ({
  consumeRegistrationChallenge: vi.fn((...args: unknown[]) =>
    mockConsumeRegistrationChallenge(...args),
  ),
  getRelyingParty: vi.fn((...args: unknown[]) => mockGetRelyingParty(...args)),
  storeWebAuthnCredential: vi.fn((...args: unknown[]) =>
    mockStoreWebAuthnCredential(...args),
  ),
  base64urlToUint8Array: vi.fn((...args: unknown[]) =>
    mockBase64urlToUint8Array(...args),
  ),
}));

vi.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: vi.fn((...args: unknown[]) =>
    mockVerifyRegistrationResponse(...args),
  ),
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

describe("POST /api/auth/mfa/webauthn/register/verify", () => {
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

  const fakeResponse = { id: "cred-id-base64url", type: "public-key" };

  const fakeRp = {
    id: "localhost",
    origin: "http://localhost:3000",
  };

  const fakeVerification = {
    verified: true,
    registrationInfo: {
      credential: {
        id: "cred-id-base64url",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
      },
    },
  };

  function makeRequest(body?: unknown) {
    return new NextRequest(
      "http://localhost:3000/api/auth/mfa/webauthn/register/verify",
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

  /** Set up mocks for a full success path. */
  function setupSuccessPath(opts?: { recoveryTotal?: number }) {
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn", "totp"],
    });
    mockConsumeRegistrationChallenge.mockResolvedValue("expected-challenge");
    mockGetRelyingParty.mockReturnValue(fakeRp);
    mockVerifyRegistrationResponse.mockResolvedValue(fakeVerification);
    mockBase64urlToUint8Array.mockReturnValue(new Uint8Array([99]));
    mockStoreWebAuthnCredential.mockResolvedValue("db-cred-id");
    mockAuditRecord.mockResolvedValue(undefined);
    mockGetRecoveryCodeCount.mockResolvedValue({
      total: opts?.recoveryTotal ?? 5,
    });
    mockGenerateRecoveryCodes.mockResolvedValue(["A1B2-C3D4", "E5F6-G7H8"]);
  }

  afterEach(() => {
    mockLoadMfaPolicy.mockReset();
    mockConsumeRegistrationChallenge.mockReset();
    mockGetRelyingParty.mockReset();
    mockStoreWebAuthnCredential.mockReset();
    mockBase64urlToUint8Array.mockReset();
    mockVerifyRegistrationResponse.mockReset();
    mockGetRecoveryCodeCount.mockReset();
    mockGenerateRecoveryCodes.mockReset();
    mockAuditRecord.mockReset();
  });

  // ── withAuth options ───────────────────────────────────────────

  it("calls withAuth with skipMfaEnrollCheck", async () => {
    await import("@/app/api/auth/mfa/webauthn/register/verify/route");

    expect(mockWithAuth).toHaveBeenCalledWith(expect.any(Function), {
      skipMfaEnrollCheck: true,
    });
  });

  // ── Body parsing ───────────────────────────────────────────────

  it("returns 400 for invalid JSON body", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn"],
    });

    const request = new NextRequest(
      "http://localhost:3000/api/auth/mfa/webauthn/register/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{{",
      },
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(request, makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 when response (credential) is missing", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn"],
    });

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(makeRequest({}), makeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Missing required field: response");
  });

  // ── MFA policy ────────────────────────────────────────────────

  it("returns 405 when WebAuthn is not allowed by MFA policy", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["totp"],
    });

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(
      makeRequest({ response: fakeResponse }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
  });

  // ── Challenge ─────────────────────────────────────────────────

  it("returns 400 when no pending challenge exists", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn"],
    });
    mockConsumeRegistrationChallenge.mockResolvedValue(null);

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(
      makeRequest({ response: fakeResponse }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("WEBAUTHN_CHALLENGE_NOT_FOUND");
  });

  // ── Verification failure ──────────────────────────────────────

  it("returns 400 when verifyRegistrationResponse throws", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn"],
    });
    mockConsumeRegistrationChallenge.mockResolvedValue("expected-challenge");
    mockGetRelyingParty.mockReturnValue(fakeRp);
    mockVerifyRegistrationResponse.mockRejectedValue(
      new Error("Attestation invalid"),
    );

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(
      makeRequest({ response: fakeResponse }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("WEBAUTHN_VERIFICATION_FAILED");
  });

  it("returns 400 when verification returns verified: false", async () => {
    currentSession = validSession;
    mockLoadMfaPolicy.mockResolvedValue({
      allowedMethods: ["webauthn"],
    });
    mockConsumeRegistrationChallenge.mockResolvedValue("expected-challenge");
    mockGetRelyingParty.mockReturnValue(fakeRp);
    mockVerifyRegistrationResponse.mockResolvedValue({
      verified: false,
      registrationInfo: null,
    });

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(
      makeRequest({ response: fakeResponse }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("WEBAUTHN_VERIFICATION_FAILED");
  });

  // ── Successful verification ───────────────────────────────────

  it("returns 200 on successful verification and stores credential", async () => {
    currentSession = validSession;
    setupSuccessPath();

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(
      makeRequest({ response: fakeResponse, displayName: "My Key" }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.credential.id).toBe("db-cred-id");
    expect(body.credential.displayName).toBe("My Key");

    expect(mockStoreWebAuthnCredential).toHaveBeenCalledWith({
      accountId: "acc-1",
      credentialId: new Uint8Array([99]),
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal"],
      displayName: "My Key",
    });
  });

  // ── Recovery codes ────────────────────────────────────────────

  it("returns recoveryCodes when no existing recovery codes (total === 0)", async () => {
    currentSession = validSession;
    setupSuccessPath({ recoveryTotal: 0 });

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(
      makeRequest({ response: fakeResponse }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.recoveryCodes).toEqual(["A1B2-C3D4", "E5F6-G7H8"]);
    expect(mockGenerateRecoveryCodes).toHaveBeenCalledWith("acc-1");
  });

  it("does NOT return recoveryCodes when existing codes exist (total > 0)", async () => {
    currentSession = validSession;
    setupSuccessPath({ recoveryTotal: 5 });

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    const response = await POST(
      makeRequest({ response: fakeResponse }),
      makeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.recoveryCodes).toBeUndefined();
    expect(mockGenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  // ── Audit log ─────────────────────────────────────────────────

  it("records audit log on success", async () => {
    currentSession = validSession;
    setupSuccessPath();

    const { POST } = await import(
      "@/app/api/auth/mfa/webauthn/register/verify/route"
    );
    await POST(makeRequest({ response: fakeResponse }), makeContext());

    expect(mockAuditRecord).toHaveBeenCalledWith({
      actor: "acc-1",
      action: "mfa.webauthn.register",
      target: "mfa",
      targetId: "acc-1",
      ip: "127.0.0.1",
      sid: "sess-1",
    });
  });
});
