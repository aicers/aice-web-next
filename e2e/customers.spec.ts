import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
  signOut,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  deleteCustomersByPrefix,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

const TEST_PREFIX = "E2E-Cust-";

test.describe("Customer management", () => {
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

  // ── API tests ─────────────────────────────────────────────────

  test("POST /api/customers creates a customer", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post("/api/customers", {
      data: { name: `${TEST_PREFIX}Alpha`, description: "Test customer" },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.data.name).toBe(`${TEST_PREFIX}Alpha`);
    expect(body.data.status).toBe("active");
    expect(body.data.database_name).toContain("customer_");
  });

  test("GET /api/customers lists customers", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await page.request.get("/api/customers");
    expect(response.status()).toBe(200);

    const body = await response.json();
    const testCustomers = body.data.filter((c: { name: string }) =>
      c.name.startsWith(TEST_PREFIX),
    );
    expect(testCustomers.length).toBeGreaterThanOrEqual(1);
  });

  test("PATCH /api/customers/[id] updates a customer", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Get customer ID
    const listRes = await page.request.get("/api/customers");
    const listBody = await listRes.json();
    const customer = listBody.data.find(
      (c: { name: string }) => c.name === `${TEST_PREFIX}Alpha`,
    );
    expect(customer).toBeDefined();

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.patch(`/api/customers/${customer.id}`, {
      data: { name: `${TEST_PREFIX}Alpha-Updated` },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.name).toBe(`${TEST_PREFIX}Alpha-Updated`);
  });

  test("DELETE /api/customers/[id] deletes a customer", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Get customer ID
    const listRes = await page.request.get("/api/customers");
    const listBody = await listRes.json();
    const customer = listBody.data.find(
      (c: { name: string }) => c.name === `${TEST_PREFIX}Alpha-Updated`,
    );
    expect(customer).toBeDefined();

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.delete(
      `/api/customers/${customer.id}`,
      {
        headers: {
          "x-csrf-token": csrfCookie?.value ?? "",
          Origin: "http://localhost:3000",
        },
      },
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify it's gone
    const verifyRes = await page.request.get(`/api/customers/${customer.id}`);
    expect(verifyRes.status()).toBe(404);
  });

  test("POST /api/customers returns 400 for missing name", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    const response = await page.request.post("/api/customers", {
      data: {},
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status()).toBe(400);
  });

  // ── UI tests ──────────────────────────────────────────────────

  test("navigates to customers page and creates a customer via UI", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/customers");

    // Verify page heading
    await expect(
      page.getByRole("heading", { name: "Customers" }),
    ).toBeVisible();

    // Click create button
    await page.getByRole("button", { name: "Create Customer" }).click();

    // Fill form
    await page.getByLabel("Name").fill(`${TEST_PREFIX}UITest`);
    await page.getByLabel("Description").fill("Created via E2E");

    // Submit
    await page.getByRole("button", { name: "Create Customer" }).click();

    // Wait for dialog to close and table to update
    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest` }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("edits a customer via UI", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/customers");

    // Wait for table to load
    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest` }),
    ).toBeVisible({ timeout: 10_000 });

    // Click edit button on the row
    const row = page.getByRole("row").filter({
      hasText: `${TEST_PREFIX}UITest`,
    });
    await row.getByRole("button").first().click();

    // Update name
    const nameInput = page.getByLabel("Name");
    await nameInput.clear();
    await nameInput.fill(`${TEST_PREFIX}UITest-Edited`);

    // Submit
    await page.getByRole("button", { name: "Edit Customer" }).click();

    // Verify update
    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest-Edited` }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("deletes a customer via UI", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/customers");

    // Wait for table to load
    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest-Edited` }),
    ).toBeVisible({ timeout: 10_000 });

    // Click delete button on the row (second button)
    const row = page.getByRole("row").filter({
      hasText: `${TEST_PREFIX}UITest-Edited`,
    });
    await row.getByRole("button").nth(1).click();

    // Confirm deletion in alert dialog
    await page.getByRole("button", { name: "Delete Customer" }).click();

    // Verify removal
    await expect(
      page.getByRole("cell", { name: `${TEST_PREFIX}UITest-Edited` }),
    ).not.toBeVisible({ timeout: 10_000 });
  });

  // ── Audit log verification ────────────────────────────────────

  test("customer audit events are visible in audit logs", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Create a customer so we have a fresh audit event
    const cookies = await page.context().cookies();
    const csrfCookie = cookies.find((c) => c.name === "csrf");

    await page.request.post("/api/customers", {
      data: { name: `${TEST_PREFIX}AuditCheck` },
      headers: {
        "x-csrf-token": csrfCookie?.value ?? "",
        Origin: "http://localhost:3000",
      },
    });

    // Check audit logs API for customer.create
    const auditRes = await page.request.get(
      "/api/audit-logs?action=customer.create",
    );
    expect(auditRes.status()).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
    expect(auditBody.data[0].target_type).toBe("customer");
  });
});
