/**
 * Capture the Node Settings list screenshots for the manual.
 *
 * Unlike Detection's hero count (which is a live REview query and
 * therefore non-deterministic in the authoring worktree), the Node
 * list is wholly driven by the mock manager response — fixtures here
 * produce the same pixels every run. That makes a real PNG capture
 * the right asset for `docs/{en,ko}/operations/node-management.md`,
 * replacing the SVG wireframe placeholders that shipped with the
 * initial Phase Node-3 PR.
 *
 * **This spec is opt-in and is skipped by `pnpm e2e`.**
 *
 * The `beforeEach` here registers catch-all `nodeList` /
 * `nodeStatusList` stubs against the shared mock-server registry. Stub
 * resolution does not filter by `mockServerSession` scope, so a parallel
 * Playwright worker running `e2e/node/list.spec.ts` could otherwise
 * race against these catch-alls — the manager-offline test in
 * particular would receive the populated fixture and fail. Gating the
 * tests on `CAPTURE_SCREENSHOTS=1` keeps them out of the default e2e
 * suite entirely (no stub registration, no race surface).
 *
 * Run manually with:
 *
 *   CAPTURE_SCREENSHOTS=1 pnpm exec playwright test \
 *     --config=e2e/playwright.config.ts \
 *     e2e/node/screenshots.spec.ts
 */
import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "../helpers/auth";
import {
  assignCustomerToAccount,
  ensureCustomerExists,
  getAccountId,
} from "../helpers/setup-db";
import { closeAdminAgent, mockServerSession } from "../mock-server-admin";

const VIEWPORT = { width: 1440, height: 900 } as const;
const ASSETS_DIR = path.resolve(__dirname, "..", "..", "docs", "assets");

test.use({ viewport: VIEWPORT });

test.beforeEach(async () => {
  await resetRateLimits();
});

test.describe
  .serial("Node manual screenshots", () => {
    // Opt-in only. Without this guard, the catch-all stubs registered
    // below leak into `e2e/node/list.spec.ts` runs in a sibling worker.
    test.skip(
      process.env.CAPTURE_SCREENSHOTS !== "1",
      "Manual screenshot capture — set CAPTURE_SCREENSHOTS=1 to run.",
    );

    const stubSession = mockServerSession();

    test.beforeAll(async ({ workerUsername }) => {
      // The Node BFF rejects callers with no customer scope unless they
      // are System Administrators (`buildDispatchContext` throws
      // NodePermissionError). The worker role grants every permission
      // but is not literally "System Administrator", so we must wire a
      // customer assignment for the worker before any node page loads.
      // The list/status specs do this themselves and tear it down in
      // their `afterAll`; the screenshot spec is opt-in and isolated,
      // so we recreate the assignment here.
      const customerId = await ensureCustomerExists("e2e-screenshots-customer");
      try {
        const accountId = await getAccountId(workerUsername);
        await assignCustomerToAccount(accountId, customerId);
      } catch {
        // Already linked or absent.
      }
    });

    test.beforeEach(async () => {
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
    });

    test.afterAll(async () => {
      await stubSession.clear();
      await closeAdminAgent();
    });

    test("EN node list", async ({ page, workerUsername, workerPassword }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/nodes/settings");
      // Wait out the streaming Suspense placeholder so `nodes-table`
      // resolves to a single element (matches `e2e/node/list.spec.ts`).
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await expect(page.getByTestId("nodes-table")).toBeVisible({
        timeout: 10_000,
      });
      // Wait for at least one row so the screenshot doesn't catch the
      // table mid-render.
      await expect(page.getByTestId("nodes-row").first()).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-list-en.png"),
        animations: "disabled",
      });
    });

    test("KO node list", async ({ page, workerUsername, workerPassword }) => {
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/nodes/settings");
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await expect(page.getByTestId("nodes-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("nodes-row").first()).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-list-ko.png"),
        animations: "disabled",
      });
    });

    test("EN node status", async ({ page, workerUsername, workerPassword }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/nodes");
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await expect(page.getByTestId("node-status-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("node-status-row").first()).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-status-en.png"),
        animations: "disabled",
      });
    });

    test("KO node status", async ({ page, workerUsername, workerPassword }) => {
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/nodes");
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await expect(page.getByTestId("node-status-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("node-status-row").first()).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-status-ko.png"),
        animations: "disabled",
      });
    });

    // Status legend captures: a single Status row whose Sensor column is
    // in `idle` state, used by the manual's `### Status legend`
    // subsection. Drives the mock through the `serviceVariants`
    // fixture (the only fixture that includes a `RELOAD_FAILED`
    // agent), then crops the screenshot to just the agent-idle row so
    // the asset shows the Idle badge in context without the rest of
    // the table chrome.
    test("EN node status legend (idle row)", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.clear();
      await stubSession.registerStub({
        operation: "nodeStatusList",
        response: {
          kind: "fixture",
          fixture: "node/nodeStatusList.serviceVariants.json",
        },
      });
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/nodes");
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await expect(page.getByTestId("node-status-table")).toBeVisible({
        timeout: 10_000,
      });
      const idleRow = page
        .getByTestId("node-status-row")
        .filter({ hasText: "agent-idle.lan" });
      await expect(idleRow).toBeVisible();
      await expect(
        idleRow.getByTestId("node-status-service-sensor"),
      ).toHaveAttribute("data-status", "idle");
      await idleRow.screenshot({
        path: path.join(ASSETS_DIR, "node-status-legend-en.png"),
        animations: "disabled",
      });
    });

    test("KO node status legend (idle row)", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.clear();
      await stubSession.registerStub({
        operation: "nodeStatusList",
        response: {
          kind: "fixture",
          fixture: "node/nodeStatusList.serviceVariants.json",
        },
      });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/nodes");
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await expect(page.getByTestId("node-status-table")).toBeVisible({
        timeout: 10_000,
      });
      const idleRow = page
        .getByTestId("node-status-row")
        .filter({ hasText: "agent-idle.lan" });
      await expect(idleRow).toBeVisible();
      await expect(
        idleRow.getByTestId("node-status-service-sensor"),
      ).toHaveAttribute("data-status", "idle");
      await idleRow.screenshot({
        path: path.join(ASSETS_DIR, "node-status-legend-ko.png"),
        animations: "disabled",
      });
    });

    /**
     * Dialog captures.
     *
     * The three dialog screenshots discharge the Phase Node-4 acceptance
     * lines:
     *  - "Include a screenshot of the dialog in create mode with at
     *    least one service section expanded"
     *  - "(a) Edit dialog happy-path save screenshot"
     *  - "(b) stale-conflict reconciliation prompt screenshot"
     *
     * The save and stale-conflict cases mock `POST /api/nodes` /
     * `PATCH /api/nodes/<id>` directly via `page.route` rather than
     * stubbing the upstream GraphQL — the captures need a frozen
     * dialog state, not a round-trip through the BFF.
     */
    // Pick a name and hostname that aren't present in
    // `nodeList.populated.json` so the client-side uniqueness pre-check
    // doesn't short-circuit the save path before the mocked POST runs.
    const DIALOG_NAME = "delta-node";
    const DIALOG_HOSTNAME = "delta.local";

    async function fillAndExpandSensor(page: Page): Promise<void> {
      // Scope to the dialog — the list page has its own "Customer" /
      // filter labels that otherwise collide with the dialog fields.
      const dialog = page.getByTestId("node-edit-dialog");
      await dialog.getByLabel("Name", { exact: true }).fill(DIALOG_NAME);
      await dialog.getByLabel("Customer", { exact: true }).click();
      await page.getByRole("option").first().click();
      await dialog
        .getByLabel("Description", { exact: true })
        .fill("primary site");
      await dialog
        .getByLabel("Hostname", { exact: true })
        .fill(DIALOG_HOSTNAME);
      await page.getByTestId("node-dialog-sensor-enable").click();
      // Allow the per-service form to mount before the screenshot.
      await expect(
        page.getByTestId("node-dialog-service-sensor"),
      ).toHaveAttribute("data-service-enabled", "true");
    }

    async function fillAndExpandSensorKo(page: Page): Promise<void> {
      const dialog = page.getByTestId("node-edit-dialog");
      await dialog.getByLabel("이름", { exact: true }).fill(DIALOG_NAME);
      await dialog.getByLabel("고객", { exact: true }).click();
      await page.getByRole("option").first().click();
      await dialog.getByLabel("설명", { exact: true }).fill("주 사이트");
      await dialog
        .getByLabel("호스트명", { exact: true })
        .fill(DIALOG_HOSTNAME);
      await page.getByTestId("node-dialog-sensor-enable").click();
      await expect(
        page.getByTestId("node-dialog-service-sensor"),
      ).toHaveAttribute("data-service-enabled", "true");
    }

    test("EN create dialog", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/nodes/settings");
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await page.getByTestId("nodes-add-button").click();
      await expect(page.getByTestId("node-edit-dialog")).toBeVisible();
      await fillAndExpandSensor(page);

      await page.getByTestId("node-edit-dialog").screenshot({
        path: path.join(ASSETS_DIR, "node-create-en.png"),
        animations: "disabled",
      });
    });

    test("KO create dialog", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/nodes/settings");
      await page.waitForFunction(() => !document.getElementById("S:0"));

      await page.getByTestId("nodes-add-button").click();
      await expect(page.getByTestId("node-edit-dialog")).toBeVisible();
      await fillAndExpandSensorKo(page);

      await page.getByTestId("node-edit-dialog").screenshot({
        path: path.join(ASSETS_DIR, "node-create-ko.png"),
        animations: "disabled",
      });
    });

    /**
     * The save-happy and stale-conflict screenshots document the
     * **edit dialog**, not the create flow — `## Saving drafts` in
     * `node-management.md` describes those captures as Edit-dialog
     * captures because the deferral they discharge (PR #366 / Phase
     * Node-9b) is about the post-edit save lifecycle. The flow below
     * therefore navigates via `?dialog=edit&id=11`, which causes the
     * settings page to SSR-fetch the canonical node (`NodeDetail`
     * stubbed to `nodeDetail.alpha.json`) and seed the dialog with it,
     * and intercepts `PATCH /api/nodes/<id>` to fulfill the save / 409
     * paths without round-tripping through the manager.
     */
    async function navigateToEditDialog(
      page: Page,
      locale: "en" | "ko",
    ): Promise<void> {
      const path =
        locale === "en"
          ? "/nodes/settings?dialog=edit&id=11"
          : "/ko/nodes/settings?dialog=edit&id=11";
      await page.goto(path);
      await page.waitForFunction(() => !document.getElementById("S:0"));
      // The Settings page resolves `?dialog=edit&id=…` server-side and
      // mounts the dialog pre-populated; wait on its presence rather
      // than clicking through the row menu so the spec is robust to
      // changes in the row's affordance layout.
      await expect(page.getByTestId("node-edit-dialog")).toBeVisible({
        timeout: 10_000,
      });
    }

    test("EN dialog save happy-path", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: {
          kind: "fixture",
          fixture: "node/nodeDetail.alpha.json",
        },
      });
      // Intercept PATCH /api/nodes/<id> so the dialog can complete its
      // save lifecycle without round-tripping through the manager. The
      // capture is taken *after* the dialog has closed (i.e. the save
      // returned 200 and `onSuccess` ran), so the asset reflects the
      // post-save state outcome rather than a pre-save edit — that is
      // what the `## Saving drafts` doc section describes as the
      // "successful save" outcome.
      await page.route("**/api/nodes/*", (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
      });

      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToEditDialog(page, "en");
      const dialog = page.getByTestId("node-edit-dialog");
      // Edit a metadata field so the PATCH actually fires and the
      // dialog enters the save lifecycle.
      await dialog
        .getByLabel("Description", { exact: true })
        .fill("Updated description");
      await page.getByTestId("node-dialog-save").click();
      // Wait for the dialog to unmount — that's the post-save state
      // we want to capture (list view restored, no error banner).
      await expect(page.getByTestId("node-edit-dialog")).toBeHidden({
        timeout: 10_000,
      });
      await expect(page.getByTestId("nodes-table")).toBeVisible();

      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-save-happy-en.png"),
        animations: "disabled",
      });
    });

    test("KO dialog save happy-path", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: {
          kind: "fixture",
          fixture: "node/nodeDetail.alpha.json",
        },
      });
      await page.route("**/api/nodes/*", (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
      });

      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToEditDialog(page, "ko");
      const dialog = page.getByTestId("node-edit-dialog");
      await dialog.getByLabel("설명", { exact: true }).fill("설명 갱신");
      await page.getByTestId("node-dialog-save").click();
      await expect(page.getByTestId("node-edit-dialog")).toBeHidden({
        timeout: 10_000,
      });
      await expect(page.getByTestId("nodes-table")).toBeVisible();

      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-save-happy-ko.png"),
        animations: "disabled",
      });
    });

    test("EN stale-conflict banner", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: {
          kind: "fixture",
          fixture: "node/nodeDetail.alpha.json",
        },
      });
      // Intercept PATCH and respond with the documented stale-conflict
      // 409 shape. The dialog routes `field: null` on a 409 to its
      // dedicated reconciliation prompt (Discard / Keep editing),
      // distinct from the generic footer banner — the screenshot
      // captures that prompt UI.
      await page.route("**/api/nodes/*", (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error:
              "The node was modified by another user since you opened the dialog. Reload to see the latest baseline.",
            field: null,
          }),
        });
      });

      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToEditDialog(page, "en");
      // Force a metadata diff so the dialog actually fires the PATCH
      // (saving an untouched edit dialog with the new "preserve
      // unchanged" contract would still send the request, but having a
      // visible diff keeps the screenshot's pre-save state clear).
      await page
        .getByTestId("node-edit-dialog")
        .getByLabel("Description", { exact: true })
        .fill("Triggering a stale-conflict");
      await page.getByTestId("node-dialog-save").click();
      const stalePromptEn = page.getByTestId("node-dialog-stale-conflict");
      await expect(stalePromptEn).toBeVisible();
      // The prompt sits at the bottom of the scrollable dialog body, so
      // a raw dialog screenshot would clip the Discard / Keep editing
      // actions below the fold. Scroll the prompt into view before the
      // capture so the reconciliation actions (the whole point of this
      // figure) are visible.
      await stalePromptEn.scrollIntoViewIfNeeded();

      await page.getByTestId("node-edit-dialog").screenshot({
        path: path.join(ASSETS_DIR, "node-stale-conflict-en.png"),
        animations: "disabled",
      });
    });

    test("KO stale-conflict banner", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: {
          kind: "fixture",
          fixture: "node/nodeDetail.alpha.json",
        },
      });
      await page.route("**/api/nodes/*", (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error:
              "다이얼로그를 연 이후 다른 사용자가 노드를 수정했습니다. 새로고침하여 최신 기준 상태를 확인하세요.",
            field: null,
          }),
        });
      });

      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToEditDialog(page, "ko");
      await page
        .getByTestId("node-edit-dialog")
        .getByLabel("설명", { exact: true })
        .fill("Stale-conflict 트리거");
      await page.getByTestId("node-dialog-save").click();
      const stalePromptKo = page.getByTestId("node-dialog-stale-conflict");
      await expect(stalePromptKo).toBeVisible();
      // See EN counterpart: scroll the prompt into view so the Discard
      // / Keep editing actions are not clipped below the fold.
      await stalePromptKo.scrollIntoViewIfNeeded();

      await page.getByTestId("node-edit-dialog").screenshot({
        path: path.join(ASSETS_DIR, "node-stale-conflict-ko.png"),
        animations: "disabled",
      });
    });

    /**
     * Detail-page captures (Phase Node-5b, #377).
     *
     * Three figures discharge the umbrella's "Node detail page"
     * docs delta:
     *
     *   (a) `node-detail-{en,ko}.png`        — full dashboard (metadata
     *       + ping indicator + three resource sparklines).
     *   (b) `node-detail-services-{en,ko}.png` — a single service card
     *       with its three-tab panel (applied / draft / diff).
     *   (c) `node-detail-apply-mid-{en,ko}.png` — the Apply preview
     *       modal during the executing phase (a fourth state distinct
     *       from #362's planned / retryable / terminal figures).
     *
     * Each capture navigates to the canonical seed (`alpha-node`,
     * id `11`) so the asset is stable across runs. The mock manager
     * answers `node`, `nodeStatusList`, and the manager-apply pair
     * (`applyNodeDraft` + `applyAgentConfig`) via the fixtures
     * registered in the surrounding `beforeEach`.
     */
    async function navigateToDetail(
      page: Page,
      locale: "en" | "ko",
    ): Promise<void> {
      const route = locale === "en" ? "/nodes/11" : "/ko/nodes/11";
      await page.goto(route);
      await page.waitForFunction(() => !document.getElementById("S:0"));
      await expect(page.getByTestId("node-detail-page")).toBeVisible({
        timeout: 30_000,
      });
      // Sparklines render asynchronously after the SSR seed lands —
      // wait so the screenshot doesn't capture an empty axis.
      await expect(page.getByTestId("node-detail-charts")).toBeVisible();
    }

    test("EN node detail dashboard", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToDetail(page, "en");
      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-detail-en.png"),
        animations: "disabled",
      });
    });

    test("KO node detail dashboard", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToDetail(page, "ko");
      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-detail-ko.png"),
        animations: "disabled",
      });
    });

    test("EN node detail service card", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToDetail(page, "en");
      // Crop to the SENSOR service card to highlight the three-tab panel
      // (applied / draft / diff) rather than the full dashboard.
      const card = page.getByTestId("node-detail-service-card-sensor");
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({
        path: path.join(ASSETS_DIR, "node-detail-services-en.png"),
        animations: "disabled",
      });
    });

    test("KO node detail service card", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToDetail(page, "ko");
      const card = page.getByTestId("node-detail-service-card-sensor");
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({
        path: path.join(ASSETS_DIR, "node-detail-services-ko.png"),
        animations: "disabled",
      });
    });

    /**
     * Apply preview state captures (six PNGs replacing the
     * `node-apply-preview-{planned,retryable,terminal}-{en,ko}.svg`
     * wireframes shipped by PR #372 as a pre-mount stand-in). The
     * modal is reached through the detail page's Apply All button.
     *
     *   - Planned state: stub `applyNodeDraft` to succeed (never
     *     invoked before the screenshot, which is taken on the
     *     planned list).
     *   - Retryable state: stub `applyNodeDraft` with errors; click
     *     Apply; wait for the row's `data-state` to settle on
     *     `failed_retryable`; capture.
     *   - Terminal state: same, but force the dispatch through
     *     APPLY_DISPATCH_MAX_ATTEMPTS+ retries by stubbing repeated
     *     errors and clicking Retry until the row settles on
     *     `failed_terminal`. The dispatch cap is a small constant in
     *     `apply-attempt-types.ts` so a couple of retries is enough.
     */
    async function openApplyModal(page: Page): Promise<void> {
      await page.getByTestId("node-detail-apply-all").click();
      await page.getByTestId("node-detail-apply-all-confirm-button").click();
      await page
        .locator(
          '[data-testid="apply-preview-body"], [data-testid="apply-preview-plan-error"]',
        )
        .first()
        .waitFor({ timeout: 30_000 });
    }

    async function captureApplyState(
      page: Page,
      filename: string,
    ): Promise<void> {
      const dialog = page.locator('[role="dialog"]').filter({
        has: page.getByTestId("apply-preview-body"),
      });
      await expect(dialog).toBeVisible();
      await dialog.screenshot({
        path: path.join(ASSETS_DIR, filename),
        animations: "disabled",
      });
    }

    test("EN apply preview — planned dispatches", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "fixture",
          fixture: "node/applyNodeDraft.success.json",
        },
      });
      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToDetail(page, "en");
      await openApplyModal(page);
      await captureApplyState(page, "node-apply-preview-planned-en.png");
    });

    test("KO apply preview — planned dispatches", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "fixture",
          fixture: "node/applyNodeDraft.success.json",
        },
      });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToDetail(page, "ko");
      await openApplyModal(page);
      await captureApplyState(page, "node-apply-preview-planned-ko.png");
    });

    test("EN apply preview — failed_retryable", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "errors",
          errors: [{ message: "transient manager dispatch failure" }],
        },
      });
      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToDetail(page, "en");
      await openApplyModal(page);
      await page.getByTestId("apply-preview-apply").click();
      const row = page
        .locator('[data-testid^="apply-preview-dispatch-"]')
        .first();
      await expect(row).toHaveAttribute("data-state", "failed_retryable", {
        timeout: 30_000,
      });
      await captureApplyState(page, "node-apply-preview-retryable-en.png");
    });

    test("KO apply preview — failed_retryable", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "errors",
          errors: [{ message: "transient manager dispatch failure" }],
        },
      });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToDetail(page, "ko");
      await openApplyModal(page);
      await page.getByTestId("apply-preview-apply").click();
      const row = page
        .locator('[data-testid^="apply-preview-dispatch-"]')
        .first();
      await expect(row).toHaveAttribute("data-state", "failed_retryable", {
        timeout: 30_000,
      });
      await captureApplyState(page, "node-apply-preview-retryable-ko.png");
    });

    test("EN apply preview — failed_terminal", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "errors",
          errors: [{ message: "manager dispatch failure" }],
        },
      });
      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToDetail(page, "en");
      await openApplyModal(page);
      await page.getByTestId("apply-preview-apply").click();
      const row = page
        .locator('[data-testid^="apply-preview-dispatch-"]')
        .first();
      // Wait for the initial confirm to settle into failed_retryable
      // before issuing retries. The dispatch cap defaults to 3
      // (APPLY_DISPATCH_MAX_ATTEMPTS), so confirm + 2 retries = 3
      // attempts, which trips the cap and flips the row to terminal.
      await expect(row).toHaveAttribute("data-state", "failed_retryable", {
        timeout: 30_000,
      });
      for (let i = 0; i < 3; i++) {
        const state = await row.getAttribute("data-state");
        if (state === "failed_terminal") break;
        const retry = page.getByTestId(/^apply-preview-retry-/);
        await retry.first().click();
        // Wait for the row to leave in_flight and settle on a failed_*
        // state before deciding whether another retry is needed.
        await expect(row).toHaveAttribute(
          "data-state",
          /^failed_(retryable|terminal)$/,
          { timeout: 30_000 },
        );
      }
      await expect(row).toHaveAttribute("data-state", "failed_terminal", {
        timeout: 30_000,
      });
      await captureApplyState(page, "node-apply-preview-terminal-en.png");
    });

    test("KO apply preview — failed_terminal", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "errors",
          errors: [{ message: "manager dispatch failure" }],
        },
      });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToDetail(page, "ko");
      await openApplyModal(page);
      await page.getByTestId("apply-preview-apply").click();
      const row = page
        .locator('[data-testid^="apply-preview-dispatch-"]')
        .first();
      await expect(row).toHaveAttribute("data-state", "failed_retryable", {
        timeout: 30_000,
      });
      for (let i = 0; i < 3; i++) {
        const state = await row.getAttribute("data-state");
        if (state === "failed_terminal") break;
        const retry = page.getByTestId(/^apply-preview-retry-/);
        await retry.first().click();
        await expect(row).toHaveAttribute(
          "data-state",
          /^failed_(retryable|terminal)$/,
          { timeout: 30_000 },
        );
      }
      await expect(row).toHaveAttribute("data-state", "failed_terminal", {
        timeout: 30_000,
      });
      await captureApplyState(page, "node-apply-preview-terminal-ko.png");
    });

    /**
     * Mid-execution capture for the manual's "Node detail page" docs
     * delta — distinct from the planned / retryable / terminal trio
     * above. Captures the modal while `confirmApplyAttempt` is in
     * flight (the executing phase shows the manager row in
     * `in_flight` and the action button in the "Applying…" disabled
     * state). We force a slow response with `page.route` on the
     * server-action URL so the executing phase is observable for
     * long enough to screenshot.
     */
    test("EN apply preview — mid-execution", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      // Stub `applyNodeDraft` to succeed so the modal projects the
      // executing state cleanly. The modal flips to `kind: "executing"`
      // synchronously the moment Apply is clicked, so the capture lands
      // on the Applying… button before the BFF resolves.
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "fixture",
          fixture: "node/applyNodeDraft.success.json",
        },
      });
      await signInAndWait(page, workerUsername, workerPassword);
      await navigateToDetail(page, "en");
      await openApplyModal(page);
      await page.getByTestId("apply-preview-apply").click();
      await expect(page.getByTestId("apply-preview-applying")).toBeVisible({
        timeout: 5_000,
      });
      await captureApplyState(page, "node-apply-preview-mid-en.png");
    });

    test("KO apply preview — mid-execution", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await stubSession.registerStub({
        operation: "node",
        response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
      });
      await stubSession.registerStub({
        operation: "applyNodeDraft",
        response: {
          kind: "fixture",
          fixture: "node/applyNodeDraft.success.json",
        },
      });
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await navigateToDetail(page, "ko");
      await openApplyModal(page);
      await page.getByTestId("apply-preview-apply").click();
      await expect(page.getByTestId("apply-preview-applying")).toBeVisible({
        timeout: 5_000,
      });
      await captureApplyState(page, "node-apply-preview-mid-ko.png");
    });
  });
