import { expect, test } from "./fixtures";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  clearMustChangePassword,
  deleteCustomersByPrefix,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

test.describe("Customer management — UI", () => {
  let TEST_PREFIX: string;

  test.beforeAll(async ({ workerUsername, workerPrefix }) => {
    await resetRateLimits();
    TEST_PREFIX = workerPrefix("E2E-Cust-");
    await clearMustChangePassword(workerUsername);
    await resetAccountDefaults(workerUsername);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await revokeAllSessions(workerUsername);
  });

  test.afterAll(async () => {
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  test("navigates to customers page and creates a customer via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/customers");

    await expect(
      page.getByRole("heading", { name: "Customers" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Create Customer" }).click();

    await page.getByLabel("Name").fill(`${TEST_PREFIX}UITest`);
    await page.getByLabel("Description").fill("Created via E2E");

    await page.getByRole("button", { name: "Create Customer" }).click();

    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest` }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("edits a customer via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/customers");

    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest` }),
    ).toBeVisible({ timeout: 10_000 });

    const row = page.getByRole("row").filter({
      hasText: `${TEST_PREFIX}UITest`,
    });
    await row.getByRole("button").first().click();

    const nameInput = page.getByLabel("Name");
    await nameInput.clear();
    await nameInput.fill(`${TEST_PREFIX}UITest-Edited`);

    await page.getByRole("button", { name: "Edit Customer" }).click();

    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest-Edited` }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("deletes a customer via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/customers");

    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest-Edited` }),
    ).toBeVisible({ timeout: 10_000 });

    const row = page.getByRole("row").filter({
      hasText: `${TEST_PREFIX}UITest-Edited`,
    });
    await row.getByRole("button").nth(1).click();

    await page.getByRole("button", { name: "Delete Customer" }).click();

    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest-Edited` }),
    ).not.toBeVisible({ timeout: 10_000 });
  });
});
