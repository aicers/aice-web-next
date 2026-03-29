import type { Page } from "@playwright/test";
import * as OTPAuth from "otpauth";

import { expect, test } from "./fixtures";
import { resetRateLimits, signIn } from "./helpers/auth";
import {
  deleteMfaChallenges,
  deleteTotpCredential,
  enrollAndVerifyTotp,
  resetAccountDefaults,
  resetMfaPolicy,
} from "./helpers/setup-db";

/** Change MFA policy via API (invalidates server cache). Requires a signed-in page context. */
async function setMfaPolicyViaApi(
  page: Page,
  allowedMethods: string[],
): Promise<void> {
  const cookies = await page.context().cookies();
  const csrfCookie = cookies.find((c) => c.name === "csrf");
  const res = await page.request.patch("/api/system-settings/mfa_policy", {
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfCookie?.value ?? "",
      Origin: "http://localhost:3000",
    },
    data: { value: { allowed_methods: allowedMethods } },
  });
  if (!res.ok()) throw new Error(`setMfaPolicyViaApi failed: ${res.status()}`);
}

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

test.describe("MFA sign-in flow (#207)", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
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

  // ── Happy path: password → TOTP → dashboard ────────────────

  test("sign-in with TOTP shows TOTP step then redirects to dashboard", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const secret = await enrollAndVerifyTotp(workerUsername);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Should show TOTP input step (not redirect yet)
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });

    // Enter valid TOTP code
    const code = generateCode(secret);
    await totpInput.fill(code);
    await page.getByRole("button", { name: /verify/i }).click();

    // Should redirect to dashboard
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
  });

  // ── Wrong code → error → retry with correct code ──────────

  test("wrong TOTP code shows error, retry with correct code succeeds", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const secret = await enrollAndVerifyTotp(workerUsername);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Wait for TOTP step
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });

    // Enter wrong code
    await totpInput.fill("000000");
    await page.getByRole("button", { name: /verify/i }).click();

    // Should show error message
    const alert = page.locator("p[role='alert']");
    await expect(alert).toBeVisible({ timeout: 5_000 });

    // Clear and enter correct code
    const code = generateCode(secret);
    await totpInput.fill(code);
    await page.getByRole("button", { name: /verify/i }).click();

    // Should redirect to dashboard
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
  });

  // ── Back button returns to credentials step ────────────────

  test("back button returns to credentials step", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await enrollAndVerifyTotp(workerUsername);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Wait for TOTP step
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });

    // Click back button
    await page.getByRole("button", { name: /back to sign in/i }).click();

    // Should return to credentials form
    await expect(page.getByLabel("Account ID")).toBeVisible();
    await expect(page.locator("input[name='password']")).toBeVisible();
  });

  // ── No TOTP enrolled → direct sign-in (no TOTP step) ──────

  test("sign-in without TOTP enrolled goes directly to dashboard", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    // Should go straight to dashboard without TOTP step
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });

    // TOTP input should NOT have appeared
    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).not.toBeVisible();
  });

  // ── Policy-off: enrolled user bypasses MFA ────────────────

  test("enrolled user signs in without MFA when admin disables TOTP policy", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    const secret = await enrollAndVerifyTotp(workerUsername);

    // Sign in with TOTP to get a session for the policy API call
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    const totpInput = page.locator("input[autocomplete='one-time-code']");
    await expect(totpInput).toBeVisible({ timeout: 5_000 });
    await totpInput.fill(generateCode(secret));
    await page.getByRole("button", { name: /verify/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });

    // Disable TOTP in policy via API (properly invalidates server cache)
    await setMfaPolicyViaApi(page, ["webauthn"]);

    try {
      // Sign out
      const cookies = await page.context().cookies();
      const csrfCookie = cookies.find((c) => c.name === "csrf");
      await page.request.post("/api/auth/sign-out", {
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      });

      // Sign in again — should go straight to dashboard without TOTP
      await page.goto("/sign-in");
      await signIn(page, workerUsername, workerPassword);

      await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
        timeout: 10_000,
      });

      const totpInput2 = page.locator("input[autocomplete='one-time-code']");
      await expect(totpInput2).not.toBeVisible();
    } finally {
      // Re-establish a session to restore the policy. Race the redirect
      // against the TOTP challenge so cleanup works regardless of whether
      // the bypass is functioning correctly.
      await page.goto("/sign-in");
      await signIn(page, workerUsername, workerPassword);

      const challengeInput = page.locator(
        "input[autocomplete='one-time-code']",
      );
      const redirected = page
        .waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
          timeout: 10_000,
        })
        .then(() => "redirected" as const);
      const challenged = challengeInput
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "challenged" as const);

      const outcome = await Promise.race([redirected, challenged]);
      if (outcome === "challenged") {
        await challengeInput.fill(generateCode(secret));
        await page.getByRole("button", { name: /verify/i }).click();
        await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
          timeout: 10_000,
        });
      }

      await setMfaPolicyViaApi(page, ["webauthn", "totp"]);
    }
  });
});
