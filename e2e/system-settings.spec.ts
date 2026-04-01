import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
  setAccountMfaOverride,
} from "./helpers/setup-db";

const READER_USER = "e2e-settings-reader";
const READER_PASS = "Reader1234!";
const READER_ROLE = "E2E Settings Reader";

test.beforeAll(async () => {
  await resetRateLimits();
  await createTestRole(READER_ROLE, ["system-settings:read"]);
  await createTestAccount(READER_USER, READER_PASS, READER_ROLE);
});

test.beforeEach(async () => {
  await resetRateLimits();
  await resetAccountDefaults(ADMIN_USERNAME);
  await setAccountMfaOverride(ADMIN_USERNAME, "exempt");
});

test.afterAll(async () => {
  await deleteTestAccount(READER_USER);
  await deleteTestRole(READER_ROLE);
});

test.describe("System settings — UI", () => {
  test("settings page displays all tabs", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/policies");

    await expect(page.getByRole("tab", { name: /password/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /session/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /lockout/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /jwt/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /mfa/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /rate limits/i })).toBeVisible();
  });

  test("tab switching shows different form fields", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/policies");

    await expect(page.locator("#min_length")).toBeVisible();

    await page.getByRole("tab", { name: /session/i }).click();
    await expect(page.locator("#idle_timeout_minutes")).toBeVisible();

    await page.getByRole("tab", { name: /jwt/i }).click();
    await expect(
      page.locator("#access_token_expiration_minutes"),
    ).toBeVisible();
  });

  test("read-only user sees disabled fields and info banner", async ({
    page,
  }) => {
    await resetAccountDefaults(READER_USER);
    await signInAndWait(page, READER_USER, READER_PASS);
    await page.goto("/settings/policies");

    await expect(
      page.getByText(/do not have permission to modify/i),
    ).toBeVisible();

    const minLength = page.locator("#min_length");
    await expect(minLength).toBeDisabled();
  });

  test("settings update via UI persists", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/policies");

    await page.getByRole("tab", { name: /jwt/i }).click();

    const input = page.locator("#access_token_expiration_minutes");
    await expect(input).toBeVisible();

    const currentValue = await input.inputValue();
    const newValue = currentValue === "15" ? "20" : "15";

    try {
      await input.fill(newValue);
      await page.getByRole("button", { name: /jwt|save/i }).click();

      await expect(page.getByText(/updated successfully/i)).toBeVisible({
        timeout: 5000,
      });

      await page.reload();
      await page.getByRole("tab", { name: /jwt/i }).click();
      await expect(input).toHaveValue(newValue);
    } finally {
      await input.fill(currentValue);
      await page.getByRole("button", { name: /jwt|save/i }).click();
      await expect(page.getByText(/updated successfully/i)).toBeVisible({
        timeout: 5000,
      });
    }
  });
});
