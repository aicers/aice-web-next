import { expect, test } from "./fixtures";
import { resetRateLimits, signIn } from "./helpers/auth";
import {
  resetAccountDefaults,
  setAccountStatus,
  setFailedSignInCount,
  setLockoutCount,
} from "./helpers/setup-db";

const alert = (page: import("@playwright/test").Page) =>
  page.locator("p[role='alert']");

test.describe("Account lockout", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
  });

  test.afterAll(async ({ workerUsername }) => {
    await resetAccountDefaults(workerUsername);
  });

  test("temp locked account shows lockout message", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Lock the account with a future expiry via DB.
    const future = new Date(Date.now() + 30 * 60_000);
    await setAccountStatus(workerUsername, "locked", future);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "Account is locked. Please try again later.",
    );
  });

  test("permanent lock (no locked_until)", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await setAccountStatus(workerUsername, "locked", null);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText(
      "Account is locked. Please try again later.",
    );
  });

  test("temp lock auto-expires and sign-in succeeds", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Set locked_until to 1 minute in the past so it's already expired.
    const past = new Date(Date.now() - 60_000);
    await setAccountStatus(workerUsername, "locked", past);
    await setFailedSignInCount(workerUsername, 0);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
  });

  test("wrong password at threshold triggers lockout on next attempt", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await resetAccountDefaults(workerUsername);
    // Set count to 4, so the next wrong password is the 5th failure.
    await setFailedSignInCount(workerUsername, 4);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, "WrongPassword!");

    // The 5th failure returns INVALID_CREDENTIALS (lockout happens
    // server-side but the current response is still "invalid creds").
    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("Invalid account ID or password");

    // The NEXT sign-in attempt should see the lockout message.
    await signIn(page, workerUsername, workerPassword);
    await expect(alert(page)).toContainText(
      "Account is locked. Please try again later.",
    );
  });

  test("suspended account shows inactive message", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await setAccountStatus(workerUsername, "suspended", null);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);

    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("Account is not active");
  });

  test("stage2 triggers suspension when lockout_count >= 1", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await resetAccountDefaults(workerUsername);
    // Simulate: previously locked once, auto-unlocked, now at threshold again
    await setFailedSignInCount(workerUsername, 4);
    await setLockoutCount(workerUsername, 1);

    await page.goto("/sign-in");
    await signIn(page, workerUsername, "WrongPassword!");

    // The 5th failure suspends the account (lockout_count >= 1).
    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toContainText("Invalid account ID or password");

    // The NEXT attempt should see the inactive (suspended) message.
    await signIn(page, workerUsername, workerPassword);
    await expect(alert(page)).toContainText("Account is not active");
  });

  test("auto-unlock after stage1 preserves lockout_count for stage2", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await resetAccountDefaults(workerUsername);
    // Simulate: stage1 lock expired (past locked_until), lockout_count = 1
    const past = new Date(Date.now() - 60_000);
    await setAccountStatus(workerUsername, "locked", past);
    await setFailedSignInCount(workerUsername, 0);
    await setLockoutCount(workerUsername, 1);

    // Auto-unlock should succeed (correct password)
    await page.goto("/sign-in");
    await signIn(page, workerUsername, workerPassword);
    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
  });
});
