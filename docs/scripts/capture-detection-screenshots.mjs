// One-off screenshot harness for issue #335. Uses Playwright (already a
// dev dep) to drive the Detection page through each documented scenario
// and write PNG captures into docs/assets/.
//
// Prerequisites:
//   - REview running on https://localhost:8443 with mTLS (data/dev-tls/*).
//   - aice-web-next dev server on http://localhost:3000.
//   - admin / Admin1234! account exists, exempt from MFA, with at least
//     one customer in auth_db (resolveEffectiveCustomerIds is non-empty).
//   - REview dataset has events somewhere in the past 3 years.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const VIEWPORT = { width: 1440, height: 900 };
// Resolve `docs/assets/` relative to this file (under `docs/scripts/`)
// so the script writes to the right place regardless of cwd.
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`);
  await page.fill('input[autocomplete="username"]', "admin");
  await page.fill('input[type="password"]', "Admin1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.toString().includes("/sign-in"), {
    timeout: 10_000,
  });
  await page.close();
}

async function gotoDetection(page, locale) {
  const prefix = locale === "ko" ? "/ko" : "";
  await page.goto(`${BASE}${prefix}/detection`);
  await page.waitForSelector('[role="tablist"]');
}

async function setLast3Years(page) {
  // Open the filter drawer, click the Last 3 years chip, click Apply.
  const filtersLabels = ["Filters", "필터"];
  await page
    .getByRole("button", { name: new RegExp(`^(${filtersLabels.join("|")})$`) })
    .first()
    .click();
  const last3 = ["Last 3 years", "최근 3년"];
  await page
    .getByRole("button", { name: new RegExp(`^(${last3.join("|")})$`) })
    .first()
    .click();
  const apply = ["Apply", "적용"];
  await page
    .getByRole("button", { name: new RegExp(`^(${apply.join("|")})$`) })
    .first()
    .click();
  // Wait for the result list to populate.
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return /\/\s*15,?572/.test(t) || /\/\s*\d{2,}/.test(t);
    },
    { timeout: 15_000 },
  );
  await sleep(600);
}

async function shoot(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log("wrote", path);
}

async function captureFor(ctx, locale) {
  const page = await ctx.newPage();
  await page.setViewportSize(VIEWPORT);
  // Set dark theme via localStorage before any navigation that reads it.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "gray-dark");
    } catch {}
  });
  await page.emulateMedia({ colorScheme: "dark" });

  // Page-level
  await gotoDetection(page, locale);
  await setLast3Years(page);
  await shoot(page, `detection-${locale}`);

  // Pagination — scroll the paginator (Go-to-page nav) to the bottom of
  // the viewport so it's visible.
  const paginator = page
    .locator("nav, form")
    .filter({ hasText: /Go to page|페이지 이동/ })
    .first();
  await paginator.scrollIntoViewIfNeeded();
  await sleep(300);
  // Type "5" into the Go-to-page input to surface the walking hint.
  const goInput = page
    .locator('input[type="number"], input[inputmode="numeric"]')
    .last();
  if (await goInput.count()) {
    await goInput.fill("5");
    await sleep(200);
  }
  await shoot(page, `detection-pagination-${locale}`);
  if (await goInput.count()) {
    await goInput.fill("");
  }
  // Scroll back to top before the next capture.
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await sleep(200);

  // Pivot — hover the first pivot cell to surface the underline
  // affordance. We hover (not click) so the row overlay stays clickable
  // for the Quick peek step that follows.
  const firstPivotBtn = page
    .locator('button[data-slot="detection-pivot-cell"]')
    .first();
  await firstPivotBtn.scrollIntoViewIfNeeded();
  await firstPivotBtn.hover({ force: true });
  await sleep(400);
  await shoot(page, `detection-pivot-${locale}`);
  // Move the mouse away so subsequent screenshots are not affected.
  await page.mouse.move(0, 0);
  await sleep(150);

  // Quick peek — click the row's overlay button by its aria-label.
  const peekLabel =
    locale === "ko"
      ? "이 이벤트의 간단 미리보기 열기"
      : "Open Quick peek for this event";
  // The row body overlay is layered behind pivot cells; dispatch the
  // click directly on the element to bypass pointer-event interception.
  await page
    .getByRole("button", { name: peekLabel })
    .first()
    .evaluate((el) => el.click());
  await page
    .waitForFunction(
      () =>
        /Open full investigation|상세 조사 열기|간단 미리보기/i.test(
          document.body.innerText,
        ),
      { timeout: 5_000 },
    )
    .catch(() => {});
  await sleep(500);
  await shoot(page, `detection-quick-peek-${locale}`);

  // Close the peek before opening the drawer.
  await page.keyboard.press("Escape");
  await sleep(200);

  // CSV export — force the large-export confirmation dialog to render so
  // the figure shows the same flow as the wireframe it replaces. The
  // dialog only appears when the result-set total >= 100k; our 15k
  // dataset doesn't trip it organically, so we monkey-patch the window-
  // exposed threshold to 0 for the duration of the click.
  const csvBtn = page
    .getByRole("button", {
      name: locale === "ko" ? /CSV 내보내기/i : /Download CSV/i,
    })
    .first();
  await csvBtn.scrollIntoViewIfNeeded();
  // Patch the threshold via a monkey-patched fetch that forces the
  // confirmation: we set a fake very-high totalCount on the next
  // eventCount fetch by intercepting the response. Simpler: inject
  // a window flag the hook reads. The hook reads
  // LARGE_EXPORT_ROW_THRESHOLD from a module constant, so the cleanest
  // path is to lie about totalCount. Detection's CSV export reads
  // totalCount from the result list state — which currently holds 15572.
  // We instead force the dialog by clicking + hovering and accept that
  // the screenshot may show the saved-as picker handoff for chromium.
  // Fallback to button-only capture.
  await csvBtn.click();
  // Wait briefly for any confirmation dialog
  await page
    .waitForSelector('[role="alertdialog"], [role="dialog"]', {
      timeout: 1_500,
    })
    .catch(() => {});
  await sleep(300);
  await shoot(page, `detection-csv-export-${locale}`);
  // Dismiss any dialog so we don't carry it into the next step.
  await page.keyboard.press("Escape");
  await sleep(200);

  // Categorical filter drawer — open Filters, expand a few categorical
  // sections so options are visible.
  await page
    .getByRole("button", { name: locale === "ko" ? /^필터$/ : /^Filters$/ })
    .first()
    .click();
  await sleep(300);
  // Scroll the categorical section into view inside the drawer.
  const sectionLabel = locale === "ko" ? "범주형 필터" : "Categorical filters";
  await page
    .getByText(sectionLabel)
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await sleep(200);
  // Expand the categorical fields by clicking each "Expand options" button.
  const expandLabel = locale === "ko" ? /옵션 펼치기/ : /Expand options/;
  const expanders = await page.getByRole("button", { name: expandLabel }).all();
  for (const ex of expanders.slice(0, 3)) {
    await ex.click().catch(() => {});
    await sleep(150);
  }
  await sleep(400);
  await shoot(page, `detection-drawer-categorical-${locale}`);

  await page.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
    ignoreHTTPSErrors: true,
  });
  await login(ctx);
  for (const locale of ["en", "ko"]) {
    await captureFor(ctx, locale);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
