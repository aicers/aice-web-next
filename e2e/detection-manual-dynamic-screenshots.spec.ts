import path from "node:path";

import { encodeEventLocator } from "@/lib/events/event-locator";

import { expect, test } from "./fixtures";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import { ensureCustomerExists } from "./helpers/setup-db";
import { mockServerSession } from "./mock-server-admin";

const VIEWPORT = { width: 1440, height: 900 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "docs", "assets");
const session = mockServerSession();

const INVESTIGATION_EVENT = {
  __typename: "HttpThreat",
  time: "2026-04-22T12:00:00+00:00",
  sensor: "sensor-east-1",
  level: "HIGH",
  origAddr: "10.0.0.5",
  origPort: 51344,
  respAddr: "203.0.113.45",
  respPort: 443,
  proto: 6,
} as const;

const INVESTIGATION_TOKEN = encodeEventLocator(INVESTIGATION_EVENT);

if (!INVESTIGATION_TOKEN) {
  throw new Error("Failed to build event investigation token for screenshots");
}

test.use({ viewport: VIEWPORT });

test.beforeAll(async () => {
  await ensureCustomerExists("Default", "default_db");
  await session.registerStub({
    operation: "eventList",
    response: {
      kind: "fixture",
      fixture: "detection/eventList.manual-page.json",
    },
  });
  await session.registerStub({
    operation: "eventList",
    matchVariables: {
      filter: {
        start: INVESTIGATION_EVENT.time,
        end: INVESTIGATION_EVENT.time,
        source: INVESTIGATION_EVENT.origAddr,
        destination: INVESTIGATION_EVENT.respAddr,
        kinds: [INVESTIGATION_EVENT.__typename],
        levels: [3],
      },
    },
    response: {
      kind: "fixture",
      fixture: "detection/eventList.manual-detail.json",
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
    matchVariables: { address: INVESTIGATION_EVENT.origAddr },
    response: {
      kind: "fixture",
      fixture: "detection/ipLocation.orig.manual.json",
    },
  });
  await session.registerStub({
    operation: "ipLocation",
    matchVariables: { address: INVESTIGATION_EVENT.respAddr },
    response: {
      kind: "fixture",
      fixture: "detection/ipLocation.resp.manual.json",
    },
  });
});

test.afterAll(async () => {
  await session.clear();
});

test.beforeEach(async ({ page }) => {
  await resetRateLimits();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "gray-dark");
    } catch {}
  });
  await page.emulateMedia({ colorScheme: "dark" });
});

test.describe
  .serial("Detection + Event Investigation dynamic manual screenshots", () => {
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
      ? `/ko/events/${INVESTIGATION_TOKEN}`
      : `/events/${INVESTIGATION_TOKEN}`;
  await page.goto(
    `${basePath}?returnTo=${encodeURIComponent(locale === "ko" ? "/ko/detection" : "/detection")}`,
  );
  await expect(
    page.getByRole("heading", { name: "HTTP Threat" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(ASSETS_DIR, `event-investigation-${locale}.png`),
    animations: "disabled",
  });

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
