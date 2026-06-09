import { expect, test } from "./fixtures";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";
import { mockServerSession } from "./mock-server-admin";

// The id selector is backed by REview's `samplingPolicyList` (manager
// SDL, dispatched via `graphqlRequest`), while the series itself comes
// from Giganto's `periodicTimeSeries` (giganto SDL, `gigantoClient`).
// Each backend needs its own scoped session.
const review = mockServerSession("review");
const giganto = mockServerSession("giganto");

test.beforeAll(async () => {
  await resetRateLimits();

  // Sampling-policy list (the `id` selector source) — two policies.
  await review.registerStub({
    operation: "samplingPolicyList",
    matchVariables: { first: 100 },
    response: {
      kind: "fixture",
      fixture: "review/sampling-policy-list.json",
    },
  });

  // Periodic series keyed on the selected policy id. With no time window
  // set the dispatched filter is exactly `{ id }`, so the two ids resolve
  // to distinct fixtures: policy-1 → a populated series, policy-2 → an
  // empty connection (the guarded path).
  await giganto.registerStub({
    operation: "periodicTimeSeries",
    matchVariables: { filter: { id: "policy-1" } },
    response: {
      kind: "fixture",
      fixture: "external/giganto/periodic-time-series.json",
    },
  });
  await giganto.registerStub({
    operation: "periodicTimeSeries",
    matchVariables: { filter: { id: "policy-2" } },
    response: {
      kind: "fixture",
      fixture: "external/giganto/periodic-time-series.empty.json",
    },
  });
});

test.beforeEach(async ({ workerUsername }) => {
  await resetRateLimits();
  await resetAccountDefaults(workerUsername);
});

test.afterAll(async () => {
  await review.clear();
  await giganto.clear();
});

// ── Toggle exposes Time Series + ?view= persistence ──────────────

test("toggle exposes Time Series and the view persists across reload", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");

  // Flat three-way toggle: Events | Statistics | Time Series.
  await expect(page.getByRole("tab", { name: "Events" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("tab", { name: "Statistics" })).toBeVisible();
  const timeSeriesTab = page.getByRole("tab", { name: "Time Series" });
  await expect(timeSeriesTab).toBeVisible();

  // Selecting Time Series pins ?view=timeseries.
  await timeSeriesTab.click();
  await expect(page).toHaveURL(/view=timeseries/);

  // The pre-query prompt renders before an id is picked.
  await expect(
    page.getByText(
      "Select a sampling policy and apply filters to view its periodic time series.",
    ),
  ).toBeVisible({ timeout: 10_000 });

  // Reload (the "share/reload" case): the view survives because it lives
  // in the URL, not client state.
  await page.reload();
  await expect(page).toHaveURL(/view=timeseries/);
  await expect(
    page.getByRole("tab", { name: "Time Series", selected: true }),
  ).toBeVisible({ timeout: 10_000 });
});

// ── samplingPolicyList-backed id selector renders the series ─────

test("selecting a sampling policy renders the periodic series", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event?view=timeseries");

  // The id selector is populated from samplingPolicyList (not a free-form
  // input): the two fixture policy names appear as options.
  const policyTrigger = page.locator("#ts-policy");
  await expect(policyTrigger).toBeVisible({ timeout: 10_000 });
  await policyTrigger.click();
  await expect(
    page.getByRole("option", { name: "Hourly conn rollup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Daily DNS rollup" }),
  ).toBeVisible();
  await page.getByRole("option", { name: "Hourly conn rollup" }).click();

  // Apply: the selected policy id lands in the URL and the recharts
  // surface renders for the fixture series.
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/tsId=policy-1/);
  await expect(page.getByRole("application")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Series origin:/)).toBeVisible();
});

// ── Empty/null result is guarded ─────────────────────────────────

test("an empty periodicTimeSeries result falls back to the empty state", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  // policy-2 resolves to the empty-connection fixture, so the series
  // fetch returns zero nodes — the view must guard it and not crash.
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event?view=timeseries&tsId=policy-2");

  // The chart is absent; the empty-state message renders instead.
  await expect(
    page.getByText("No time series data matches the current filters."),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("application")).toHaveCount(0);
});

// ── Korean locale ────────────────────────────────────────────────

test("time series view renders in the Korean locale", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/ko/event?view=timeseries");

  // Localized tab + pre-query prompt.
  await expect(page.getByRole("tab", { name: "시계열" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByText(
      "샘플링 정책을 선택하고 필터를 적용하여 주기 시계열을 확인하세요.",
    ),
  ).toBeVisible();

  // The selector is still populated from samplingPolicyList in KO.
  await page.locator("#ts-policy").click();
  await expect(
    page.getByRole("option", { name: "Hourly conn rollup" }),
  ).toBeVisible();
});
