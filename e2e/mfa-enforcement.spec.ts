import * as OTPAuth from "otpauth";

import { expect, test } from "./fixtures";
import { resetRateLimits, signIn } from "./helpers/auth";
import {
  deleteMfaChallenges,
  deleteRecoveryCodes,
  deleteTotpCredential,
  deleteWebAuthnCredentials,
  enrollAndVerifyTotp,
  generateRecoveryCodesForAccount,
  resetAccountDefaults,
  resetMfaPolicy,
  setRoleMfaRequired,
} from "./helpers/setup-db";

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

test.describe("MFA enforcement (#220)", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await deleteRecoveryCodes(workerUsername);
    await resetMfaPolicy();
    await setRoleMfaRequired(workerUsername, false);
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await deleteRecoveryCodes(workerUsername);
    await resetMfaPolicy();
    await setRoleMfaRequired(workerUsername, false);
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await deleteRecoveryCodes(workerUsername);
    await resetAccountDefaults(workerUsername);
    await resetMfaPolicy();
    await setRoleMfaRequired(workerUsername, false);
  });

  // ── Test 1: Mandatory MFA enrollment flow ──────────────────

  test("mandatory MFA enrollment: redirect to enroll-mfa, complete TOTP, see recovery codes, reach dashboard", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Enable MFA requirement on the worker's role
    await setRoleMfaRequired(workerUsername, true);

    // Sign in with a user who has NO MFA enrolled
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Should redirect to /enroll-mfa
    await page.waitForURL((url) => url.pathname.includes("/enroll-mfa"), {
      timeout: 10_000,
    });

    // Enrollment page auto-starts TOTP setup; wait for QR code
    await expect(page.getByText(/scan this qr code/i)).toBeVisible({
      timeout: 10_000,
    });

    // Toggle manual key and read secret
    await page.getByText(/enter this key manually/i).click();
    const secretElement = page.locator("code.font-mono").first();
    await expect(secretElement).toBeVisible({ timeout: 5_000 });
    const secret = await secretElement.textContent();
    expect(secret).toBeTruthy();

    // Generate and enter valid TOTP code
    const code = generateCode(secret as string);
    const codeInput = page.locator("input[autocomplete='one-time-code']");
    await codeInput.fill(code);
    await page.getByRole("button", { name: /verify/i }).click();

    // Recovery codes should appear after enrollment
    await expect(
      page.getByText("Save these codes in a safe place.", { exact: true }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Verify codes are displayed (should be a grid of code elements)
    const codeElements = page.locator("code.font-mono.text-sm");
    await expect(codeElements.first()).toBeVisible({ timeout: 5_000 });

    // Click Done to continue
    await page.getByRole("button", { name: /done/i }).click();

    // Should redirect to dashboard (away from enroll-mfa)
    await page.waitForURL(
      (url) =>
        !url.pathname.includes("/enroll-mfa") &&
        !url.pathname.includes("/sign-in"),
      { timeout: 15_000 },
    );
  });

  // ── Test 2: Recovery code sign-in ──────────────────────────

  test("sign in with a recovery code during MFA challenge", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Enroll TOTP so the sign-in flow triggers MFA
    await enrollAndVerifyTotp(workerUsername);

    // Generate recovery codes directly in DB
    const codes = await generateRecoveryCodesForAccount(workerUsername);
    expect(codes.length).toBeGreaterThan(0);

    // Sign in — should show MFA step
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Wait for TOTP input step
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });

    // Click "Use a recovery code"
    await page.getByRole("button", { name: /use a recovery code/i }).click();

    // Should show recovery code input
    await expect(
      page.getByText(/enter one of your recovery codes/i),
    ).toBeVisible({
      timeout: 5_000,
    });

    // Enter a valid recovery code
    const recoveryInput = page.getByPlaceholder("A1B2-C3D4");
    await expect(recoveryInput).toBeVisible({ timeout: 5_000 });
    await recoveryInput.fill(codes[0]);
    await page.getByRole("button", { name: /verify/i }).click();

    // Should redirect to dashboard
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
  });

  // ── Test 3: Recovery code management on profile ────────────

  test("generate and view recovery codes on profile page", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Enroll TOTP so recovery codes card is relevant
    const secret = await enrollAndVerifyTotp(workerUsername);

    // Sign in with TOTP
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });
    await totpInput.fill(generateCode(secret));
    await page.getByRole("button", { name: /verify/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });

    // Navigate to profile
    await page.goto("/profile");

    // Recovery codes card should show "No codes" initially
    const recoveryCard = page
      .locator("[data-slot='card']")
      .filter({ has: page.getByText("Recovery Codes") });
    await expect(recoveryCard.getByText(/no recovery codes/i)).toBeVisible({
      timeout: 10_000,
    });

    // Click generate button
    await recoveryCard
      .getByRole("button", { name: /generate recovery codes/i })
      .click();

    // Dialog should appear asking for password
    await expect(page.getByText(/this will invalidate/i)).toBeVisible({
      timeout: 5_000,
    });

    // Enter password and submit within the dialog
    const dialog = page.getByRole("dialog");
    const passwordInput = dialog.getByLabel("Password");
    await passwordInput.fill(workerPassword);
    await dialog
      .getByRole("button", { name: /generate recovery codes/i })
      .click();

    // Should show the generated codes
    await expect(
      page.getByText("Save these codes in a safe place.", { exact: true }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Verify codes are displayed
    const codeElements = page.locator("code.font-mono.text-sm");
    await expect(codeElements.first()).toBeVisible({ timeout: 5_000 });

    // Click Done
    await page.getByRole("button", { name: /done/i }).click();

    // Card should now show remaining count (e.g., "10 of 10 remaining")
    await expect(recoveryCard.getByText(/of.*remaining/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
