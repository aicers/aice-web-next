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
import { mockServerSession } from "./mock-server-admin";

const NOPERM_PASS = "Noperm1234!";

let NOPERM_USER: string;
let NOPERM_ROLE: string;

const session = mockServerSession();

test.beforeAll(async ({ workerUsername, workerPrefix }) => {
  await resetRateLimits();
  const prefix = workerPrefix("e2e-triage-");

  NOPERM_USER = `${prefix}noperm`;
  NOPERM_ROLE = `${prefix}No Triage`;

  await resetAccountDefaults(workerUsername);

  await createTestRole(NOPERM_ROLE, ["accounts:read"]);
  await createTestAccount(NOPERM_USER, NOPERM_PASS, NOPERM_ROLE);

  // The Triage page bootstraps an `eventList` round-trip; without a
  // matching stub the mock server returns a "no stub registered"
  // GraphQL error and the page renders the error banner instead of
  // the funnel + asset list shell. Register an empty list so the
  // happy-path assertions below land on the rendered shell.
  await session.registerStub({
    operation: "eventList",
    response: {
      kind: "fixture",
      fixture: "detection/eventList.empty.json",
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

test("triage page redirects for user without triage:read", async ({ page }) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);
  await page.goto("/triage");

  // `requirePermission` redirects to "/" when the permission is missing.
  await page.waitForURL((url) => !url.pathname.includes("/triage"), {
    timeout: 10_000,
  });
});

test("triage page renders shell affordances for an authorized user", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/triage");

  await expect(
    page.getByRole("heading", { level: 1, name: "Triage" }),
  ).toBeVisible({ timeout: 10_000 });

  // Period picker — start/end inputs and an Apply button.
  await expect(page.getByLabel("Start", { exact: true })).toBeVisible();
  await expect(page.getByLabel("End", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeEnabled();

  // Mode toggle — Baseline is the active tab; "With my policies" is
  // present but disabled (the deprecatable seam from #447 §6).
  const baselineTab = page.getByRole("tab", { name: "Baseline" });
  const policiesTab = page.getByRole("tab", { name: "With my policies" });
  await expect(baselineTab).toHaveAttribute("aria-selected", "true");
  await expect(policiesTab).toBeDisabled();

  // Funnel section renders with all three labels.
  const funnel = page.getByRole("region", { name: "Funnel" });
  await expect(funnel).toBeVisible();
  await expect(funnel.getByText("Detected", { exact: true })).toBeVisible();
  await expect(funnel.getByText("Triaged", { exact: true })).toBeVisible();
  await expect(funnel.getByText("Pass-through", { exact: true })).toBeVisible();

  // Empty asset list renders the empty-state copy from the labels.
  await expect(
    page.getByText("No assets matched the baseline rule in this period."),
  ).toBeVisible();
});

test("Korean locale: triage shell renders localized title", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWaitKo(page, workerUsername, workerPassword);
  await page.goto("/ko/triage");

  await expect(
    page.getByRole("heading", { level: 1, name: "선별" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("tab", { name: "기준" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "내 정책 적용" })).toBeDisabled();
});
