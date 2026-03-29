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

  test("shows not-available message when TOTP is not allowed by policy", async ({
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

    try {
      await page.goto("/profile");

      // No enable button should be visible
      await expect(
        page.getByRole("button", { name: /enable totp/i }),
      ).not.toBeVisible({ timeout: 5_000 });

      // "TOTP is not available" message
      await expect(page.getByText(/totp is not available/i)).toBeVisible();
    } finally {
      // Restore policy via API so server cache is consistent for other suites
      await page.request.patch("/api/system-settings/mfa_policy", {
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
        data: { value: { allowed_methods: ["webauthn", "totp"] } },
      });
    }
  });

  test("shows disabled-by-admin state when enrolled but policy disallows TOTP", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Enroll TOTP first
    const secret = await enrollAndVerifyTotp(workerUsername);

    await signInWithTotp(page, workerUsername, workerPassword, secret);

    // Disable TOTP in policy via API
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

    try {
      await page.goto("/profile");

      // Should show "Enabled" badge (still enrolled)
      await expect(page.getByText("Enabled")).toBeVisible({ timeout: 5_000 });

      // Should show "disabled by admin" message
      await expect(
        page.getByText(/disabled by an administrator/i),
      ).toBeVisible();

      // Should show "Remove TOTP" button
      const removeButton = page.getByRole("button", {
        name: /remove totp/i,
      });
      await expect(removeButton).toBeVisible();

      // Remove TOTP using the button
      await removeButton.click();

      // Enter code and confirm removal
      const code = generateCode(secret);
      const codeInput = page.locator("input[autocomplete='one-time-code']");
      await codeInput.fill(code);
      await page
        .getByRole("button", { name: /remove totp/i })
        .last()
        .click();

      // Should revert to "not available" (still policy-off, now unenrolled)
      await expect(page.getByText(/totp is not available/i)).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      // Re-enable TOTP in policy
      await page.request.patch("/api/system-settings/mfa_policy", {
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
        data: { value: { allowed_methods: ["webauthn", "totp"] } },
      });
    }

    // Reload — "Enable TOTP" button should reappear
    await page.goto("/profile");
    await expect(
      page.getByRole("button", { name: /enable totp/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("mid-enrollment policy change shows error gracefully", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    // Start enrollment — click enable and wait for QR
    await page.getByRole("button", { name: /enable totp/i }).click();
    await expect(page.getByText(/scan this qr code/i)).toBeVisible({
      timeout: 5_000,
    });

    // Read the secret for code generation
    await page.getByText(/enter this key manually/i).click();
    const secretElement = page.locator("[data-testid='totp-secret']");
    await expect(secretElement).toBeVisible();
    const secret = await secretElement.textContent();
    expect(secret).toBeTruthy();

    // Admin disables TOTP mid-enrollment via API
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

    try {
      // Enter valid code and try to verify
      const code = generateCode(secret as string);
      const codeInput = page.locator("input[autocomplete='one-time-code']");
      await codeInput.fill(code);
      await page.getByRole("button", { name: /^verify$/i }).click();

      // Should show an error (TOTP_NOT_ALLOWED handled gracefully)
      const alert = page.locator("p[role='alert']");
      await expect(alert).toBeVisible({ timeout: 5_000 });
    } finally {
      // Restore policy
      await page.request.patch("/api/system-settings/mfa_policy", {
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
        data: { value: { allowed_methods: ["webauthn", "totp"] } },
      });
    }
  });
});
