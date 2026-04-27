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
  const PASSWORD = "TestPass1234!";

  test.beforeAll(async ({ workerPrefix: wp, workerUsername }) => {
    await resetRateLimits();
    TEST_PREFIX = wp("e2e-node-");
    SECMON_USERNAME = `${TEST_PREFIX}secmon`;
    MISSING_SERVICES_USERNAME = `${TEST_PREFIX}missing-services`;
    TENANT_ADMIN_USERNAME = `${TEST_PREFIX}tenant-admin`;
    ADMIN_FULL_USERNAME = `${TEST_PREFIX}admin-full`;
    SECMON_ROLE = `${TEST_PREFIX}role-secmon`;
    MISSING_SERVICES_ROLE = `${TEST_PREFIX}role-missing-services`;
    TENANT_ADMIN_ROLE = `${TEST_PREFIX}role-tenant-admin`;
    ADMIN_FULL_ROLE = `${TEST_PREFIX}role-admin-full`;

    await deleteTestAccount(SECMON_USERNAME);
    await deleteTestAccount(MISSING_SERVICES_USERNAME);
    await deleteTestAccount(TENANT_ADMIN_USERNAME);
    await deleteTestAccount(ADMIN_FULL_USERNAME);
    await deleteRolesByPrefix(`${TEST_PREFIX}role-`);
    await deleteCustomersByPrefix(TEST_PREFIX);

    await createTestRole(SECMON_ROLE, NODE_PERMS_READ_ONLY);
    await createTestRole(MISSING_SERVICES_ROLE, NODE_PERMS_MISSING_SERVICES);
    await createTestRole(TENANT_ADMIN_ROLE, NODE_PERMS_TENANT_ADMIN);
    await createTestRole(ADMIN_FULL_ROLE, NODE_PERMS_FULL);

    await createTestAccount(SECMON_USERNAME, PASSWORD, SECMON_ROLE);
    await createTestAccount(
      MISSING_SERVICES_USERNAME,
      PASSWORD,
      MISSING_SERVICES_ROLE,
    );
    await createTestAccount(TENANT_ADMIN_USERNAME, PASSWORD, TENANT_ADMIN_ROLE);
    await createTestAccount(ADMIN_FULL_USERNAME, PASSWORD, ADMIN_FULL_ROLE);

    // Assign every test account a customer so dispatch context is non-empty.
    const customerId = await ensureCustomerExists(`${TEST_PREFIX}customer`);
    for (const username of [
      SECMON_USERNAME,
      MISSING_SERVICES_USERNAME,
      TENANT_ADMIN_USERNAME,
      ADMIN_FULL_USERNAME,
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
    // System-Admin-only tenant filter must not appear.
    await expect(page.getByLabel("Customer")).toHaveCount(0);
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

  test("missing services:read produces a 403 redirect", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page, MISSING_SERVICES_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    await page.goto("/nodes/settings");
    // The layout redirects unauthorized callers off the route.
    await expect(page).not.toHaveURL(/\/nodes\/settings/);
  });
});
