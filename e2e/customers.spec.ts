import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  deleteCustomersByPrefix,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

const TEST_PREFIX = "E2E-Cust-";

test.describe("Customer management — UI", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await clearMustChangePassword(ADMIN_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  test("navigates to customers page and creates a customer via UI", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
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

  test("edits a customer via UI", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
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

  test("deletes a customer via UI", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
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
