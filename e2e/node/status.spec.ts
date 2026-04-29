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
    // that pushes `/nodes/[id]`. Phase Node-5a (#376) ships the real
    // detail page that supersedes the earlier placeholder, so this
    // assertion targets the `node-detail-page` testid that the new
    // route exposes.
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
    // Destination is a real route — the detail page renders and
    // carries the node id on its root container.
    await expect(page.getByTestId("node-detail-page")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("node-detail-page")).toHaveAttribute(
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

    // Round-3 dead-node-override regression: the dead.lan fixture only
    // enumerates a SENSOR agent and no external services, so the
    // previous behaviour left the other five service cells as
    // placeholder em-dashes. The override now collapses every one of
    // the six agent / external cells to Off — matching the issue
    // contract that a non-responding node cannot be trusted to
    // enumerate its own services.
    const deadRow = page
      .getByTestId("node-status-row")
      .filter({ hasText: "dead.lan" });
    for (const kind of [
      "sensor",
      "unsupervised",
      "semiSupervised",
      "timeSeries",
      "dataStore",
      "tiContainer",
    ]) {
      const cell = deadRow.getByTestId(`node-status-service-${kind}`);
      await expect(cell).toHaveAttribute("data-status", "off");
      await expect(cell).toContainText("Off");
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
    // Phase Node-5a's detail page server-fetches the canonical Node
    // payload via `getNode` before rendering — without a NodeDetail
    // stub the SSR returns 500. The agentEnabled fixture carries id
    // "21" with a SENSOR agent matching the serviceVariants fixture
    // above.
    await stubSession.registerStub({
      operation: "node",
      matchVariables: { id: "21" },
      response: {
        kind: "fixture",
        fixture: "node/nodeDetail.agentEnabled.json",
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

    await expect(page.getByTestId("node-detail-service-grid")).toBeVisible({
      timeout: 30_000,
    });
    const sensorCard = page.getByTestId("node-detail-service-card-sensor");
    await expect(sensorCard).toBeVisible();
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor"),
    ).toHaveAttribute("data-status", "on");
  });

  test("cold-load /nodes Status table renders truthful service cells in the SSR HTML (no absent flash)", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression for #313 review round 6 #1: opening `/nodes`
    // directly used to server-render every configured service column
    // as the `absent` em-dash placeholder, even though the page already
    // fetches the SSR `nodeStatusList` payload. The fix threads the
    // matching SSR `NodeStatus` from `initialEdges` into the per-row
    // `useServiceStatus(...)` so the truthful badge lands in the
    // server-rendered HTML itself — same first-paint truthfulness
    // pattern the detail page already carries.
    await stubSession.clear();
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.serviceVariants.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);

    // Capture the server HTML response *before* any hydration runs.
    // Without the fix, the server body for `/nodes` only carries
    // `node-status-service-sensor` as the absent-placeholder span (no
    // `data-status` attribute), and the agent-on row's `On` badge does
    // not appear until hydration runs the seed effect.
    const ssr = await page.context().request.get("/nodes", {
      maxRedirects: 0,
      headers: { Accept: "text/html" },
    });
    expect(ssr.status()).toBe(200);
    const ssrBody = await ssr.text();

    // The serviceVariants fixture maps row 21 → ENABLED (`on`), row 22
    // → DISABLED, row 23 → RELOAD_FAILED (`idle`), row 24 → UNKNOWN
    // (`off`), row 25 → dead-node override (`off`). Only the row-21
    // sensor cell is `on`, so a presence check on `data-status="on"`
    // for any `node-status-service-sensor` element in the SSR body is
    // a unique signal that the agent-on row painted its badge during
    // SSR rather than after hydration.
    const sensorCellMatches = ssrBody.matchAll(
      /<[^>]*data-testid="node-status-service-sensor"[^>]*>/g,
    );
    const sensorStatuses = Array.from(sensorCellMatches, (match) => {
      const statusAttr = match[0].match(/data-status="([^"]+)"/);
      return statusAttr?.[1] ?? "absent";
    });
    expect(sensorStatuses).toContain("on");
    // Also assert at least one cell is `idle` so the test catches a
    // regression that paints `On` everywhere via a stale snapshot
    // instead of from the per-row SSR payload.
    expect(sensorStatuses).toContain("idle");

    // Then exercise the rendered page to confirm hydration matches the
    // SSR-rendered state (no client-side flip from On → off → on).
    await page.goto("/nodes");
    await page.waitForFunction(() => !document.getElementById("S:0"));
    await expect(page.getByTestId("node-status-table")).toBeVisible({
      timeout: 15_000,
    });
    const onRow = page
      .getByTestId("node-status-row")
      .filter({ hasText: "agent-on.lan" });
    await expect(
      onRow.getByTestId("node-status-service-sensor"),
    ).toHaveAttribute("data-status", "on");
  });

  test("intra-segment navigation preserves the external-probe snapshot (no stale-Off flash)", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Round-4 review #1 (#313): the external Giganto / Tivan probe
    // store used to be driven by the page-level `useExternalServiceProbes`
    // call inside `NodeStatusTable` / `NodeDetailServiceCards`. React
    // runs page cleanup BEFORE the next page mounts on intra-segment
    // navigation, so a Status-row click → `/nodes/[id]` bounced
    // `probeDriverCount` through 0 and the last-unmount cleanup wiped
    // both probes back to `unknown`. Because `mapExternalStatus("unknown")`
    // renders `off`, the detail page first-painted Giganto / Tivan as
    // `Off` even when the row had just shown them `On`.
    //
    // The probe driver now lives in `nodes/(gate)/(probe)/layout.tsx`
    // — a sub-route group shared by the Status tab (`/nodes`) and the
    // detail page (`/nodes/[id]`) but not `/nodes/settings`. Status ↔
    // Detail navigation preserves that layout, so the probe snapshot
    // survives. Verify by forcing Giganto to `on` via the BFF probe
    // route, waiting for the Status row to register `on`, navigating
    // to the detail page, and asserting the dataStore card is still
    // `on` immediately — without waiting for the probe loop to re-fire
    // on the new page.
    //
    // Use the `populated` fixture (alpha-node enumerates a DATA_STORE
    // external service); the `serviceVariants` fixture intentionally
    // omits external services to focus on agent storedStatus rows.
    await page.route(
      "**/api/services/external/giganto/status",
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ok: true }),
        });
      },
    );
    await page.route("**/api/services/external/tivan/status", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true }),
      });
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToStatus(page);
    await expect(page.getByTestId("node-status-table")).toBeVisible({
      timeout: 15_000,
    });

    // Wait for the dataStore probe to land `on` on the alpha-node row.
    // The `populated` fixture's alpha-node row carries the DATA_STORE
    // external service, so its cell is a real badge once the probe
    // replies.
    const onRow = page
      .getByTestId("node-status-row")
      .filter({ hasText: "alpha-node" });
    await expect(
      onRow.getByTestId("node-status-service-dataStore"),
    ).toHaveAttribute("data-status", "on", { timeout: 30_000 });

    const rowId = await onRow.getAttribute("data-row-id");
    expect(rowId).toBeTruthy();

    // Click into the detail page. Without the segment-scoped driver,
    // the navigation would tear the probe store down to `unknown` and
    // the dataStore card would first-paint as `off` until the next
    // probe boundary lands. With the fix, the snapshot survives and
    // the card paints `on` right away.
    await onRow.getByTestId("node-status-row-link").click();
    await expect(page).toHaveURL(new RegExp(`/nodes/${rowId}(\\?|/|$)`));

    const dataStoreCard = page.getByTestId(
      "node-detail-service-card-dataStore",
    );
    await expect(dataStoreCard).toBeVisible({ timeout: 30_000 });
    await expect(
      dataStoreCard.getByTestId("node-detail-service-dataStore"),
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
