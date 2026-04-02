import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  resetRateLimits,
  signIn,
  signInAndWait,
  signOut,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  createTestAccount,
  deleteMfaChallenges,
  deleteRecoveryCodes,
  deleteTestAccount,
  deleteTotpCredential,
  deleteWebAuthnCredentials,
  enrollAndVerifyTotp,
  resetAccountDefaults,
  resetMfaPolicy,
  setRoleMfaRequired,
} from "./helpers/setup-db";

function accountRow(page: Page, username: string): Locator {
  return page.locator("tbody tr").filter({
    has: page.locator("td.font-medium", { hasText: username }),
  });
}

test.describe("Admin MFA Reset (#221)", () => {
  let TEST_PREFIX: string;
  let TARGET_USERNAME: string;
  const TARGET_PASSWORD = "TargetPass1234!";

  test.beforeAll(async ({ workerUsername, workerPrefix: wp }) => {
    await resetRateLimits();
    TEST_PREFIX = wp("e2e-mfa-rst-");
    TARGET_USERNAME = `${TEST_PREFIX}target`;

    await clearMustChangePassword(workerUsername);
    await resetAccountDefaults(workerUsername);

    // Clean up and create fresh target
    await deleteTestAccount(TARGET_USERNAME);
    await createTestAccount(
      TARGET_USERNAME,
      TARGET_PASSWORD,
      "Security Monitor",
    );
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(TARGET_USERNAME);
    await deleteWebAuthnCredentials(TARGET_USERNAME);
    await deleteRecoveryCodes(TARGET_USERNAME);
    await deleteMfaChallenges(TARGET_USERNAME);
    await resetMfaPolicy();
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteTotpCredential(TARGET_USERNAME);
    await deleteWebAuthnCredentials(TARGET_USERNAME);
    await deleteRecoveryCodes(TARGET_USERNAME);
    await deleteMfaChallenges(TARGET_USERNAME);
    await deleteTestAccount(TARGET_USERNAME);
    await setRoleMfaRequired(TARGET_USERNAME, false).catch(() => {});
    await setRoleMfaRequired(workerUsername, false).catch(() => {});
    await resetMfaPolicy();
  });

  // ── Core flow ─────────────────────────────────────────────────

  test("admin resets user MFA via account menu", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await enrollAndVerifyTotp(TARGET_USERNAME);

    await signInAndWait(page, workerUsername, workerPassword);

    await page.goto("/settings/accounts");
    await page.waitForSelector("table");

    const row = accountRow(page, TARGET_USERNAME);
    await row.locator("button").last().click();

    await page.getByRole("menuitem", { name: "Reset MFA" }).click();

    await page.locator("input[type='password']").fill(workerPassword);

    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reset MFA" })
      .click();

    await expect(
      page.getByText(`MFA has been reset for ${TARGET_USERNAME}`),
    ).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "OK" })
      .click();

    // After reset, the target account should no longer show "Reset MFA"
    const refreshedRow = accountRow(page, TARGET_USERNAME);
    await refreshedRow.locator("button").last().click();
    await expect(
      page.getByRole("menuitem", { name: "Reset MFA" }),
    ).not.toBeVisible();
  });

  // ── Re-enrollment enforcement ─────────────────────────────────

  test("user redirected to MFA enrollment after admin reset when role requires MFA", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Enable MFA requirement for the target's role
    await setRoleMfaRequired(TARGET_USERNAME, true);
    await enrollAndVerifyTotp(TARGET_USERNAME);

    // Admin resets the target's MFA
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/accounts");
    await page.waitForSelector("table");

    const row = accountRow(page, TARGET_USERNAME);
    await row.locator("button").last().click();
    await page.getByRole("menuitem", { name: "Reset MFA" }).click();
    await page.locator("input[type='password']").fill(workerPassword);
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reset MFA" })
      .click();
    await expect(
      page.getByText(`MFA has been reset for ${TARGET_USERNAME}`),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "OK" })
      .click();

    // Sign out the admin
    await signOut(page);

    // Now sign in as the target user
    await page.goto("/sign-in");
    await signIn(page, TARGET_USERNAME, TARGET_PASSWORD);

    // Should be redirected to MFA enrollment (not dashboard)
    await page.waitForURL((url) => url.pathname.includes("/enroll-mfa"), {
      timeout: 10_000,
    });

    // Verify enrollment page is shown
    await expect(
      page.getByText(/scan this qr code|two-factor authentication/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── Error cases ───────────────────────────────────────────────

  test("admin MFA reset with wrong password shows error", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await enrollAndVerifyTotp(TARGET_USERNAME);

    await signInAndWait(page, workerUsername, workerPassword);

    await page.goto("/settings/accounts");
    await page.waitForSelector("table");

    const row = accountRow(page, TARGET_USERNAME);
    await row.locator("button").last().click();
    await page.getByRole("menuitem", { name: "Reset MFA" }).click();

    await page.locator("input[type='password']").fill("WrongPassword1!");

    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reset MFA" })
      .click();

    await expect(page.getByText("Invalid password")).toBeVisible({
      timeout: 10_000,
    });
  });

  // ── UI visibility ─────────────────────────────────────────────

  test("Reset MFA menu item hidden when account has no MFA", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    await page.goto("/settings/accounts");
    await page.waitForSelector("table");

    const row = accountRow(page, TARGET_USERNAME);
    await row.locator("button").last().click();

    await expect(
      page.getByRole("menuitem", { name: "Reset MFA" }),
    ).not.toBeVisible();
  });

  test("Reset MFA menu item visible when account has MFA", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await enrollAndVerifyTotp(TARGET_USERNAME);

    await signInAndWait(page, workerUsername, workerPassword);

    await page.goto("/settings/accounts");
    await page.waitForSelector("table");

    const row = accountRow(page, TARGET_USERNAME);
    await row.locator("button").last().click();

    await expect(
      page.getByRole("menuitem", { name: "Reset MFA" }),
    ).toBeVisible();
  });
});
