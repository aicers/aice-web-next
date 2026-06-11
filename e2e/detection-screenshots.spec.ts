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
import { closeAdminAgent, mockServerSession } from "./mock-server-admin";

const VIEWPORT = { width: 1440, height: 900 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "docs", "assets");

test.use({ viewport: VIEWPORT });

// Screenshot capture is opt-in. In a normal `pnpm e2e` run these tests are
// skipped and the file-scope hooks below short-circuit, so no `eventList`
// stub is registered against the shared mock-server registry. Run with
// `CAPTURE_SCREENSHOTS=1` (or via `DETECTION_MANUAL_CAPTURE_ONLY=1`, which
// the manual-capture project mode sets) to capture the assets locally.
const SHOULD_CAPTURE =
  process.env.CAPTURE_SCREENSHOTS === "1" ||
  process.env.DETECTION_MANUAL_CAPTURE_ONLY === "1";

// Per-spec scope so the empty-bootstrap stub registered below is
// removed in `afterAll` without touching other specs' state.
const session = mockServerSession();

test.beforeAll(async () => {
  if (!SHOULD_CAPTURE) return;
  // The Detection page bootstrap dispatches `eventList` with the
  // default page size (50). Since #405 Round 2 the bootstrap re-
  // throws unrecognised review GraphQL `errors[]` payloads as
  // `ReviewUnknownGraphQLError` (including the mock server's
  // "no stub registered" message), so the page tree crashes
  // before the drawer can render. Pin an empty fixture to
  // `first: 50` so the captures below render the shell at rest.
  await session.registerStub({
    operation: "eventList",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "detection/eventList.empty.json",
    },
  });
});

test.afterAll(async () => {
  if (!SHOULD_CAPTURE) return;
  await session.clear();
  await closeAdminAgent();
});

// The serial Detection screenshot suite runs six sign-ins back-to-
// back; without resetting between tests the auth rate limiter blocks
// the later locale's sign-in.
test.beforeEach(async () => {
  if (!SHOULD_CAPTURE) return;
  await resetRateLimits();
});

async function forceDarkTheme(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "gray-dark");
    } catch {}
  });
  await page.emulateMedia({ colorScheme: "dark" });
}

test.describe
  .serial("Detection manual screenshots", () => {
    test.skip(
      !SHOULD_CAPTURE,
      "Manual screenshot capture — set CAPTURE_SCREENSHOTS=1 to run.",
    );

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

    // Issue #428: the Saved + Recommended sections moved from the
    // always-visible left rail into an on-demand Presets dropdown.
    // The captures below open that dropdown so the manual can show
    // the populated three-section layout (Recommended / Saved /
    // Save-current) operators see when they trigger it.
    test("EN presets dropdown", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await forceDarkTheme(page);
      await deleteSavedFiltersForAccount(workerUsername);
      await resetAccountDefaults(workerUsername);
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/detection");

      // Save two filters so the Saved section renders a populated
      // list rather than the muted-empty placeholder.
      await saveOneFilter(page, "Last 1h · Production");
      await saveOneFilter(page, "Last 1d · KR endpoints");

      const presetsTrigger = page.getByRole("button", {
        name: "Presets",
        exact: true,
      });
      await expect(presetsTrigger).toBeVisible({ timeout: 10_000 });
      await presetsTrigger.click();

      // Wait for the populated rows so the screenshot doesn't catch
      // the dropdown mid-fetch. The recommended group is static
      // client-side, the saved group resolves once the rename/save
      // round-trips above have committed.
      await expect(
        page.getByRole("menuitem", { name: "3 years", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", {
          name: "Last 1h · Production",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: /Save current filter/ }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-presets-dropdown-en.png"),
        animations: "disabled",
      });
    });

    test("KO presets dropdown", async ({
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

      const presetsTrigger = page.getByRole("button", {
        name: "프리셋",
        exact: true,
      });
      await expect(presetsTrigger).toBeVisible({ timeout: 10_000 });
      await presetsTrigger.click();

      await expect(
        page.getByRole("menuitem", { name: "최근 3년", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Last 1h · 운영", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: /현재 필터 저장/ }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "detection-presets-dropdown-ko.png"),
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
