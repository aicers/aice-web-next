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
  createTestRole,
  deleteRolesByPrefix,
  deleteTestAccount,
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

test.describe("Role management", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await clearMustChangePassword(ADMIN_USERNAME);
    await resetAccountDefaults(ADMIN_USERNAME);
    // Clean up leftover test data
    await deleteTestAccount(`${TEST_PREFIX}secmon`);
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await deleteTestAccount(`${TEST_PREFIX}secmon`);
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  // ── API tests ─────────────────────────────────────────────────

  test("GET /api/roles returns all roles", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await page.request.get("/api/roles");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    // Verify built-in roles exist
    const names = body.data.map((r: { name: string }) => r.name);
    expect(names).toContain("System Administrator");
    expect(names).toContain("Tenant Administrator");
    expect(names).toContain("Security Monitor");
  });

  test("POST /api/roles creates a custom role", async ({ page }) => {
    await deleteTestRole(`${TEST_PREFIX}api-create`);
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post("/api/roles", {
      data: {
        name: `${TEST_PREFIX}api-create`,
        description: "E2E test role",
        permissions: ["accounts:read", "customers:read"],
      },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.data.name).toBe(`${TEST_PREFIX}api-create`);
    expect(body.data.permissions).toContain("accounts:read");
    expect(body.data.permissions).toContain("customers:read");
  });

  test("PATCH /api/roles/[id] updates a custom role", async ({ page }) => {
    const roleId = await createTestRole(
      `${TEST_PREFIX}api-update`,
      ["accounts:read"],
      "before update",
    );

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.patch(`/api/roles/${roleId}`, {
      data: {
        name: `${TEST_PREFIX}api-update`,
        permissions: ["accounts:read", "accounts:write", "roles:read"],
      },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.permissions).toHaveLength(3);
    expect(body.data.permissions).toContain("accounts:write");
  });

  test("PATCH /api/roles/[id] rejects built-in role modification", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    // Role ID 1 = System Administrator (built-in)
    const response = await page.request.patch("/api/roles/1", {
      data: { name: "Hacked", permissions: [] },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(403);
  });

  test("DELETE /api/roles/[id] deletes a custom role", async ({ page }) => {
    const roleId = await createTestRole(`${TEST_PREFIX}api-delete`, [
      "accounts:read",
    ]);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.delete(`/api/roles/${roleId}`, {
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(200);

    // Verify role is gone
    const listRes = await page.request.get("/api/roles");
    const listBody = await listRes.json();
    const names = listBody.data.map((r: { name: string }) => r.name);
    expect(names).not.toContain(`${TEST_PREFIX}api-delete`);
  });

  test("DELETE /api/roles/[id] rejects built-in role deletion", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.delete("/api/roles/1", {
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(403);
  });

  test("DELETE /api/roles/[id] rejects deletion of role in use", async ({
    page,
  }) => {
    // Create a role and assign an account to it
    const roleId = await createTestRole(`${TEST_PREFIX}in-use`, [
      "accounts:read",
    ]);
    await createTestAccount(
      `${TEST_PREFIX}secmon`,
      "TestPass1234!",
      `${TEST_PREFIX}in-use`,
    );

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.delete(`/api/roles/${roleId}`, {
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/assigned to accounts/i);

    // Clean up: delete account first, then role
    await deleteTestAccount(`${TEST_PREFIX}secmon`);
  });

  test("POST /api/roles returns 400 for invalid permissions", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post("/api/roles", {
      data: {
        name: `${TEST_PREFIX}bad-perms`,
        permissions: ["nonexistent:perm"],
      },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(400);
  });

  test("POST /api/roles returns 400 for duplicate name", async ({ page }) => {
    await createTestRole(`${TEST_PREFIX}dup`, ["accounts:read"]);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post("/api/roles", {
      data: {
        name: `${TEST_PREFIX}dup`,
        permissions: ["accounts:read"],
      },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    // Error message may be in body.error or body.details
    const errorText = JSON.stringify(body);
    expect(errorText).toMatch(/already exists/i);
  });

  // ── UI tests ──────────────────────────────────────────────────

  test("navigates to roles page and displays built-in roles", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();

    // Verify built-in roles are listed
    await expect(roleRow(page, "System Administrator")).toBeVisible({
      timeout: 10_000,
    });
    await expect(roleRow(page, "Tenant Administrator")).toBeVisible();
    await expect(roleRow(page, "Security Monitor")).toBeVisible();

    // Verify built-in badges
    await expect(
      roleRow(page, "System Administrator").getByText("Built-in"),
    ).toBeVisible();
  });

  test("creates a custom role via UI", async ({ page }) => {
    await deleteTestRole(`${TEST_PREFIX}ui-create`);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();

    // Click create button
    await page.getByRole("button", { name: "Create Role" }).click();

    // Fill form
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill(`${TEST_PREFIX}ui-create`);
    await dialog.getByLabel("Description").fill("Created via E2E test");

    // Select permissions
    await dialog.locator("#perm-accounts\\:read").click();
    await dialog.locator("#perm-customers\\:read").click();

    // Submit
    await dialog.getByRole("button", { name: "Create Role" }).click();

    // Verify new role appears in table
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

    // Click edit button (pencil icon, first button in actions)
    await row.getByRole("button").first().click();

    // Update name and add permission
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const nameInput = dialog.getByLabel("Name");
    await nameInput.clear();
    await nameInput.fill(`${TEST_PREFIX}ui-edited`);

    // Add customers:read permission
    await dialog.locator("#perm-customers\\:read").click();

    // Submit
    await dialog.getByRole("button", { name: "Edit Role" }).click();

    // Verify updated name appears
    await expect(roleRow(page, `${TEST_PREFIX}ui-edited`)).toBeVisible({
      timeout: 15_000,
    });

    // Clean up renamed role
    await deleteTestRole(`${TEST_PREFIX}ui-edited`);
  });

  test("clones a built-in role via UI", async ({ page }) => {
    await deleteTestRole(`${TEST_PREFIX}ui-clone`);

    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    const adminRow = roleRow(page, "System Administrator");
    await expect(adminRow).toBeVisible({ timeout: 10_000 });

    // Click clone button (copy icon — for built-in roles it's the only button)
    await adminRow.getByRole("button").first().click();

    // Verify dialog opened with "Clone Role" title
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Clone Role")).toBeVisible();

    // Name should be empty, fill it
    await dialog.getByLabel("Name").fill(`${TEST_PREFIX}ui-clone`);

    // Wait for the clone response to complete
    const createRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/roles"),
    );

    // Submit
    await dialog.getByRole("button", { name: "Create Role" }).click();
    const createResponse = await createRequest;

    if (!createResponse.ok()) {
      const errorBody = await createResponse.json();
      throw new Error(
        `Clone API failed (${createResponse.status()}): ${JSON.stringify(errorBody)}`,
      );
    }

    // Wait for dialog to close
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Verify cloned role appears with same permission count as System Administrator
    const clonedRow = roleRow(page, `${TEST_PREFIX}ui-clone`);
    await expect(clonedRow).toBeVisible({ timeout: 15_000 });
    await expect(clonedRow).toContainText("15");
  });

  test("built-in roles have no edit or delete buttons", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/roles");

    const adminRow = roleRow(page, "System Administrator");
    await expect(adminRow).toBeVisible({ timeout: 10_000 });

    // Built-in roles should have only 1 action button (clone)
    const buttons = adminRow.getByRole("button");
    await expect(buttons).toHaveCount(1);

    // The button should have the clone title
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

    // Custom roles should have 3 action buttons
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

    // Click delete button (3rd button)
    const deleteRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/api/roles/"),
    );
    await row.getByRole("button").nth(2).click();

    // Confirm deletion in alert dialog
    await page.getByRole("button", { name: "Delete Role" }).click();
    const deleteResponse = await deleteRequest;
    expect(deleteResponse.ok()).toBeTruthy();

    // Verify role is gone from table
    await expect(row).not.toBeVisible({ timeout: 10_000 });
  });

  // ── RBAC tests ────────────────────────────────────────────────

  test("Security Monitor cannot modify roles", async ({ page }) => {
    const secMonUser = `${TEST_PREFIX}rbac`;
    const secMonPass = "SecMon1234!";
    await createTestAccount(secMonUser, secMonPass, "Security Monitor");

    try {
      await signInAndWait(page, secMonUser, secMonPass);

      const cookies = await page.context().cookies();
      const csrfCookie = cookies.find((c) => c.name === "csrf");

      // GET /api/roles is open (needed for account forms), but POST requires roles:write
      const getRes = await page.request.get("/api/roles");
      expect(getRes.status()).toBe(200);

      const postRes = await page.request.post("/api/roles", {
        data: { name: "hacked", permissions: [] },
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      });
      expect(postRes.status()).toBe(403);
    } finally {
      await deleteTestAccount(secMonUser);
    }
  });

  test("Security Monitor cannot create roles", async ({ page }) => {
    const secMonUser = `${TEST_PREFIX}rbac-write`;
    const secMonPass = "SecMon1234!";
    await createTestAccount(secMonUser, secMonPass, "Security Monitor");

    try {
      await signInAndWait(page, secMonUser, secMonPass);

      const cookies = await page.context().cookies();
      const csrfCookie = cookies.find((c) => c.name === "csrf");

      const response = await page.request.post("/api/roles", {
        data: {
          name: `${TEST_PREFIX}rbac-attempt`,
          permissions: ["accounts:read"],
        },
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      });

      expect(response.status()).toBe(403);
    } finally {
      await deleteTestAccount(secMonUser);
    }
  });

  // ── Audit log verification ──────────────────────────────────

  test("role audit events are visible in audit logs", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const auditRes = await page.request.get(
      "/api/audit-logs?action=role.create",
    );
    expect(auditRes.status()).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
    expect(auditBody.data[0].target_type).toBe("role");
  });
});
