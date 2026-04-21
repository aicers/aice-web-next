import { expect, test } from "./fixtures";

import {
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

// ── Constants ────────────────────────────────────────────────────

const NOPERM_PASS = "Noperm1234!";

// ── Prefix-derived constants (initialized in beforeAll) ─────────

let NOPERM_USER: string;
let NOPERM_ROLE: string;

// ── Setup / Teardown ─────────────────────────────────────────────

test.beforeAll(async ({ workerUsername, workerPrefix }) => {
  await resetRateLimits();
  const prefix = workerPrefix("e2e-detection-");

  NOPERM_USER = `${prefix}noperm`;
  NOPERM_ROLE = `${prefix}No Detection`;

  await resetAccountDefaults(workerUsername);

  // Role with no detection permissions
  await createTestRole(NOPERM_ROLE, ["accounts:read"]);
  await createTestAccount(NOPERM_USER, NOPERM_PASS, NOPERM_ROLE);
});

test.beforeEach(async ({ workerUsername }) => {
  await resetRateLimits();
  await resetAccountDefaults(workerUsername);
});

test.afterAll(async () => {
  try {
    await deleteTestAccount(NOPERM_USER);
    await deleteTestRole(NOPERM_ROLE);
  } catch {
    // best-effort cleanup
  }
});

// ── Permission gate ──────────────────────────────────────────────

test("detection page redirects for user without detection:read", async ({
  page,
}) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);
  await page.goto("/detection");

  // `requirePermission` redirects to "/" when the permission is missing.
  await page.waitForURL((url) => !url.pathname.includes("/detection"), {
    timeout: 10_000,
  });
});

test("detection page renders shell for admin worker", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  // Filters affordance and region placeholders confirm the shell mounted.
  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  // The drawer lands in a later phase; the placeholder button is disabled.
  await expect(filtersButton).toBeDisabled();
  await expect(
    page.getByText("Detection results will appear here."),
  ).toBeVisible();

  // Rail sections expose accessible names so the collapsed icon-only
  // layout still announces what each icon represents.
  await expect(
    page.getByRole("region", { name: "Recommended Filter" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Saved Filters" }),
  ).toBeVisible();

  // At narrow viewports the rail collapses visually but the accessible
  // names (section + placeholder copy) remain in the a11y tree via sr-only.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(
    page.getByRole("region", { name: "Recommended Filter" }),
  ).toBeAttached();
  await expect(
    page.getByRole("region", { name: "Saved Filters" }),
  ).toBeAttached();
});

// ── Analytics strip collapsed-by-default ─────────────────────────

test("analytics strip starts collapsed and toggles open", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const toggle = page.getByRole("button", { name: /Analytics/i });
  await expect(toggle).toBeVisible({ timeout: 10_000 });

  // Collapsed by default: aria-expanded="false" and panel absent.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#detection-analytics-panel")).toHaveCount(0);

  await toggle.click();

  // After click: aria-expanded="true" and placeholder panel present.
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Analytics will appear here.")).toBeVisible();
});

// ── Localization ─────────────────────────────────────────────────

test("Korean locale: detection shell renders localized placeholders", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWaitKo(page, workerUsername, workerPassword);
  await page.goto("/ko/detection");

  await expect(page.getByRole("button", { name: "필터" })).toBeVisible({
    timeout: 10_000,
  });
});
