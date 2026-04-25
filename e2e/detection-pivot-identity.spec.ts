import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";
import { closeAdminAgent, mockServerSession } from "./mock-server-admin";

/**
 * Phase Detection-31 / issue #352: cell-specific Playwright pivot
 * coverage for the `userName` and `hostname` cells (#347 deferred
 * this from PR #350).
 *
 * The mock-server stub returns two events:
 *
 *  - One `HttpThreat` row with `username` + `host` populated — both
 *    identity cells should render as pivotable buttons.
 *  - One `BlocklistConn` row whose schema emits neither field — both
 *    cells should render as the non-pivotable `User: —` / `Host: —`
 *    fallback.
 *
 * The fixture and its paired query are declared in
 * `src/__tests__/fixtures/manifest.json` so the pre-test preflight
 * validates them against `schemas/review.graphql`.
 *
 * Stub matching is keyed on the request's `first` value: this spec
 * navigates with `?pageSize=200`, so its `eventList` requests carry
 * `first: 200`, which no other detection spec uses (the rest fall
 * back to the default 50). A catch-all matcher would otherwise leak
 * the identity rows into `detection-screenshots.spec.ts` and any
 * other Apply-driven detection spec running in a parallel worker —
 * the mock server is shared across workers, so once a catch-all is
 * live every page's `eventList` query is satisfied by it. Pinning to
 * `first: 200` keeps the stub local to this spec.
 */

const session = mockServerSession();

test.beforeAll(async () => {
  await resetRateLimits();
  await session.registerStub({
    operation: "eventList",
    matchVariables: { first: 200 },
    response: {
      kind: "fixture",
      fixture: "detection/eventList.identity.json",
    },
  });
});

test.beforeEach(async ({ workerUsername }) => {
  await resetRateLimits();
  await resetAccountDefaults(workerUsername);
});

test.afterAll(async () => {
  await session.clear();
  await closeAdminAgent();
});

test("clicking the User and Host cells opens narrowed pivot tabs", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  // `?pageSize=200` keys this spec's `eventList` requests off the
  // page-size matcher the stub registration above pins to. See the
  // module-level docstring for the cross-spec leak this avoids.
  await page.goto("/detection?pageSize=200");

  // Apply the default filter to dispatch the eventList query — without
  // Apply the shell renders the empty-prequery state and never asks
  // the mock server for rows.
  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();

  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Filters" })).toBeVisible();
  await drawer.getByRole("button", { name: "Apply", exact: true }).click();

  // Wait for the result list region to render — anchors the assertions
  // below on the post-Apply state (the empty-prequery placeholder is
  // gone, and the row list has at least the two fixture rows). Without
  // this gate a slow CI worker can race the `User:` count assertion
  // against the empty-prequery shell and report 0 matches.
  const resultListRoot = page.locator('[data-slot="detection-result-list"]');
  await expect(resultListRoot).toBeVisible({ timeout: 15_000 });
  await expect(resultListRoot.locator("li")).toHaveCount(2);

  // The HttpThreat row's User cell carries the localized pivot
  // aria-label `Filter results by User name: alice@example.test`,
  // which is the activate label `pivotActivate` composes from the
  // `pivotColumnLabels.userName` token + the cell value.
  const userPivot = page.getByRole("button", {
    name: "Filter results by User name: alice@example.test",
  });
  await expect(userPivot).toBeVisible({ timeout: 10_000 });
  await expect(userPivot).toHaveAttribute("data-slot", "detection-pivot-cell");

  // BlocklistConn (no schema-emitted username / host) renders the
  // non-pivotable `User: —` / `Host: —` fallback. The dash is inside
  // a plain <span>, never a <button>, so the locator must match no
  // role=button. There are two `—` tokens on that row (one per cell),
  // so we assert via the prefix tokens being present (User: and Host:)
  // and that there is no pivot button for either dash.
  const resultList = page.locator('[data-slot="detection-result-list"]');
  await expect(resultList).toBeVisible();
  // Two `User:` and `Host:` prefixes total — one pair per row.
  await expect(resultList.getByText("User:")).toHaveCount(2);
  await expect(resultList.getByText("Host:")).toHaveCount(2);
  // Only the HttpThreat row contributes a pivot button for these
  // cells; the BlocklistConn row's `—` cells must not be pivotable.
  await expect(
    resultList.locator(
      'button[data-slot="detection-pivot-cell"][aria-label^="Filter results by User name"]',
    ),
  ).toHaveCount(1);
  await expect(
    resultList.locator(
      'button[data-slot="detection-pivot-cell"][aria-label^="Filter results by Hostname"]',
    ),
  ).toHaveCount(1);

  // ── Activate the User cell ─────────────────────────────────────
  const tablist = page.getByRole("tablist", { name: "Detection result tabs" });
  await expect(tablist.getByRole("tab")).toHaveCount(1);
  await userPivot.click();

  // A new tab is opened and made active; the active filter chip bar
  // for the new tab carries a `User Names: alice@example.test` chip.
  await expect(tablist.getByRole("tab")).toHaveCount(2);
  const chipBar = page.getByRole("toolbar", { name: "Filters" });
  await expect(
    chipBar.getByRole("button", {
      name: "User Names: alice@example.test",
    }),
  ).toBeVisible();

  // ── Switch back to tab 1 and activate the Host cell ────────────
  // The first tab keeps its original (empty) filter; clicking the
  // Host cell from there creates a third tab narrowed by `hostnames`.
  await tablist.getByRole("tab").first().click();
  // After the switch the chip bar should no longer carry the userNames
  // chip — we are back on the un-narrowed tab.
  await expect(
    chipBar.getByRole("button", {
      name: "User Names: alice@example.test",
    }),
  ).toHaveCount(0);

  const hostPivot = page.getByRole("button", {
    name: "Filter results by Hostname: phish.example.test",
  });
  await expect(hostPivot).toBeVisible();
  await hostPivot.click();
  await expect(tablist.getByRole("tab")).toHaveCount(3);
  await expect(
    chipBar.getByRole("button", {
      name: "Hostnames: phish.example.test",
    }),
  ).toBeVisible();
});
