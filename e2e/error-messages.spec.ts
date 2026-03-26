import { expect, test } from "./fixtures";
import { resetRateLimits, signIn } from "./helpers/auth";
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

  test.afterEach(async ({ workerUsername }) => {
    await resetAccountDefaults(workerUsername);
  });

  test("inactive account shows 'Account is not active'", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await setAccountStatus(workerUsername, "disabled");

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("Account is not active");
  });

  test("max sessions exceeded shows error", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await resetAccountDefaults(workerUsername);
    await setMaxSessions(workerUsername, 1);
    await createFakeSessions(workerUsername, 1);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "Maximum number of active sessions reached",
    );
  });
});
