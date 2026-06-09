import { expect, test } from "./fixtures";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
} from "./helpers/setup-db";
import { mockServerSession } from "./mock-server-admin";

const NOPERM_PASS = "Noperm1234!";

let NOPERM_USER: string;
let NOPERM_ROLE: string;

const session = mockServerSession("giganto");

test.beforeAll(async ({ workerUsername, workerPrefix }) => {
  await resetRateLimits();
  const prefix = workerPrefix("e2e-event-");

  NOPERM_USER = `${prefix}noperm`;
  NOPERM_ROLE = `${prefix}No Event`;

  await resetAccountDefaults(workerUsername);

  // Role without event:read.
  await createTestRole(NOPERM_ROLE, ["accounts:read"]);
  await createTestAccount(NOPERM_USER, NOPERM_PASS, NOPERM_ROLE);

  // Sensor list (single-sensor selector source).
  await session.registerStub({
    operation: "sensors",
    response: { kind: "fixture", fixture: "external/giganto/sensors.json" },
  });

  // Conn page keyed on the default page size (50) so the SSR search
  // resolves the fixture connection (2 edges, hasNextPage true).
  await session.registerStub({
    operation: "connRawEvents",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "external/giganto/connRawEvents.page1.json",
    },
  });

  // Forward step: Next sends `first/after` with page 1's endCursor.
  // Page 2 reports hasPreviousPage true / hasNextPage false.
  await session.registerStub({
    operation: "connRawEvents",
    matchVariables: { first: 50, after: "Y3Vyc29yOjE=" },
    response: {
      kind: "fixture",
      fixture: "external/giganto/connRawEvents.page2.json",
    },
  });

  // Backward step: Previous sends `last/before` with page 2's
  // startCursor, returning to page 1.
  await session.registerStub({
    operation: "connRawEvents",
    matchVariables: { last: 50, before: "Y3Vyc29yOjI=" },
    response: {
      kind: "fixture",
      fixture: "external/giganto/connRawEvents.page1.json",
    },
  });

  // Statistics view: any statistics query resolves the aggregation
  // fixture (conn + dns across two timestamp buckets).
  await session.registerStub({
    operation: "statistics",
    response: {
      kind: "fixture",
      fixture: "external/giganto/statistics.json",
    },
  });
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
  await session.clear();
});

// ── Permission gate ──────────────────────────────────────────────

test("event page redirects for user without event:read", async ({ page }) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);
  await page.goto("/event");
  await page.waitForURL((url) => !url.pathname.includes("/event"), {
    timeout: 10_000,
  });
});

// ── Render + Conn search + pagination + detail ───────────────────

test("event page renders filter form, Conn search, pagination, detail", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");

  // Filter form mounted.
  await expect(page.getByRole("heading", { name: "Event" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel("Record type")).toBeVisible();

  // Single-sensor selector populated from the sensors query.
  const sensorTrigger = page.locator("#event-sensor");
  await sensorTrigger.click();
  await expect(page.getByRole("option", { name: "sensor-a" })).toBeVisible();
  await expect(page.getByRole("option", { name: "sensor-b" })).toBeVisible();
  await expect(page.getByRole("option", { name: "sensor-c" })).toBeVisible();
  await page.getByRole("option", { name: "sensor-a" }).click();

  // Run the search.
  await page.getByRole("button", { name: "Apply" }).click();

  // Results table: headers + a Conn row (state + service from fixture).
  await expect(page.getByRole("columnheader", { name: "State" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole("columnheader", { name: "Service" }),
  ).toBeVisible();
  await expect(page.getByText("ShDdAaFf")).toBeVisible();
  await expect(page.getByRole("cell", { name: "ssl" })).toBeVisible();

  // Pagination driven off pageInfo: Prev disabled, Next enabled.
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();

  // Next steps forward via `first/after`: page 2 content appears, the
  // cursor lands in the URL, and pageInfo flips Prev on / Next off.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("cell", { name: "http" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("ShDdAaFf")).toBeHidden();
  await expect(page).toHaveURL(/after=Y3Vyc29yOjE%3D/);
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

  // Previous steps backward via `last/before`: page 1 content returns
  // and the backward cursor lands in the URL.
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("ShDdAaFf")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("cell", { name: "http" })).toBeHidden();
  await expect(page).toHaveURL(/before=Y3Vyc29yOjI%3D/);

  // Page-size selector exposes 25 / 50 / 100.
  const pageSizeTrigger = page.getByLabel("Rows per page");
  await expect(pageSizeTrigger).toContainText("50");
  await pageSizeTrigger.click();
  await expect(page.getByRole("option", { name: "25" })).toBeVisible();
  await expect(page.getByRole("option", { name: "50" })).toBeVisible();
  await expect(page.getByRole("option", { name: "100" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Row detail sheet opens with the full record.
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(page.getByText("Connection detail")).toBeVisible();
});

// ── View-mode toggle + Statistics ────────────────────────────────

test("event page switches to Statistics and renders the aggregation chart", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");

  // The view-mode toggle exposes Events | Statistics.
  await expect(page.getByRole("tab", { name: "Events" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("tab", { name: "Statistics" }).click();
  await expect(page).toHaveURL(/view=statistics/);

  // Multi-select sensor control (checkboxes) populated from the sensors
  // query; pick one and apply.
  await page.getByRole("checkbox", { name: "sensor-a" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/sensors=sensor-a/);

  // The recharts chart and the metric selector render for the result.
  await expect(page.getByLabel("Metric")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("svg.recharts-surface")).toBeVisible();
});

// ── Korean locale ────────────────────────────────────────────────

test("event page renders in Korean locale", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/ko/event");
  await expect(page.locator("#event-sensor")).toBeVisible({ timeout: 10_000 });
  // Localized prequery state (no sensor selected yet).
  await expect(
    page.getByText("센서를 선택하고 필터를 적용하여 원본 이벤트를 검색하세요."),
  ).toBeVisible();
});
