import { expect, test } from "./fixtures";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";

test.beforeAll(async ({ workerUsername }) => {
  await resetRateLimits();
  await resetAccountDefaults(workerUsername);
});

test.beforeEach(async () => {
  await resetRateLimits();
});

test.describe("UI regression (#130 Sidebar/NavUser, #718 color-scheme)", () => {
  // ── NavUser (#130) ──────────────────────────────────────────

  test("nav user shows real username instead of hardcoded text", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // The nav user should show the actual username, not "Profile" or "U"
    // The username appears in the sidebar's nav user section
    const sidebar = page.locator("aside");
    await expect(sidebar.getByText(workerUsername)).toBeVisible();
  });

  test("nav user avatar shows correct initials", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // The avatar should show the first letter(s) of the username
    // For "e2e-worker-N" → "E"
    const avatar = page.locator(
      '[class*="bg-primary"][class*="text-primary-foreground"]',
    );
    await expect(avatar.first()).toBeVisible();
    const text = await avatar.first().textContent();
    expect(text?.trim().charAt(0).toUpperCase()).toBe("E");
  });

  // ── Sign-out from nav user dropdown ─────────────────────────

  test("nav user dropdown has profile and sign-out options", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Click the nav user trigger to open dropdown
    const sidebar = page.locator("aside");
    const navUser = sidebar
      .locator("button")
      .filter({ hasText: workerUsername });
    await navUser.click();

    // Dropdown should show Profile and Sign Out
    await expect(
      page.getByRole("menuitem", { name: /profile/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /sign out/i }),
    ).toBeVisible();
  });

  // ── color-scheme follows active theme (#718) ────────────────
  //
  // Native date/time controls (e.g. `<input type="datetime-local">`)
  // paint their picker indicator and popup using the document's
  // `color-scheme`. Without it, the dark theme drew a dark calendar
  // glyph on the dark input background, making it invisible. The fix
  // declares `color-scheme` per theme on the root, which inherits to
  // every native control, so asserting the root computed value guards
  // the whole surface.

  test("root color-scheme is dark under the dark theme", async ({ page }) => {
    await page.goto("/sign-in");

    // gray-dark is the default theme, so a fresh visit resolves dark.
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "gray-dark");

    const colorScheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(colorScheme).toBe("dark");
  });

  test("root color-scheme follows a switch to the light theme", async ({
    page,
  }) => {
    await page.goto("/sign-in");

    // next-themes persists the selection under the default "theme"
    // storage key and applies it via its pre-paint script on reload.
    await page.evaluate(() => localStorage.setItem("theme", "gray-light"));
    await page.reload();

    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "gray-light");

    const colorScheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(colorScheme).toBe("light");
  });
});
