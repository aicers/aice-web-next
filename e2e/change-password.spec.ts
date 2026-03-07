import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signIn,
} from "./helpers/auth";
import {
  addPasswordHistory,
  clearPasswordHistory,
  resetAccountDefaults,
  setMustChangePassword,
  setPassword,
} from "./helpers/setup-db";

const NEW_PASSWORD = "NewSecurePass123!";

test.describe("Change password flow", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await clearPasswordHistory(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    // Restore original password and reset account
    await setPassword(ADMIN_USERNAME, ADMIN_PASSWORD);
    await clearPasswordHistory(ADMIN_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("mustChangePassword user is redirected to /change-password from dashboard", async ({
    page,
  }) => {
    await setMustChangePassword(ADMIN_USERNAME, true);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await page.waitForURL("**/change-password", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/change-password/);
  });

  test("wrong current password shows error", async ({ page }) => {
    await setMustChangePassword(ADMIN_USERNAME, true);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.waitForURL("**/change-password", { timeout: 10_000 });

    // Fill the change-password form with wrong current password
    await page
      .locator("input[autocomplete='current-password']")
      .fill("WrongPassword123!");
    await page
      .locator("input[autocomplete='new-password']")
      .first()
      .fill(NEW_PASSWORD);
    await page
      .locator("input[autocomplete='new-password']")
      .nth(1)
      .fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /change password/i }).click();

    // Should show error
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });
  });

  test("successful password change redirects to dashboard", async ({
    page,
  }) => {
    await setMustChangePassword(ADMIN_USERNAME, true);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.waitForURL("**/change-password", { timeout: 10_000 });

    // Fill the change-password form correctly
    await page
      .locator("input[autocomplete='current-password']")
      .fill(ADMIN_PASSWORD);
    await page
      .locator("input[autocomplete='new-password']")
      .first()
      .fill(NEW_PASSWORD);
    await page
      .locator("input[autocomplete='new-password']")
      .nth(1)
      .fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /change password/i }).click();

    // Should redirect to dashboard (home page)
    await page.waitForURL(
      (url) =>
        !url.pathname.includes("/change-password") &&
        !url.pathname.includes("/sign-in"),
      { timeout: 10_000 },
    );

    // Restore password for subsequent tests
    await setPassword(ADMIN_USERNAME, ADMIN_PASSWORD);
    await clearPasswordHistory(ADMIN_USERNAME);
  });

  test("blocklisted password shows error", async ({ page }) => {
    await setMustChangePassword(ADMIN_USERNAME, true);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.waitForURL("**/change-password", { timeout: 10_000 });

    // "password" is in the blocklist (also too short, so both errors appear)
    const blocklisted = "password";
    await page
      .locator("input[autocomplete='current-password']")
      .fill(ADMIN_PASSWORD);
    await page
      .locator("input[autocomplete='new-password']")
      .first()
      .fill(blocklisted);
    await page
      .locator("input[autocomplete='new-password']")
      .nth(1)
      .fill(blocklisted);
    await page.getByRole("button", { name: /change password/i }).click();

    const errorAlert = page.locator("p[role='alert']");
    await expect(errorAlert).toBeVisible({ timeout: 10_000 });
    await expect(errorAlert).toContainText(/common/i);
  });

  test("recently used password shows reuse error", async ({ page }) => {
    // Use a password that meets minLength (12) and add it to history
    const reusedPassword = "ReusedPass123!";
    await setPassword(ADMIN_USERNAME, reusedPassword);
    await addPasswordHistory(ADMIN_USERNAME, reusedPassword);
    await setMustChangePassword(ADMIN_USERNAME, true);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, reusedPassword);
    await page.waitForURL("**/change-password", { timeout: 10_000 });

    // Try to reuse the same password
    await page
      .locator("input[autocomplete='current-password']")
      .fill(reusedPassword);
    await page
      .locator("input[autocomplete='new-password']")
      .first()
      .fill(reusedPassword);
    await page
      .locator("input[autocomplete='new-password']")
      .nth(1)
      .fill(reusedPassword);
    await page.getByRole("button", { name: /change password/i }).click();

    const errorAlert = page.locator("p[role='alert']");
    await expect(errorAlert).toBeVisible({ timeout: 10_000 });
    await expect(errorAlert).toContainText(/recent/i);

    // Cleanup: restore original password
    await setPassword(ADMIN_USERNAME, ADMIN_PASSWORD);
    await clearPasswordHistory(ADMIN_USERNAME);
  });
});
