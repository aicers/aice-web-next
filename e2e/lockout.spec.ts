import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signIn,
} from "./helpers/auth";
import {
  resetAccountDefaults,
  setAccountStatus,
  setFailedSignInCount,
} from "./helpers/setup-db";

const alert = (page: import("@playwright/test").Page) =>
  page.locator("p[role='alert']");

test.describe("Account lockout", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("temp locked account shows lockout message", async ({ page }) => {
    // Lock the account with a future expiry via DB.
    const future = new Date(Date.now() + 30 * 60_000);
    await setAccountStatus(ADMIN_USERNAME, "locked", future);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "Account is locked. Please try again later.",
    );
  });

  test("permanent lock (no locked_until)", async ({ page }) => {
    await setAccountStatus(ADMIN_USERNAME, "locked", null);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "Account is locked. Please try again later.",
    );
  });

  test("temp lock auto-expires and sign-in succeeds", async ({ page }) => {
    // Set locked_until to 1 minute in the past so it's already expired.
    const past = new Date(Date.now() - 60_000);
    await setAccountStatus(ADMIN_USERNAME, "locked", past);
    await setFailedSignInCount(ADMIN_USERNAME, 0);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
  });

  test("wrong password at threshold triggers lockout on next attempt", async ({
    page,
  }) => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    // Set count to 4, so the next wrong password is the 5th failure.
    await setFailedSignInCount(ADMIN_USERNAME, 4);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, "WrongPassword!");

    // The 5th failure returns INVALID_CREDENTIALS (lockout happens
    // server-side but the current response is still "invalid creds").
    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("Invalid account ID or password");

    // The NEXT sign-in attempt should see the lockout message.
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await expect(alert(page)).toContainText(
      "Account is locked. Please try again later.",
    );
  });
});
