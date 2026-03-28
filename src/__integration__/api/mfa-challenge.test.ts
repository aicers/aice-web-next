import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  type AuthSession,
  authGet,
  authPatch,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createFakeSessions,
  deleteMfaChallenges,
  deleteTotpCredential,
  enrollAndVerifyTotp,
  incrementTokenVersion,
  resetAccountDefaults,
  setAccountRole,
  setAccountStatus,
  setAllowedIps,
  setMaxSessions,
} from "../helpers/setup-db";
import { SERVER_ORIGIN } from "../setup";

/** Generate a valid TOTP code for a given base32 secret. */
function generateCode(secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: "AICE",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.generate();
}

/** Update MFA policy via the settings API (invalidates server cache). */
async function setMfaPolicy(
  session: AuthSession,
  allowedMethods: string[],
): Promise<void> {
  const res = await authPatch(session, "/api/system-settings/mfa_policy", {
    value: { allowed_methods: allowedMethods },
  });
  if (!res.ok) throw new Error(`Failed to update MFA policy: ${res.status}`);
}

/** Perform password sign-in and return response body. */
async function passwordSignIn(
  username: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${SERVER_ORIGIN}/api/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** Submit TOTP challenge and return response. */
async function submitChallenge(
  mfaToken: string,
  code: string,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}/api/auth/mfa/totp/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfaToken, code }),
  });
}

describe("MFA Challenge", () => {
  beforeAll(async () => {
    await resetRateLimits();
  });

  beforeEach(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteTotpCredential(ADMIN_USERNAME);
    await deleteMfaChallenges(ADMIN_USERNAME);
    await setAllowedIps(ADMIN_USERNAME, null);
    // Reset MFA policy via API
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  afterAll(async () => {
    await deleteTotpCredential(ADMIN_USERNAME);
    await deleteMfaChallenges(ADMIN_USERNAME);
    await setAllowedIps(ADMIN_USERNAME, null);
    await resetAccountDefaults(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  // ── Sign-in behavior ───────────────────────────────────────────

  describe("sign-in with TOTP", () => {
    it("returns mfaRequired when TOTP enrolled and policy on", async () => {
      await enrollAndVerifyTotp(ADMIN_USERNAME);

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaToken).toBeDefined();
      expect(typeof body.mfaToken).toBe("string");
      expect(body.mfaMethods).toEqual(["totp"]);
    });

    it("returns normal session when TOTP enrolled but policy off", async () => {
      await enrollAndVerifyTotp(ADMIN_USERNAME);
      const session = await signIn(ADMIN_USERNAME);
      await setMfaPolicy(session, ["webauthn"]); // TOTP disabled

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mfaRequired).toBeUndefined();
      expect(body.mustChangePassword).toBeDefined();
    });

    it("returns normal session when no TOTP enrolled", async () => {
      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mfaRequired).toBeUndefined();
      expect(body.mustChangePassword).toBeDefined();
    });
  });

  // ── Challenge endpoint ─────────────────────────────────────────

  describe("POST /api/auth/mfa/totp/challenge", () => {
    it("creates session with valid TOTP code", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      const code = generateCode(secret);
      const res = await submitChallenge(signInBody.mfaToken as string, code);

      expect(res.status).toBe(200);
      const challengeBody = await res.json();
      expect(challengeBody.mustChangePassword).toBeDefined();

      // Verify cookies were set (session created)
      const cookies = res.headers.get("set-cookie");
      expect(cookies).toContain("at=");
    });

    it("returns 401 INVALID_MFA_CODE with wrong code, token still usable", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Wrong code
      const res1 = await submitChallenge(mfaToken, "000000");
      expect(res1.status).toBe(401);
      const body1 = await res1.json();
      expect(body1.code).toBe("INVALID_MFA_CODE");

      // Same token with correct code should still work
      const code = generateCode(secret);
      const res2 = await submitChallenge(mfaToken, code);
      expect(res2.status).toBe(200);
    });

    it("returns 401 for expired/invalid mfaToken", async () => {
      await enrollAndVerifyTotp(ADMIN_USERNAME);

      const res = await submitChallenge("invalid.jwt.token", "123456");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("MFA_TOKEN_INVALID");
    });

    it("returns 401 for replayed token after success", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // First attempt succeeds
      const code = generateCode(secret);
      const res1 = await submitChallenge(mfaToken, code);
      expect(res1.status).toBe(200);

      // Replay with same token
      const code2 = generateCode(secret);
      const res2 = await submitChallenge(mfaToken, code2);
      expect(res2.status).toBe(401);
      const body2 = await res2.json();
      expect(body2.code).toBe("MFA_TOKEN_INVALID");
    });

    it("returns 400 for non-6-digit code", async () => {
      await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      const res = await submitChallenge(signInBody.mfaToken as string, "12345");
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing fields", async () => {
      const res = await fetch(`${SERVER_ORIGIN}/api/auth/mfa/totp/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Re-validation scenarios ────────────────────────────────────

  describe("account state re-validation", () => {
    it("rejects when account suspended mid-flow", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Suspend account between sign-in and challenge
      await setAccountStatus(ADMIN_USERNAME, "suspended");

      const code = generateCode(secret);
      const res = await submitChallenge(mfaToken, code);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("ACCOUNT_INACTIVE");
    });

    it("rejects when account locked mid-flow", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      await setAccountStatus(ADMIN_USERNAME, "locked");

      const code = generateCode(secret);
      const res = await submitChallenge(mfaToken, code);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("ACCOUNT_LOCKED");
    });

    it("rejects when token_version changed mid-flow", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Increment token_version (simulates password reset or sign-out-all)
      await incrementTokenVersion(ADMIN_USERNAME);

      const code = generateCode(secret);
      const res = await submitChallenge(mfaToken, code);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("MFA_TOKEN_INVALID");
    });

    it("rejects when max sessions reached mid-flow", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Set max sessions to 1 and create a session
      await setMaxSessions(ADMIN_USERNAME, 1);
      await createFakeSessions(ADMIN_USERNAME, 1);

      const code = generateCode(secret);
      const res = await submitChallenge(mfaToken, code);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("MAX_SESSIONS");
    });

    it("rejects when TOTP policy disabled mid-flow", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Disable TOTP in policy
      const session = await signIn(ADMIN_USERNAME);
      await setMfaPolicy(session, ["webauthn"]);

      const code = generateCode(secret);
      const res = await submitChallenge(mfaToken, code);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("TOTP_NOT_ALLOWED");
    });

    it("rejects when role changed mid-flow", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Change user's role (the mfaToken has the old role)
      await setAccountRole(ADMIN_USERNAME, "Security Monitor");

      const code = generateCode(secret);
      const res = await submitChallenge(mfaToken, code);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("MFA_TOKEN_INVALID");

      // Restore original role
      await setAccountRole(ADMIN_USERNAME, "System Administrator");
    });

    it("rejects when IP not in allowed list", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Set allowed IPs to exclude test IP
      await setAllowedIps(ADMIN_USERNAME, ["10.0.0.0/8"]);

      const code = generateCode(secret);
      const res = await submitChallenge(mfaToken, code);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("IP_RESTRICTED");
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────

  describe("rate limiting", () => {
    it("returns 429 after exceeding MFA challenge limit", async () => {
      await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const mfaToken = signInBody.mfaToken as string;

      // Send 5 wrong attempts (at threshold)
      for (let i = 0; i < 5; i++) {
        const res = await submitChallenge(mfaToken, "000000");
        expect(res.status).toBe(401);
      }

      // 6th attempt should be rate limited
      const res = await submitChallenge(mfaToken, "000000");
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.code).toBe("MFA_RATE_LIMITED");
      expect(res.headers.get("Retry-After")).toBeDefined();
    });
  });

  // ── Audit logging ──────────────────────────────────────────────

  describe("audit logging", () => {
    it("records mfa.totp.verify.success on successful challenge", async () => {
      const secret = await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      const code = generateCode(secret);
      const res = await submitChallenge(signInBody.mfaToken as string, code);
      expect(res.status).toBe(200);

      // Check audit log
      const session = await signIn(ADMIN_USERNAME);
      const auditRes = await authGet(
        session,
        "/api/audit-logs?action=mfa.totp.verify.success&pageSize=1",
      );
      expect(auditRes.status).toBe(200);
      const auditBody = await auditRes.json();
      expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.data[0].action).toBe("mfa.totp.verify.success");
    });

    it("records mfa.totp.verify.failure on wrong code", async () => {
      await enrollAndVerifyTotp(ADMIN_USERNAME);
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      const res = await submitChallenge(
        signInBody.mfaToken as string,
        "000000",
      );
      expect(res.status).toBe(401);

      // Check audit log
      const session = await signIn(ADMIN_USERNAME);
      const auditRes = await authGet(
        session,
        "/api/audit-logs?action=mfa.totp.verify.failure&pageSize=1",
      );
      expect(auditRes.status).toBe(200);
      const auditBody = await auditRes.json();
      expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.data[0].action).toBe("mfa.totp.verify.failure");
    });
  });
});
