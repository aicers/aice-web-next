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

import { expect, test } from "../fixtures";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "../helpers/auth";
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

      await expect(page.getByTestId("nodes-table")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("nodes-row").first()).toBeVisible();
      await page.screenshot({
        path: path.join(ASSETS_DIR, "node-list-ko.png"),
        animations: "disabled",
      });
    });
  });
