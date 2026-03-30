import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  deleteWebAuthnChallenges,
  deleteWebAuthnCredentials,
  insertWebAuthnCredential,
  resetAccountDefaults,
  resetMfaPolicy,
} from "./helpers/setup-db";
import {
  createCredentialInBrowser,
  csrfHeaders,
  getCsrf,
} from "./helpers/webauthn";

test.describe("WebAuthn API (#217)", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await resetAccountDefaults(workerUsername);
    await resetMfaPolicy();
  });

  // ── Status endpoint ──────────────────────────────────────────

  test("status: not enrolled, webauthn allowed", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.get("/api/auth/mfa/webauthn/status", {
      headers: csrfHeaders(csrf),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(false);
    expect(body.allowed).toBe(true);
    expect(body.credentialCount).toBe(0);
  });

  test("status: enrolled with credential count", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    await insertWebAuthnCredential(workerUsername, {
      displayName: "Key 1",
    });
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Key 2",
    });
    const csrf = await getCsrf(page);

    const res = await page.request.get("/api/auth/mfa/webauthn/status", {
      headers: csrfHeaders(csrf),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(true);
    expect(body.credentialCount).toBe(2);
  });

  test("status: webauthn not allowed by policy", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    // Disable webauthn in policy via API
    await page.request.patch("/api/system-settings/mfa_policy", {
      headers: csrfHeaders(csrf),
      data: { value: { allowed_methods: ["totp"] } },
    });

    try {
      const res = await page.request.get("/api/auth/mfa/webauthn/status", {
        headers: csrfHeaders(csrf),
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(false);
    } finally {
      await page.request.patch("/api/system-settings/mfa_policy", {
        headers: csrfHeaders(csrf),
        data: { value: { allowed_methods: ["webauthn", "totp"] } },
      });
    }
  });

  // ── Registration options endpoint ──────────────────────────

  test("register options: returns valid attestation options", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.post(
      "/api/auth/mfa/webauthn/register/options",
      { headers: csrfHeaders(csrf) },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Should have WebAuthn registration fields
    expect(body.challenge).toBeTruthy();
    expect(body.rp).toBeTruthy();
    expect(body.rp.name).toBeTruthy();
    expect(body.user).toBeTruthy();
    expect(body.user.name).toBe(workerUsername);
    expect(body.pubKeyCredParams).toBeTruthy();
  });

  test("register options: blocked when policy disables webauthn", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    await page.request.patch("/api/system-settings/mfa_policy", {
      headers: csrfHeaders(csrf),
      data: { value: { allowed_methods: ["totp"] } },
    });

    try {
      const res = await page.request.post(
        "/api/auth/mfa/webauthn/register/options",
        { headers: csrfHeaders(csrf) },
      );
      expect(res.status()).toBe(405);
      const body = await res.json();
      expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
    } finally {
      await page.request.patch("/api/system-settings/mfa_policy", {
        headers: csrfHeaders(csrf),
        data: { value: { allowed_methods: ["webauthn", "totp"] } },
      });
    }
  });

  test("register options: excludes existing credentials", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    await insertWebAuthnCredential(workerUsername, {
      displayName: "Existing",
    });
    const csrf = await getCsrf(page);

    const res = await page.request.post(
      "/api/auth/mfa/webauthn/register/options",
      { headers: csrfHeaders(csrf) },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.excludeCredentials).toBeTruthy();
    expect(body.excludeCredentials.length).toBeGreaterThanOrEqual(1);
  });

  // ── Full registration happy path (virtual authenticator) ───

  test("register: full options → verify → credential created", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    // Create a virtual authenticator via CDP
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      },
    );

    try {
      // Step 1: Get registration options
      const optionsRes = await page.request.post(
        "/api/auth/mfa/webauthn/register/options",
        { headers: csrfHeaders(csrf) },
      );
      expect(optionsRes.status()).toBe(200);
      const options = await optionsRes.json();
      expect(options.challenge).toBeTruthy();

      // Step 2: Create credential with the virtual authenticator
      const credential = await createCredentialInBrowser(page, options);

      // Step 3: Verify the registration
      const verifyRes = await page.request.post(
        "/api/auth/mfa/webauthn/register/verify",
        {
          headers: csrfHeaders(csrf),
          data: { response: credential, displayName: "E2E Virtual Key" },
        },
      );
      expect(verifyRes.status()).toBe(200);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.success).toBe(true);
      expect(verifyBody.credential.id).toBeTruthy();
      expect(verifyBody.credential.displayName).toBe("E2E Virtual Key");

      // Step 4: Verify status shows enrolled
      const statusRes = await page.request.get(
        "/api/auth/mfa/webauthn/status",
        { headers: csrfHeaders(csrf) },
      );
      const statusBody = await statusRes.json();
      expect(statusBody.enrolled).toBe(true);
      expect(statusBody.credentialCount).toBeGreaterThanOrEqual(1);

      // Step 5: Verify credential appears in list
      const listRes = await page.request.get(
        "/api/auth/mfa/webauthn/credentials",
        { headers: csrfHeaders(csrf) },
      );
      const listBody = await listRes.json();
      const found = listBody.credentials.find(
        (c: { id: string }) => c.id === verifyBody.credential.id,
      );
      expect(found).toBeTruthy();
      expect(found.displayName).toBe("E2E Virtual Key");
    } finally {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      });
      await cdp.send("WebAuthn.disable");
      await cdp.detach();
    }
  });

  test("register: re-requesting options replaces challenge and verify still works", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      },
    );

    try {
      // Request options twice — the second should replace the first
      await page.request.post("/api/auth/mfa/webauthn/register/options", {
        headers: csrfHeaders(csrf),
      });
      const optionsRes = await page.request.post(
        "/api/auth/mfa/webauthn/register/options",
        { headers: csrfHeaders(csrf) },
      );
      expect(optionsRes.status()).toBe(200);
      const options = await optionsRes.json();

      // Create and verify with the second challenge
      const credential = await createCredentialInBrowser(page, options);

      const verifyRes = await page.request.post(
        "/api/auth/mfa/webauthn/register/verify",
        {
          headers: csrfHeaders(csrf),
          data: { response: credential, displayName: "Retry Key" },
        },
      );
      expect(verifyRes.status()).toBe(200);
      expect((await verifyRes.json()).success).toBe(true);
    } finally {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      });
      await cdp.send("WebAuthn.disable");
      await cdp.detach();
    }
  });

  // ── Register verify endpoint ───────────────────────────────

  test("register verify: rejects when no pending challenge", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.post(
      "/api/auth/mfa/webauthn/register/verify",
      {
        headers: csrfHeaders(csrf),
        data: { response: { id: "fake", type: "public-key" } },
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("WEBAUTHN_CHALLENGE_NOT_FOUND");
  });

  test("register verify: rejects with missing response field", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.post(
      "/api/auth/mfa/webauthn/register/verify",
      {
        headers: csrfHeaders(csrf),
        data: {},
      },
    );
    expect(res.status()).toBe(400);
  });

  test("register verify: blocked when policy disables webauthn", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    await page.request.patch("/api/system-settings/mfa_policy", {
      headers: csrfHeaders(csrf),
      data: { value: { allowed_methods: ["totp"] } },
    });

    try {
      const res = await page.request.post(
        "/api/auth/mfa/webauthn/register/verify",
        {
          headers: csrfHeaders(csrf),
          data: { response: { id: "fake", type: "public-key" } },
        },
      );
      expect(res.status()).toBe(405);
      const body = await res.json();
      expect(body.code).toBe("WEBAUTHN_NOT_ALLOWED");
    } finally {
      await page.request.patch("/api/system-settings/mfa_policy", {
        headers: csrfHeaders(csrf),
        data: { value: { allowed_methods: ["webauthn", "totp"] } },
      });
    }
  });

  // ── Credentials list endpoint ──────────────────────────────

  test("credentials: empty list when no credentials", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.get("/api/auth/mfa/webauthn/credentials", {
      headers: csrfHeaders(csrf),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.credentials).toEqual([]);
  });

  test("credentials: lists credentials with safe fields only", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    await insertWebAuthnCredential(workerUsername, {
      displayName: "My Passkey",
    });
    const csrf = await getCsrf(page);

    const res = await page.request.get("/api/auth/mfa/webauthn/credentials", {
      headers: csrfHeaders(csrf),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.credentials.length).toBe(1);

    const cred = body.credentials[0];
    expect(cred.id).toBeTruthy();
    expect(cred.displayName).toBe("My Passkey");
    expect(cred.createdAt).toBeTruthy();
    // Sensitive fields must not be exposed
    expect(cred.publicKey).toBeUndefined();
    expect(cred.credentialId).toBeUndefined();
  });

  // ── Credential rename endpoint ─────────────────────────────

  test("rename: updates display name", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const credId = await insertWebAuthnCredential(workerUsername, {
      displayName: "Old Name",
    });
    const csrf = await getCsrf(page);

    const res = await page.request.patch(
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      {
        headers: csrfHeaders(csrf),
        data: { displayName: "New Name" },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify via list
    const listRes = await page.request.get(
      "/api/auth/mfa/webauthn/credentials",
      { headers: csrfHeaders(csrf) },
    );
    const listBody = await listRes.json();
    expect(listBody.credentials[0].displayName).toBe("New Name");
  });

  test("rename: 404 for non-existent credential", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.patch(
      "/api/auth/mfa/webauthn/credentials/00000000-0000-0000-0000-000000000000",
      {
        headers: csrfHeaders(csrf),
        data: { displayName: "Nope" },
      },
    );
    expect(res.status()).toBe(404);
  });

  // ── Credential delete endpoint ─────────────────────────────

  test("delete: removes credential", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const credId = await insertWebAuthnCredential(workerUsername, {
      displayName: "To Delete",
    });
    const csrf = await getCsrf(page);

    const res = await page.request.delete(
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      {
        headers: csrfHeaders(csrf),
        data: { password: workerPassword },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify it's gone
    const listRes = await page.request.get(
      "/api/auth/mfa/webauthn/credentials",
      { headers: csrfHeaders(csrf) },
    );
    const listBody = await listRes.json();
    expect(listBody.credentials.length).toBe(0);
  });

  test("delete: 400 without password", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const credId = await insertWebAuthnCredential(workerUsername);
    const csrf = await getCsrf(page);

    const res = await page.request.delete(
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      { headers: csrfHeaders(csrf) },
    );
    expect(res.status()).toBe(400);
  });

  test("delete: 401 with wrong password", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const credId = await insertWebAuthnCredential(workerUsername);
    const csrf = await getCsrf(page);

    const res = await page.request.delete(
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      {
        headers: csrfHeaders(csrf),
        data: { password: "WrongPassword1!" },
      },
    );
    expect(res.status()).toBe(401);
  });

  test("delete: 404 for non-existent credential", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.delete(
      "/api/auth/mfa/webauthn/credentials/00000000-0000-0000-0000-000000000000",
      {
        headers: csrfHeaders(csrf),
        data: { password: workerPassword },
      },
    );
    expect(res.status()).toBe(404);
  });

  test("delete: removes only the targeted credential", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const credId1 = await insertWebAuthnCredential(workerUsername, {
      displayName: "Keep",
    });
    const credId2 = await insertWebAuthnCredential(workerUsername, {
      displayName: "Remove",
    });
    const csrf = await getCsrf(page);

    await page.request.delete(`/api/auth/mfa/webauthn/credentials/${credId2}`, {
      headers: csrfHeaders(csrf),
      data: { password: workerPassword },
    });

    const listRes = await page.request.get(
      "/api/auth/mfa/webauthn/credentials",
      { headers: csrfHeaders(csrf) },
    );
    const listBody = await listRes.json();
    expect(listBody.credentials.length).toBe(1);
    expect(listBody.credentials[0].id).toBe(credId1);
    expect(listBody.credentials[0].displayName).toBe("Keep");
  });

  test("delete: works even when webauthn is disabled by policy", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const credId = await insertWebAuthnCredential(workerUsername, {
      displayName: "Policy Off",
    });
    const csrf = await getCsrf(page);

    // Disable webauthn in policy
    await page.request.patch("/api/system-settings/mfa_policy", {
      headers: csrfHeaders(csrf),
      data: { value: { allowed_methods: ["totp"] } },
    });

    try {
      const res = await page.request.delete(
        `/api/auth/mfa/webauthn/credentials/${credId}`,
        {
          headers: csrfHeaders(csrf),
          data: { password: workerPassword },
        },
      );
      // Deletion should still work (policy-independent, like TOTP remove)
      expect(res.status()).toBe(200);
    } finally {
      await page.request.patch("/api/system-settings/mfa_policy", {
        headers: csrfHeaders(csrf),
        data: { value: { allowed_methods: ["webauthn", "totp"] } },
      });
    }
  });

  // ── Unauthenticated access ─────────────────────────────────

  test("unauthenticated: status returns 401", async ({ page }) => {
    const res = await page.request.get("/api/auth/mfa/webauthn/status");
    expect(res.status()).toBe(401);
  });

  test("unauthenticated: credentials list returns 401", async ({ page }) => {
    const res = await page.request.get("/api/auth/mfa/webauthn/credentials");
    expect(res.status()).toBe(401);
  });

  test("unauthenticated: register options returns 401", async ({ page }) => {
    const res = await page.request.post(
      "/api/auth/mfa/webauthn/register/options",
    );
    expect(res.status()).toBe(401);
  });
});
