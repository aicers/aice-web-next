import type { Page } from "@playwright/test";
import * as OTPAuth from "otpauth";

import { expect, test } from "./fixtures";
import { resetRateLimits, signIn, signInAndWait } from "./helpers/auth";
import {
  deleteMfaChallenges,
  deleteTotpCredential,
  enrollAndVerifyTotp,
  resetAccountDefaults,
  resetMfaPolicy,
} from "./helpers/setup-db";

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

/** Sign in with MFA: fill credentials, complete TOTP challenge, wait for redirect. */
async function signInWithTotp(
  page: Page,
  username: string,
  password: string,
  totpSecret: string,
): Promise<void> {
  await page.goto("/sign-in");
  await signIn(page, username, password);

  const totpInput = page.locator("input[autocomplete='one-time-code']");
  await expect(totpInput).toBeVisible({ timeout: 5_000 });

  const code = generateCode(totpSecret);
  await totpInput.fill(code);
  await page.getByRole("button", { name: /verify/i }).click();

  await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
    timeout: 10_000,
  });
}

test.describe("TOTP profile management (#205)", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await deleteTotpCredential(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteTotpCredential(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetAccountDefaults(workerUsername);
    await resetMfaPolicy();
  });

  // ── Status display ──────────────────────────────────────────

  test("shows disabled badge when TOTP is not enrolled", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    await expect(page.getByText("Disabled")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /enable totp/i }),
    ).toBeVisible();
  });

  test("shows enabled badge when TOTP is enrolled", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const secret = await enrollAndVerifyTotp(workerUsername);

    await signInWithTotp(page, workerUsername, workerPassword, secret);
    await page.goto("/profile");

    await expect(page.getByText("Enabled")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /disable totp/i }),
    ).toBeVisible();
  });

  // ── Enrollment wizard ───────────────────────────────────────

  test("full enrollment flow: enable → QR code → verify → success", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    // Click enable
    await page.getByRole("button", { name: /enable totp/i }).click();

    // Wait for QR code SVG
    await expect(page.getByText(/scan this qr code/i)).toBeVisible({
      timeout: 5_000,
    });

    // Toggle manual key and read secret
    await page.getByText(/enter this key manually/i).click();
    const secretElement = page.locator("[data-testid='totp-secret']");
    await expect(secretElement).toBeVisible();
    const secret = await secretElement.textContent();
    expect(secret).toBeTruthy();

    // Generate and enter valid code
    const code = generateCode(secret as string);
    const codeInput = page.locator("input[autocomplete='one-time-code']");
    await codeInput.fill(code);
    await page.getByRole("button", { name: /^verify$/i }).click();

    // Should show success
    await expect(page.getByText(/setup complete/i)).toBeVisible({
      timeout: 5_000,
    });

    // Close dialog
    await page.getByRole("button", { name: /done/i }).click();

    // Card should now show enabled
    await expect(page.getByText("Enabled")).toBeVisible({ timeout: 5_000 });
  });

  test("enrollment with wrong code shows error, correct code succeeds", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    await page.getByRole("button", { name: /enable totp/i }).click();

    // Toggle manual key and read secret
    await page.getByText(/enter this key manually/i).click();
    const secretElement = page.locator("[data-testid='totp-secret']");
    await expect(secretElement).toBeVisible({ timeout: 5_000 });
    const secret = await secretElement.textContent();

    // Enter wrong code
    const codeInput = page.locator("input[autocomplete='one-time-code']");
    await codeInput.fill("000000");
    await page.getByRole("button", { name: /^verify$/i }).click();

    // Should show error
    const alert = page.locator("p[role='alert']");
    await expect(alert).toBeVisible({ timeout: 5_000 });

    // Enter correct code
    const code = generateCode(secret as string);
    await codeInput.fill(code);
    await page.getByRole("button", { name: /^verify$/i }).click();

    // Should show success
    await expect(page.getByText(/setup complete/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  test("cancel closes enrollment dialog without enrolling", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    await page.getByRole("button", { name: /enable totp/i }).click();

    // Wait for dialog content
    await expect(page.getByText(/scan this qr code/i)).toBeVisible({
      timeout: 5_000,
    });

    // Cancel
    await page.getByRole("button", { name: /cancel/i }).click();

    // Dialog should close, card still shows disabled
    await expect(page.getByText("Disabled")).toBeVisible({ timeout: 5_000 });
  });

  test("enroll via UI then sign in with TOTP", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    // Enroll TOTP via UI
    await page.getByRole("button", { name: /enable totp/i }).click();
    await page.getByText(/enter this key manually/i).click();
    const secretElement = page.locator("[data-testid='totp-secret']");
    await expect(secretElement).toBeVisible({ timeout: 5_000 });
    const secret = await secretElement.textContent();
    expect(secret).toBeTruthy();

    const enrollCode = generateCode(secret as string);
    await page.locator("input[autocomplete='one-time-code']").fill(enrollCode);
    await page.getByRole("button", { name: /^verify$/i }).click();
    await expect(page.getByText(/setup complete/i)).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("button", { name: /done/i }).click();

    // Sign out
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    await page.request.post("/api/auth/sign-out", {
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    // Sign in again — should require TOTP
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });

    const signInCode = generateCode(secret as string);
    await totpInput.fill(signInCode);
    await page.getByRole("button", { name: /verify/i }).click();

    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
  });

  // ── Disable flow ────────────────────────────────────────────

  test("disable TOTP with valid code", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const secret = await enrollAndVerifyTotp(workerUsername);

    await signInWithTotp(page, workerUsername, workerPassword, secret);
    await page.goto("/profile");

    await expect(page.getByText("Enabled")).toBeVisible({ timeout: 5_000 });

    // Click disable
    await page.getByRole("button", { name: /disable totp/i }).click();

    // Should show confirmation dialog
    await expect(
      page.getByText(/remove two-factor authentication/i),
    ).toBeVisible({ timeout: 5_000 });

    // Enter code and confirm
    const code = generateCode(secret);
    const codeInput = page.locator("input[autocomplete='one-time-code']");
    await codeInput.fill(code);
    await page
      .getByRole("button", { name: /disable totp/i })
      .last()
      .click();

    // Card should revert to disabled
    await expect(page.getByText("Disabled")).toBeVisible({ timeout: 5_000 });
  });

  test("disable TOTP with wrong code shows error", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const secret = await enrollAndVerifyTotp(workerUsername);

    await signInWithTotp(page, workerUsername, workerPassword, secret);
    await page.goto("/profile");

    await page.getByRole("button", { name: /disable totp/i }).click();

    // Enter wrong code
    const codeInput = page.locator("input[autocomplete='one-time-code']");
    await codeInput.fill("000000");
    await page
      .getByRole("button", { name: /disable totp/i })
      .last()
      .click();

    // Should show error
    const alert = page.locator("p[role='alert']");
    await expect(alert).toBeVisible({ timeout: 5_000 });
  });

  // ── Policy enforcement ──────────────────────────────────────

  test("enable button is disabled when TOTP is not allowed by policy", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Update policy via API so server cache is invalidated
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");
    await page.request.patch("/api/system-settings/mfa_policy", {
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
      data: { value: { allowed_methods: ["webauthn"] } },
    });

    await page.goto("/profile");

    const enableButton = page.getByRole("button", { name: /enable totp/i });
    await expect(enableButton).toBeVisible({ timeout: 5_000 });
    await expect(enableButton).toBeDisabled();

    // Policy restriction message
    await expect(
      page.getByText(/not allowed by the current security policy/i),
    ).toBeVisible();

    // Restore policy via API so server cache is consistent for other suites
    await page.request.patch("/api/system-settings/mfa_policy", {
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
      data: { value: { allowed_methods: ["webauthn", "totp"] } },
    });
  });
});
