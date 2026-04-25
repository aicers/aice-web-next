// One-off screenshot harness for issue #285 (Top N + Time Series
// analytics strip). Logs in, expands the analytics strip on the
// Detection page, and writes EN/KO captures into docs/assets/.
//
// Prerequisites — same as capture-detection-screenshots.mjs:
//   - REview running on https://localhost:8443 with mTLS (data/dev-tls/*).
//   - aice-web-next dev server on http://localhost:3000.
//   - admin / Admin1234! account exists, exempt from MFA, with at least
//     one customer in auth_db.
//   - REview dataset has events somewhere in the past 3 years.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const VIEWPORT = { width: 1440, height: 900 };
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

async function setLast3Years(page, locale) {
  const filtersLabel = locale === "ko" ? /^필터$/ : /^Filters$/;
  await page.getByRole("button", { name: filtersLabel }).first().click();
  const last3 = locale === "ko" ? /^최근 3년$/ : /^Last 3 years$/;
  await page.getByRole("button", { name: last3 }).first().click();
  const apply = locale === "ko" ? /^적용$/ : /^Apply$/;
  await page.getByRole("button", { name: apply }).first().click();
  // Wait for the result list to populate (broad regex — the dataset
  // size varies by snapshot but always renders a `n / total` count).
  await page.waitForFunction(
    () => /\/\s*\d{2,}/.test(document.body.innerText),
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
  await page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "gray-dark");
    } catch {}
  });
  await page.emulateMedia({ colorScheme: "dark" });

  await gotoDetection(page, locale);
  await setLast3Years(page, locale);

  // Expand the analytics strip via its toggle button. The button's
  // accessible name is the localized strip title.
  const toggleLabel =
    locale === "ko" ? /Top N · 시계열/ : /Top N & Time Series/;
  const toggle = page.getByRole("button", { name: toggleLabel }).first();
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  // Wait for both halves to populate. The Top N rows render as
  // `<button>` elements when pivoting is wired, and the time-series
  // SVG carries an aria-label with the localized "events" suffix.
  await page.waitForFunction(
    () => {
      const body = document.body.innerText;
      // "events" / "이벤트" is in the count suffix template that the
      // bar tooltip and time-series aria-label both use.
      return /events|이벤트/.test(body);
    },
    { timeout: 15_000 },
  );
  // Give the SVG a moment to settle and any animation to finish.
  await sleep(800);

  // Scroll so the analytics strip's panel fills the visible viewport —
  // it sits below the result list, so without scrolling the capture
  // would show only the result list. We scroll to the strip's panel
  // (the expanded body) and align it to the bottom of the viewport so
  // both halves of the panel are visible.
  const panel = page.locator("#detection-analytics-panel");
  await panel.scrollIntoViewIfNeeded();
  // The strip's container is the toggle + panel together; scroll the
  // toggle so the entire strip with its title bar is in view.
  await page.evaluate(() => {
    const panel = document.getElementById("detection-analytics-panel");
    if (!panel) return;
    const container = panel.parentElement; // wrapper carrying border
    if (!container) return;
    container.scrollIntoView({ block: "end", inline: "nearest" });
  });
  await sleep(300);
  await shoot(page, `detection-analytics-${locale}`);

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
