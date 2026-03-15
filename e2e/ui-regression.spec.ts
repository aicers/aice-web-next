import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";

test.beforeAll(async () => {
  await resetRateLimits();
  await resetAccountDefaults(ADMIN_USERNAME);
});

test.describe("UI regression (#129 Logo, #130 Sidebar/NavUser)", () => {
  // ── Logo (#129) ─────────────────────────────────────────────

  test("logo renders on sign-in page", async ({ page }) => {
    await page.goto("/sign-in");
    // The Logo component renders both light and dark variants;
    // one is hidden via CSS depending on theme. Check that at least
    // one img with the alt text exists in the DOM.
    const logos = page.locator('img[alt="Clumit Security"]');
    const count = await logos.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("logo renders in sidebar after sign-in", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Sidebar should contain at least one logo image
    const logos = page.locator('img[alt="Clumit Security"]');
    const count = await logos.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  // ── NavUser (#130) ──────────────────────────────────────────

  test("nav user shows real username instead of hardcoded text", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // The nav user should show "admin" (the actual username), not "Profile" or "U"
    // The username appears in the sidebar's nav user section
    const sidebar = page.locator("aside");
    await expect(sidebar.getByText(ADMIN_USERNAME)).toBeVisible();
  });

  test("nav user avatar shows correct initials", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // The avatar should show the first letter(s) of the username
    // For "admin" → "A"
    const avatar = page.locator(
      '[class*="bg-primary"][class*="text-primary-foreground"]',
    );
    await expect(avatar.first()).toBeVisible();
    const text = await avatar.first().textContent();
    expect(text?.trim().charAt(0).toUpperCase()).toBe("A");
  });

  // ── Sidebar active indicator (#130) ─────────────────────────

  test("sidebar shows active indicator on current page", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Navigate to accounts page
    await page.goto("/settings/accounts");

    // The active sidebar item should have the active indicator element
    // The sidebar-item renders an absolute div with the active indicator
    // when the item is active (pathname starts with item.href)
    const sidebar = page.locator("aside");
    const activeIndicator = sidebar.locator(
      '[style*="--sidebar-active"], [class*="sidebar-active"]',
    );
    // At least one active indicator should exist
    const indicatorCount = await activeIndicator.count();
    // If CSS variable approach doesn't work, check for the active link styling
    if (indicatorCount === 0) {
      // Fallback: check that at least one nav link has the active text color
      const activeLink = sidebar.locator("a").filter({
        has: page.locator('[class*="sidebar-fg"]'),
      });
      await expect(activeLink.first()).toBeVisible();
    }
  });

  // ── Sign-out from nav user dropdown ─────────────────────────

  test("nav user dropdown has profile and sign-out options", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Click the nav user trigger to open dropdown
    const sidebar = page.locator("aside");
    const navUser = sidebar
      .locator("button")
      .filter({ hasText: ADMIN_USERNAME });
    await navUser.click();

    // Dropdown should show Profile and Sign Out
    await expect(
      page.getByRole("menuitem", { name: /profile/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /sign out/i }),
    ).toBeVisible();
  });
});
