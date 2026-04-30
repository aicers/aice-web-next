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

const NODE_PERMS_MISSING_SERVICES = ["nodes:read", "customers:read"];

// Mixed-permission write contract callers (issue #310 Round 6): the
// dialog is a write surface for both node metadata (`nodes:write`) and
// service drafts (`services:write`). A caller holding only one of the
// two must see the list (read scopes pass) but never reach the dialog —
// the Add button is hidden and `?dialog=edit&id=…` rejects with HTTP
// 403. Two role shapes pin both halves of the partial-write surface.
const NODE_PERMS_NODES_WRITE_ONLY = [
  "nodes:read",
  "services:read",
  "customers:read",
  "nodes:write",
];
const NODE_PERMS_SERVICES_WRITE_ONLY = [
  "nodes:read",
  "services:read",
  "customers:read",
  "services:write",
];

// Tenant Administrator parity: full node CRUD inside the assigned
// customer scope, but no `customers:access-all`. The Settings list
// must hide the customer (tenant) filter dropdown for this caller.
const NODE_PERMS_TENANT_ADMIN = [
  "nodes:read",
  "nodes:write",
  "nodes:delete",
  "services:read",
  "services:write",
  "customers:read",
];

async function navigateToList(page: Page): Promise<void> {
  await page.goto("/nodes/settings");
  // The page is wrapped in a React Suspense boundary (its sibling
  // `loading.tsx` defines the fallback). Streamed RSC content lives
  // inside `<div hidden id="S:0">` until the inline `$RC(...)` bootstrap
  // moves it into the visible tree, and during that window every
  // `data-testid` resolves to two elements — the streaming clone trips
  // Playwright's strict-mode locator check on the first assertion.
  // Wait for the placeholder to be removed before asserting on rendered
  // content so each test sees a stable single-rendered DOM.
  await page.waitForFunction(() => !document.getElementById("S:0"));
}

test.describe("Node settings list page", () => {
  const stubSession = mockServerSession();

  let TEST_PREFIX: string;
  let SECMON_USERNAME: string;
  let MISSING_SERVICES_USERNAME: string;
  let TENANT_ADMIN_USERNAME: string;
  let SECMON_ROLE: string;
  let MISSING_SERVICES_ROLE: string;
  let TENANT_ADMIN_ROLE: string;
  let ADMIN_FULL_ROLE: string;
  let ADMIN_FULL_USERNAME: string;
  let NODES_WRITE_ONLY_USERNAME: string;
  let NODES_WRITE_ONLY_ROLE: string;
  let SERVICES_WRITE_ONLY_USERNAME: string;
  let SERVICES_WRITE_ONLY_ROLE: string;
  const PASSWORD = "TestPass1234!";

  test.beforeAll(async ({ workerPrefix: wp, workerUsername }) => {
    await resetRateLimits();
    TEST_PREFIX = wp("e2e-node-");
    SECMON_USERNAME = `${TEST_PREFIX}secmon`;
    MISSING_SERVICES_USERNAME = `${TEST_PREFIX}missing-services`;
    TENANT_ADMIN_USERNAME = `${TEST_PREFIX}tenant-admin`;
    ADMIN_FULL_USERNAME = `${TEST_PREFIX}admin-full`;
    NODES_WRITE_ONLY_USERNAME = `${TEST_PREFIX}nodes-write-only`;
    SERVICES_WRITE_ONLY_USERNAME = `${TEST_PREFIX}services-write-only`;
    SECMON_ROLE = `${TEST_PREFIX}role-secmon`;
    MISSING_SERVICES_ROLE = `${TEST_PREFIX}role-missing-services`;
    TENANT_ADMIN_ROLE = `${TEST_PREFIX}role-tenant-admin`;
    ADMIN_FULL_ROLE = `${TEST_PREFIX}role-admin-full`;
    NODES_WRITE_ONLY_ROLE = `${TEST_PREFIX}role-nodes-write-only`;
    SERVICES_WRITE_ONLY_ROLE = `${TEST_PREFIX}role-services-write-only`;

    await deleteTestAccount(SECMON_USERNAME);
    await deleteTestAccount(MISSING_SERVICES_USERNAME);
    await deleteTestAccount(TENANT_ADMIN_USERNAME);
    await deleteTestAccount(ADMIN_FULL_USERNAME);
    await deleteTestAccount(NODES_WRITE_ONLY_USERNAME);
    await deleteTestAccount(SERVICES_WRITE_ONLY_USERNAME);
    await deleteRolesByPrefix(`${TEST_PREFIX}role-`);
    await deleteCustomersByPrefix(TEST_PREFIX);

    await createTestRole(SECMON_ROLE, NODE_PERMS_READ_ONLY);
    await createTestRole(MISSING_SERVICES_ROLE, NODE_PERMS_MISSING_SERVICES);
    await createTestRole(TENANT_ADMIN_ROLE, NODE_PERMS_TENANT_ADMIN);
    await createTestRole(ADMIN_FULL_ROLE, NODE_PERMS_FULL);
    await createTestRole(NODES_WRITE_ONLY_ROLE, NODE_PERMS_NODES_WRITE_ONLY);
    await createTestRole(
      SERVICES_WRITE_ONLY_ROLE,
      NODE_PERMS_SERVICES_WRITE_ONLY,
    );

    await createTestAccount(SECMON_USERNAME, PASSWORD, SECMON_ROLE);
    await createTestAccount(
      MISSING_SERVICES_USERNAME,
      PASSWORD,
      MISSING_SERVICES_ROLE,
    );
    await createTestAccount(TENANT_ADMIN_USERNAME, PASSWORD, TENANT_ADMIN_ROLE);
    await createTestAccount(ADMIN_FULL_USERNAME, PASSWORD, ADMIN_FULL_ROLE);
    await createTestAccount(
      NODES_WRITE_ONLY_USERNAME,
      PASSWORD,
      NODES_WRITE_ONLY_ROLE,
    );
    await createTestAccount(
      SERVICES_WRITE_ONLY_USERNAME,
      PASSWORD,
      SERVICES_WRITE_ONLY_ROLE,
    );

    // Assign every test account a customer so dispatch context is non-empty.
    const customerId = await ensureCustomerExists(`${TEST_PREFIX}customer`);
    for (const username of [
      SECMON_USERNAME,
      MISSING_SERVICES_USERNAME,
      TENANT_ADMIN_USERNAME,
      ADMIN_FULL_USERNAME,
      NODES_WRITE_ONLY_USERNAME,
      SERVICES_WRITE_ONLY_USERNAME,
      workerUsername,
    ]) {
      try {
        const accountId = await getAccountId(username);
        await assignCustomerToAccount(accountId, customerId);
      } catch {
        // Worker account already linked or absent — fine.
      }
    }
  });

  test.afterAll(async () => {
    await stubSession.clear();
    await closeAdminAgent();
    await deleteTestAccount(SECMON_USERNAME);
    await deleteTestAccount(MISSING_SERVICES_USERNAME);
    await deleteTestAccount(TENANT_ADMIN_USERNAME);
    await deleteTestAccount(ADMIN_FULL_USERNAME);
    await deleteTestAccount(NODES_WRITE_ONLY_USERNAME);
    await deleteTestAccount(SERVICES_WRITE_ONLY_USERNAME);
    await deleteRolesByPrefix(`${TEST_PREFIX}role-`);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  test.beforeEach(async () => {
    await resetRateLimits();
  });

  test("renders nodes from mock data", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    await expect(page.getByTestId("nodes-table")).toBeVisible();
    const rows = page.getByTestId("nodes-row");
    await expect(rows).toHaveCount(3);
    await expect(page.getByText("alpha-node")).toBeVisible();
    await expect(page.getByText("beta-node-renamed")).toBeVisible();
    await expect(page.getByText("gamma-node")).toBeVisible();
  });

  test("rows with pending changes get the badge", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    const betaRow = page
      .getByTestId("nodes-row")
      .filter({ hasText: "beta-node-renamed" });
    await expect(betaRow).toBeVisible();
    await expect(betaRow).toHaveAttribute("data-pending", "true");
    await expect(
      betaRow.getByTestId("nodes-row-pending-badge").first(),
    ).toBeVisible();
  });

  test("search filters results", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    await page.getByTestId("nodes-search").fill("gamma");
    await expect(page.getByTestId("nodes-row")).toHaveCount(1);
    await expect(page.getByText("gamma-node")).toBeVisible();
  });

  test("Manager column renders running / not-running with no pending badge", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    const alpha = page
      .getByTestId("nodes-row")
      .filter({ hasText: "alpha-node" });
    await expect(alpha.getByTestId("nodes-manager-running")).toBeVisible();

    const beta = page
      .getByTestId("nodes-row")
      .filter({ hasText: "beta-node-renamed" });
    await expect(beta.getByTestId("nodes-manager-not-running")).toBeVisible();

    // Manager cell never shows the row-level pending badge nested inside it.
    await expect(
      beta.locator('[data-testid="nodes-row-pending-badge"]').last(),
    ).toBeVisible();
    const managerCell = beta.locator("td").nth(11);
    await expect(
      managerCell.getByTestId("nodes-row-pending-badge"),
    ).toHaveCount(0);
  });

  test("manager-offline shows panel instead of 403 or empty table", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Use `connectionFailure` (socket hang-up) rather than `errors`. The
    // page only renders the offline panel for `ManagerUnavailableError`,
    // which is raised by `withManagerErrorMapping` on transport-level
    // failures. A 200 with `errors[]` would surface as a `ClientError`
    // and is intentionally allowed to propagate so unrelated query
    // failures are not silently masked as "manager offline".
    await stubSession.registerStub({
      operation: "nodeList",
      response: { kind: "connectionFailure" },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: { kind: "connectionFailure" },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    await expect(page.getByTestId("manager-unavailable-panel")).toBeVisible();
  });

  test("Security Monitor sees no write affordances (Add / row checkboxes / row menu)", async ({
    page,
  }) => {
    // The acceptance criterion requires Security Monitor to see no Add /
    // Edit / Delete affordances. The bulk-select column is the first step
    // of the bulk-delete flow, so read-only viewers must not see it
    // either — otherwise they can pick rows that produce no floating bar.
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await page.goto("/sign-in");
    await signIn(page, SECMON_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    await navigateToList(page);
    await expect(page.getByTestId("nodes-table")).toBeVisible();
    await expect(page.getByTestId("nodes-add-button")).toHaveCount(0);
    // Bulk-select column (header + per-row checkboxes) is hidden, so the
    // floating bulk-delete bar can never surface for a read-only viewer.
    await expect(page.getByTestId("nodes-select-all")).toHaveCount(0);
    await expect(page.getByTestId("nodes-row-checkbox")).toHaveCount(0);
    // Per-row kebab (the Edit / Delete entry point) is hidden because
    // both `onEdit` and `onDelete` resolve to `null` for this caller.
    await expect(page.getByTestId("nodes-row-menu")).toHaveCount(0);
  });

  test("Tenant Admin only sees their customer's nodes and no tenant filter dropdown", async ({
    page,
  }) => {
    // Tenant Admin holds full node CRUD but no `customers:access-all`.
    // The mock returns a tenant-1-scoped node payload (alpha + beta)
    // with no customer-2 row. We assert two things:
    //   1. the list does NOT include a cross-tenant row (gamma-node);
    //   2. the System-Admin-only "Customer" filter dropdown is absent.
    // (1) verifies that when review-web filters out cross-tenant nodes
    // the page renders the filtered set; (2) is the visible UI signal
    // for the role downgrade.
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.tenant1.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.tenant1.json",
      },
    });

    await page.goto("/sign-in");
    await signIn(page, TENANT_ADMIN_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    await navigateToList(page);

    await expect(page.getByTestId("nodes-table")).toBeVisible();
    // Tenant-scoped rows are present.
    await expect(
      page.getByTestId("nodes-row").filter({ hasText: "alpha-node" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("nodes-row").filter({ hasText: "beta-node-renamed" }),
    ).toBeVisible();
    // Cross-tenant row must not surface.
    await expect(
      page.getByTestId("nodes-row").filter({ hasText: "gamma-node" }),
    ).toHaveCount(0);
    await expect(page.getByText("gamma-node")).toHaveCount(0);
    // Tenant Admin retains write affordances within their scope.
    await expect(page.getByTestId("nodes-add-button")).toBeVisible();
    // System-Admin-only tenant filter must not appear. Use an exact
    // match on the dropdown's `aria-label="Customer"` so the assertion
    // does not also catch the customer scope indicator (whose aria-label
    // happens to contain the substring "customer").
    await expect(page.getByLabel("Customer", { exact: true })).toHaveCount(0);
  });

  test("row-menu Edit/Delete do not also navigate to /nodes/[id]", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression: the whole row carries an `onClick` that pushes
    // `/nodes/[id]`. Radix portals the dropdown content out of the row
    // DOM, but React synthetic events still bubble through the React
    // owner tree, so without explicit stopPropagation a kebab click on
    // Edit or Delete would also trigger the row navigation. That would
    // overwrite the edit query-param push and tear down the delete
    // confirmation modal mid-render. This test verifies neither happens.
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    const alpha = page
      .getByTestId("nodes-row")
      .filter({ hasText: "alpha-node" });
    await expect(alpha).toBeVisible();

    // Click kebab → Delete and assert the confirm modal is visible and
    // the URL stayed on /nodes/settings (no row-nav side effect).
    await alpha.getByTestId("nodes-row-menu").click();
    await page.getByTestId("nodes-row-delete").click();
    await expect(page.getByText("Delete node")).toBeVisible();
    await expect(page).toHaveURL(/\/nodes\/settings(\?|$)/);
    // Close the modal and reopen the menu for the Edit assertion.
    await page.keyboard.press("Escape");
    await expect(page.getByText("Delete node")).toHaveCount(0);

    await alpha.getByTestId("nodes-row-menu").click();
    await page.getByText("Edit", { exact: true }).click();
    // Edit pushes a query param under /nodes/settings; the row click
    // would have replaced this with /nodes/<id>. Verify the query-param
    // navigation survived.
    await expect(page).toHaveURL(/\/nodes\/settings\?dialog=edit&id=/);
  });

  test("missing services:read produces a 403", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page, MISSING_SERVICES_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    const response = await page.goto("/nodes/settings");
    // The `(gate)` route-group layout calls `forbidden()` so the URL
    // stays put, the sibling `nodes/forbidden.tsx` renders, and the
    // response carries status 403 (issue acceptance). The gate is a
    // child of `/nodes` (so the throw is caught by the localised
    // boundary) and sits above every loading.tsx (so the throw lands
    // before any Suspense fallback streams and the headers can lock
    // at 200).
    expect(response?.status()).toBe(403);
    await expect(page).toHaveURL(/\/nodes\/settings/);
    await expect(page.getByTestId("nodes-forbidden")).toBeVisible();
  });

  test("nodes:write only — Add hidden, ?dialog=edit URL returns 403", async ({
    page,
  }) => {
    // Round 6 reviewer's missing coverage: a partial-write caller (one
    // of `nodes:write` / `services:write`) must clear the read gate and
    // see the list, but the dialog must remain unreachable. Verify both
    // halves of the contract end-to-end:
    //   1. the Add button affordance is hidden (issue acceptance);
    //   2. a direct `?dialog=edit&id=…` navigation returns HTTP 403.
    // The unit tests on `src/app/api/nodes/route.ts` already cover the
    // POST/PATCH side; this test is the page-level path the issue
    // explicitly assigns to Phase Node-4.
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await page.goto("/sign-in");
    await signIn(page, NODES_WRITE_ONLY_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    await navigateToList(page);

    await expect(page.getByTestId("nodes-table")).toBeVisible();
    // Add affordance must be absent — `canCreate = canWriteNodes &&
    // canWriteServices` evaluates to false here.
    await expect(page.getByTestId("nodes-add-button")).toHaveCount(0);

    // Direct edit URL: page calls `forbidden()` before fetching the
    // node, so the response carries 403 and `nodes/forbidden.tsx`
    // renders.
    const response = await page.goto("/nodes/settings?dialog=edit&id=11");
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId("nodes-forbidden")).toBeVisible();
  });

  test("services:write only — Add hidden, ?dialog=edit URL returns 403", async ({
    page,
  }) => {
    // Inverse partial-write shape: `services:write` granted but
    // `nodes:write` missing. Same expectation — Add hidden, edit URL
    // 403. Pinning both halves of the partial-write surface protects
    // against a future regression where the gate is implemented as an
    // OR instead of an AND on the two scopes.
    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await page.goto("/sign-in");
    await signIn(page, SERVICES_WRITE_ONLY_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    await navigateToList(page);

    await expect(page.getByTestId("nodes-table")).toBeVisible();
    await expect(page.getByTestId("nodes-add-button")).toHaveCount(0);

    const response = await page.goto("/nodes/settings?dialog=edit&id=11");
    expect(response?.status()).toBe(403);
    await expect(page.getByTestId("nodes-forbidden")).toBeVisible();
  });

  test("alive/dead facet picks up live polling: a dead node moves to alive without reload", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Acceptance criterion: the Settings list `alive` / `dead` facets
    // switch from the initial one-shot ping snapshot to live polling
    // data once Phase Node-6's hook is running. Verified by rendering
    // the list with a stale `dead` node, swapping the mock to bring
    // the node back up, advancing past one polling interval, and
    // asserting the node moves out of the `dead` filter without a
    // full reload. The hook exposes the live snapshot through the
    // module-level store the table re-projects, so the row's facet
    // membership flips as soon as the next polled sample lands.
    test.setTimeout(60_000);

    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    // Initial snapshot: beta-node is dead (ping null, manager false).
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    const betaRow = page
      .getByTestId("nodes-row")
      .filter({ hasText: "beta-node-renamed" });
    await expect(betaRow).toBeVisible();

    // Engage the Dead facet. With the populated stub in force, beta is
    // the only dead node and survives the filter.
    await page.getByRole("button", { name: "Dead" }).click();
    await expect(betaRow).toBeVisible();

    // Swap the stub so the next polled sample reports beta as alive
    // (ping non-null, manager true). Catch-all stubs resolve
    // last-registered-wins, so this overrides the populated catch-all
    // for any subsequent `nodeStatusList` request.
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.alive.json",
      },
    });

    // Polling cadence in dev defaults to NEXT_PUBLIC_NODE_STATUS_POLL_MS
    // (10s). Once the next interval tick fires, the polling hook re-
    // projects beta over the row, the row carries `ping !== null`, and
    // the Dead filter no longer matches. We assert the absence rather
    // than a reload — Playwright's polling expect waits up to 20s for
    // the row to disappear from the filtered set.
    await expect(betaRow).toHaveCount(0, { timeout: 20_000 });

    // Switching to the Alive facet should now surface beta — proof
    // that the row carries the new sample, not just that the dead
    // filter no longer matches.
    await page.getByRole("button", { name: "Dead" }).click();
    await page.getByRole("button", { name: "Alive" }).click();
    await expect(betaRow).toBeVisible();
  });

  test("alive/dead facet picks up live polling: a node pruned from the manager leaves the alive facet", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Companion to the dead→alive test above. The previous case proved
    // the polling path replaces seeded SSR ping/manager values for rows
    // that are still present in the live snapshot. This test pins the
    // missing-row case the SSR fallback used to mask: when the manager
    // prunes a node from `nodeStatusList`, the Settings list must drop
    // it from the Alive facet (and not silently keep it pinned to the
    // SSR-seeded values) once the polling snapshot is authoritative.
    test.setTimeout(60_000);

    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    // Initial snapshot: alpha + beta + gamma all reported. Alpha and
    // gamma are alive; beta is dead.
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    const alphaRow = page
      .getByTestId("nodes-row")
      .filter({ hasText: "alpha-node" });
    const gammaRow = page
      .getByTestId("nodes-row")
      .filter({ hasText: "gamma-node" });
    await expect(alphaRow).toBeVisible();
    await expect(gammaRow).toBeVisible();

    // With the populated snapshot in force, the Alive facet keeps both
    // alpha and gamma.
    await page.getByRole("button", { name: "Alive" }).click();
    await expect(alphaRow).toBeVisible();
    await expect(gammaRow).toBeVisible();

    // Swap the stub so the next polled sample only includes alpha.
    // The manager has effectively pruned beta and gamma from the
    // status list (e.g. they failed to report in this window). Once
    // the polling snapshot is authoritative, gamma must leave the
    // Alive facet — its `ping !== null` was seeded by the SSR snapshot
    // and is no longer current.
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.alphaOnly.json",
      },
    });

    // After the next polling tick (default 10s cadence), gamma should
    // disappear from the Alive filter. Polls under Playwright's expect
    // wait up to 20s.
    await expect(gammaRow).toHaveCount(0, { timeout: 20_000 });
    // Alpha is still in the live snapshot, so it remains in Alive.
    await expect(alphaRow).toBeVisible();

    // Cross-check: gamma is also not in Dead — a missing live row
    // projects to "no current status" (`hasStatus: false`,
    // `ping: null`, `manager: null`) rather than reusing the SSR
    // values, so it does not satisfy the Dead facet's
    // `hasStatus && ping === null` predicate either.
    await page.getByRole("button", { name: "Alive" }).click();
    await page.getByRole("button", { name: "Dead" }).click();
    await expect(gammaRow).toHaveCount(0);
  });

  test("manager dropping after first paint swaps the Settings list to the offline panel", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Companion to the SSR-path coverage above. The Settings page
    // mounts the table from a healthy `nodeStatusList` response; once
    // the polling loop is running, a manager outage shows up as a 503
    // on `/api/nodes/status` and flips the polling store's
    // `isManagerUnreachable` flag. The table must swap to the same
    // "Cannot reach manager" panel the SSR path uses, instead of
    // freezing on the now-stale snapshot.
    test.setTimeout(60_000);

    await stubSession.registerStub({
      operation: "nodeList",
      response: {
        kind: "fixture",
        fixture: "node/nodeList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    // Initial paint succeeds — table is up, panel is absent.
    await expect(page.getByTestId("nodes-table")).toBeVisible();
    await expect(page.getByTestId("manager-unavailable-panel")).toHaveCount(0);

    // Intercept the polling hook's `/api/nodes/status` calls and force
    // a 503 so the next tick flips `isManagerUnreachable` on the store.
    // We route only the API endpoint the polling fetcher hits, leaving
    // the SSR path untouched (the SSR fetch already completed).
    await page.route("**/api/nodes/status", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Manager unavailable" }),
      });
    });

    // After the next polling tick (10s default cadence), the table
    // disappears and the offline panel renders. Polls under
    // Playwright's expect wait up to 20s.
    await expect(page.getByTestId("manager-unavailable-panel")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("nodes-table")).toHaveCount(0);
  });
});
