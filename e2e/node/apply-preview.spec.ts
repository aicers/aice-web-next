/**
 * Apply preview save → preview → confirm → retry e2e (Phase Node-5b,
 * #377). Discharges the deferred Playwright spec from PR #372 / Phase
 * Node-9d (#362) — the modal can now be reached through the detail
 * page mounted by Phase Node-5a (#376), and the mock-server harness
 * has been extended with an `applyNode` mutation handler under
 * `src/__tests__/fixtures/manifest.json`.
 *
 * The detail page's `applyActions` prop wires the production
 * `createApplyAttempt` / `confirmApplyAttempt` / `retryDispatch`
 * server actions. `createApplyAttempt` reads the canonical node from
 * the mock manager (no external services dispatch yet) and persists a
 * row in `apply_attempts`. `confirmApplyAttempt` runs the manager
 * dispatch via the upstream `applyNode` mutation (also against the
 * mock manager). The `nodeDetail.alpha.json` fixture used here has
 * `draft: null` on every external service, so the planned-dispatch
 * sequence is just the single `MANAGER` step — the spec exercises the
 * UI state machine end-to-end without needing separate Giganto / Tivan
 * mock infrastructure (which the wider mock harness does not provide
 * in the `#296` baseline that landed for Phase Node-5b).
 *
 * Spec coverage:
 *
 *   - **Success path**: open modal → planned list → Apply → confirm
 *     succeeds → modal renders the succeeded heading.
 *   - **Retry path**: open modal → planned list → Apply → manager
 *     dispatch returns GraphQL errors → modal shows the
 *     `failed_retryable` row with a Retry button → re-stub `applyNode`
 *     to succeed → click Retry → modal renders the succeeded heading.
 *
 * The retry variant simulates the Giganto-fails-then-succeeds scenario
 * documented in #362 against the manager dispatch, which is the only
 * dispatch the v1 mock harness can drive end-to-end. The UI state
 * machine the spec asserts is identical: a `failed_retryable` row
 * surfaces a Retry button, clicking it transitions the row to
 * `in_flight` and then to `succeeded`, and the resume rule advances
 * any subsequent queued rows when the retried row clears. Because
 * this plan only carries one dispatch, the resume rule is a no-op for
 * this fixture but is exercised by the unit-test layer in
 * `src/__tests__/lib/node/apply-attempt-lifecycle*.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import pg from "pg";

import { expect, test } from "../fixtures";
import { resetRateLimits, signInAndWait } from "../helpers/auth";
import {
  assignCustomerToAccount,
  deleteCustomersByPrefix,
  ensureCustomerExists,
  getAccountId,
} from "../helpers/setup-db";
import { closeAdminAgent, mockServerSession } from "../mock-server-admin";

// Mirror `helpers/setup-db.ts:getDatabaseUrl` so this spec resolves the
// same DATABASE_URL the rest of the e2e helpers use — playwright workers
// do not inherit the dev server's `.env.local` automatically, so a bare
// `process.env.DATABASE_URL` would fall through to the
// `postgres://postgres@…` default and fail on hosts whose Postgres
// install does not provision the `postgres` role.
function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(
      resolve(__dirname, "../../.env.local"),
      "utf8",
    );
    const match = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // .env.local not found — use default
  }
  return "postgres://postgres:postgres@localhost:5432/auth_db";
}

const pool = new pg.Pool({ connectionString: getDatabaseUrl(), max: 2 });
const NODE_ID = "11";
const MULTI_SERVICE_NODE_ID = "41";
const GIGANTO_UPDATE_VARIABLES = {
  old: JSON.stringify({
    ackTransmission: 4,
    dataDir: "/srv/giganto/data",
    exportDir: "/srv/giganto/export",
    graphqlSrvAddr: "127.0.0.1:8444",
    ingestSrvAddr: "127.0.0.1:38370",
    maxMbOfLevelBase: "512",
    maxOpenFiles: 4096,
    maxSubcompactions: "2",
    numOfThread: 8,
    publishSrvAddr: "127.0.0.1:38371",
    retention: "168h",
  }),
  new: JSON.stringify({
    ackTransmission: 8,
    dataDir: "/srv/giganto/data-next",
    exportDir: "/srv/giganto/export-next",
    graphqlSrvAddr: "127.0.0.1:9444",
    ingestSrvAddr: "127.0.0.1:48370",
    maxMbOfLevelBase: "1024",
    maxOpenFiles: 8192,
    maxSubcompactions: "4",
    numOfThread: 16,
    publishSrvAddr: "127.0.0.1:48371",
    retention: "336h",
  }),
} as const;
const TIVAN_UPDATE_VARIABLES = {
  old: JSON.stringify({
    excelData: null,
    graphqlSrvAddr: "127.0.0.1:38371",
    originMitre: null,
    translateMitre: "/srv/tivan/translate.json",
  }),
  new: JSON.stringify({
    graphqlSrvAddr: "127.0.0.1:48371",
    translateMitre: "/srv/tivan/translate-next.json",
    excelData: "/srv/tivan/excel.xlsx",
    originMitre: "/srv/tivan/origin.json",
  }),
} as const;

async function clearApplyAttempts(nodeId: string): Promise<void> {
  await pool.query("DELETE FROM apply_attempts WHERE node_id = $1", [nodeId]);
}

async function navigateToDetail(page: Page, id: string): Promise<void> {
  await page.goto(`/nodes/${id}`);
  await page.waitForFunction(() => !document.getElementById("S:0"));
  await page.getByTestId("node-detail-page").waitFor({ timeout: 30_000 });
}

async function openApplyPreviewModal(page: Page): Promise<void> {
  await page.getByTestId("node-detail-apply-all").click();
  // Confirm-prompt: the dashboard guards Apply behind a confirmation
  // dialog before opening the modal.
  await page.getByTestId("node-detail-apply-all-confirm-button").click();
  // Modal mounts and either lands on the planned list or surfaces the
  // load-error state.
  await page
    .locator(
      '[data-testid="apply-preview-body"], [data-testid="apply-preview-plan-error"]',
    )
    .first()
    .waitFor({ timeout: 30_000 });
}

test.describe("Node detail apply preview save→preview→confirm→retry", () => {
  const stubSession = mockServerSession("review");
  const gigantoSession = mockServerSession("giganto");
  const tivanSession = mockServerSession("tivan");

  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    // Drop any leftover customer row from a prior run before
    // creating ours: the customer table survives across test runs,
    // and `runStartupMigrations` would otherwise fail to migrate
    // an orphaned customer DB on the next webserver start.
    await deleteCustomersByPrefix("e2e-apply-preview-customer");
    const customerId = await ensureCustomerExists("e2e-apply-preview-customer");
    try {
      const accountId = await getAccountId(workerUsername);
      await assignCustomerToAccount(accountId, customerId);
    } catch {
      // already linked or absent
    }
    await clearApplyAttempts(NODE_ID);
    await clearApplyAttempts(MULTI_SERVICE_NODE_ID);
  });

  test.afterAll(async () => {
    await stubSession.clear();
    await gigantoSession.clear();
    await tivanSession.clear();
    await closeAdminAgent();
    await clearApplyAttempts(NODE_ID);
    await clearApplyAttempts(MULTI_SERVICE_NODE_ID);
    await deleteCustomersByPrefix("e2e-apply-preview-customer");
    await pool.end();
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    await clearApplyAttempts(NODE_ID);
    await clearApplyAttempts(MULTI_SERVICE_NODE_ID);
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "node",
      response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
    });
  });

  test("success path: save → preview → confirm → all dispatches succeeded", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Manager dispatch succeeds on the very first call.
    await stubSession.registerStub({
      operation: "applyNode",
      response: { kind: "fixture", fixture: "node/applyNode.success.json" },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, NODE_ID);
    await openApplyPreviewModal(page);

    // Planned dispatches: one MANAGER row (alpha-node has no external
    // drafts in the seed fixture).
    await expect(page.getByTestId("apply-preview-body")).toBeVisible();
    const dispatches = page.locator(
      'li[data-testid^="apply-preview-dispatch-"]',
    );
    await expect(dispatches).toHaveCount(1);

    // Click Apply → confirm runs the manager dispatch via mock applyNode.
    await page.getByTestId("apply-preview-apply").click();

    // Modal eventually transitions to the executed → succeeded heading.
    // Use the dispatch row's data-state attribute as a deterministic
    // signal: `confirmApplyAttempt` returns the row with the manager
    // dispatch in `succeeded` state, which the modal projects onto the
    // body.
    const managerRow = dispatches.first();
    await expect(managerRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    // No Retry button is rendered when every dispatch settled
    // successfully.
    await expect(
      page.locator('[data-testid^="apply-preview-retry-"]'),
    ).toHaveCount(0);
  });

  test("retry path: dispatch fails failed_retryable → user clicks Retry → succeeds", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // First confirm: applyNode returns GraphQL errors. The lifecycle's
    // runOneDispatch catches the error and marks the dispatch
    // failed_retryable (cap not yet reached).
    await stubSession.registerStub({
      operation: "applyNode",
      response: {
        kind: "errors",
        errors: [{ message: "transient manager dispatch failure" }],
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, NODE_ID);
    await openApplyPreviewModal(page);

    await expect(page.getByTestId("apply-preview-body")).toBeVisible();
    const dispatches = page.locator(
      'li[data-testid^="apply-preview-dispatch-"]',
    );
    await expect(dispatches).toHaveCount(1);

    // Confirm: drives the row into failed_retryable via the errors stub.
    await page.getByTestId("apply-preview-apply").click();
    const row = dispatches.first();
    await expect(row).toHaveAttribute("data-state", "failed_retryable", {
      timeout: 30_000,
    });

    // Retry button is visible on the failed_retryable row.
    const retryButton = page.locator('[data-testid^="apply-preview-retry-"]');
    await expect(retryButton).toHaveCount(1);

    // Re-stub applyNode to succeed for the retry call. Specificity-first
    // resolution treats a later catch-all as last-registered-wins, so
    // this overrides the failure stub for subsequent calls.
    await stubSession.registerStub({
      operation: "applyNode",
      response: { kind: "fixture", fixture: "node/applyNode.success.json" },
    });

    await retryButton.click();
    await expect(row).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    // Retry button is no longer rendered once the row has settled
    // successfully.
    await expect(
      page.locator('[data-testid^="apply-preview-retry-"]'),
    ).toHaveCount(0);
  });

  test("multi-service retry path: manager succeeds → giganto fails retryable → retry resumes tivan", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "node",
      matchVariables: { id: MULTI_SERVICE_NODE_ID },
      response: {
        kind: "fixture",
        fixture: "node/nodeDetail.multiServiceDrafts.json",
      },
    });
    await stubSession.registerStub({
      operation: "applyNode",
      response: { kind: "fixture", fixture: "node/applyNode.success.json" },
    });

    await gigantoSession.registerStub({
      operation: "config",
      response: {
        kind: "fixture",
        fixture: "external/giganto/config.base.json",
      },
    });
    await gigantoSession.registerStub({
      operation: "updateConfig",
      matchVariables: GIGANTO_UPDATE_VARIABLES,
      response: {
        kind: "errors",
        errors: [{ message: "transient giganto update failure" }],
      },
    });

    await tivanSession.registerStub({
      operation: "config",
      response: {
        kind: "fixture",
        fixture: "external/tivan/config.base.json",
      },
    });
    await tivanSession.registerStub({
      operation: "updateConfig",
      matchVariables: TIVAN_UPDATE_VARIABLES,
      response: {
        kind: "fixture",
        fixture: "external/tivan/updateConfig.success.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, MULTI_SERVICE_NODE_ID);
    await openApplyPreviewModal(page);

    await expect(page.getByTestId("apply-preview-body")).toBeVisible();
    const dispatches = page.locator(
      'li[data-testid^="apply-preview-dispatch-"]',
    );
    await expect(dispatches).toHaveCount(3);

    const managerRow = dispatches.nth(0);
    const gigantoRow = dispatches.nth(1);
    const tivanRow = dispatches.nth(2);

    await page.getByTestId("apply-preview-apply").click();

    await expect(managerRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    await expect(gigantoRow).toHaveAttribute("data-state", "failed_retryable", {
      timeout: 30_000,
    });
    await expect(tivanRow).toHaveAttribute("data-state", "queued", {
      timeout: 30_000,
    });

    const retryButton = gigantoRow.locator(
      '[data-testid^="apply-preview-retry-"]',
    );
    await expect(retryButton).toHaveCount(1);

    await gigantoSession.registerStub({
      operation: "updateConfig",
      matchVariables: GIGANTO_UPDATE_VARIABLES,
      response: {
        kind: "fixture",
        fixture: "external/giganto/updateConfig.success.json",
      },
    });

    await retryButton.focus();
    await page.keyboard.press("Enter");

    await expect(gigantoRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    await expect(tivanRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    await expect(
      page.locator('[data-testid^="apply-preview-retry-"]'),
    ).toHaveCount(0);
  });
});
