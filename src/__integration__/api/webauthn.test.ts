import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
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
  deleteWebAuthnChallenges,
  deleteWebAuthnCredentials,
  insertWebAuthnCredential,
  resetAccountDefaults,
} from "../helpers/setup-db";
import { SERVER_ORIGIN } from "../setup";

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

describe("WebAuthn API", () => {
  beforeAll(async () => {
    await resetRateLimits();
  });

  beforeEach(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteWebAuthnCredentials(ADMIN_USERNAME);
    await deleteWebAuthnChallenges(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  afterAll(async () => {
    await deleteWebAuthnCredentials(ADMIN_USERNAME);
    await deleteWebAuthnChallenges(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["webauthn", "totp"]);
  });

  // ── Register options ──────────────────────────────────────────

  it("register options returns valid PublicKeyCredentialCreationOptions", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/options",
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rp).toBeDefined();
    expect(body.rp.name).toBeDefined();
    expect(body.rp.id).toBeDefined();
    expect(body.user).toBeDefined();
    expect(body.user.name).toBe(ADMIN_USERNAME);
    expect(body.challenge).toBeDefined();
    expect(typeof body.challenge).toBe("string");
    expect(body.pubKeyCredParams).toBeDefined();
    expect(Array.isArray(body.pubKeyCredParams)).toBe(true);
    expect(body.pubKeyCredParams.length).toBeGreaterThan(0);
    expect(body.authenticatorSelection).toBeDefined();
  });

  it("register options when WebAuthn disabled in policy returns 405", async () => {
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["totp"]);

    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/options",
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
  });

  it("register options includes excludeCredentials for existing credentials", async () => {
    await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "Existing Key",
    });

    const session = await signIn(ADMIN_USERNAME);
    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/options",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.excludeCredentials).toBeDefined();
    expect(body.excludeCredentials.length).toBe(1);
  });

  it("register options excludes multiple existing credentials", async () => {
    await insertWebAuthnCredential(ADMIN_USERNAME, { displayName: "Key 1" });
    await insertWebAuthnCredential(ADMIN_USERNAME, { displayName: "Key 2" });
    await insertWebAuthnCredential(ADMIN_USERNAME, { displayName: "Key 3" });

    const session = await signIn(ADMIN_USERNAME);
    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/options",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.excludeCredentials.length).toBe(3);
  });

  // ── Register verify ───────────────────────────────────────────

  it("register verify without pending challenge returns 400", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/verify",
      { response: { id: "test", rawId: "test", type: "public-key" } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_CHALLENGE_NOT_FOUND");
  });

  it("register verify when WebAuthn disabled in policy returns 405", async () => {
    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["totp"]);

    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/verify",
      { response: { id: "test", rawId: "test", type: "public-key" } },
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
  });

  it("register verify with missing response field returns 400", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/verify",
      { displayName: "test" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required field");
  });

  it("register verify with invalid JSON returns 400", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await fetch(
      `${SERVER_ORIGIN}/api/auth/mfa/webauthn/register/verify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrfToken,
          "User-Agent": "IntegrationTest/1.0",
          Origin: SERVER_ORIGIN,
        },
        body: "not json",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("register verify with malformed attestation after getting challenge returns 400", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Get a real challenge first
    const optionsRes = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/options",
    );
    expect(optionsRes.status).toBe(200);

    // Send a malformed attestation response
    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/verify",
      {
        response: {
          id: "fake-id",
          rawId: "fake-id",
          type: "public-key",
          response: {
            attestationObject: "invalid",
            clientDataJSON: "invalid",
          },
        },
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_VERIFICATION_FAILED");
  });

  it("register verify when policy disabled mid-registration returns 405", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Start registration with WebAuthn allowed
    const optionsRes = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/options",
    );
    expect(optionsRes.status).toBe(200);

    // Disable WebAuthn mid-registration
    await setMfaPolicy(session, ["totp"]);

    // Try to verify
    const res = await authPost(
      session,
      "/api/auth/mfa/webauthn/register/verify",
      {
        response: {
          id: "fake",
          rawId: "fake",
          type: "public-key",
          response: {
            attestationObject: "invalid",
            clientDataJSON: "invalid",
          },
        },
      },
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
  });

  // ── Credential list ───────────────────────────────────────────

  it("credentials list returns empty when none registered", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authGet(session, "/api/auth/mfa/webauthn/credentials");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials).toEqual([]);
  });

  it("credentials list returns registered credentials", async () => {
    await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "MacBook Touch ID",
    });
    await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "YubiKey 5",
    });

    const session = await signIn(ADMIN_USERNAME);
    const res = await authGet(session, "/api/auth/mfa/webauthn/credentials");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials.length).toBe(2);
    expect(body.credentials[0].displayName).toBe("MacBook Touch ID");
    expect(body.credentials[1].displayName).toBe("YubiKey 5");
    expect(body.credentials[0].id).toBeDefined();
    expect(body.credentials[0].createdAt).toBeDefined();
    expect(body.credentials[0].lastUsedAt).toBeNull();
  });

  it("credentials list returns correct fields for each credential", async () => {
    await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "Test Key",
    });

    const session = await signIn(ADMIN_USERNAME);
    const res = await authGet(session, "/api/auth/mfa/webauthn/credentials");
    const body = await res.json();
    const cred = body.credentials[0];

    // Verify all expected fields are present
    expect(cred).toHaveProperty("id");
    expect(cred).toHaveProperty("displayName");
    expect(cred).toHaveProperty("createdAt");
    expect(cred).toHaveProperty("lastUsedAt");
    expect(cred).toHaveProperty("transports");

    // Verify sensitive fields are NOT exposed
    expect(cred).not.toHaveProperty("publicKey");
    expect(cred).not.toHaveProperty("credentialId");
    expect(cred).not.toHaveProperty("counter");
    expect(cred).not.toHaveProperty("accountId");
  });

  // ── Credential rename ─────────────────────────────────────────

  it("rename credential updates display name", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "Old Name",
    });

    const session = await signIn(ADMIN_USERNAME);
    const patchRes = await authPatch(
      session,
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      { displayName: "New Name" },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.success).toBe(true);

    // Verify the name changed
    const listRes = await authGet(
      session,
      "/api/auth/mfa/webauthn/credentials",
    );
    const listBody = await listRes.json();
    expect(listBody.credentials[0].displayName).toBe("New Name");
  });

  it("rename non-existent credential returns 404", async () => {
    const session = await signIn(ADMIN_USERNAME);
    const res = await authPatch(
      session,
      "/api/auth/mfa/webauthn/credentials/00000000-0000-0000-0000-000000000000",
      { displayName: "Test" },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_NOT_FOUND");
  });

  it("rename with invalid UUID returns 400", async () => {
    const session = await signIn(ADMIN_USERNAME);
    const res = await authPatch(
      session,
      "/api/auth/mfa/webauthn/credentials/not-a-uuid",
      { displayName: "Test" },
    );
    expect(res.status).toBe(400);
  });

  it("rename with missing displayName returns 400", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME);

    const session = await signIn(ADMIN_USERNAME);
    const res = await authPatch(
      session,
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      {},
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("displayName");
  });

  it("rename with non-string displayName returns 400", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME);

    const session = await signIn(ADMIN_USERNAME);
    const res = await authPatch(
      session,
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      { displayName: 123 },
    );
    expect(res.status).toBe(400);
  });

  // ── Credential remove ─────────────────────────────────────────

  it("remove credential deletes it", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "To Delete",
    });

    const session = await signIn(ADMIN_USERNAME);
    const deleteRes = await authDelete(
      session,
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      { password: ADMIN_PASSWORD },
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);

    // Verify credential is gone
    const listRes = await authGet(
      session,
      "/api/auth/mfa/webauthn/credentials",
    );
    const listBody = await listRes.json();
    expect(listBody.credentials.length).toBe(0);
  });

  it("remove with invalid UUID returns 400", async () => {
    const session = await signIn(ADMIN_USERNAME);
    const res = await authDelete(
      session,
      "/api/auth/mfa/webauthn/credentials/not-a-uuid",
      { password: ADMIN_PASSWORD },
    );
    expect(res.status).toBe(400);
  });

  it("remove without password returns 400", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);
    const res = await authDelete(
      session,
      `/api/auth/mfa/webauthn/credentials/${credId}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("PASSWORD_REQUIRED");
  });

  it("remove with wrong password returns 401", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);
    const res = await authDelete(
      session,
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      { password: "WrongPassword1!" },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PASSWORD");
  });

  it("remove non-existent credential returns 404", async () => {
    const session = await signIn(ADMIN_USERNAME);
    const res = await authDelete(
      session,
      "/api/auth/mfa/webauthn/credentials/00000000-0000-0000-0000-000000000000",
      { password: ADMIN_PASSWORD },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_NOT_FOUND");
  });

  it("remove works even when WebAuthn policy is disabled", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME);
    const session = await signIn(ADMIN_USERNAME);

    // Disable WebAuthn in policy
    await setMfaPolicy(session, ["totp"]);

    // Remove should still work
    const res = await authDelete(
      session,
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      { password: ADMIN_PASSWORD },
    );
    expect(res.status).toBe(200);
  });

  it("remove only deletes the targeted credential", async () => {
    const credId1 = await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "Keep",
    });
    const credId2 = await insertWebAuthnCredential(ADMIN_USERNAME, {
      displayName: "Delete",
    });

    const session = await signIn(ADMIN_USERNAME);
    await authDelete(session, `/api/auth/mfa/webauthn/credentials/${credId2}`, {
      password: ADMIN_PASSWORD,
    });

    // Verify only the targeted credential is gone
    const listRes = await authGet(
      session,
      "/api/auth/mfa/webauthn/credentials",
    );
    const listBody = await listRes.json();
    expect(listBody.credentials.length).toBe(1);
    expect(listBody.credentials[0].id).toBe(credId1);
    expect(listBody.credentials[0].displayName).toBe("Keep");
  });

  // ── Status ────────────────────────────────────────────────────

  it("status returns not enrolled when no credentials", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authGet(session, "/api/auth/mfa/webauthn/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(false);
    expect(body.allowed).toBe(true);
    expect(body.credentialCount).toBe(0);
  });

  it("status returns enrolled when credentials exist", async () => {
    await insertWebAuthnCredential(ADMIN_USERNAME);

    const session = await signIn(ADMIN_USERNAME);
    const res = await authGet(session, "/api/auth/mfa/webauthn/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(true);
    expect(body.allowed).toBe(true);
    expect(body.credentialCount).toBe(1);
  });

  it("status reflects correct credential count", async () => {
    await insertWebAuthnCredential(ADMIN_USERNAME);
    await insertWebAuthnCredential(ADMIN_USERNAME);
    await insertWebAuthnCredential(ADMIN_USERNAME);

    const session = await signIn(ADMIN_USERNAME);
    const res = await authGet(session, "/api/auth/mfa/webauthn/status");
    const body = await res.json();
    expect(body.credentialCount).toBe(3);
  });

  it("status with disabled policy + enrolled shows both states", async () => {
    await insertWebAuthnCredential(ADMIN_USERNAME);

    const session = await signIn(ADMIN_USERNAME);
    await setMfaPolicy(session, ["totp"]);

    const res = await authGet(session, "/api/auth/mfa/webauthn/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(true);
    expect(body.allowed).toBe(false);
    expect(body.credentialCount).toBe(1);
  });

  // ── Audit log ─────────────────────────────────────────────────

  it("remove creates audit log entry", async () => {
    const credId = await insertWebAuthnCredential(ADMIN_USERNAME);

    const session = await signIn(ADMIN_USERNAME);
    await authDelete(session, `/api/auth/mfa/webauthn/credentials/${credId}`, {
      password: ADMIN_PASSWORD,
    });

    // Check audit log
    const auditRes = await authGet(
      session,
      "/api/audit-logs?action=mfa.webauthn.remove&pageSize=1",
    );
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThan(0);
    expect(auditBody.data[0].action).toBe("mfa.webauthn.remove");
    expect(auditBody.data[0].target_type).toBe("mfa");
  });

  // ── Unauthenticated access ─────────────────────────────────────

  it("unauthenticated GET /status returns 401", async () => {
    const res = await fetch(`${SERVER_ORIGIN}/api/auth/mfa/webauthn/status`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /credentials returns 401", async () => {
    const res = await fetch(
      `${SERVER_ORIGIN}/api/auth/mfa/webauthn/credentials`,
    );
    expect(res.status).toBe(401);
  });

  it("unauthenticated POST /register/options returns 401", async () => {
    const res = await fetch(
      `${SERVER_ORIGIN}/api/auth/mfa/webauthn/register/options`,
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });
});
