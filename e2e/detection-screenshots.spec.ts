/**
 * Capture the deterministic Detection manual screenshots.
 *
 * This spec covers the client-rendered surfaces: the filter drawer,
 * customer multi-select, save-filter dialog, and both left-rail
 * sections. The list / analytics / quick-peek / Event Investigation
 * captures now live in `e2e/detection-manual-dynamic-screenshots.spec.ts`,
 * which stubs REview-backed responses so the page-level PNGs can be
 * reproduced without a live staging backend.
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
  ensureCustomerExists,
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

function forceDarkTheme(page: import("@playwright/test").Page): Promise<void> {
  page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "gray-dark");
    } catch {}
  });
  return page.emulateMedia({ colorScheme: "dark" });
}

async function captureRailFigure(
  page: import("@playwright/test").Page,
  rail: import("@playwright/test").Locator,
  fileName: string,
): Promise<void> {
  const box = await rail.boundingBox();
  if (!box) {
    throw new Error(`Unable to capture rail screenshot for ${fileName}`);
  }

  const padding = 16;
  await page.screenshot({
    path: path.join(ASSETS_DIR, fileName),
    animations: "disabled",
    clip: {
      x: Math.max(0, box.x - padding),
      y: Math.max(0, box.y - padding),
      width: box.width + padding * 2,
      height: box.height + padding * 2,
    },
  });
}

test.describe
  .serial("Detection manual screenshots", () => {
    test("EN filter drawer", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      const filtersButton = page.getByRole("button", {
        name: "Filters",
        exact: true,
      });
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
      await forceDarkTheme(page);
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/detection");

      const filtersButton = page.getByRole("button", {
        name: "필터",
        exact: true,
      });
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

    // Customer multi-select drawer (#384). The control opens to reveal
    // a search box, "Select all" toggle, and a checkbox list of the
    // customers `getEffectiveCustomerScope(session)` returns. The
    // worker account holds the System Administrator role and so resolves
    // to every registered customer; we seed two so the panel renders a
    // populated list rather than the disabled empty-scope affordance.
    test("EN customer drawer", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
      await ensureCustomerExists("Acme Inc.", "acme_inc_db");
      await ensureCustomerExists("Globex", "globex_db");
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      const filtersButton = page.getByRole("button", {
        name: "Filters",
        exact: true,
      });
      await expect(filtersButton).toBeVisible({ timeout: 10_000 });
      await filtersButton.click();
      const drawer = page.getByRole("dialog");
      await expect(
        drawer.getByRole("heading", { name: "Filters" }),
      ).toBeVisible();

      // Wait for the customer fetch to settle into the `ready` state
      // before interacting; while the request is in flight the trigger
      // renders the disabled "Loading customers…" variant, and the
      // ready-state replacement detaches that node mid-test otherwise.
      const customerTrigger = drawer.getByRole("button", {
        name: "Select customers",
      });
      await expect(customerTrigger).toBeVisible({ timeout: 10_000 });
      await customerTrigger.scrollIntoViewIfNeeded();
      await customerTrigger.click();
      await expect(
        drawer.getByRole("checkbox", { name: /Acme Inc\./ }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-drawer-customer-en.png"),
        animations: "disabled",
      });
    });

    test("KO customer drawer", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
      await ensureCustomerExists("Acme Inc.", "acme_inc_db");
      await ensureCustomerExists("Globex", "globex_db");
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/detection");

      const filtersButton = page.getByRole("button", {
        name: "필터",
        exact: true,
      });
      await expect(filtersButton).toBeVisible({ timeout: 10_000 });
      await filtersButton.click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("heading", { name: "필터" })).toBeVisible();

      const customerTrigger = drawer.getByRole("button", {
        name: "고객사 선택",
      });
      await expect(customerTrigger).toBeVisible({ timeout: 10_000 });
      await customerTrigger.scrollIntoViewIfNeeded();
      await customerTrigger.click();
      await expect(
        drawer.getByRole("checkbox", { name: /Acme Inc\./ }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-drawer-customer-ko.png"),
        animations: "disabled",
      });
    });

    test("EN save filter dialog", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
      await resetAccountDefaults(workerUsername);
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      const filtersButton = page.getByRole("button", {
        name: "Filters",
        exact: true,
      });
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
      await forceDarkTheme(page);
      await resetAccountDefaults(workerUsername);
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/detection");

      const filtersButton = page.getByRole("button", {
        name: "필터",
        exact: true,
      });
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
      await forceDarkTheme(page);
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
      await captureRailFigure(
        page,
        rail,
        "detection-saved-filters-rail-en.png",
      );
    });

    test("KO saved filters rail", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
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
      await captureRailFigure(
        page,
        rail,
        "detection-saved-filters-rail-ko.png",
      );
    });

    // The Recommended Filter rail is fully client-side: presets are
    // declared in `src/lib/detection/recommended-filters.ts` and never
    // hit the database, so this capture is deterministic on any
    // signed-in account regardless of REview state.
    test("EN recommended filters rail", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      const rail = page.getByRole("region", { name: "Recommended Filter" });
      await expect(rail).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "3 years", exact: true }),
      ).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "1 year, Inbound", exact: true }),
      ).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "1 year", exact: true }),
      ).toBeVisible();
      await captureRailFigure(
        page,
        rail,
        "detection-recommended-filters-rail-en.png",
      );
    });

    test("KO recommended filters rail", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/detection");

      const rail = page.getByRole("region", { name: "추천 필터" });
      await expect(rail).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "최근 3년", exact: true }),
      ).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "최근 1년, 인바운드", exact: true }),
      ).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "최근 1년", exact: true }),
      ).toBeVisible();
      await captureRailFigure(
        page,
        rail,
        "detection-recommended-filters-rail-ko.png",
      );
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
