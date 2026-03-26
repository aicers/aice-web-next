import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  clearMustChangePassword,
  createTestRole,
  deleteRolesByPrefix,
  deleteTestRole,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

function roleRow(page: Page, name: string): Locator {
  return page.locator("tbody tr").filter({
    has: page.locator("td.font-medium", { hasText: name }),
  });
}

test.describe("Role management — UI", () => {
  let TEST_PREFIX: string;

  test.beforeAll(async ({ workerUsername, workerPrefix: wp }) => {
    await resetRateLimits();
    TEST_PREFIX = wp("e2e-role-");
    await clearMustChangePassword(workerUsername);
    await resetAccountDefaults(workerUsername);
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await revokeAllSessions(workerUsername);
  });

  test.afterAll(async () => {
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  test("navigates to roles page and displays built-in roles", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
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

  test("creates a custom role via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await deleteTestRole(`${TEST_PREFIX}ui-create`);

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/roles");

    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();

    await page.getByRole("button", { name: "Add" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill(`${TEST_PREFIX}ui-create`);
    await dialog.getByLabel("Description").fill("Created via E2E test");

    await dialog.locator("#perm-accounts\\:read").click();
    await dialog.locator("#perm-customers\\:read").click();

    await dialog.getByRole("button", { name: "Add" }).click();

    await expect(roleRow(page, `${TEST_PREFIX}ui-create`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(roleRow(page, `${TEST_PREFIX}ui-create`)).toContainText("2");
  });

  test("edits a custom role via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await createTestRole(
      `${TEST_PREFIX}ui-edit`,
      ["accounts:read"],
      "Before edit",
    );

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/roles");

    const row = roleRow(page, `${TEST_PREFIX}ui-edit`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open kebab menu and click Edit
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const nameInput = dialog.getByLabel("Name");
    await nameInput.clear();
    await nameInput.fill(`${TEST_PREFIX}ui-edited`);

    await dialog.locator("#perm-customers\\:read").click();

    await dialog.getByRole("button", { name: "Edit" }).click();

    await expect(roleRow(page, `${TEST_PREFIX}ui-edited`)).toBeVisible({
      timeout: 15_000,
    });

    await deleteTestRole(`${TEST_PREFIX}ui-edited`);
  });

  test("clones a built-in role via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await deleteTestRole(`${TEST_PREFIX}ui-clone`);

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/roles");

    const adminRow = roleRow(page, "System Administrator");
    await expect(adminRow).toBeVisible({ timeout: 10_000 });

    // Open kebab menu and click Clone
    await adminRow.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Clone" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Clone")).toBeVisible();

    await dialog.getByLabel("Name").fill(`${TEST_PREFIX}ui-clone`);

    const createRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/roles"),
    );

    await dialog.getByRole("button", { name: "Add" }).click();
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

  test("built-in roles have no edit or delete buttons", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/roles");

    const adminRow = roleRow(page, "System Administrator");
    await expect(adminRow).toBeVisible({ timeout: 10_000 });

    // Built-in roles have a kebab menu with only Clone
    const buttons = adminRow.getByRole("button");
    await expect(buttons).toHaveCount(1);

    // Open kebab and verify only Clone is available
    await buttons.first().click();
    await expect(page.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Edit" }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Delete" }),
    ).not.toBeVisible();
    // Close menu
    await page.keyboard.press("Escape");
  });

  test("custom roles have edit, clone, and delete buttons", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await createTestRole(`${TEST_PREFIX}ui-buttons`, ["accounts:read"]);

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/roles");

    const row = roleRow(page, `${TEST_PREFIX}ui-buttons`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Custom roles have a kebab menu with Edit, Clone, and Delete
    const buttons = row.getByRole("button");
    await expect(buttons).toHaveCount(1);

    // Open kebab and verify all three actions are available
    await buttons.first().click();
    await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Clone" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    // Close menu
    await page.keyboard.press("Escape");
  });

  test("deletes a custom role via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await createTestRole(`${TEST_PREFIX}ui-delete`, ["accounts:read"]);

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/roles");

    const row = roleRow(page, `${TEST_PREFIX}ui-delete`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const deleteRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/api/roles/"),
    );
    // Open kebab menu and click Delete
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    await page.getByRole("button", { name: "Delete" }).click();
    const deleteResponse = await deleteRequest;
    expect(deleteResponse.ok()).toBeTruthy();

    await expect(row).not.toBeVisible({ timeout: 10_000 });
  });
});
