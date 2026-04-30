/**
 * Capture the Customer scope indicator screenshots for the manual.
 *
 * The indicator is a pure UI surface that renders a JSON-serializable
 * scope prop, so its captures are wholly deterministic on any machine
 * that can run the e2e suite. The capture covers the breadcrumb-bar
 * indicator on desktop and the mobile-header pill at a narrow viewport
 * across two scope categories: an `assigned` 2–3-customer state (the
 * canonical hero figure for the manual) and the `customers:access-all`
 * admin state (so the docs show the admin badge alongside the tenant
 * label). EN and KR run back-to-back so the captures share a session
 * and any data drift is shared between locales.
 *
 * Run manually with:
 *
 *   CAPTURE_SCREENSHOTS=1 pnpm exec playwright test \
 *     --config=e2e/playwright.config.ts \
 *     e2e/customer-scope-screenshots.spec.ts
 */
import path from "node:path";

import { expect, test } from "./fixtures";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import {
  assignCustomerToAccount,
  createTestAccount,
  createTestRole,
  deleteCustomersByPrefix,
  deleteRolesByPrefix,
  deleteTestAccount,
  ensureCustomerExists,
  getAccountId,
  removeAccountCustomerAssignments,
  resetAccountDefaults,
  setPassword,
} from "./helpers/setup-db";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
const MOBILE_VIEWPORT = { width: 414, height: 896 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "docs", "assets");

const TENANT_USERNAME = "scope-shot-tenant";
const TENANT_PASSWORD = "ScopeShot1234!";
const TENANT_ROLE = "scope-shot-tenant-role";
const TENANT_CUSTOMERS = ["ACME", "Beta", "Gamma"] as const;

test.beforeEach(async () => {
  await resetRateLimits();
});

test.describe
  .serial("Customer scope indicator screenshots", () => {
    // Opt-in only — the spec mutates auth_db roles/accounts and would
    // otherwise create churn against the parallel suites.
    test.skip(
      process.env.CAPTURE_SCREENSHOTS !== "1",
      "Manual screenshot capture — set CAPTURE_SCREENSHOTS=1 to run.",
    );

    test.beforeAll(async () => {
      // Tenant role has dashboard read but no `customers:access-all`,
      // so `getEffectiveCustomerScope` returns `kind: 'assigned'` —
      // the multi-customer label the canonical hero figure showcases.
      await createTestRole(
        TENANT_ROLE,
        ["dashboard:read", "customers:read"],
        "Scope-screenshot tenant",
      );
      await createTestAccount(TENANT_USERNAME, TENANT_PASSWORD, TENANT_ROLE);
      await resetAccountDefaults(TENANT_USERNAME);
      await setPassword(TENANT_USERNAME, TENANT_PASSWORD);
      const accountId = await getAccountId(TENANT_USERNAME);
      await removeAccountCustomerAssignments(accountId);
      for (const name of TENANT_CUSTOMERS) {
        const cid = await ensureCustomerExists(`scope-shot-${name}`);
        await assignCustomerToAccount(accountId, cid);
      }
    });

    test.afterAll(async () => {
      try {
        await deleteTestAccount(TENANT_USERNAME);
      } catch {
        // already removed
      }
      await deleteCustomersByPrefix("scope-shot-");
      await deleteRolesByPrefix("scope-shot-");
    });

    test("EN desktop indicator (assigned, multi-customer)", async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      // Force dark theme so the capture matches the rest of the manual.
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("theme", "gray-dark");
        } catch {}
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await signInAndWait(page, TENANT_USERNAME, TENANT_PASSWORD);
      await page.goto("/dashboard");
      const pill = page.locator(
        '[data-testid="customer-scope-indicator"][data-variant="desktop"]',
      );
      await expect(pill).toBeVisible({ timeout: 10_000 });
      await pill.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "customer-scope-indicator-en.png"),
        animations: "disabled",
      });
    });

    test("KO desktop indicator (assigned, multi-customer)", async ({
      page,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("theme", "gray-dark");
        } catch {}
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await signInAndWaitKo(page, TENANT_USERNAME, TENANT_PASSWORD);
      await page.goto("/ko/dashboard");
      const pill = page.locator(
        '[data-testid="customer-scope-indicator"][data-variant="desktop"]',
      );
      await expect(pill).toBeVisible({ timeout: 10_000 });
      await pill.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "customer-scope-indicator-ko.png"),
        animations: "disabled",
      });
    });

    test("EN mobile indicator (assigned, multi-customer)", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("theme", "gray-dark");
        } catch {}
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await signInAndWait(page, TENANT_USERNAME, TENANT_PASSWORD);
      await page.goto("/dashboard");
      const mobilePill = page.locator(
        '[data-testid="customer-scope-indicator"][data-variant="mobile"]',
      );
      await expect(mobilePill).toBeVisible({ timeout: 10_000 });
      await mobilePill.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "customer-scope-indicator-mobile-en.png"),
        animations: "disabled",
      });
    });

    test("KO mobile indicator (assigned, multi-customer)", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("theme", "gray-dark");
        } catch {}
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await signInAndWaitKo(page, TENANT_USERNAME, TENANT_PASSWORD);
      await page.goto("/ko/dashboard");
      const mobilePill = page.locator(
        '[data-testid="customer-scope-indicator"][data-variant="mobile"]',
      );
      await expect(mobilePill).toBeVisible({ timeout: 10_000 });
      await mobilePill.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "customer-scope-indicator-mobile-ko.png"),
        animations: "disabled",
      });
    });

    test("EN admin indicator", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("theme", "gray-dark");
        } catch {}
      });
      await page.emulateMedia({ colorScheme: "dark" });
      // The worker role grants `customers:access-all`, so the indicator
      // resolves to admin scope.
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/dashboard");
      const pill = page.locator(
        '[data-testid="customer-scope-indicator"][data-variant="desktop"]',
      );
      await expect(pill).toBeVisible({ timeout: 10_000 });
      await expect(pill).toHaveAttribute("data-scope-kind", "admin");
      await page.screenshot({
        path: path.join(ASSETS_DIR, "customer-scope-indicator-admin-en.png"),
        animations: "disabled",
      });
    });

    test("KO admin indicator", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("theme", "gray-dark");
        } catch {}
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/dashboard");
      const pill = page.locator(
        '[data-testid="customer-scope-indicator"][data-variant="desktop"]',
      );
      await expect(pill).toBeVisible({ timeout: 10_000 });
      await expect(pill).toHaveAttribute("data-scope-kind", "admin");
      await page.screenshot({
        path: path.join(ASSETS_DIR, "customer-scope-indicator-admin-ko.png"),
        animations: "disabled",
      });
    });
  });
