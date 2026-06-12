/**
 * Capture the Time-format preferences screenshots for the manual (#766).
 *
 * The Time-format section on the Profile preferences page is a pure
 * client-side UI surface (four select controls + a live preview); it
 * does not depend on REview data, so its capture is deterministic on any
 * machine that can run the e2e suite. EN and KR run back-to-back so the
 * captures share the worker session and the same sample instant.
 *
 * Run manually with:
 *
 *   CAPTURE_SCREENSHOTS=1 pnpm exec playwright test \
 *     --config=e2e/playwright.config.ts \
 *     e2e/preferences-screenshots.spec.ts
 */
import path from "node:path";

import { expect, test } from "./fixtures";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  resetAccountDefaults,
  resetAccountPreferences,
} from "./helpers/setup-db";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "docs", "assets");

test.describe
  .serial("Time-format preferences screenshots", () => {
    // Opt-in only — keep the manual capture out of the default suite.
    test.skip(
      process.env.CAPTURE_SCREENSHOTS !== "1",
      "Manual screenshot capture — set CAPTURE_SCREENSHOTS=1 to run.",
    );

    test.beforeAll(async ({ workerUsername }) => {
      await clearMustChangePassword(workerUsername);
      await resetAccountDefaults(workerUsername);
      await resetAccountPreferences(workerUsername);
    });

    test.beforeEach(async () => {
      await resetRateLimits();
    });

    test.afterAll(async ({ workerUsername }) => {
      await resetAccountPreferences(workerUsername);
    });

    test("EN time-format section", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      // Match the rest of the manual: dark theme.
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("theme", "gray-dark");
        } catch {}
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/profile");

      const section = page.locator('[data-slot="time-format-section"]');
      await expect(section).toBeVisible({ timeout: 10_000 });
      await expect(
        page.locator('[data-slot="time-format-preview"]'),
      ).not.toHaveText("", { timeout: 5_000 });
      await section.screenshot({
        path: path.join(ASSETS_DIR, "preferences-time-format-en.png"),
        animations: "disabled",
      });
    });

    test("KO time-format section", async ({
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
      await page.goto("/ko/profile");

      const section = page.locator('[data-slot="time-format-section"]');
      await expect(section).toBeVisible({ timeout: 10_000 });
      await expect(
        page.locator('[data-slot="time-format-preview"]'),
      ).not.toHaveText("", { timeout: 5_000 });
      await section.screenshot({
        path: path.join(ASSETS_DIR, "preferences-time-format-ko.png"),
        animations: "disabled",
      });
    });
  });
