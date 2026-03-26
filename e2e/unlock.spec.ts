import { expect, test } from "./fixtures";
import { resetRateLimits } from "./helpers/auth";
import {
  createTestAccount,
  deleteTestAccount,
  resetAccountDefaults,
} from "./helpers/setup-db";

const TARGET_USERNAME = "e2e-unlock-target";
const TARGET_PASSWORD = "Target1234!";

test.describe("Account unlock/restore — UI", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await createTestAccount(
      TARGET_USERNAME,
      TARGET_PASSWORD,
      "Security Monitor",
    );
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteTestAccount(TARGET_USERNAME);
    await resetAccountDefaults(workerUsername);
  });

  test("restored account can sign in again", async ({ page }) => {
    // Ensure the account is in a clean active state
    await resetAccountDefaults(TARGET_USERNAME);

    await page.goto("/sign-in");
    await page.getByLabel("Account ID").fill(TARGET_USERNAME);
    await page.locator("input[name='password']").fill(TARGET_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page).not.toHaveURL(/sign-in/, { timeout: 10_000 });
  });
});
