/**
 * Capture the Detection filter-drawer screenshots for the manual.
 *
 * This spec deliberately captures only the drawer — the drawer is
 * client-rendered and does not depend on the REview backend, so it
 * produces a deterministic asset on any machine that can run the
 * e2e suite. The page-level illustration in the manual is an SVG
 * wireframe (`docs/assets/detection-{en,ko}.svg`) because the hero
 * count is sourced from a live query and the authoring worktree has
 * no staging backend with seeded detection data — a PNG taken here
 * would capture the `Could not load detection results.` error state
 * and would get silently re-published on every refresh. Per
 * `docs/AUTHORING.md` the localized wireframe is the correct fallback
 * until staging is available.
 *
 * Run manually with:
 *
 *   pnpm exec playwright test --config=e2e/playwright.config.ts \
 *     e2e/detection-screenshots.spec.ts
 */
import path from "node:path";

import { expect, test } from "./fixtures";
import { signInAndWait, signInAndWaitKo } from "./helpers/auth";

const VIEWPORT = { width: 1440, height: 900 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "docs", "assets");

test.use({ viewport: VIEWPORT });

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
  });
