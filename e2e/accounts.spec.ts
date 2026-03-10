import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  createTestAccount,
  deleteTestAccount,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

const TEST_PREFIX = "e2e-acct-";
const UI_CREATE_USERNAME = `${TEST_PREFIX}ui-create`;
const UI_EDIT_USERNAME = `${TEST_PREFIX}ui-edit`;
const UI_DELETE_USERNAME = `${TEST_PREFIX}ui-delete`;

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
  test.beforeAll(async () => {
    await resetRateLimits();
    await clearMustChangePassword(ADMIN_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
    // Clean up any leftover test accounts
    await deleteTestAccount(`${TEST_PREFIX}alpha`);
    await deleteTestAccount(UI_CREATE_USERNAME);
    await deleteTestAccount(UI_EDIT_USERNAME);
    await deleteTestAccount(UI_DELETE_USERNAME);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await deleteTestAccount(`${TEST_PREFIX}alpha`);
    await deleteTestAccount(UI_CREATE_USERNAME);
    await deleteTestAccount(UI_EDIT_USERNAME);
    await deleteTestAccount(UI_DELETE_USERNAME);
  });

  // ── API tests ─────────────────────────────────────────────────

  test("POST /api/accounts creates an account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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

  test("GET /api/accounts lists accounts", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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

  test("PATCH /api/accounts/[id] updates an account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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
  }) => {
    // Clean up first
    await deleteTestAccount(UI_CREATE_USERNAME);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/accounts");

    // Verify page heading
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();

    // Click create button
    await page.getByRole("button", { name: "Create Account" }).click();

    // Fill form
    await page.getByLabel("Username").fill(UI_CREATE_USERNAME);
    await page.getByLabel("Display Name").fill("E2E UI Test");
    await page.getByLabel("Password").fill("UiTestPass1234!");

    // Select role (System Administrator doesn't require customer assignment)
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "System Administrator" }).click();

    // Submit
    await page.getByRole("button", { name: "Create Account" }).click();

    // Wait for dialog to close and table to update
    await expect(accountRow(page, UI_CREATE_USERNAME)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("edits an account via UI", async ({ page }) => {
    await recreateUiAccount(UI_EDIT_USERNAME, "UiEditPass1234!");

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/accounts");

    // Wait for table to load
    const row = accountRow(page, UI_EDIT_USERNAME);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Click edit button on the row
    await row.getByRole("button").first().click();

    // Update display name
    const nameInput = page.getByLabel("Display Name");
    await nameInput.clear();
    await nameInput.fill("E2E UI Edited");

    // Submit
    await page.getByRole("button", { name: "Edit Account" }).click();

    // Verify update
    await expect(row).toContainText("E2E UI Edited", { timeout: 10_000 });
  });

  test("deletes an account via UI", async ({ page }) => {
    await recreateUiAccount(UI_DELETE_USERNAME, "UiDeletePass1234!");

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/accounts");

    // Wait for table to load
    const row = accountRow(page, UI_DELETE_USERNAME);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Click delete button on the row (second button)
    const deleteRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/api/accounts/"),
    );
    await row.getByRole("button").nth(1).click();

    // Confirm deletion in alert dialog
    await page.getByRole("button", { name: "Delete Account" }).click();
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

  test("search filter returns matching accounts", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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

  test("role filter returns only matching role accounts", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await page.request.get("/api/accounts?status=active");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(
      body.data.every((a: { status: string }) => a.status === "active"),
    ).toBe(true);
  });

  // ── Audit log verification ────────────────────────────────────

  test("account audit events are visible in audit logs", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

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
