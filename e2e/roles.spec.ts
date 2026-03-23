import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  createTestRole,
  deleteRolesByPrefix,
  deleteTestRole,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

const TEST_PREFIX = "e2e-role-";

function roleRow(page: Page, name: string): Locator {
  return page.locator("tbody tr").filter({
    has: page.locator("td.font-medium", { hasText: name }),
  });
}

test.describe("Role management — UI", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await clearMustChangePassword(ADMIN_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  test("navigates to roles page and displays built-in roles", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();

    await expect(roleRow(page, "System Administrator")).toBeVisible({
      timeout: 10_000,
    });
    await expect(roleRow(page, "Tenant Administrator")).toBeVisible();
    await expect(roleRow(page, "Security Monitor")).toBeVisible();

    await expect(
      roleRow(page, "System Administrator").getByText("Built-in"),
    ).toBeVisible();
  });

  test("creates a custom role via UI", async ({ page }) => {
    await deleteTestRole(`${TEST_PREFIX}ui-create`);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();

    await page.getByRole("button", { name: "Create Role" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill(`${TEST_PREFIX}ui-create`);
    await dialog.getByLabel("Description").fill("Created via E2E test");

    await dialog.locator("#perm-accounts\\:read").click();
    await dialog.locator("#perm-customers\\:read").click();

    await dialog.getByRole("button", { name: "Create Role" }).click();

    await expect(roleRow(page, `${TEST_PREFIX}ui-create`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(roleRow(page, `${TEST_PREFIX}ui-create`)).toContainText("2");
  });

  test("edits a custom role via UI", async ({ page }) => {
    await createTestRole(
      `${TEST_PREFIX}ui-edit`,
      ["accounts:read"],
      "Before edit",
    );

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    const row = roleRow(page, `${TEST_PREFIX}ui-edit`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole("button").first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const nameInput = dialog.getByLabel("Name");
    await nameInput.clear();
    await nameInput.fill(`${TEST_PREFIX}ui-edited`);

    await dialog.locator("#perm-customers\\:read").click();

    await dialog.getByRole("button", { name: "Edit Role" }).click();

    await expect(roleRow(page, `${TEST_PREFIX}ui-edited`)).toBeVisible({
      timeout: 15_000,
    });

    await deleteTestRole(`${TEST_PREFIX}ui-edited`);
  });

  test("clones a built-in role via UI", async ({ page }) => {
    await deleteTestRole(`${TEST_PREFIX}ui-clone`);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    const adminRow = roleRow(page, "System Administrator");
    await expect(adminRow).toBeVisible({ timeout: 10_000 });

    await adminRow.getByRole("button").first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Clone Role")).toBeVisible();

    await dialog.getByLabel("Name").fill(`${TEST_PREFIX}ui-clone`);

    const createRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/roles"),
    );

    await dialog.getByRole("button", { name: "Create Role" }).click();
    const createResponse = await createRequest;

    if (!createResponse.ok()) {
      const errorBody = await createResponse.json();
      throw new Error(
        `Clone API failed (${createResponse.status()}): ${JSON.stringify(errorBody)}`,
      );
    }

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    const clonedRow = roleRow(page, `${TEST_PREFIX}ui-clone`);
    await expect(clonedRow).toBeVisible({ timeout: 15_000 });
    await expect(clonedRow).toContainText("15");
  });

  test("built-in roles have no edit or delete buttons", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    const adminRow = roleRow(page, "System Administrator");
    await expect(adminRow).toBeVisible({ timeout: 10_000 });

    const buttons = adminRow.getByRole("button");
    await expect(buttons).toHaveCount(1);

    await expect(buttons.first()).toHaveAttribute("title", "Clone Role");
  });

  test("custom roles have edit, clone, and delete buttons", async ({
    page,
  }) => {
    await createTestRole(`${TEST_PREFIX}ui-buttons`, ["accounts:read"]);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    const row = roleRow(page, `${TEST_PREFIX}ui-buttons`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const buttons = row.getByRole("button");
    await expect(buttons).toHaveCount(3);

    await expect(buttons.nth(0)).toHaveAttribute("title", "Edit Role");
    await expect(buttons.nth(1)).toHaveAttribute("title", "Clone Role");
    await expect(buttons.nth(2)).toHaveAttribute("title", "Delete Role");
  });

  test("deletes a custom role via UI", async ({ page }) => {
    await createTestRole(`${TEST_PREFIX}ui-delete`, ["accounts:read"]);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    const row = roleRow(page, `${TEST_PREFIX}ui-delete`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const deleteRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/api/roles/"),
    );
    await row.getByRole("button").nth(2).click();

    await page.getByRole("button", { name: "Delete Role" }).click();
    const deleteResponse = await deleteRequest;
    expect(deleteResponse.ok()).toBeTruthy();

    await expect(row).not.toBeVisible({ timeout: 10_000 });
  });
});
