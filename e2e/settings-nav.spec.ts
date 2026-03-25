import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
} from "./helpers/setup-db";

// User with only accounts:read — no dashboard or system-settings access
const ACCOUNTS_ONLY_USER = "e2e-settings-acct-only";
const ACCOUNTS_ONLY_PASS = "AcctOnly1234!";
const ACCOUNTS_ONLY_ROLE = "E2E Accounts Only";

// User with dashboard:read but no system-settings — can see Account Status but not Policies
const DASH_ONLY_USER = "e2e-settings-dash-only";
const DASH_ONLY_PASS = "DashOnly1234!";
const DASH_ONLY_ROLE = "E2E Dashboard Only";

test.beforeAll(async () => {
  await resetRateLimits();

  await createTestRole(ACCOUNTS_ONLY_ROLE, ["accounts:read"]);
  await createTestAccount(
    ACCOUNTS_ONLY_USER,
    ACCOUNTS_ONLY_PASS,
    ACCOUNTS_ONLY_ROLE,
  );

  await createTestRole(DASH_ONLY_ROLE, ["dashboard:read"]);
  await createTestAccount(DASH_ONLY_USER, DASH_ONLY_PASS, DASH_ONLY_ROLE);
});

test.beforeEach(async () => {
  await resetRateLimits();
  await resetAccountDefaults(ADMIN_USERNAME);
});

test.afterAll(async () => {
  try {
    await deleteTestAccount(ACCOUNTS_ONLY_USER);
    await deleteTestAccount(DASH_ONLY_USER);
    await deleteTestRole(ACCOUNTS_ONLY_ROLE);
    await deleteTestRole(DASH_ONLY_ROLE);
  } catch {
    // best-effort cleanup
  }
});

test.describe("Settings navigation", () => {
  test("settings page shows all five tabs for admin", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings");

    const nav = page.locator("nav").filter({ hasText: "Accounts" });
    await expect(nav.getByRole("link", { name: "Accounts" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Roles" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Customers" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Policies" })).toBeVisible();
    await expect(
      nav.getByRole("link", { name: "Account Status" }),
    ).toBeVisible();
  });

  test("settings redirects to accounts tab by default", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings");

    await page.waitForURL(/\/settings\/accounts/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  });

  test("policies tab renders system settings panel", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/policies");

    await expect(page.getByRole("tab", { name: /password/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /session/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /lockout/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /jwt/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /mfa/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /rate limits/i })).toBeVisible();
  });

  test("account status tab renders monitoring cards", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/account-status");

    await expect(
      page.getByRole("heading", { name: /Account Status/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Active Sessions").first()).toBeVisible();
    await expect(page.getByText("Locked & Suspended Accounts")).toBeVisible();
  });

  test("breadcrumb shows correct label for policies", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/policies");

    const breadcrumb = page.getByLabel("Breadcrumb");
    await expect(breadcrumb.getByText("Settings")).toBeVisible();
    await expect(breadcrumb.getByText("Policies")).toBeVisible();
  });

  test("breadcrumb shows correct label for account status", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/settings/account-status");

    const breadcrumb = page.getByLabel("Breadcrumb");
    await expect(breadcrumb.getByText("Settings")).toBeVisible();
    await expect(breadcrumb.getByText("Account Status")).toBeVisible();
  });
});

test.describe("Settings navigation — Korean locale", () => {
  test("settings page shows Korean tab labels", async ({ page }) => {
    await signInAndWaitKo(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/ko/settings");

    await page.waitForURL(/\/settings\/accounts/, { timeout: 10_000 });

    const nav = page.locator("nav").filter({ hasText: "계정" });
    await expect(
      nav.getByRole("link", { name: "계정", exact: true }),
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: "역할" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "고객" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "정책" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "계정 현황" })).toBeVisible();
  });

  test("Korean breadcrumb shows correct label for policies", async ({
    page,
  }) => {
    await signInAndWaitKo(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/ko/settings/policies");

    const breadcrumb = page.getByLabel("Breadcrumb");
    await expect(breadcrumb.getByText("설정")).toBeVisible();
    await expect(breadcrumb.getByText("정책")).toBeVisible();
  });

  test("Korean breadcrumb shows correct label for account status", async ({
    page,
  }) => {
    await signInAndWaitKo(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto("/ko/settings/account-status");

    const breadcrumb = page.getByLabel("Breadcrumb");
    await expect(breadcrumb.getByText("설정")).toBeVisible();
    await expect(breadcrumb.getByText("계정 현황")).toBeVisible();
  });
});

test.describe("Settings navigation — RBAC", () => {
  test("user without dashboard:read does not see Account Status tab", async ({
    page,
  }) => {
    await signInAndWait(page, ACCOUNTS_ONLY_USER, ACCOUNTS_ONLY_PASS);
    await page.goto("/settings/accounts");

    const nav = page.locator("nav").filter({ hasText: "Accounts" });
    await expect(nav.getByRole("link", { name: "Accounts" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Account Status" })).toHaveCount(
      0,
    );
  });

  test("user without system-settings:read does not see Policies tab", async ({
    page,
  }) => {
    await signInAndWait(page, ACCOUNTS_ONLY_USER, ACCOUNTS_ONLY_PASS);
    await page.goto("/settings/accounts");

    const nav = page.locator("nav").filter({ hasText: "Accounts" });
    await expect(nav.getByRole("link", { name: "Accounts" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Policies" })).toHaveCount(0);
  });

  test("user with only dashboard:read sees Account Status but not Policies", async ({
    page,
  }) => {
    await signInAndWait(page, DASH_ONLY_USER, DASH_ONLY_PASS);
    await page.goto("/settings/account-status");

    const nav = page.locator("nav").filter({ hasText: "Account Status" });
    await expect(
      nav.getByRole("link", { name: "Account Status" }),
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: "Policies" })).toHaveCount(0);
  });

  test("dashboard-only user visiting /settings is redirected to account-status", async ({
    page,
  }) => {
    await signInAndWait(page, DASH_ONLY_USER, DASH_ONLY_PASS);
    await page.goto("/settings");

    await page.waitForURL(/\/settings\/account-status/, { timeout: 10_000 });
  });

  test("user without dashboard:read is redirected from account-status page", async ({
    page,
  }) => {
    await signInAndWait(page, ACCOUNTS_ONLY_USER, ACCOUNTS_ONLY_PASS);
    await page.goto("/settings/account-status");

    await page.waitForURL(
      (url) => !url.pathname.includes("/settings/account-status"),
      { timeout: 10_000 },
    );
  });

  test("user without system-settings:read is redirected from policies page", async ({
    page,
  }) => {
    await signInAndWait(page, ACCOUNTS_ONLY_USER, ACCOUNTS_ONLY_PASS);
    await page.goto("/settings/policies");

    await page.waitForURL(
      (url) => !url.pathname.includes("/settings/policies"),
      { timeout: 10_000 },
    );
  });
});

test.describe("Settings navigation — old URL", () => {
  test("/settings/system returns 404", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const response = await page.goto("/settings/system");
    expect(response?.status()).toBe(404);
  });
});
