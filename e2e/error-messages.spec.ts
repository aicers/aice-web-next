import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signIn,
} from "./helpers/auth";
import {
  createFakeSessions,
  resetAccountDefaults,
  setAccountStatus,
  setMaxSessions,
} from "./helpers/setup-db";

const alert = (page: import("@playwright/test").Page) =>
  page.locator("p[role='alert']");

test.describe("Sign-in error messages", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
  });

  test.afterEach(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("inactive account shows 'Account is not active'", async ({ page }) => {
    await setAccountStatus(ADMIN_USERNAME, "disabled");

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("Account is not active");
  });

  test("max sessions exceeded shows error", async ({ page }) => {
    await resetAccountDefaults(ADMIN_USERNAME);
    await setMaxSessions(ADMIN_USERNAME, 1);
    await createFakeSessions(ADMIN_USERNAME, 1);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "Maximum number of active sessions reached",
    );
  });
});
