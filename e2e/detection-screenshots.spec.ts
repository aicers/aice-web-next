/**
 * Capture the Detection filter-drawer screenshots for the manual.
 *
 * This spec captures the drawer plus the Phase Detection-15 saved-
 * filter dialog and saved-filters rail. All three surfaces are
 * client-rendered (the rail draws from the personal saved-filter
 * table, not REview), so they produce deterministic assets on any
 * machine that can run the e2e suite. The page-level illustration in
 * the manual is an SVG wireframe (`docs/assets/detection-{en,ko}.svg`)
 * because the hero count is sourced from a live query and the
 * authoring worktree has no staging backend with seeded detection
 * data — a PNG taken there would capture the `Could not load
 * detection results.` error state and would get silently re-published
 * on every refresh. Per `docs/AUTHORING.md` the localized wireframe
 * is the correct fallback until staging is available.
 *
 * Run manually with:
 *
 *   pnpm exec playwright test --config=e2e/playwright.config.ts \
 *     e2e/detection-screenshots.spec.ts
 */
import path from "node:path";

import { expect, test } from "./fixtures";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import {
  deleteSavedFiltersForAccount,
  resetAccountDefaults,
} from "./helpers/setup-db";

const VIEWPORT = { width: 1440, height: 900 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "docs", "assets");

test.use({ viewport: VIEWPORT });

// The serial Detection screenshot suite runs six sign-ins back-to-
// back; without resetting between tests the auth rate limiter blocks
// the later locale's sign-in.
test.beforeEach(async () => {
  await resetRateLimits();
});

test.describe
  .serial("Detection manual screenshots", () => {
    test("EN filter drawer", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      const filtersButton = page.getByRole("button", { name: "Filters" });
      await expect(filtersButton).toBeVisible({ timeout: 10_000 });
      await filtersButton.click();
      await expect(
        page.getByRole("heading", { name: "Filters" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Apply", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-drawer-en.png"),
        animations: "disabled",
      });
    });

    test("KO filter drawer", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/detection");

      const filtersButton = page.getByRole("button", { name: "필터" });
      await expect(filtersButton).toBeVisible({ timeout: 10_000 });
      await filtersButton.click();
      await expect(page.getByRole("heading", { name: "필터" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "적용", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-drawer-ko.png"),
        animations: "disabled",
      });
    });

    test("EN save filter dialog", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await resetAccountDefaults(workerUsername);
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      const filtersButton = page.getByRole("button", { name: "Filters" });
      await expect(filtersButton).toBeVisible({ timeout: 10_000 });
      await filtersButton.click();
      const drawer = page.getByRole("dialog");
      await expect(
        drawer.getByRole("heading", { name: "Filters" }),
      ).toBeVisible();
      await drawer.getByRole("button", { name: "Save this filter" }).click();
      // The save dialog reuses the radix Dialog primitive, so a fresh
      // dialog with the Save title takes over once it opens.
      const saveDialog = page.getByRole("dialog").filter({
        has: page.getByRole("heading", { name: "Save this filter" }),
      });
      await expect(saveDialog).toBeVisible();
      await expect(
        saveDialog.getByRole("button", { name: "Save", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-save-filter-dialog-en.png"),
        animations: "disabled",
      });
    });

    test("KO save filter dialog", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await resetAccountDefaults(workerUsername);
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/detection");

      const filtersButton = page.getByRole("button", { name: "필터" });
      await expect(filtersButton).toBeVisible({ timeout: 10_000 });
      await filtersButton.click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("heading", { name: "필터" })).toBeVisible();
      await drawer.getByRole("button", { name: "필터 저장" }).click();
      const saveDialog = page
        .getByRole("dialog")
        .filter({ has: page.getByRole("heading", { name: "이 필터 저장" }) });
      await expect(saveDialog).toBeVisible();
      await expect(
        saveDialog.getByRole("button", { name: "저장", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-save-filter-dialog-ko.png"),
        animations: "disabled",
      });
    });

    test("EN saved filters rail", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await deleteSavedFiltersForAccount(workerUsername);
      await resetAccountDefaults(workerUsername);
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      // Save two filters with different names so the rail renders the
      // populated list (the empty / loading states are illustrated by
      // the surrounding text in the manual).
      await saveOneFilter(page, "Last 1h · Production");
      await saveOneFilter(page, "Last 1d · KR endpoints");

      const rail = page.getByRole("region", { name: "Saved Filters" });
      await expect(rail).toBeVisible();
      // Wait for both rows to render so the screenshot doesn't catch
      // the rail mid-fetch. Use `exact` because each row also exposes
      // a per-row `Saved filter actions for {name}` menu trigger that
      // would otherwise match by substring.
      await expect(
        rail.getByRole("button", {
          name: "Last 1h · Production",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        rail.getByRole("button", {
          name: "Last 1d · KR endpoints",
          exact: true,
        }),
      ).toBeVisible();
      await rail.screenshot({
        path: path.join(ASSETS_DIR, "detection-saved-filters-rail-en.png"),
        animations: "disabled",
      });
    });

    test("KO saved filters rail", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await deleteSavedFiltersForAccount(workerUsername);
      await resetAccountDefaults(workerUsername);
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/detection");

      await saveOneFilterKo(page, "Last 1h · 운영");
      await saveOneFilterKo(page, "Last 1d · 한국 엔드포인트");

      const rail = page.getByRole("region", { name: "저장된 필터" });
      await expect(rail).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "Last 1h · 운영", exact: true }),
      ).toBeVisible();
      await expect(
        rail.getByRole("button", {
          name: "Last 1d · 한국 엔드포인트",
          exact: true,
        }),
      ).toBeVisible();
      await rail.screenshot({
        path: path.join(ASSETS_DIR, "detection-saved-filters-rail-ko.png"),
        animations: "disabled",
      });
    });
  });

async function saveOneFilter(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: "Save this filter" }).click();
  const saveDialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Save this filter" }) });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByLabel("Name", { exact: true }).fill(name);
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveDialog).not.toBeVisible();
  // The drawer also closes when the dialog committed (focus
  // returned to the drawer would otherwise overlap the rail).
  await page.keyboard.press("Escape");
}

async function saveOneFilterKo(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  // Use exact to avoid matching `필터 저장`, `필터 닫기`, or the
  // network advanced-filter trigger that all contain `필터`.
  const filtersButton = page.getByRole("button", {
    name: "필터",
    exact: true,
  });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: "필터 저장" }).click();
  const saveDialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "이 필터 저장" }) });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByLabel("이름", { exact: true }).fill(name);
  await saveDialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(saveDialog).not.toBeVisible();
  await page.keyboard.press("Escape");
}
