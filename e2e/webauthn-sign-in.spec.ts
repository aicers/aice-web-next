import * as OTPAuth from "otpauth";

import { expect, test } from "./fixtures";
import { resetRateLimits, signIn } from "./helpers/auth";
import {
  deleteMfaChallenges,
  deleteTotpCredential,
  deleteWebAuthnChallenges,
  deleteWebAuthnCredentials,
  enrollAndVerifyTotp,
  insertWebAuthnCredential,
  resetAccountDefaults,
  resetMfaPolicy,
} from "./helpers/setup-db";
import {
  csrfHeaders,
  getCsrf,
  registerViaApi,
  setMfaPolicyViaApi,
} from "./helpers/webauthn";

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

test.describe("WebAuthn sign-in flow (#218)", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetAccountDefaults(workerUsername);
    await resetMfaPolicy();
  });

  // ── WebAuthn step renders when enrolled ────────────────────────

  test("sign-in with WebAuthn enrolled shows WebAuthn step", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Test Key",
    });

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Should show WebAuthn step (passkey prompt)
    await expect(page.getByText(/follow your browser.*prompt/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  // ── Method switching: WebAuthn → TOTP ──────────────────────────

  test("switch from WebAuthn to TOTP and complete sign-in", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const secret = await enrollAndVerifyTotp(workerUsername);
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Test Key",
    });

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Should show WebAuthn step first (default when both available)
    await expect(page.getByText(/follow your browser.*prompt/i)).toBeVisible({
      timeout: 5_000,
    });

    // Click "Use authenticator app instead"
    await page.getByRole("button", { name: /authenticator app/i }).click();

    // Should show TOTP input step
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });

    // Enter valid TOTP code and complete sign-in
    const code = generateCode(secret);
    await totpInput.fill(code);
    await page.getByRole("button", { name: /verify/i }).click();

    // Should redirect to dashboard
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
  });

  // ── Method switching: TOTP → WebAuthn ──────────────────────────

  test("switch from TOTP to WebAuthn step", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await enrollAndVerifyTotp(workerUsername);
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Test Key",
    });

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Wait for WebAuthn step then switch to TOTP
    await expect(page.getByText(/follow your browser.*prompt/i)).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("button", { name: /authenticator app/i }).click();

    // Now in TOTP step, switch back to WebAuthn
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /passkey/i }).click();

    // Should be back at WebAuthn step
    await expect(page.getByText(/follow your browser.*prompt/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  // ── Back button returns to credentials ─────────────────────────

  test("back button from WebAuthn step returns to credentials", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Test Key",
    });

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Wait for WebAuthn step
    await expect(page.getByText(/follow your browser.*prompt/i)).toBeVisible({
      timeout: 5_000,
    });

    // Click back button
    await page.getByRole("button", { name: /back to sign in/i }).click();

    // Should return to credentials form
    await expect(page.getByLabel("Account ID")).toBeVisible();
    await expect(page.locator("input[name='password']")).toBeVisible();
  });

  // ── TOTP-only: no WebAuthn switch link ─────────────────────────

  test("TOTP-only enrollment does not show passkey switch button", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await enrollAndVerifyTotp(workerUsername);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Should show TOTP step
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });

    // Should NOT show "Use passkey instead" button
    const passkeyBtn = page.getByRole("button", { name: /passkey/i });
    await expect(passkeyBtn).not.toBeVisible();
  });

  // ── WebAuthn-only: no TOTP switch link ─────────────────────────

  test("WebAuthn-only enrollment does not show authenticator app switch button", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Test Key",
    });

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Should show WebAuthn step
    await expect(page.getByText(/follow your browser.*prompt/i)).toBeVisible({
      timeout: 5_000,
    });

    // Should NOT show "Use authenticator app instead" button
    const totpBtn = page.getByRole("button", {
      name: /authenticator app/i,
    });
    await expect(totpBtn).not.toBeVisible();
  });

  // ── Complete WebAuthn sign-in with virtual authenticator ───────

  test("complete sign-in with WebAuthn via virtual authenticator", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Set up virtual authenticator
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
      // Sign in and register a real credential via API
      await page.goto("/sign-in");
      await signIn(page, workerUsername, workerPassword);
      await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
        timeout: 10_000,
      });

      const csrf = await getCsrf(page);
      await registerViaApi(page, csrf, "Sign-In Key");

      // Sign out
      await page.request.post("/api/auth/sign-out", {
        headers: csrfHeaders(csrf),
      });

      // Sign in again — should require WebAuthn
      await page.goto("/sign-in");
      await signIn(page, workerUsername, workerPassword);

      // Virtual authenticator auto-responds, should redirect to dashboard
      await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
        timeout: 10_000,
      });
    } finally {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      });
      await cdp.send("WebAuthn.disable");
      await cdp.detach();
    }
  });

  // ── Policy-off: enrolled user bypasses MFA ────────────────────

  test("enrolled WebAuthn user bypasses MFA when admin disables webauthn policy", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Sign in first (no MFA enrolled yet) to get a session for policy change
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });

    // Enroll a credential and disable webauthn policy
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Policy Test Key",
    });
    await setMfaPolicyViaApi(page, ["totp"]);

    try {
      // Sign out
      const csrf = await getCsrf(page);
      await page.request.post("/api/auth/sign-out", {
        headers: csrfHeaders(csrf),
      });

      // Sign in — should go straight to dashboard without WebAuthn
      await page.goto("/sign-in");
      await signIn(page, workerUsername, workerPassword);

      await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
        timeout: 10_000,
      });

      // WebAuthn prompt should NOT have appeared
      await expect(
        page.getByText(/follow your browser.*prompt/i),
      ).not.toBeVisible();
    } finally {
      await resetMfaPolicy();
    }
  });
});
