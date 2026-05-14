/**
 * Apply preview save → preview → confirm → retry e2e (Phase Node-5b,
 * #377). Discharges the deferred Playwright spec from PR #372 / Phase
 * Node-9d (#362) — the modal can now be reached through the detail
 * page mounted by Phase Node-5a (#376), and the mock-server harness
 * carries `applyNodeDraft` + `applyAgentConfig` mutation handlers (the
 * manager pair that replaced the single-shot `applyNode` in Phase
 * Node-12 / #333).
 *
 * The detail page's `applyActions` prop wires the production
 * `createApplyAttempt` / `confirmApplyAttempt` / `retryDispatch`
 * server actions. `createApplyAttempt` reads the canonical node from
 * the mock manager (no external services dispatch yet) and persists a
 * row in `apply_attempts`. `confirmApplyAttempt` runs the manager
 * dispatch as the split pair `applyNodeDraft` (atomic draft commit)
 * then `applyAgentConfig` (agent notify), both stubbed against the
 * mock manager. The `nodeDetail.alpha.json` fixture used here has
 * `draft: null` on every external service, so the planned-dispatch
 * sequence is just the two manager rows `MANAGER_DB` +
 * `MANAGER_NOTIFY` — the spec exercises the UI state machine
 * end-to-end without needing separate Giganto / Tivan mock
 * infrastructure (which the wider mock harness does not provide in
 * the `#296` baseline that landed for Phase Node-5b).
 *
 * Spec coverage:
 *
 *   - **Success path**: open modal → planned list → Apply → both
 *     manager dispatches succeed → modal renders the succeeded
 *     heading.
 *   - **Retry path**: open modal → planned list → Apply → manager-DB
 *     dispatch (`applyNodeDraft`) returns GraphQL errors → modal
 *     shows the `failed_retryable` row with a Retry button → re-stub
 *     `applyNodeDraft` to succeed → click Retry → modal renders the
 *     succeeded heading once `MANAGER_NOTIFY` also clears.
 *
 * The retry variant simulates the Giganto-fails-then-succeeds scenario
 * documented in #362 against the manager-DB dispatch, which is the
 * first manager-pair step the v1 mock harness can drive end-to-end.
 * The UI state machine the spec asserts is identical: a
 * `failed_retryable` row surfaces a Retry button, clicking it
 * transitions the row to `in_flight` and then to `succeeded`, and the
 * resume rule advances the queued `MANAGER_NOTIFY` row once the
 * retried `MANAGER_DB` row clears. The same resume rule is exercised
 * more broadly by the unit-test layer in
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
    // Manager dispatches succeed on the very first call. Phase Node-12
    // (#333) splits the manager stage into `MANAGER_DB` (atomic
    // `applyNodeDraft` write) and `MANAGER_NOTIFY` (`applyAgentConfig`
    // agent notify), so both mutations need stubs.
    await stubSession.registerStub({
      operation: "applyNodeDraft",
      response: {
        kind: "fixture",
        fixture: "node/applyNodeDraft.success.json",
      },
    });
    await stubSession.registerStub({
      operation: "applyAgentConfig",
      response: {
        kind: "fixture",
        fixture: "node/applyAgentConfig.success.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, NODE_ID);
    await openApplyPreviewModal(page);

    // Planned dispatches: two manager rows (`MANAGER_DB` +
    // `MANAGER_NOTIFY`). Alpha-node has no external drafts in the seed
    // fixture, so no external dispatches are planned.
    await expect(page.getByTestId("apply-preview-body")).toBeVisible();
    const dispatches = page.locator(
      'li[data-testid^="apply-preview-dispatch-"]',
    );
    await expect(dispatches).toHaveCount(2);

    // Click Apply → confirm runs the manager DB and notify dispatches
    // via the mock applyNodeDraft + applyAgentConfig mutations.
    await page.getByTestId("apply-preview-apply").click();

    // Modal eventually transitions to the executed → succeeded heading.
    // Both manager rows must reach `succeeded` — the lifecycle's
    // sequential-advance contract guarantees notify only runs after DB
    // succeeds, and `confirmApplyAttempt` only returns once every
    // queued dispatch has settled.
    await expect(dispatches.nth(0)).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    await expect(dispatches.nth(1)).toHaveAttribute("data-state", "succeeded", {
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
    // First confirm: applyNodeDraft returns GraphQL errors. The
    // lifecycle's runOneDispatch catches the error and marks the
    // `MANAGER_DB` dispatch `failed_retryable` (cap not yet reached);
    // the `MANAGER_NOTIFY` dispatch stays queued because sequential
    // advance stops on failure.
    await stubSession.registerStub({
      operation: "applyNodeDraft",
      response: {
        kind: "errors",
        errors: [{ message: "transient manager dispatch failure" }],
      },
    });
    await stubSession.registerStub({
      operation: "applyAgentConfig",
      response: {
        kind: "fixture",
        fixture: "node/applyAgentConfig.success.json",
      },
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToDetail(page, NODE_ID);
    await openApplyPreviewModal(page);

    await expect(page.getByTestId("apply-preview-body")).toBeVisible();
    const dispatches = page.locator(
      'li[data-testid^="apply-preview-dispatch-"]',
    );
    await expect(dispatches).toHaveCount(2);

    // Confirm: drives the manager-DB row into failed_retryable via the
    // errors stub.
    await page.getByTestId("apply-preview-apply").click();
    const managerDbRow = dispatches.nth(0);
    const managerNotifyRow = dispatches.nth(1);
    await expect(managerDbRow).toHaveAttribute(
      "data-state",
      "failed_retryable",
      { timeout: 30_000 },
    );
    // The notify row never ran — sequential advance stops on first
    // failure.
    await expect(managerNotifyRow).toHaveAttribute("data-state", "queued");

    // Retry button is visible only on the failed_retryable row.
    const retryButton = page.locator('[data-testid^="apply-preview-retry-"]');
    await expect(retryButton).toHaveCount(1);

    // Re-stub applyNodeDraft to succeed for the retry call. Specificity-
    // first resolution treats a later catch-all as last-registered-wins,
    // so this overrides the failure stub for subsequent calls.
    await stubSession.registerStub({
      operation: "applyNodeDraft",
      response: {
        kind: "fixture",
        fixture: "node/applyNodeDraft.success.json",
      },
    });

    await retryButton.click();
    // Both manager rows settle to `succeeded` once the retried DB write
    // clears: sequential advance promotes the notify row.
    await expect(managerDbRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    await expect(managerNotifyRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    // Retry button is no longer rendered once every row has settled
    // successfully.
    await expect(
      page.locator('[data-testid^="apply-preview-retry-"]'),
    ).toHaveCount(0);
  });

  test("multi-service retry path: manager succeeds → giganto fails retryable → tivan still runs in parallel (#333) → retry giganto", async ({
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
      operation: "applyNodeDraft",
      response: {
        kind: "fixture",
        fixture: "node/applyNodeDraft.success.json",
      },
    });
    await stubSession.registerStub({
      operation: "applyAgentConfig",
      response: {
        kind: "fixture",
        fixture: "node/applyAgentConfig.success.json",
      },
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
    // Phase Node-12 (#333) split the v1 single `MANAGER` dispatch into
    // `MANAGER_DB` + `MANAGER_NOTIFY`, so the plan now carries four
    // rows (DB, notify, Giganto, Tivan) instead of three.
    await expect(dispatches).toHaveCount(4);

    const managerDbRow = dispatches.nth(0);
    const managerNotifyRow = dispatches.nth(1);
    const gigantoRow = dispatches.nth(2);
    const tivanRow = dispatches.nth(3);

    await page.getByTestId("apply-preview-apply").click();

    await expect(managerDbRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    await expect(managerNotifyRow).toHaveAttribute("data-state", "succeeded", {
      timeout: 30_000,
    });
    await expect(gigantoRow).toHaveAttribute("data-state", "failed_retryable", {
      timeout: 30_000,
    });
    // Phase Node-12 (#333) makes post-DB dispatches independent: a
    // failing external no longer blocks the others, so tivan is
    // attempted in parallel with giganto and (per its stubbed
    // success) settles `succeeded` before the operator retries
    // giganto.
    await expect(tivanRow).toHaveAttribute("data-state", "succeeded", {
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
