import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";

test.describe("Audit log page", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  test("audit log page loads and displays entries", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await page.goto("/audit-logs");
    await page.waitForURL("**/audit-logs");

    // The heading is rendered by AuditLogTable component.
    await expect(page.getByRole("heading", { name: "Audit Logs" })).toBeVisible(
      { timeout: 10_000 },
    );

    // Table should have at least one row (from the sign-in we just did).
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  });

  test("sign-in event appears in audit log", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/audit-logs");
    await page.waitForURL("**/audit-logs");

    // Wait for table to load.
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    // Look for the "Sign in success" action badge.
    const signInBadge = page
      .locator("table tbody")
      .getByText("Sign in success");
    await expect(signInBadge.first()).toBeVisible();
  });

  test("filter by action returns filtered results", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/audit-logs");
    await page.waitForURL("**/audit-logs");

    // Wait for initial load.
    await expect(page.locator("table tbody tr").first()).toBeVisible({
      timeout: 10_000,
    });

    // Select the "Sign in success" action filter.
    // Label is not associated with the Select via htmlFor/id, so locate
    // the trigger by its visible placeholder text.
    await page.getByText("All actions").click();
    await page.getByRole("option", { name: "Sign in success" }).click();
    await page.getByRole("button", { name: "Search" }).click();

    // All visible rows should have "Sign in success" badge.
    await expect(page.locator("table tbody tr").first()).toBeVisible({
      timeout: 10_000,
    });
    const badges = page.locator("table tbody .inline-flex");
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(badges.nth(i)).toContainText("Sign in success");
    }
  });

  test("filter by date range returns results", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/audit-logs");
    await page.waitForURL("**/audit-logs");

    // Set "from" to 1 hour ago, "to" to now.
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const formatDatetime = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

    const dateInputs = page.locator('input[type="datetime-local"]');
    await dateInputs.first().fill(formatDatetime(oneHourAgo));
    await dateInputs.nth(1).fill(formatDatetime(now));
    await page.getByRole("button", { name: "Search" }).click();

    // Should show results (we just signed in).
    await expect(page.locator("table tbody tr").first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
