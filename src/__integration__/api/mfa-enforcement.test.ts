import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  type AuthSession,
  authGet,
  authPost,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  deleteMfaChallenges,
  deleteRecoveryCodes,
  deleteTotpCredential,
  deleteWebAuthnCredentials,
  enrollAndVerifyTotp,
  resetAccountDefaults,
  setAccountMfaOverride,
  setRoleMfaRequired,
} from "../helpers/setup-db";
import { SERVER_ORIGIN } from "../setup";

// ── Shared constants ────────────────────────────────────────────

const ADMIN_ROLE = "System Administrator";

// ── Helpers ─────────────────────────────────────────────────────

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

/** Submit recovery code challenge and return response. */
async function submitRecoveryChallenge(
  mfaToken: string,
  code: string,
): Promise<Response> {
  return fetch(`${SERVER_ORIGIN}/api/auth/mfa/recovery/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfaToken, code }),
  });
}

/** Generate recovery codes for the authenticated user. */
async function generateRecoveryCodes(session: AuthSession): Promise<string[]> {
  const res = await authPost(session, "/api/auth/mfa/recovery/generate", {
    password: ADMIN_PASSWORD,
  });
  if (!res.ok)
    throw new Error(`Failed to generate recovery codes: ${res.status}`);
  const body = await res.json();
  return body.codes;
}

/** Get recovery code count for the authenticated user. */
async function getRecoveryCount(
  session: AuthSession,
): Promise<{ remaining: number; total: number }> {
  const res = await authGet(session, "/api/auth/mfa/recovery/count");
  if (!res.ok) throw new Error(`Failed to get recovery count: ${res.status}`);
  return res.json();
}

// ── Cleanup helper ──────────────────────────────────────────────

async function cleanupAll(): Promise<void> {
  await resetRateLimits();
  await resetAccountDefaults(ADMIN_USERNAME);
  await deleteTotpCredential(ADMIN_USERNAME);
  await deleteWebAuthnCredentials(ADMIN_USERNAME);
  await deleteMfaChallenges(ADMIN_USERNAME);
  await deleteRecoveryCodes(ADMIN_USERNAME);
  await setRoleMfaRequired(ADMIN_ROLE, true);
  await setAccountMfaOverride(ADMIN_USERNAME, null);
}

// ── Tests ───────────────────────────────────────────────────────

describe("MFA Enforcement & Recovery Codes", { concurrent: false }, () => {
  beforeAll(async () => {
    await cleanupAll();
  });

  beforeEach(async () => {
    await cleanupAll();
  });

  afterAll(async () => {
    await cleanupAll();
  });

  // ── MFA Enforcement ───────────────────────────────────────────

  describe("MFA Enforcement", () => {
    it("role with mfa_required + user not enrolled → mustEnrollMfa response", async () => {
      await setRoleMfaRequired(ADMIN_ROLE, true);
      await deleteTotpCredential(ADMIN_USERNAME);
      await deleteWebAuthnCredentials(ADMIN_USERNAME);

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mustEnrollMfa).toBe(true);
    });

    it("role with mfa_required + user enrolled → normal MFA challenge", async () => {
      await setRoleMfaRequired(ADMIN_ROLE, true);
      await enrollAndVerifyTotp(ADMIN_USERNAME);

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaToken).toBeDefined();
      expect(body.mustEnrollMfa).toBeFalsy();
    });

    it("mfa_override = 'exempt' → no enforcement", async () => {
      await setRoleMfaRequired(ADMIN_ROLE, true);
      await setAccountMfaOverride(ADMIN_USERNAME, "exempt");
      await deleteTotpCredential(ADMIN_USERNAME);
      await deleteWebAuthnCredentials(ADMIN_USERNAME);

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mustEnrollMfa).toBeFalsy();
    });

    it("mfa_override = 'required' on non-required role → enforced", async () => {
      await setRoleMfaRequired(ADMIN_ROLE, false);
      await setAccountMfaOverride(ADMIN_USERNAME, "required");
      await deleteTotpCredential(ADMIN_USERNAME);
      await deleteWebAuthnCredentials(ADMIN_USERNAME);

      const { status, body } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );

      expect(status).toBe(200);
      expect(body.mustEnrollMfa).toBe(true);
    });
  });

  // ── withAuth rejects when must_enroll_mfa = true ──────────────

  describe("withAuth rejects API calls when must_enroll_mfa = true", () => {
    it("rejects regular API but allows enrollment endpoints", async () => {
      // Ensure enforcement triggers mustEnrollMfa
      await setRoleMfaRequired(ADMIN_ROLE, true);
      await deleteTotpCredential(ADMIN_USERNAME);
      await deleteWebAuthnCredentials(ADMIN_USERNAME);

      // Sign in via HTTP to get a session with must_enroll_mfa = true
      const signInRes = await passwordSignIn(ADMIN_USERNAME, ADMIN_PASSWORD);
      expect(signInRes.body.mustEnrollMfa).toBe(true);

      // Create a real session (signIn helper creates DB session directly)
      // but with must_enroll_mfa = true on the session row.
      // We need to use the actual HTTP flow. The passwordSignIn above
      // created a session via cookies, but we can't capture them.
      // Instead, sign in via the helper and manually flag the session.
      const session = await signIn(ADMIN_USERNAME);

      // Flag the session as must_enroll_mfa in the DB
      const pg = await import("pg");
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");

      function getEnvVar(key: string, fallback: string): string {
        if (process.env[key]) return process.env[key] as string;
        try {
          const envFile = readFileSync(resolve(".env.local"), "utf8");
          const match = envFile.match(new RegExp(`^${key}=(.+)$`, "m"));
          if (match) return match[1].trim();
        } catch {
          // .env.local not found
        }
        return fallback;
      }

      const dbUrl = getEnvVar(
        "DATABASE_URL",
        "postgres://postgres:postgres@localhost:5432/auth_db",
      );

      // Extract sid from session cookie
      const atMatch = session.cookie.match(/at=([^;]+)/);
      if (!atMatch) throw new Error("No access token in session cookie");
      const jwtPayload = JSON.parse(
        Buffer.from(atMatch[1].split(".")[1], "base64url").toString(),
      );
      const sid = jwtPayload.sid;

      const client = new pg.default.Client({ connectionString: dbUrl });
      await client.connect();
      try {
        await client.query(
          "UPDATE sessions SET must_enroll_mfa = true WHERE sid = $1",
          [sid],
        );
      } finally {
        await client.end();
      }

      // Regular API endpoint should be rejected with 403
      const rolesRes = await authGet(session, "/api/roles");
      expect(rolesRes.status).toBe(403);
      const rolesBody = await rolesRes.json();
      expect(rolesBody.code).toBe("MFA_ENROLLMENT_REQUIRED");

      // MFA enrollment endpoint (TOTP status) should succeed
      const totpStatusRes = await authGet(session, "/api/auth/mfa/totp/status");
      expect(totpStatusRes.status).toBe(200);
    });
  });

  // ── Recovery Codes ────────────────────────────────────────────

  describe("Recovery Codes", () => {
    it("generation returns 10 codes", async () => {
      // Disable enforcement so we can sign in cleanly
      await setRoleMfaRequired(ADMIN_ROLE, false);

      const session = await signIn(ADMIN_USERNAME);
      const codes = await generateRecoveryCodes(session);

      expect(codes).toHaveLength(10);
      // Each code should match A1B2-C3D4 format
      for (const code of codes) {
        expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
      }
    });

    it("recovery code verification creates session", async () => {
      // Disable role enforcement, enroll TOTP
      await setRoleMfaRequired(ADMIN_ROLE, false);
      await enrollAndVerifyTotp(ADMIN_USERNAME);

      // Generate recovery codes
      const session = await signIn(ADMIN_USERNAME);
      const codes = await generateRecoveryCodes(session);

      // Sign in to trigger MFA challenge
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      expect(signInBody.mfaRequired).toBe(true);
      const mfaToken = signInBody.mfaToken as string;

      // Use recovery code
      const res = await submitRecoveryChallenge(mfaToken, codes[0]);
      expect(res.status).toBe(200);

      // Should have set session cookies
      const cookies = res.headers.get("set-cookie");
      expect(cookies).toContain("at=");
    });

    it("used recovery code is rejected", async () => {
      await setRoleMfaRequired(ADMIN_ROLE, false);
      await enrollAndVerifyTotp(ADMIN_USERNAME);

      const session = await signIn(ADMIN_USERNAME);
      const codes = await generateRecoveryCodes(session);

      // First use: should succeed
      const { body: signIn1 } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const res1 = await submitRecoveryChallenge(
        signIn1.mfaToken as string,
        codes[0],
      );
      expect(res1.status).toBe(200);

      // Second use of same code with a fresh mfaToken: should fail
      const { body: signIn2 } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const res2 = await submitRecoveryChallenge(
        signIn2.mfaToken as string,
        codes[0],
      );
      expect(res2.status).toBe(401);
      const body2 = await res2.json();
      expect(body2.code).toBe("INVALID_MFA_CODE");
    });

    it("recovery code count decreases after use", async () => {
      await setRoleMfaRequired(ADMIN_ROLE, false);
      await enrollAndVerifyTotp(ADMIN_USERNAME);

      const session = await signIn(ADMIN_USERNAME);
      const codes = await generateRecoveryCodes(session);

      // Before using any code
      const countBefore = await getRecoveryCount(session);
      expect(countBefore.remaining).toBe(10);
      expect(countBefore.total).toBe(10);

      // Use one code
      const { body: signInBody } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const res = await submitRecoveryChallenge(
        signInBody.mfaToken as string,
        codes[0],
      );
      expect(res.status).toBe(200);

      // After using one code
      const freshSession = await signIn(ADMIN_USERNAME);
      const countAfter = await getRecoveryCount(freshSession);
      expect(countAfter.remaining).toBe(9);
      expect(countAfter.total).toBe(10);
    });

    it("regeneration invalidates old codes", async () => {
      await setRoleMfaRequired(ADMIN_ROLE, false);
      await enrollAndVerifyTotp(ADMIN_USERNAME);

      const session = await signIn(ADMIN_USERNAME);

      // Generate set A
      const codesA = await generateRecoveryCodes(session);

      // Regenerate set B
      const codesB = await generateRecoveryCodes(session);

      // Sets should be different
      expect(codesA).not.toEqual(codesB);

      // Try to use a code from set A — should fail
      const { body: signIn1 } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const res1 = await submitRecoveryChallenge(
        signIn1.mfaToken as string,
        codesA[0],
      );
      expect(res1.status).toBe(401);
      const body1 = await res1.json();
      expect(body1.code).toBe("INVALID_MFA_CODE");

      // Use a code from set B — should succeed
      const { body: signIn2 } = await passwordSignIn(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
      );
      const res2 = await submitRecoveryChallenge(
        signIn2.mfaToken as string,
        codesB[0],
      );
      expect(res2.status).toBe(200);

      // Count should show 9/10 (one used from set B)
      const freshSession = await signIn(ADMIN_USERNAME);
      const count = await getRecoveryCount(freshSession);
      expect(count.remaining).toBe(9);
      expect(count.total).toBe(10);
    });
  });
});
