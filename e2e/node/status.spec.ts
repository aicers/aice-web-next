import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { resetRateLimits, signIn, signInAndWait } from "../helpers/auth";
import {
  assignCustomerToAccount,
  createTestAccount,
  createTestRole,
  deleteCustomersByPrefix,
  deleteRolesByPrefix,
  deleteTestAccount,
  ensureCustomerExists,
  getAccountId,
} from "../helpers/setup-db";
import { closeAdminAgent, mockServerSession } from "../mock-server-admin";

const NODE_PERMS_FULL = [
  "nodes:read",
  "nodes:write",
  "nodes:delete",
  "services:read",
  "services:write",
  "customers:read",
  "customers:access-all",
];

const NODE_PERMS_READ_ONLY = ["nodes:read", "services:read", "customers:read"];

async function navigateToStatus(page: Page): Promise<void> {
  await page.goto("/nodes");
  // Wait out the streaming Suspense placeholder (matches the
  // pattern used in `e2e/node/list.spec.ts`).
  await page.waitForFunction(() => !document.getElementById("S:0"));
  // Wait for the actual page shell to render. The /nodes route's first
  // dev compile in CI can take longer than the default 5s expect
  // timeout — wait here so per-test assertions have a stable starting
  // point and we don't pay the compile cost in their first check.
  await page
    .getByTestId("node-status-page")
    .or(page.getByTestId("nodes-forbidden"))
    .or(page.getByTestId("manager-unavailable-panel"))
    .waitFor({ timeout: 30_000 });
}

test.describe("Node Status tab", () => {
  const stubSession = mockServerSession();

  let TEST_PREFIX: string;
  let SECMON_USERNAME: string;
  let ADMIN_FULL_USERNAME: string;
  let SECMON_ROLE: string;
  let ADMIN_FULL_ROLE: string;
  const PASSWORD = "TestPass1234!";

  test.beforeAll(async ({ workerPrefix: wp, workerUsername }) => {
    await resetRateLimits();
    TEST_PREFIX = wp("e2e-node-status-");
    SECMON_USERNAME = `${TEST_PREFIX}secmon`;
    ADMIN_FULL_USERNAME = `${TEST_PREFIX}admin-full`;
    SECMON_ROLE = `${TEST_PREFIX}role-secmon`;
    ADMIN_FULL_ROLE = `${TEST_PREFIX}role-admin-full`;

    await deleteTestAccount(SECMON_USERNAME);
    await deleteTestAccount(ADMIN_FULL_USERNAME);
    await deleteRolesByPrefix(`${TEST_PREFIX}role-`);
    await deleteCustomersByPrefix(TEST_PREFIX);

    await createTestRole(SECMON_ROLE, NODE_PERMS_READ_ONLY);
    await createTestRole(ADMIN_FULL_ROLE, NODE_PERMS_FULL);

    await createTestAccount(SECMON_USERNAME, PASSWORD, SECMON_ROLE);
    await createTestAccount(ADMIN_FULL_USERNAME, PASSWORD, ADMIN_FULL_ROLE);

    const customerId = await ensureCustomerExists(`${TEST_PREFIX}customer`);
    for (const username of [
      SECMON_USERNAME,
      ADMIN_FULL_USERNAME,
      workerUsername,
    ]) {
      try {
        const accountId = await getAccountId(username);
        await assignCustomerToAccount(accountId, customerId);
      } catch {
        // already linked or absent
      }
    }
  });

  test.afterAll(async () => {
    await stubSession.clear();
    await closeAdminAgent();
    await deleteTestAccount(SECMON_USERNAME);
    await deleteTestAccount(ADMIN_FULL_USERNAME);
    await deleteRolesByPrefix(`${TEST_PREFIX}role-`);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
  });

  test("renders one row per node and a Manager badge driven by NodeStatus.manager", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);

    // The status route's first dev compile in CI can take longer than
    // the default 5s expect timeout — give the table a longer window
    // so the very first test of the spec doesn't pay the compile cost
    // alone. Subsequent assertions can fall back to the default.
    await expect(page.getByTestId("node-status-table")).toBeVisible({
      timeout: 15_000,
    });
    const rows = page.getByTestId("node-status-row");
    await expect(rows).toHaveCount(3);
    await expect(
      page
        .getByTestId("node-status-row")
        .filter({ hasText: "alpha-node" })
        .getByTestId("node-status-manager-running"),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("node-status-row")
        .filter({ hasText: "beta-node" })
        .getByTestId("node-status-manager-not-running"),
    ).toBeVisible();
  });

  test("Restart opens a confirmation modal", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);

    const alpha = page
      .getByTestId("node-status-row")
      .filter({ hasText: "alpha-node" });
    await alpha.getByTestId("node-status-row-menu").click();
    await page.getByTestId("node-status-restart").click();

    await expect(page.getByTestId("node-restart-confirm")).toBeVisible();
    await expect(page.getByTestId("node-restart-confirm-button")).toBeVisible();
  });

  test("Shutdown opens a confirmation modal", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);

    const alpha = page
      .getByTestId("node-status-row")
      .filter({ hasText: "alpha-node" });
    await alpha.getByTestId("node-status-row-menu").click();
    await page.getByTestId("node-status-shutdown").click();

    await expect(page.getByTestId("node-shutdown-confirm")).toBeVisible();
    await expect(
      page.getByTestId("node-shutdown-confirm-button"),
    ).toBeVisible();
  });

  test("Security Monitor sees the rows but no Restart / Shutdown menu", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await signIn(page, SECMON_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    await navigateToStatus(page);

    await expect(page.getByTestId("node-status-table")).toBeVisible();
    await expect(page.getByTestId("node-status-row-menu")).toHaveCount(0);
  });

  test("clicking a Status row navigates to the node detail page", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // The Status row is the read-only entry point into the
    // detail-page Apply All Pending flow; the row carries an onClick
    // that pushes `/nodes/[id]`. Phase Node-5 owns the full detail
    // dashboard, so this PR ships a thin placeholder route that
    // renders the node identity header — enough that row navigation
    // lands on a real page (not the framework 404) and the
    // `data-testid="node-detail-placeholder"` element is here for
    // Phase Node-5 to replace in-place.
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);

    const alpha = page
      .getByTestId("node-status-row")
      .filter({ hasText: "alpha-node" });
    const alphaId = await alpha.getAttribute("data-row-id");
    expect(alphaId).toBeTruthy();

    // Click outside the kebab menu so the row click handler runs.
    await alpha.getByTestId("node-status-row-link").click();
    await expect(page).toHaveURL(new RegExp(`/nodes/${alphaId}(\\?|/|$)`));
    // Destination is a real route — the placeholder header renders
    // and carries the node id so Phase Node-5 can swap the body.
    await expect(page.getByTestId("node-detail-placeholder")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("node-detail-placeholder")).toHaveAttribute(
      "data-node-id",
      alphaId ?? "",
    );
  });

  test("Restart kebab does not also navigate to /nodes/[id]", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression: the whole row carries an onClick that pushes
    // `/nodes/[id]`. Radix portals the dropdown content out of the
    // row DOM, but React synthetic events still bubble through the
    // owner tree — without explicit stopPropagation, a kebab click on
    // Restart would tear the confirmation modal down mid-render
    // because the route swapped underneath. Verify the modal is
    // visible and the URL is still on /nodes.
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);

    const alpha = page
      .getByTestId("node-status-row")
      .filter({ hasText: "alpha-node" });
    await alpha.getByTestId("node-status-row-menu").click();
    await page.getByTestId("node-status-restart").click();

    await expect(page.getByTestId("node-restart-confirm")).toBeVisible();
    await expect(page).toHaveURL(/\/nodes(\?|$)/);
  });

  test("polling pauses when document.visibilityState === 'hidden'", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);

    // The page surfaces its polling state via `data-polling` for test
    // observability (acceptance criterion).
    await expect(page.getByTestId("node-status-page")).toHaveAttribute(
      "data-polling",
      "true",
    );

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(page.getByTestId("node-status-page")).toHaveAttribute(
      "data-polling",
      "false",
    );
  });

  test("renders an On / Off / Idle service badge for each agent storedStatus variant", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Phase Node-7 (#313) acceptance: drive the mock GraphQL through
    // each `storedStatus` variant and assert the rendered label. The
    // serviceVariants fixture pairs one node per variant (ENABLED, /
    // DISABLED, RELOAD_FAILED, UNKNOWN) plus a dead-node row, so a
    // single navigation covers the full mapping table.
    await stubSession.clear();
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.serviceVariants.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);
    await expect(page.getByTestId("node-status-table")).toBeVisible({
      timeout: 15_000,
    });

    const expectations: Array<{
      hostname: string;
      label: string;
      status: "on" | "off" | "idle";
    }> = [
      { hostname: "agent-on.lan", label: "On", status: "on" },
      { hostname: "agent-off.lan", label: "Off", status: "off" },
      { hostname: "agent-idle.lan", label: "Idle", status: "idle" },
      { hostname: "agent-unknown.lan", label: "Off", status: "off" },
      // Dead-node override: ENABLED on the wire, but `ping === null`
      // forces the cell to Off regardless.
      { hostname: "dead.lan", label: "Off", status: "off" },
    ];

    for (const exp of expectations) {
      const row = page
        .getByTestId("node-status-row")
        .filter({ hasText: exp.hostname });
      const cell = row.getByTestId("node-status-service-sensor");
      await expect(cell).toHaveAttribute("data-status", exp.status);
      await expect(cell).toContainText(exp.label);
    }
  });

  test("cold-load /nodes/[id] renders the service cards from SSR (no Off-with-absent flash, server HTML included)", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression for #313 review rounds 1 & 2: opening a detail URL
    // directly (without first visiting the Status tab) used to render
    // every service card as Off / absent for up to a full polling
    // interval, because the polling driver intentionally defers its
    // first client tick. The detail page now both seeds the shared
    // polling buffer from its own SSR `nodeStatusList` payload AND
    // threads the matching SSR `NodeStatus` into `useServiceStatus`
    // as a first-paint fallback — so the truthful state lands in the
    // server-rendered HTML, not just after hydration runs the seed
    // effect.
    await stubSession.clear();
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.serviceVariants.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);

    // Hit the detail URL through the same authenticated context to
    // capture the server HTML response *before* the browser runs any
    // hydration code. The body must already carry
    // `data-status="on"` for the sensor card — round 2 specifically
    // called out that the previous fix only corrected the post-
    // hydration state. Use `request.get` with manual redirects so we
    // capture the rendered detail page rather than a sign-in bounce.
    const ssr = await page.context().request.get("/nodes/21", {
      maxRedirects: 0,
      headers: { Accept: "text/html" },
    });
    expect(ssr.status()).toBe(200);
    const ssrBody = await ssr.text();
    // Sensor card is the agent-on signal in the serviceVariants
    // fixture; the SSR response must already mark its badge as `on`.
    // The badge has a unique `data-testid` so we can scan for the
    // wrapping tag and read its `data-status` attribute directly,
    // without depending on the surrounding card markup or attribute
    // ordering.
    const tagMatch = ssrBody.match(
      /<[^>]*data-testid="node-detail-service-sensor"[^>]*>/,
    );
    expect(tagMatch).not.toBeNull();
    const statusAttr = tagMatch?.[0].match(/data-status="([^"]+)"/);
    expect(statusAttr?.[1]).toBe("on");

    // Then exercise the rendered page to confirm hydration matches
    // the SSR-rendered state (no client-side flip).
    await page.goto("/nodes/21");
    await page.waitForFunction(() => !document.getElementById("S:0"));

    await expect(page.getByTestId("node-detail-service-cards")).toBeVisible({
      timeout: 30_000,
    });
    const sensorCard = page.getByTestId("node-detail-service-card-sensor");
    await expect(sensorCard).toBeVisible();
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor"),
    ).toHaveAttribute("data-status", "on");
  });

  test("Restart surfaces a transport-level fetch failure as controlError", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression: `performControl()` previously let `fetch()` rejections
    // (browser offline, connection reset, same-origin server restart)
    // escape the click handler as an unhandled promise rejection — the
    // dialog's `controlError` slot only fired on a non-OK HTTP response.
    // The handler now catches transport failures and routes them
    // through the same user-visible error state. We force the failure
    // by aborting the restart POST at the network layer.
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);

    await page.route("**/api/nodes/*/restart", async (route) => {
      await route.abort("failed");
    });

    const alpha = page
      .getByTestId("node-status-row")
      .filter({ hasText: "alpha-node" });
    await alpha.getByTestId("node-status-row-menu").click();
    await page.getByTestId("node-status-restart").click();
    await page.getByTestId("node-restart-confirm-button").click();

    // The dialog stays open and surfaces the localised control-error
    // message; without the catch the rejection escapes silently.
    await expect(page.getByTestId("node-restart-confirm")).toBeVisible();
    await expect(
      page.getByText("The action could not be completed."),
    ).toBeVisible();
  });
});
