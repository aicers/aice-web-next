import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { encodeEventLocator } from "@/lib/events/event-locator";

import { expect, test } from "./fixtures";
import {
  clearAimerSigningKey,
  ensureAimerSigningKey,
} from "./helpers/aimer-signing-key";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import {
  clearAimerSetting,
  ensureCustomerExists,
  setAimerSetting,
  setCustomerExternalKey,
} from "./helpers/setup-db";
import { mockServerSession } from "./mock-server-admin";

const VIEWPORT = { width: 1440, height: 900 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "docs", "assets");
const session = mockServerSession();

const INVESTIGATION_EVENT_ID = "evt-manual-dynamic-1";
const INVESTIGATION_EVENT_ORIG_ADDR = "10.0.0.5";
const INVESTIGATION_EVENT_RESP_ADDR = "203.0.113.45";

const INVESTIGATION_TOKEN = encodeEventLocator({ id: INVESTIGATION_EVENT_ID });

if (!INVESTIGATION_TOKEN) {
  throw new Error("Failed to build event investigation token for screenshots");
}

test.use({ viewport: VIEWPORT });

// Screenshot capture is opt-in. In a normal `pnpm e2e` run these tests are
// skipped and the file-scope hooks below short-circuit, so no catch-all
// REview stubs are registered and the on-disk fixture is not rewritten —
// neither can leak into sibling specs. Run with `CAPTURE_SCREENSHOTS=1`
// (or via `DETECTION_MANUAL_CAPTURE_ONLY=1`) to capture the assets locally.
const SHOULD_CAPTURE =
  process.env.CAPTURE_SCREENSHOTS === "1" ||
  process.env.DETECTION_MANUAL_CAPTURE_ONLY === "1";

const FIXTURES_ROOT = path.resolve(
  __dirname,
  "..",
  "src",
  "__tests__",
  "fixtures",
);
// The Aimer-modal capture path needs `event.manual-detail.json`'s
// `origCustomer.id` to line up with the actual seeded customer row's
// id (the auth_db `customers_id_seq` advances across runs, so the
// hardcoded `"1"` no longer matches `getCustomerBridgeEligibility`).
// We rewrite the fixture in `beforeAll` and restore the original
// content in `afterAll`; stub registration goes through the
// manifest-coverage check so a side-by-side dynamic fixture file is
// not an option.
const EVENT_FIXTURE_SOURCE = "detection/event.manual-detail.json";
let eventFixtureOriginal: string | null = null;

test.beforeAll(async () => {
  if (!SHOULD_CAPTURE) return;
  const customerId = await ensureCustomerExists("Default", "default_db");
  // Send to Aimer button is only enabled when the customer carries an
  // `external_key` and the Aimer integration is fully configured. Seed
  // all three SSR-side dependencies so the Overview tab renders the
  // banner in its happy-path state for the modal captures below.
  await setCustomerExternalKey("Default", "aimer-default-ext-key");
  await setAimerSetting("aice_id", "default.aice.example.test");
  await setAimerSetting(
    "clumit_insight_bridge_url",
    "https://aimer.example.test/bridge",
  );
  await setAimerSetting("clumit_insight_default_model_name", "default-model");
  await setAimerSetting(
    "clumit_insight_default_model",
    "default-model-version",
  );
  await ensureAimerSigningKey();

  const fixturePath = path.join(FIXTURES_ROOT, EVENT_FIXTURE_SOURCE);
  eventFixtureOriginal = readFileSync(fixturePath, "utf8");
  const patched = JSON.parse(eventFixtureOriginal) as {
    event: { origCustomer: { id: string; name: string } | null };
  };
  if (patched.event.origCustomer) {
    patched.event.origCustomer.id = String(customerId);
  }
  writeFileSync(fixturePath, `${JSON.stringify(patched, null, 2)}\n`, "utf8");
  await session.registerStub({
    operation: "eventList",
    response: {
      kind: "fixture",
      fixture: "detection/eventList.manual-page.json",
    },
  });
  await session.registerStub({
    operation: "event",
    matchVariables: { id: INVESTIGATION_EVENT_ID },
    response: {
      kind: "fixture",
      fixture: EVENT_FIXTURE_SOURCE,
    },
  });
  await session.registerStub({
    operation: "eventCountsByOriginatorIpAddress",
    response: {
      kind: "fixture",
      fixture: "detection/eventCountsByOriginatorIpAddress.manual.json",
    },
  });
  await session.registerStub({
    operation: "eventFrequencySeries",
    response: {
      kind: "fixture",
      fixture: "detection/eventFrequencySeries.manual.json",
    },
  });
  await session.registerStub({
    operation: "ipLocation",
    matchVariables: { address: INVESTIGATION_EVENT_ORIG_ADDR },
    response: {
      kind: "fixture",
      fixture: "detection/ipLocation.orig.manual.json",
    },
  });
  await session.registerStub({
    operation: "ipLocation",
    matchVariables: { address: INVESTIGATION_EVENT_RESP_ADDR },
    response: {
      kind: "fixture",
      fixture: "detection/ipLocation.resp.manual.json",
    },
  });
});

test.afterAll(async () => {
  if (!SHOULD_CAPTURE) return;
  await session.clear();
  await setCustomerExternalKey("Default", null);
  await clearAimerSetting("aice_id");
  await clearAimerSetting("clumit_insight_bridge_url");
  await clearAimerSetting("clumit_insight_default_model_name");
  await clearAimerSetting("clumit_insight_default_model");
  clearAimerSigningKey();
  if (eventFixtureOriginal !== null) {
    writeFileSync(
      path.join(FIXTURES_ROOT, EVENT_FIXTURE_SOURCE),
      eventFixtureOriginal,
      "utf8",
    );
    eventFixtureOriginal = null;
  }
});

test.beforeEach(async ({ page }) => {
  if (!SHOULD_CAPTURE) return;
  await resetRateLimits();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "gray-dark");
    } catch {}
  });
  // Hide the Next.js dev-tools indicator (the bottom-left "N Issues"
  // badge). It is dev-server-only chrome that never appears in the
  // production UI the manual documents, but `pnpm dev` surfaces it for
  // any hydration warning — e.g. the event header's `formatDateTime`
  // renders the browser-locale time, a pre-existing client/server
  // mismatch unrelated to these captures. Suppress it so the asset
  // shows only real product UI.
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement("style");
      style.setAttribute("data-screenshot-hide-dev-overlay", "");
      style.textContent = "nextjs-portal{display:none !important}";
      (document.head ?? document.documentElement).appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide, { once: true });
  });
  await page.emulateMedia({ colorScheme: "dark" });
});

test.describe
  .serial("Detection + Event Investigation dynamic manual screenshots", () => {
    test.skip(
      !SHOULD_CAPTURE,
      "Manual screenshot capture — set CAPTURE_SCREENSHOTS=1 to run.",
    );

    test("EN dynamic screenshots", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await captureDetectionSuite(page, "en");
      await captureEventInvestigationSuite(page, "en");
    });

    test("KO dynamic screenshots", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await captureDetectionSuite(page, "ko");
      await captureEventInvestigationSuite(page, "ko");
    });
  });

async function captureDetectionSuite(
  page: import("@playwright/test").Page,
  locale: "en" | "ko",
) {
  const detectionPath = locale === "ko" ? "/ko/detection" : "/detection";
  await page.goto(detectionPath);
  await waitForDetectionList(page, locale);

  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-${locale}.png`),
    animations: "disabled",
  });

  const paginator = page
    .locator("nav, form")
    .filter({
      hasText: locale === "ko" ? /페이지 이동/ : /Go to page/,
    })
    .first();
  await paginator.scrollIntoViewIfNeeded();
  const pageInput = paginator
    .locator('input[inputmode="numeric"], input[pattern="[0-9]*"]')
    .first();
  await pageInput.fill("5");
  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-pagination-${locale}.png`),
    animations: "disabled",
  });
  await pageInput.fill("");
  await page.evaluate(() => window.scrollTo({ top: 0 }));

  const pivotPrefix =
    locale === "ko" ? "사용자 이름:" : "Filter results by User name";
  const pivotTarget = page.locator(
    `button[data-slot="detection-pivot-cell"][aria-label^="${pivotPrefix}"]`,
  );
  await expect(pivotTarget.first()).toBeVisible();
  await pivotTarget.first().hover({ force: true });
  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-pivot-${locale}.png`),
    animations: "disabled",
  });
  await page.mouse.move(0, 0);

  const quickPeekLabel =
    locale === "ko"
      ? "이 이벤트의 간단 미리보기 열기"
      : "Open Quick peek for this event";
  await page
    .getByRole("button", { name: quickPeekLabel })
    .first()
    .evaluate((el) => (el as HTMLButtonElement).click());
  await expect(
    page.getByRole("link", {
      name: locale === "ko" ? /전체 조사 열기/i : /Open full investigation/i,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-quick-peek-${locale}.png`),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");

  const downloadLabel = locale === "ko" ? /CSV 내보내기/i : /Download CSV/i;
  await page.getByRole("button", { name: downloadLabel }).click();
  await expect(
    page.getByText(
      locale === "ko" ? "대용량 결과 내보내기" : "Export a large result set?",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-csv-export-${locale}.png`),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");

  const analyticsToggle = page.getByRole("button", {
    name: locale === "ko" ? /Top N · 시계열/ : /Top N & Time Series/,
  });
  await analyticsToggle.click();
  await expect(
    page.getByRole("combobox", {
      name: locale === "ko" ? /기준/ : /Dimension/,
    }),
  ).toBeVisible();
  await page
    .locator("#detection-analytics-panel")
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-analytics-${locale}.png`),
    animations: "disabled",
  });
  await page.evaluate(() => window.scrollTo({ top: 0 }));

  await openFilters(page, locale);
  const expanders = page
    .getByRole("button", {
      name: locale === "ko" ? /옵션 펼치기/ : /Expand options/,
    })
    .all();
  for (const expander of (await expanders).slice(0, 3)) {
    await expander.click().catch(() => {});
  }
  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-drawer-categorical-${locale}.png`),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");

  await openFilters(page, locale);
  const endpointButton = page.getByRole("button", {
    name:
      locale === "ko"
        ? "네트워크/IP 고급 필터 열기"
        : "Open advanced Network/IP filter",
  });
  await endpointButton.click();
  const endpointPanelTitle = page.getByText(
    locale === "ko" ? "네트워크/IP 필터" : "Network/IP filter",
    { exact: true },
  );
  await expect(endpointPanelTitle).toBeVisible();
  const endpointInput = page.getByLabel(
    locale === "ko" ? "네트워크 또는 IP 추가" : "Add a network or IP",
  );
  await endpointInput.fill("10.0.0.5");
  await page
    .getByRole("button", { name: locale === "ko" ? "항목 추가" : "Add entry" })
    .click();
  await endpointInput.fill("203.0.113.0/24");
  await page
    .getByRole("button", { name: locale === "ko" ? "항목 추가" : "Add entry" })
    .click();
  await page.screenshot({
    path: path.join(ASSETS_DIR, `detection-endpoint-filter-${locale}.png`),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

async function captureEventInvestigationSuite(
  page: import("@playwright/test").Page,
  locale: "en" | "ko",
) {
  const basePath =
    locale === "ko"
      ? `/ko/detection/events/${INVESTIGATION_TOKEN}`
      : `/detection/events/${INVESTIGATION_TOKEN}`;
  await page.goto(
    `${basePath}?returnTo=${encodeURIComponent(locale === "ko" ? "/ko/detection" : "/detection")}`,
  );
  await expect(
    page.getByRole("heading", { name: "HTTP Threat" }),
  ).toBeVisible();
  // The breadcrumb's rich `{compact time} · {event kind}` label is
  // published by a client effect after hydration. Wait for it so the
  // captured asset shows the meaningful label rather than the static
  // `Event detail` fallback that renders for a frame before the effect.
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toContainText("HTTP Threat");
  await page.screenshot({
    path: path.join(ASSETS_DIR, `event-investigation-${locale}.png`),
    animations: "disabled",
  });

  await captureAimerSendModals(page, locale);

  await page
    .getByRole("tab", { name: locale === "ko" ? "엔드포인트" : "Endpoints" })
    .click();
  await expect(
    page.getByRole("region", {
      name: locale === "ko" ? "엔드포인트 지도" : "Endpoint map",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(
      ASSETS_DIR,
      `event-investigation-endpoints-map-${locale}.png`,
    ),
    animations: "disabled",
  });
}

/**
 * Capture the Analyze-with-Aimer pre-send confirmation modal. The
 * surface is a deterministic client-rendered dialog, so it can be
 * captured without speaking to a live aimer-web (AUTHORING.md's
 * "captures whose shape is fully determined by client-side state"
 * carve-out applies).
 *
 * The post-confirm screen is intentionally NOT captured: the
 * analyze-bridge flow opens the result on aimer-web in a new tab, so
 * there is no aice-web-next-side post-send disclosure to screenshot.
 */
async function captureAimerSendModals(
  page: import("@playwright/test").Page,
  locale: "en" | "ko",
): Promise<void> {
  const sendButton = page.getByTestId("aimer-send-button");
  await expect(sendButton).toBeEnabled({ timeout: 10_000 });
  await sendButton.scrollIntoViewIfNeeded();
  await sendButton.click();

  const confirmButton = page.getByTestId("aimer-modal-send");
  await expect(confirmButton).toBeVisible();
  await page.screenshot({
    path: path.join(ASSETS_DIR, `aimer-send-modal-${locale}.png`),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(confirmButton).toBeHidden();
}

async function waitForDetectionList(
  page: import("@playwright/test").Page,
  locale: "en" | "ko",
) {
  await expect(
    page.getByRole("button", {
      name: locale === "ko" ? "필터" : "Filters",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("mail.example.test")).toBeVisible();
}

async function openFilters(
  page: import("@playwright/test").Page,
  locale: "en" | "ko",
) {
  await page
    .getByRole("button", {
      name: locale === "ko" ? "필터" : "Filters",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: locale === "ko" ? "필터" : "Filters" }),
  ).toBeVisible();
}
