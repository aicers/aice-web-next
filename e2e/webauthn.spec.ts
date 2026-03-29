import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  deleteWebAuthnChallenges,
  deleteWebAuthnCredentials,
  insertWebAuthnCredential,
  resetAccountDefaults,
  resetMfaPolicy,
} from "./helpers/setup-db";

/**
 * Helper: get CSRF token and Origin header from current page cookies.
 */
function csrfHeaders(csrfValue: string) {
  return {
    "Content-Type": "application/json",
    "x-csrf-token": csrfValue,
    Origin: "http://localhost:3000",
  };
}

async function getCsrf(page: import("@playwright/test").Page) {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf")?.value ?? "";
}

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
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Key 1",
    });
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Key 2",
    });

    await signInAndWait(page, workerUsername, workerPassword);
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
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Existing",
    });

    await signInAndWait(page, workerUsername, workerPassword);
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
    await insertWebAuthnCredential(workerUsername, {
      displayName: "My Passkey",
    });

    await signInAndWait(page, workerUsername, workerPassword);
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
    const credId = await insertWebAuthnCredential(workerUsername, {
      displayName: "Old Name",
    });

    await signInAndWait(page, workerUsername, workerPassword);
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
    const credId = await insertWebAuthnCredential(workerUsername, {
      displayName: "To Delete",
    });

    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.delete(
      `/api/auth/mfa/webauthn/credentials/${credId}`,
      { headers: csrfHeaders(csrf) },
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

  test("delete: 404 for non-existent credential", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    const res = await page.request.delete(
      "/api/auth/mfa/webauthn/credentials/00000000-0000-0000-0000-000000000000",
      { headers: csrfHeaders(csrf) },
    );
    expect(res.status()).toBe(404);
  });

  test("delete: removes only the targeted credential", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const credId1 = await insertWebAuthnCredential(workerUsername, {
      displayName: "Keep",
    });
    const credId2 = await insertWebAuthnCredential(workerUsername, {
      displayName: "Remove",
    });

    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    await page.request.delete(`/api/auth/mfa/webauthn/credentials/${credId2}`, {
      headers: csrfHeaders(csrf),
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
    const credId = await insertWebAuthnCredential(workerUsername, {
      displayName: "Policy Off",
    });

    await signInAndWait(page, workerUsername, workerPassword);
    const csrf = await getCsrf(page);

    // Disable webauthn in policy
    await page.request.patch("/api/system-settings/mfa_policy", {
      headers: csrfHeaders(csrf),
      data: { value: { allowed_methods: ["totp"] } },
    });

    try {
      const res = await page.request.delete(
        `/api/auth/mfa/webauthn/credentials/${credId}`,
        { headers: csrfHeaders(csrf) },
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
