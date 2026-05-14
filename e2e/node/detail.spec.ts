/**
 * Detail-page surface e2e (Phase Node-5b, #377).
 *
 * Discharges the detail-page surface acceptance from the umbrella sub-
 * issue: opens the detail page mounted by Phase Node-5a (#376) and
 * exercises the documented surface — metadata + ping indicator + three
 * resource charts + the service card grid (with the Manager card),
 * empty Diff copy, external-service unreachable copy, manager-offline
 * fallback, and Security Monitor read-only gating.
 *
 * The mock-server's `nodeDetail.alpha.json` fixture is the seed: node
 * id `11`, one SENSOR agent in steady state (`draft == config`), one
 * DATA_STORE external (`draft: null`), and `customerId: "1"`. The
 * combined `(gate)/layout.tsx` requires `nodes:read + services:read`
 * before the page renders, so worker accounts are linked to a customer
 * with id `"1"` via the test customer-assignment helpers.
 *
 * GIGANTO_GRAPHQL_ENDPOINT / TIVAN_GRAPHQL_ENDPOINT are wired to the
 * schema-specific mock servers in `playwright.config.ts:buildEnv`, so
 * external-service success / failure paths must now be driven explicitly
 * via those harness endpoints rather than by leaving the env unset.
 */
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

// Read-only permissions for the Security Monitor role + `customers:access-all`.
// access-all is required so the seed `nodeDetail.alpha.json` fixture
// (`customerId: "1"`) is in scope of the test account regardless of whichever
// auto-incremented customer id Postgres assigns to the test customer in
// `beforeAll`. Affordance gating is independent of scope (Edit / Delete /
// Restart / Shutdown / Apply / "Edit this service" all key off
// `nodes:write` / `services:write` / `nodes:delete`), so granting the
// scope-bypass here does not weaken the test contract.
const NODE_PERMS_READ_ONLY = [
  "nodes:read",
  "services:read",
  "customers:read",
  "customers:access-all",
];

async function navigateToDetail(page: Page, id: string): Promise<void> {
  await page.goto(`/nodes/${id}`);
  await page.waitForFunction(() => !document.getElementById("S:0"));
  await page
    .getByTestId("node-detail-page")
    .or(page.getByTestId("manager-unavailable-panel"))
    .waitFor({ timeout: 30_000 });
}

test.describe("Node detail page", () => {
  const stubSession = mockServerSession();
  const gigantoSession = mockServerSession("giganto");

  let TEST_PREFIX: string;
  let SECMON_USERNAME: string;
  let SECMON_ROLE: string;
  const PASSWORD = "TestPass1234!";

  test.beforeAll(async ({ workerPrefix: wp, workerUsername }) => {
    await resetRateLimits();
    TEST_PREFIX = wp("e2e-node-detail-");
    SECMON_USERNAME = `${TEST_PREFIX}secmon`;
    SECMON_ROLE = `${TEST_PREFIX}role-secmon`;

    await deleteTestAccount(SECMON_USERNAME);
    await deleteRolesByPrefix(`${TEST_PREFIX}role-`);
    await deleteCustomersByPrefix(TEST_PREFIX);

    await createTestRole(SECMON_ROLE, NODE_PERMS_READ_ONLY);
    await createTestAccount(SECMON_USERNAME, PASSWORD, SECMON_ROLE);
    // Worker uses its own all-permissions role from global-setup; only
    // re-create the worker role here if a future test ever needs to
    // shadow it.
    void NODE_PERMS_FULL;

    const customerId = await ensureCustomerExists(`${TEST_PREFIX}customer`);
    for (const username of [SECMON_USERNAME, workerUsername]) {
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
    await gigantoSession.clear();
    await closeAdminAgent();
    await deleteTestAccount(SECMON_USERNAME);
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
    // Register the success stub at the same specificity (`{ id: "11" }`)
    // as the manager-offline test's connectionFailure stub so this entry
    // wins under specificity-first → last-registered-wins on every
    // beforeEach, regardless of whichever previous test left a sibling
    // `{ id: "11" }` matcher in the registry (the per-session clear only
    // runs in afterAll, so leftover specific stubs would otherwise
    // shadow this catch-all).
    await stubSession.registerStub({
      operation: "node",
      matchVariables: { id: "11" },
      response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
    });
  });

  test("renders metadata, ping, three resource charts, and the service card grid (Manager card included)", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, "11");

    // Metadata card with title + ping + charts.
    await expect(page.getByTestId("node-detail-dashboard")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("node-detail-title")).toContainText(
      "alpha-node",
    );
    await expect(page.getByTestId("node-detail-meta-hostname")).toContainText(
      "alpha.lan",
    );
    await expect(page.getByTestId("node-detail-ping")).toBeVisible();

    // Three resource charts (cpu / memory / disk) in the same dashboard.
    const charts = page.getByTestId("node-detail-charts");
    await expect(charts).toBeVisible();
    await expect(
      charts.locator('[data-testid="node-detail-sparkline-cpu"]'),
    ).toBeVisible();
    await expect(
      charts.locator('[data-testid="node-detail-sparkline-memory"]'),
    ).toBeVisible();
    await expect(
      charts.locator('[data-testid="node-detail-sparkline-disk"]'),
    ).toBeVisible();

    // Service card grid with the Manager card and the SENSOR / DATA_STORE
    // cards driven by the seed fixture's enumeration.
    const grid = page.getByTestId("node-detail-service-grid");
    await expect(grid).toBeVisible();
    await expect(page.getByTestId("node-detail-manager-card")).toBeVisible();
    await expect(
      page.getByTestId("node-detail-service-card-sensor"),
    ).toBeVisible();
    await expect(
      page.getByTestId("node-detail-service-card-dataStore"),
    ).toBeVisible();
  });

  test("Diff tab on a service in steady state renders the empty-diff copy", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, "11");
    await expect(page.getByTestId("node-detail-dashboard")).toBeVisible({
      timeout: 30_000,
    });

    // Sensor agent has `draft == config` in the seed fixture (steady
    // state under the #551 comparison-based pending model), so its Diff
    // tab must surface the documented "No pending changes for this
    // service." copy under the empty-diff testid.
    const sensorCard = page.getByTestId("node-detail-service-card-sensor");
    await sensorCard.getByTestId("node-detail-service-sensor-tab-diff").click();
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor-diff-empty"),
    ).toBeVisible();
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor-diff-empty"),
    ).toContainText("No pending changes for this service.");
  });

  test("Diff tab on a service with a draft shows only the changed fields", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Drive the page off `nodeDetail.sensorDraft.json` (id: "31"): the
    // sensor agent's `draft` differs from `config` only on
    // `pcap_max_size` (1000 → 2000); `protocols` and `http_ports` are
    // identical. The Diff tab must therefore render the diff table with
    // exactly one row keyed by `pcap_max_size` and not surface a row for
    // either of the unchanged keys — verifying both halves of the
    // "shows only changed fields" contract end-to-end (the unit-level
    // `diffServiceConfig` test already covers shape; this catches a
    // regression in the page → component → row wiring).
    await stubSession.registerStub({
      operation: "node",
      matchVariables: { id: "31" },
      response: {
        kind: "fixture",
        fixture: "node/nodeDetail.sensorDraft.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, "31");
    await expect(page.getByTestId("node-detail-dashboard")).toBeVisible({
      timeout: 30_000,
    });

    const sensorCard = page.getByTestId("node-detail-service-card-sensor");
    await sensorCard.getByTestId("node-detail-service-sensor-tab-diff").click();

    // Diff table is rendered, not the empty-diff fallback.
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor-diff"),
    ).toBeVisible();
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor-diff-empty"),
    ).toHaveCount(0);

    // The single changed key surfaces a row.
    const changedRow = sensorCard.getByTestId(
      "node-detail-service-sensor-diff-row-pcap_max_size",
    );
    await expect(changedRow).toBeVisible();
    await expect(changedRow).toContainText("1000");
    await expect(changedRow).toContainText("2000");

    // Unchanged keys must NOT appear as rows — that's the "only changed
    // fields" half of the contract.
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor-diff-row-protocols"),
    ).toHaveCount(0);
    await expect(
      sensorCard.getByTestId("node-detail-service-sensor-diff-row-http_ports"),
    ).toHaveCount(0);
  });

  test("External service (DATA_STORE) unreachable: Applied + Diff render unavailable copy, Draft renders normally", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await gigantoSession.registerStub({
      operation: "config",
      response: { kind: "connectionFailure" },
    });

    // Drive the SSR `getGigantoConfig` path into
    // `ExternalServiceUnavailableError` via the Giganto mock. The page
    // should surface unreachable copy on Applied + Diff while leaving
    // the Draft tab editable.
    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, "11");
    await expect(page.getByTestId("node-detail-dashboard")).toBeVisible({
      timeout: 30_000,
    });

    const dataStoreCard = page.getByTestId(
      "node-detail-service-card-dataStore",
    );
    // Applied tab: "unreachable" copy.
    await expect(
      dataStoreCard.getByTestId(
        "node-detail-service-dataStore-applied-unreachable",
      ),
    ).toBeVisible();

    // Diff tab: "Diff cannot be computed while the service is
    // unreachable." copy.
    await dataStoreCard
      .getByTestId("node-detail-service-dataStore-tab-diff")
      .click();
    const diffUnreachable = dataStoreCard.getByTestId(
      "node-detail-service-dataStore-diff-unreachable",
    );
    await expect(diffUnreachable).toBeVisible();
    await expect(diffUnreachable).toContainText(
      "Diff cannot be computed while the service is unreachable.",
    );

    // Draft tab: continues to render normally — the seed has
    // `draft: null`, so the empty-draft copy is shown rather than a
    // network-failure banner.
    await dataStoreCard
      .getByTestId("node-detail-service-dataStore-tab-draft")
      .click();
    await expect(
      dataStoreCard.getByTestId("node-detail-service-dataStore-draft-empty"),
    ).toBeVisible();
  });

  test("Manager offline shows the fallback panel, not a 403", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // A connection-failure stub on the canonical `node` read is the
    // path the page maps to `ManagerUnavailableError`, then renders
    // `<ManagerUnavailablePanel />`. The combined gate at the layout
    // has already passed (worker has full perms), so this is the
    // post-gate manager-dropped path — not a 403.
    await stubSession.clear();
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
    // Match on the same `{ id }` shape the manifest preload uses for
    // `node(id: "11")` so this admin stub wins under
    // specificity-first resolution. A catch-all (no `matchVariables`)
    // would tie at the catch-all tier and the manifest's specific
    // `nodeDetail.alpha.json` entry would still answer the request.
    await stubSession.registerStub({
      operation: "node",
      matchVariables: { id: "11" },
      response: { kind: "connectionFailure" },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, "11");

    await expect(page.getByTestId("manager-unavailable-panel")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("nodes-forbidden")).toHaveCount(0);
  });

  test("Security Monitor sees no Edit / Delete / Restart / Shutdown / Apply / 'Edit this service' affordances", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await signIn(page, SECMON_USERNAME, PASSWORD);
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 10_000,
    });
    await navigateToDetail(page, "11");

    await expect(page.getByTestId("node-detail-page")).toBeVisible({
      timeout: 30_000,
    });
    // Read-only role must not see any of the dashboard write
    // affordances.
    await expect(page.getByTestId("node-detail-edit")).toHaveCount(0);
    await expect(page.getByTestId("node-detail-delete")).toHaveCount(0);
    await expect(page.getByTestId("node-detail-restart")).toHaveCount(0);
    await expect(page.getByTestId("node-detail-shutdown")).toHaveCount(0);
    await expect(page.getByTestId("node-detail-apply-all")).toHaveCount(0);
    // Per-service "Edit this service" link is gated on `canEditServices`.
    await expect(page.locator('[data-testid$="-edit-link"]')).toHaveCount(0);
  });
});
