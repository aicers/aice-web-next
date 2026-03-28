import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  type AuthSession,
  authDelete,
  authGet,
  authPatch,
  authPost,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  deleteTotpCredential,
  resetAccountDefaults,
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

describe("TOTP API", () => {
  beforeAll(async () => {
    await resetRateLimits();
  });

  beforeEach(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteTotpCredential(ADMIN_USERNAME);
    // Reset MFA policy via API
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  afterAll(async () => {
    await deleteTotpCredential(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  // ── Setup → verify-setup → status (happy path) ──────────────

  it("setup → verify-setup → status returns enrolled: true", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Setup
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    expect(setupRes.status).toBe(200);
    const setupBody = await setupRes.json();
    expect(setupBody.secret).toBeDefined();
    expect(setupBody.uri).toMatch(/^otpauth:\/\/totp\//);

    // Verify setup
    const code = generateCode(setupBody.secret);
    const verifyRes = await authPost(
      session,
      "/api/auth/mfa/totp/verify-setup",
      { code },
    );
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.success).toBe(true);

    // Status
    const statusRes = await authGet(session, "/api/auth/mfa/totp/status");
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.enrolled).toBe(true);
    expect(statusBody.allowed).toBe(true);
  });

  // ── Setup replaces abandoned (unverified) setup ──────────────

  it("setup replaces abandoned unverified setup", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Start first setup (don't verify)
    const firstRes = await authPost(session, "/api/auth/mfa/totp/setup");
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();

    // Start second setup — should succeed, replacing the first
    const secondRes = await authPost(session, "/api/auth/mfa/totp/setup");
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody.secret).not.toBe(firstBody.secret);
  });

  // ── Setup when already enrolled → 409 ───────────────────────

  it("setup when already enrolled returns 409", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Enroll first
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    const { secret } = await setupRes.json();
    const code = generateCode(secret);
    await authPost(session, "/api/auth/mfa/totp/verify-setup", { code });

    // Try setup again
    const res = await authPost(session, "/api/auth/mfa/totp/setup");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("TOTP_ALREADY_ENROLLED");
  });

  // ── Setup when TOTP disabled in policy → 405 ────────────────

  it("setup when TOTP disabled in policy returns 405", async () => {
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn"]);

    const res = await authPost(session, "/api/auth/mfa/totp/setup");
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe("TOTP_NOT_ALLOWED");
  });

  // ── verify-setup without pending setup → 404 ─────────────────

  it("verify-setup without pending setup returns 404", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPost(session, "/api/auth/mfa/totp/verify-setup", {
      code: "123456",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("TOTP_NOT_FOUND");
  });

  // ── verify-setup with wrong code → 401 ──────────────────────

  it("verify-setup with wrong code returns 401", async () => {
    const session = await signIn(ADMIN_USERNAME);

    await authPost(session, "/api/auth/mfa/totp/setup");

    const res = await authPost(session, "/api/auth/mfa/totp/verify-setup", {
      code: "000000",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CODE");
  });

  // ── verify-setup when policy disabled mid-setup → 405 ───────

  it("verify-setup when policy disabled mid-setup returns 405", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Start setup with TOTP allowed
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    const { secret } = await setupRes.json();

    // Disable TOTP in policy mid-setup
    await setMfaPolicy(session, ["webauthn"]);

    // Try to verify
    const code = generateCode(secret);
    const res = await authPost(session, "/api/auth/mfa/totp/verify-setup", {
      code,
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe("TOTP_NOT_ALLOWED");
  });

  // ── Remove with valid code → success ─────────────────────────

  it("remove with valid code succeeds", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Enroll
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    const { secret } = await setupRes.json();
    const code = generateCode(secret);
    await authPost(session, "/api/auth/mfa/totp/verify-setup", { code });

    // Remove
    const removeCode = generateCode(secret);
    const removeRes = await authDelete(session, "/api/auth/mfa/totp", {
      code: removeCode,
    });
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();
    expect(removeBody.success).toBe(true);

    // Verify status
    const statusRes = await authGet(session, "/api/auth/mfa/totp/status");
    const statusBody = await statusRes.json();
    expect(statusBody.enrolled).toBe(false);
    expect(statusBody.allowed).toBe(true);
  });

  // ── Remove when not enrolled → 404 ────────────────────────────

  it("remove when not enrolled returns 404", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authDelete(session, "/api/auth/mfa/totp", {
      code: "123456",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("TOTP_NOT_FOUND");
  });

  // ── Remove with invalid code → 401 ──────────────────────────

  it("remove with invalid code returns 401", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Enroll
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    const { secret } = await setupRes.json();
    const code = generateCode(secret);
    await authPost(session, "/api/auth/mfa/totp/verify-setup", { code });

    // Remove with wrong code
    const res = await authDelete(session, "/api/auth/mfa/totp", {
      code: "000000",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CODE");
  });

  // ── Remove when policy disabled → still succeeds ─────────────

  it("remove works even when TOTP policy is disabled", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Enroll
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    const { secret } = await setupRes.json();
    const code = generateCode(secret);
    await authPost(session, "/api/auth/mfa/totp/verify-setup", { code });

    // Disable TOTP in policy
    await setMfaPolicy(session, ["webauthn"]);

    // Remove should still work
    const removeCode = generateCode(secret);
    const res = await authDelete(session, "/api/auth/mfa/totp", {
      code: removeCode,
    });
    expect(res.status).toBe(200);
  });

  // ── Status when policy disabled + enrolled ───────────────────

  it("status with disabled policy + enrolled shows both states", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Enroll
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    const { secret } = await setupRes.json();
    const code = generateCode(secret);
    await authPost(session, "/api/auth/mfa/totp/verify-setup", { code });

    // Disable policy
    await setMfaPolicy(session, ["webauthn"]);

    const res = await authGet(session, "/api/auth/mfa/totp/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(true);
    expect(body.allowed).toBe(false);
  });

  // ── Audit log records enroll and remove ────────────────────────

  it("enroll and remove create audit log entries", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Enroll
    const setupRes = await authPost(session, "/api/auth/mfa/totp/setup");
    const { secret } = await setupRes.json();
    const code = generateCode(secret);
    await authPost(session, "/api/auth/mfa/totp/verify-setup", { code });

    // Check enroll audit log
    const enrollRes = await authGet(
      session,
      "/api/audit-logs?action=mfa.totp.enroll&pageSize=1",
    );
    expect(enrollRes.status).toBe(200);
    const enrollBody = await enrollRes.json();
    expect(enrollBody.data.length).toBeGreaterThan(0);
    expect(enrollBody.data[0].action).toBe("mfa.totp.enroll");

    // Remove
    const removeCode = generateCode(secret);
    await authDelete(session, "/api/auth/mfa/totp", { code: removeCode });

    // Check remove audit log
    const removeRes = await authGet(
      session,
      "/api/audit-logs?action=mfa.totp.remove&pageSize=1",
    );
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();
    expect(removeBody.data.length).toBeGreaterThan(0);
    expect(removeBody.data[0].action).toBe("mfa.totp.remove");
  });

  // ── Unauthenticated access → 401 ────────────────────────────

  it("unauthenticated requests return 401", async () => {
    const res = await fetch(`${SERVER_ORIGIN}/api/auth/mfa/totp/status`);
    expect(res.status).toBe(401);
  });
});
