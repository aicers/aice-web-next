import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  clearMustChangePassword,
  createTestAccount,
  createTestRole,
  deleteRolesByPrefix,
  deleteTestAccount,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

const SYSTEM_ADMIN_PERMISSIONS = [
  "accounts:read",
  "accounts:write",
  "accounts:delete",
  "roles:read",
  "roles:write",
  "roles:delete",
  "customers:read",
  "customers:write",
  "customers:access-all",
  "audit-logs:read",
  "system-settings:read",
  "system-settings:write",
];

async function recreateUiAccount(
  username: string,
  password: string,
): Promise<void> {
  await deleteTestAccount(username);
  await createTestAccount(username, password, "System Administrator");
}

function accountRow(page: Page, username: string): Locator {
  return page.locator("tbody tr").filter({
    has: page.locator("td.font-medium", { hasText: username }),
  });
}

test.describe("Account management", () => {
  let TEST_PREFIX: string;
  let UI_CREATE_USERNAME: string;
  let UI_EDIT_USERNAME: string;
  let UI_DELETE_USERNAME: string;
  let CUSTOM_ROLE_API_USERNAME: string;
  let CUSTOM_ROLE_UI_USERNAME: string;
  let CUSTOM_ROLE_PREFIX: string;
  let CUSTOM_GLOBAL_ROLE_NAME: string;
  let customGlobalRoleId: number;

  test.beforeAll(async ({ workerUsername, workerPrefix: wp }) => {
    await resetRateLimits();
    TEST_PREFIX = wp("e2e-acct-");
    UI_CREATE_USERNAME = `${TEST_PREFIX}ui-create`;
    UI_EDIT_USERNAME = `${TEST_PREFIX}ui-edit`;
    UI_DELETE_USERNAME = `${TEST_PREFIX}ui-delete`;
    CUSTOM_ROLE_API_USERNAME = `${TEST_PREFIX}custom-api`;
    CUSTOM_ROLE_UI_USERNAME = `${TEST_PREFIX}custom-ui`;
    CUSTOM_ROLE_PREFIX = `${TEST_PREFIX}role-`;
    CUSTOM_GLOBAL_ROLE_NAME = `${CUSTOM_ROLE_PREFIX}global-access`;

    await clearMustChangePassword(workerUsername);
    await resetAccountDefaults(workerUsername);
    // Clean up any leftover test accounts
    await deleteTestAccount(`${TEST_PREFIX}alpha`);
    await deleteTestAccount(UI_CREATE_USERNAME);
    await deleteTestAccount(UI_EDIT_USERNAME);
    await deleteTestAccount(UI_DELETE_USERNAME);
    await deleteTestAccount(CUSTOM_ROLE_API_USERNAME);
    await deleteTestAccount(CUSTOM_ROLE_UI_USERNAME);
    await deleteRolesByPrefix(CUSTOM_ROLE_PREFIX);
    customGlobalRoleId = await createTestRole(
      CUSTOM_GLOBAL_ROLE_NAME,
      SYSTEM_ADMIN_PERMISSIONS,
      "E2E custom global-access role",
    );
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await revokeAllSessions(workerUsername);
  });

  test.afterAll(async () => {
    await deleteTestAccount(`${TEST_PREFIX}alpha`);
    await deleteTestAccount(UI_CREATE_USERNAME);
    await deleteTestAccount(UI_EDIT_USERNAME);
    await deleteTestAccount(UI_DELETE_USERNAME);
    await deleteTestAccount(CUSTOM_ROLE_API_USERNAME);
    await deleteTestAccount(CUSTOM_ROLE_UI_USERNAME);
    await deleteRolesByPrefix(CUSTOM_ROLE_PREFIX);
  });

  // ── API tests ─────────────────────────────────────────────────

  test("POST /api/accounts creates an account", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Use System Administrator role (roleId 1) which doesn't require
    // customer assignment, keeping the test self-contained.
    const response = await page.request.post("/api/accounts", {
      data: {
        username: `${TEST_PREFIX}alpha`,
        displayName: "E2E Alpha",
        password: "TestPass1234!",
        roleId: 1,
      },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.data.username).toBe(`${TEST_PREFIX}alpha`);
    expect(body.data.status).toBe("active");
  });

  test("POST /api/accounts accepts a custom global-access role without customers", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await deleteTestAccount(CUSTOM_ROLE_API_USERNAME);
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post("/api/accounts", {
      data: {
        username: CUSTOM_ROLE_API_USERNAME,
        displayName: "Custom Role API",
        password: "TestPass1234!",
        roleId: customGlobalRoleId,
      },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.data.username).toBe(CUSTOM_ROLE_API_USERNAME);
    expect(body.data.role_name).toBe(CUSTOM_GLOBAL_ROLE_NAME);
  });

  test("GET /api/accounts lists accounts", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const response = await page.request.get(
      `/api/accounts?search=${TEST_PREFIX}`,
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    const testAccounts = body.data.filter((a: { username: string }) =>
      a.username.startsWith(TEST_PREFIX),
    );
    expect(testAccounts.length).toBeGreaterThanOrEqual(1);
  });

  test("PATCH /api/accounts/[id] updates an account", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Get account ID
    const listRes = await page.request.get(
      `/api/accounts?search=${TEST_PREFIX}alpha`,
    );
    const listBody = await listRes.json();
    const account = listBody.data.find(
      (a: { username: string }) => a.username === `${TEST_PREFIX}alpha`,
    );
    expect(account).toBeDefined();

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.patch(`/api/accounts/${account.id}`, {
      data: { displayName: "E2E Alpha Updated" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.display_name).toBe("E2E Alpha Updated");
  });

  test("DELETE /api/accounts/[id] soft-deletes an account", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Get account ID
    const listRes = await page.request.get(
      `/api/accounts?search=${TEST_PREFIX}alpha`,
    );
    const listBody = await listRes.json();
    const account = listBody.data.find(
      (a: { username: string }) => a.username === `${TEST_PREFIX}alpha`,
    );
    expect(account).toBeDefined();

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.delete(`/api/accounts/${account.id}`, {
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(200);

    // Verify it's disabled (not hard-deleted)
    const verifyRes = await page.request.get(`/api/accounts/${account.id}`);
    expect(verifyRes.status()).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.data.status).toBe("disabled");
  });

  test("POST /api/accounts returns 400 for missing fields", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post("/api/accounts", {
      data: { username: "incomplete" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(400);
  });

  // ── UI tests ──────────────────────────────────────────────────

  test("navigates to accounts page and creates an account via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Clean up first
    await deleteTestAccount(UI_CREATE_USERNAME);

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/accounts");

    // Verify page heading
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();

    // Click create button
    await page.getByRole("button", { name: "Add" }).click();

    // Fill form
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Username").fill(UI_CREATE_USERNAME);
    await dialog.getByLabel("Display Name").fill("E2E UI Test");
    await dialog.getByLabel("Password").fill("UiTestPass1234!");

    // Select role (System Administrator doesn't require customer assignment)
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "System Administrator" }).click();

    // Submit
    await dialog.getByRole("button", { name: "Add" }).click();

    // Wait for dialog to close and table to update
    await expect(accountRow(page, UI_CREATE_USERNAME)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("UI create flow treats a custom global-access role like System Administrator", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await deleteTestAccount(CUSTOM_ROLE_UI_USERNAME);

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/accounts");

    await page.getByRole("button", { name: "Add" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Username").fill(CUSTOM_ROLE_UI_USERNAME);
    await dialog.getByLabel("Display Name").fill("Custom Role UI");
    await dialog.getByLabel("Password").fill("UiTestPass1234!");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: CUSTOM_GLOBAL_ROLE_NAME }).click();

    await expect(dialog.getByText("Customers")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Add" }).click();

    await expect(accountRow(page, CUSTOM_ROLE_UI_USERNAME)).toBeVisible({
      timeout: 15_000,
    });
    await expect(accountRow(page, CUSTOM_ROLE_UI_USERNAME)).toContainText(
      CUSTOM_GLOBAL_ROLE_NAME,
    );
  });

  test("edits an account via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await recreateUiAccount(UI_EDIT_USERNAME, "UiEditPass1234!");

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/accounts");

    // Wait for table to load
    const row = accountRow(page, UI_EDIT_USERNAME);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open kebab menu and click Edit
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    // Update display name
    const nameInput = page.getByLabel("Display Name");
    await nameInput.clear();
    await nameInput.fill("E2E UI Edited");

    // Submit
    await page.getByRole("button", { name: "Edit" }).click();

    // Verify update
    await expect(row).toContainText("E2E UI Edited", { timeout: 10_000 });
  });

  test("deletes an account via UI", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await recreateUiAccount(UI_DELETE_USERNAME, "UiDeletePass1234!");

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/settings/accounts");

    // Wait for table to load
    const row = accountRow(page, UI_DELETE_USERNAME);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open kebab menu and click Delete
    const deleteRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/api/accounts/"),
    );
    await row.getByRole("button").first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    // Confirm deletion in alert dialog
    await page.getByRole("button", { name: "Delete" }).click();
    const deleteResponse = await deleteRequest;
    expect(deleteResponse.ok()).toBeTruthy();

    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/accounts?search=${UI_DELETE_USERNAME}`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        const body = await response.json();
        const account = body.data.find(
          (entry: { username: string; status: string }) =>
            entry.username === UI_DELETE_USERNAME,
        );
        return account?.status ?? "missing";
      })
      .toBe("disabled");

    await expect(row).toContainText("Disabled", { timeout: 10_000 });
  });

  // ── RBAC tests ───────────────────────────────────────────────

  test("Security Monitor cannot access accounts API", async ({ page }) => {
    const secMonUser = `${TEST_PREFIX}secmon`;
    const secMonPass = "SecMon1234!";
    await createTestAccount(secMonUser, secMonPass, "Security Monitor");

    try {
      await signInAndWait(page, secMonUser, secMonPass);

      const response = await page.request.get("/api/accounts");
      expect(response.status()).toBe(403);
    } finally {
      await deleteTestAccount(secMonUser);
    }
  });

  // ── Filter tests ────────────────────────────────────────────

  test("search filter returns matching accounts", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const response = await page.request.get("/api/accounts?search=admin");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(
      body.data.every(
        (a: { username: string; display_name: string }) =>
          a.username.includes("admin") || a.display_name.includes("admin"),
      ),
    ).toBe(true);
  });

  test("role filter returns only matching role accounts", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const response = await page.request.get(
      "/api/accounts?role=System+Administrator",
    );
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(
      body.data.every(
        (a: { role_name: string }) => a.role_name === "System Administrator",
      ),
    ).toBe(true);
  });

  test("status filter returns only matching status accounts", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const response = await page.request.get("/api/accounts?status=active");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(
      body.data.every((a: { status: string }) => a.status === "active"),
    ).toBe(true);
  });

  // ── Audit log verification ────────────────────────────────────

  test("account audit events are visible in audit logs", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Check audit logs API for account.create
    const auditRes = await page.request.get(
      "/api/audit-logs?action=account.create",
    );
    expect(auditRes.status()).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
    expect(auditBody.data[0].target_type).toBe("account");
  });
});
