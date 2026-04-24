/**
 * Phase Detection-10 multi-tab result behaviour.
 *
 * Exercises the test plan from PR #330 against the running dev
 * server + mock REview backend.
 */
import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";

test.beforeAll(async () => {
  await resetRateLimits();
});
test.beforeEach(async () => {
  await resetRateLimits();
});

// Collects the count of server-action POSTs dispatched against the
// page (the only thing that fires `runEventQuery`). A switch between
// tabs must never bump this counter — the result cache is per tab.
function trackServerActionCalls(page: import("@playwright/test").Page): {
  count: () => number;
  reset: () => void;
} {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const headers = req.headers();
    if (headers["next-action"]) count += 1;
  });
  return {
    count: () => count,
    reset: () => {
      count = 0;
    },
  };
}

async function openDetection(
  page: import("@playwright/test").Page,
  workerUsername: string,
  workerPassword: string,
) {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("detection multi-tab", () => {
  test("initial tab: one tab, default filter, results auto-loaded", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(1);
    // Active chip bar shows the default period.
    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    await expect(chipBar.getByText("Last 1 hour")).toBeVisible();
    // Tab title auto-summary reflects the default period.
    await expect(tabs.first()).toContainText("Last 1 hour");
  });

  test("+ creates a blank tab that does not auto-run", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tracker = trackServerActionCalls(page);

    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    const addButton = tablist.getByRole("button", { name: "Open a new tab" });
    tracker.reset();
    await addButton.click();

    // The blank tab appears and is selected.
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toContainText("Last 1 hour");

    // Empty pre-query panel is shown (no query run).
    await expect(page.getByText("Build a filter to begin")).toBeVisible();

    // Give the runtime a beat to show the loader would have if it had
    // kicked off — then assert no server action fired.
    await page.waitForTimeout(500);
    expect(tracker.count()).toBe(0);
  });

  test("Apply on a + tab runs the query and caches it for that tab only", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(2);

    const tracker = trackServerActionCalls(page);
    tracker.reset();

    // Open the drawer, pick a different period, Apply.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Last 1 week" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Filters" }),
    ).not.toBeVisible();

    // Result pane transitions out of "pre-query" into ready/loading,
    // and a server action fired for the current tab.
    await expect(page.getByText("Build a filter to begin")).not.toBeVisible({
      timeout: 10_000,
    });
    expect(tracker.count()).toBeGreaterThanOrEqual(1);

    // Active tab title auto-summary now reflects Last 1 week.
    await expect(tabs.nth(1)).toContainText("Last 1 week");
    // Tab 0 (still "Last 1 hour") is untouched.
    await expect(tabs.nth(0)).toContainText("Last 1 hour");
  });

  test("switching tabs does not hit the network and re-syncs the chip bar", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Last 1 week" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    // Wait for the applied query to settle.
    await expect(page.getByText("Build a filter to begin")).not.toBeVisible({
      timeout: 10_000,
    });

    const tabs = tablist.getByRole("tab");
    const tracker = trackServerActionCalls(page);
    tracker.reset();

    // Switch back to tab 1. No server action should fire.
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    await expect(chipBar.getByText("Last 1 hour")).toBeVisible();

    await page.waitForTimeout(500);
    expect(tracker.count()).toBe(0);

    // Switch back to tab 2 → chip bar re-syncs to Last 1 week.
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(chipBar.getByText("Last 1 week")).toBeVisible();

    await page.waitForTimeout(500);
    expect(tracker.count()).toBe(0);
  });

  test("tab switch re-syncs the drawer to the active tab's committed filter, not a stale draft", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Issue acceptance: tab switch re-synchronises the filter drawer
    // and chip bar to the active tab's committed filter. Drafts from
    // an unapplied drawer edit must not survive a switch away and
    // back, or the drawer would reopen on state that no longer
    // matches the chip bar. Reviewer #330 round 6 repro.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    const tabs = tablist.getByRole("tab");

    // Switch back to tab 0, open the drawer, change Last 1 hour → Last 1 week,
    // and close the drawer WITHOUT Apply.
    await tabs.nth(0).click();
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Last 1 week" }).click();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // Chip bar still shows the committed filter — the draft has not
    // been applied.
    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    await expect(chipBar.getByText("Last 1 hour")).toBeVisible();

    // Switch to tab 1 and back.
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

    // Reopen the drawer: the start/end inputs must reflect the
    // committed Last 1 hour window, not the abandoned Last 1 week
    // draft. We assert via the chip the drawer exposes as the active
    // period selection — `Last 1 hour` is highlighted, `Last 1 week`
    // is not.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Last 1 hour", pressed: true }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Last 1 week", pressed: true }),
    ).toHaveCount(0);
  });

  test("`+` context switch discards the leaving tab's unapplied drawer draft", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Reviewer #330 round 8 repro. The `+` affordance switches away
    // from the active tab just like `handleTabSelect`, so the same
    // draft-discard rule must hold: an abandoned `Last 1 week` edit on
    // tab A must not resurface when the user returns from the newly
    // opened tab.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    const tabs = tablist.getByRole("tab");

    // On tab 0, open Filters, change Last 1 hour → Last 1 week, and
    // close the drawer WITHOUT Apply.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Last 1 week" }).click();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // Chip bar still reflects the committed filter.
    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    await expect(chipBar.getByText("Last 1 hour")).toBeVisible();

    // Context-switch via `+` (not a plain tab click) to a new blank
    // tab, then return to tab 0.
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

    // Reopen the drawer: the period must be the committed Last 1 hour,
    // not the abandoned Last 1 week draft.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Last 1 hour", pressed: true }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Last 1 week", pressed: true }),
    ).toHaveCount(0);
  });

  test("opening + until the 8-tab cap disables the affordance", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    const addButton = tablist.getByRole("button", { name: "Open a new tab" });
    // Already one tab; click + seven more.
    for (let i = 0; i < 7; i += 1) {
      await addButton.click();
    }
    await expect(tablist.getByRole("tab")).toHaveCount(8);
    // Now disabled, with tooltip on hover.
    await expect(addButton).toBeDisabled();
    await addButton.hover({ force: true });
    await expect(
      page.getByText(/Tab limit reached \(8 tabs\)\. Close one/),
    ).toBeVisible();
  });

  test("closing the last tab auto-creates a fresh default tab", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(1);

    // Close the one and only tab.
    const closeButton = tabs.first().getByRole("button", { name: /Close tab/ });
    await closeButton.click();

    // A fresh default tab is auto-created — we never render tab-less.
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toContainText("Last 1 hour");
    // The replacement is a *default* tab, not a pending `+` tab.
    // Reviewer Round 18 item 1: the recreated tab must auto-run its
    // first query (issue: "closing the last tab auto-creates a default
    // tab" — default, i.e. page-entry-equivalent, auto-executes). A
    // pending-tab replacement would leave Refresh disabled and show
    // the pre-query empty panel; instead we expect Refresh to be
    // enabled once the auto-run query completes.
    await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  test("double-click rename persists across filter edits and resets via ↺", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    const firstTab = tablist.getByRole("tab").first();

    // Double-click the title, type a new one, Enter. The title is a
    // non-focusable span (Round 20 fix kept nested buttons out of the
    // tab order); the `onDoubleClick` handler lives on the `role="tab"`
    // wrapper, so dblclick'ing the title inside it still triggers the
    // rename. Targeting the visible title text keeps the gesture away
    // from the reset / close affordances.
    const title = firstTab.getByText("Last 1 hour").first();
    await title.dblclick();
    const input = firstTab.locator("input[type='text']");
    await expect(input).toBeVisible();
    await input.fill("Corp network recon");
    await input.press("Enter");

    await expect(firstTab).toContainText("Corp network recon");

    // Apply a filter change — the manual name survives.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Last 1 week" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Filters" }),
    ).not.toBeVisible();
    await expect(firstTab).toContainText("Corp network recon");

    // ↺ resets to the auto-generated summary (now `Last 1 week`).
    const reset = firstTab.getByRole("button", {
      name: "Reset tab name to auto-generated",
    });
    await reset.click();
    await expect(firstTab).toContainText("Last 1 week");
    await expect(firstTab).not.toContainText("Corp network recon");
  });

  test("reloading restores the full tab set and active index", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    const addButton = tablist.getByRole("button", { name: "Open a new tab" });
    await addButton.click();
    await addButton.click();
    await expect(tablist.getByRole("tab")).toHaveCount(3);
    await tablist.getByRole("tab").nth(2).click();

    // Confirm sessionStorage has all three tabs before reload.
    const storedBefore = await page.evaluate(() =>
      window.sessionStorage.getItem("detection.tabs.v1"),
    );
    const parsedBefore = storedBefore ? JSON.parse(storedBefore) : null;
    expect(parsedBefore?.tabs?.length).toBe(3);
    expect(parsedBefore?.activeIndex).toBe(2);

    await page.reload();
    await expect(
      page.getByRole("tablist", { name: "Detection search tabs" }),
    ).toBeVisible({ timeout: 10_000 });

    const restoredTabs = page
      .getByRole("tablist", { name: "Detection search tabs" })
      .getByRole("tab");
    await expect(restoredTabs).toHaveCount(3);
    await expect(restoredTabs.nth(2)).toHaveAttribute("aria-selected", "true");
  });

  test("reloading after opening + preserves the fresh tab's default filter", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression guard for the "+ before reload leaves a stale URL that
    // rebases into the wrong filter" bug: the URL must describe the
    // now-active tab as soon as `+` runs, not only after the next Apply.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });

    // Start in tab 0 and commit a filter that's visible in the chip bar.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page.getByRole("dialog");
    const sourceInput = drawer.getByLabel("Source", { exact: true });
    await sourceInput.fill("10.0.0.1");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForURL(/source=10\.0\.0\.1/);

    // Open a blank + tab. This is the tab we'll reload into.
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    await expect(tablist.getByRole("tab")).toHaveCount(2);
    await expect(tablist.getByRole("tab").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // URL should no longer describe tab 0's filter now that the blank
    // + tab is active.
    await expect(page).not.toHaveURL(/source=10\.0\.0\.1/);

    // Reloading a + tab must keep it in the pre-query state — the
    // URL marker (`pending=1`) drives both the SSR-skip on the
    // server and the shell's autoRun gate, so the default 1-hour
    // query never fires against the blank + tab.
    await expect(page).toHaveURL(/pending=1/);

    await page.reload();
    await expect(
      page.getByRole("tablist", { name: "Detection search tabs" }),
    ).toBeVisible({ timeout: 10_000 });

    // The + tab is still active, still blank (no stale source chip).
    const restored = page
      .getByRole("tablist", { name: "Detection search tabs" })
      .getByRole("tab");
    await expect(restored).toHaveCount(2);
    await expect(restored.nth(1)).toHaveAttribute("aria-selected", "true");
    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    await expect(chipBar).not.toContainText("10.0.0.1");
    // Pre-query panel is shown — Apply never ran against the default
    // filter during reload.
    await expect(page.getByText("Build a filter to begin")).toBeVisible();
  });

  test("removing the default period chip on a + tab survives reload without resurrecting it", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression guard for PR #330 reviewer round 5 item 2: on a
    // fresh + tab, removing the default `Last 1 hour` chip
    // intentionally leaves the tab with `period: null` and no
    // explicit range (the tab stays pending — the user must Apply).
    // Reloading into that state must not silently fall back to the
    // default period; otherwise the tab the operator left behind is
    // not what they return to.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    await expect(tablist.getByRole("tab")).toHaveCount(2);

    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    const periodChipRemove = chipBar.getByRole("button", {
      name: "Remove Last 1 hour",
    });
    await expect(periodChipRemove).toBeVisible();
    await periodChipRemove.click();

    // Chip is gone, tab remains pending (Refresh still disabled).
    await expect(chipBar.getByText("Last 1 hour")).not.toBeVisible();
    await expect(page).toHaveURL(/pending=1/);
    await expect(page).not.toHaveURL(/period=1h/);
    await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();

    await page.reload();
    await expect(
      page.getByRole("tablist", { name: "Detection search tabs" }),
    ).toBeVisible({ timeout: 10_000 });

    // After reload the period chip is still gone — the SSR resolver
    // no longer forces the default period back onto pending tabs.
    const restoredChipBar = page.getByRole("toolbar", { name: "Filters" });
    await expect(restoredChipBar.getByText("Last 1 hour")).not.toBeVisible();
    await expect(page).toHaveURL(/pending=1/);
    await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await expect(page.getByText("Build a filter to begin")).toBeVisible();
  });

  test("Apply from a + tab with the time chip removed runs a no-time first query", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression guard for PR #330 reviewer round 17 item 1: a fresh
    // `+` tab whose default `Last 1 hour` chip has been removed must
    // still be Apply-able. The prior Apply path hard-required both
    // `startIso` and `endIso`, which made the drawer reject the
    // submission — the tab became a dead end. The fix lets Apply run
    // a no-time first query the same way chip-removal on a committed
    // tab already does.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    await expect(tablist.getByRole("tab")).toHaveCount(2);

    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    await chipBar.getByRole("button", { name: "Remove Last 1 hour" }).click();
    await expect(chipBar.getByText("Last 1 hour")).not.toBeVisible();

    const tracker = trackServerActionCalls(page);
    tracker.reset();

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();

    // The drawer closes instead of surfacing an "invalid range" error,
    // the tab transitions out of the pre-query empty state, and a
    // server action fires for the no-time first query.
    await expect(
      page.getByRole("heading", { name: "Filters" }),
    ).not.toBeVisible();
    await expect(page.getByText("Build a filter to begin")).not.toBeVisible({
      timeout: 10_000,
    });
    expect(tracker.count()).toBeGreaterThanOrEqual(1);

    // The tab is now committed — Refresh re-enables and the URL
    // no longer advertises the pending state.
    await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
    await expect(page).not.toHaveURL(/pending=1/);
  });

  test("removing the period chip on a committed tab actually clears time and survives reload", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Regression guard for PR #330 reviewer round 7: the chip-bar `×`
    // on the committed period chip has to really remove the time
    // filter, not silently snap back to `Last 1 hour`. The SSR
    // resolver previously treated an already-run tab with no period
    // and no explicit range as malformed and restored the default,
    // which made the `×` affordance effectively non-functional on the
    // non-pending path. The fix carries a `notime=1` URL marker so
    // reload reproduces the operator's "no time filter" intent.
    await openDetection(page, workerUsername, workerPassword);

    const chipBar = page.getByRole("toolbar", { name: "Filters" });
    // Committed default-tab state: `Last 1 hour` chip + Refresh enabled.
    await expect(chipBar.getByText("Last 1 hour")).toBeVisible();
    const refresh = page.getByRole("button", { name: "Refresh" });
    await expect(refresh).toBeEnabled();

    const periodChipRemove = chipBar.getByRole("button", {
      name: "Remove Last 1 hour",
    });
    await expect(periodChipRemove).toBeVisible();
    await periodChipRemove.click();

    // The time chip is gone — no default Last-1-hour resurrection.
    await expect(chipBar.getByText("Last 1 hour")).not.toBeVisible();
    // URL reflects the cleared state via `notime=1`, and the period /
    // start / end params have been stripped.
    await expect(page).toHaveURL(/notime=1/);
    await expect(page).not.toHaveURL(/period=1h/);
    await expect(page).not.toHaveURL(/[?&]start=/);
    await expect(page).not.toHaveURL(/[?&]end=/);
    // The tab is still a committed tab, not pending — Refresh stays
    // enabled and the pre-query empty panel never appears.
    await expect(page).not.toHaveURL(/pending=1/);
    await expect(refresh).toBeEnabled();
    await expect(page.getByText("Build a filter to begin")).not.toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("tablist", { name: "Detection search tabs" }),
    ).toBeVisible({ timeout: 10_000 });

    // After reload the time chip is still absent and the SSR path has
    // not silently forced the default period back. Refresh remains
    // actionable because the tab is committed (autoRun=true).
    const restoredChipBar = page.getByRole("toolbar", { name: "Filters" });
    await expect(restoredChipBar.getByText("Last 1 hour")).not.toBeVisible();
    await expect(page).toHaveURL(/notime=1/);
    await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  test("shared multi-tab URL reproduces every tab in a fresh context", async ({
    browser,
    workerUsername,
    workerPassword,
  }) => {
    // Builds a two-tab working set, verifies the `tabs=<json>` param
    // is written, and asserts a fresh-context recipient lands on
    // both tabs — not just the active one.
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await signInAndWait(page1, workerUsername, workerPassword);
    await page1.goto("/detection");

    // Commit a filter on tab 0.
    await page1.getByRole("button", { name: "Filters", exact: true }).click();
    let drawer = page1.getByRole("dialog");
    await drawer.getByLabel("Source", { exact: true }).fill("1.1.1.1");
    await page1.getByRole("button", { name: "Apply", exact: true }).click();
    await page1.waitForURL(/source=1\.1\.1\.1/);

    // Open a second tab and commit a different filter on it.
    const tablist1 = page1.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist1.getByRole("button", { name: "Open a new tab" }).click();
    await page1.getByRole("button", { name: "Filters", exact: true }).click();
    drawer = page1.getByRole("dialog");
    await drawer.getByLabel("Source", { exact: true }).fill("2.2.2.2");
    await page1.getByRole("button", { name: "Apply", exact: true }).click();
    await page1.waitForURL(/source=2\.2\.2\.2/);
    // `?tabs=` carries both tabs when under the budget.
    await expect(page1).toHaveURL(/tabs=/);
    const sharedUrl = page1.url();
    await context1.close();

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await signInAndWait(page2, workerUsername, workerPassword);
    await page2.goto(sharedUrl);
    const tablist2 = page2.getByRole("tablist", {
      name: "Detection search tabs",
    });
    // Recipient sees both tabs, with tab 1 active.
    await expect(tablist2.getByRole("tab")).toHaveCount(2);
    await expect(tablist2.getByRole("tab").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const chipBar = page2.getByRole("toolbar", { name: "Filters" });
    await expect(chipBar.getByText("2.2.2.2")).toBeVisible();
    // Switch to tab 0 → the first author's filter is still there.
    await tablist2.getByRole("tab").nth(0).click();
    await expect(chipBar.getByText("1.1.1.1")).toBeVisible();
    await context2.close();
  });

  test("Refresh is disabled on a pending + tab until the user goes through Apply", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Issue acceptance: "the query does not auto-run for new tabs; the
    // user must Apply." Refresh is a "run the tab's query" affordance,
    // so on a pending tab it must be disabled — otherwise a brand-new
    // + tab could be executed without ever going through the drawer.
    // After Apply, Refresh becomes actionable again.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });

    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    await expect(tablist.getByRole("tab")).toHaveCount(2);
    await expect(page).toHaveURL(/pending=1/);

    const refresh = page.getByRole("button", { name: "Refresh" });
    await expect(refresh).toBeDisabled();
    // Pre-query panel is visible and Refresh did not fire.
    await expect(page.getByText("Build a filter to begin")).toBeVisible();

    // Apply from the drawer — this is the sanctioned path to run the
    // first query for a + tab. After Apply, Refresh re-enables.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page).not.toHaveURL(/pending=1/);
    await expect(refresh).toBeEnabled();
  });

  test("reopen-and-reapply on a relative-period tab rolls the window forward to `now`", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Reviewer Round 23 repro. `handleApply` used to cache the
    // submitted draft on the active tab as `draft: applied`, which made
    // `openDrawer` short-circuit on reopen and reuse the frozen
    // absolute `startIso` / `endIso` captured at first Apply. The
    // consequence: on a `Last 1 hour` tab, editing any other field and
    // Applying again quietly re-queried the original window instead of
    // rolling to the hour ending "now". Clearing the cached draft on
    // Apply is what lets reopen re-seed from the rolled committed
    // filter.
    //
    // The URL encoder writes `period=1h` for relative-period tabs and
    // deliberately omits absolute `start` / `end` (a shared link
    // reproduces the rolling window at load time, not the exact window
    // at share time). So we can't diff URL search params here —
    // instead we observe the server-action POSTs that `runEventQuery`
    // fires from two user-initiated Apply calls and compare the `end`
    // timestamps embedded in their RSC payloads. The bug manifests as
    // two identical payloads; the fix makes the second strictly later
    // than the first.
    //
    // Note: the initial page load's first query is SSR'd inside
    // `DetectionPage`, not dispatched via `runEventQuery`, so it does
    // not produce a server-action POST. We deliberately drive two
    // explicit Applies here.
    const actionEnds: number[] = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (!req.headers()["next-action"]) return;
      // Server actions POST back to the page URL; scope the listener
      // to the detection page so sign-in / CSRF actions from
      // `signInAndWait` don't pollute `actionEnds`.
      if (!/\/detection(?:\b|\/|\?)/.test(req.url())) return;
      const body = req.postData();
      if (!body) return;
      // Pull every ISO timestamp the RSC body carries and keep the
      // largest as the `end` bound. The `EventListFilterInput` only
      // carries two ISO fields (`start`, `end`) so "max ISO" is a
      // stable proxy for `end` without having to decode the RSC wire
      // format.
      const matches = body.match(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
      );
      if (!matches || matches.length === 0) return;
      const max = matches
        .map((iso) => Date.parse(iso))
        .filter((ms) => Number.isFinite(ms))
        .reduce((a, b) => (a > b ? a : b), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(max)) actionEnds.push(max);
    });

    await openDetection(page, workerUsername, workerPassword);

    // First Apply: edit Source and submit. On the buggy path this
    // caches the draft on the tab as `draft: applied` with the
    // rolled-at-this-moment absolute `startIso` / `endIso`.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByLabel("Source", { exact: true }).fill("10.0.0.1");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForURL(/source=10\.0\.0\.1/);
    await expect.poll(() => actionEnds.length).toBeGreaterThanOrEqual(1);
    const firstEndMs = actionEnds[0];

    // Wait long enough that a rolled window will have a measurably
    // different `end` timestamp (the RSC payload encodes milliseconds).
    await page.waitForTimeout(1500);

    const beforeSecond = actionEnds.length;
    // Second Apply: reopen the drawer on the same `Last 1 hour` tab,
    // change Source to a different value, and Apply again. If the
    // cached draft from the first Apply survived, the second Apply
    // would reuse the frozen `startIso` / `endIso` and the second
    // payload's `end` would not advance.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await drawer.getByLabel("Source", { exact: true }).fill("10.0.0.2");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForURL(/source=10\.0\.0\.2/);
    await expect.poll(() => actionEnds.length).toBeGreaterThan(beforeSecond);

    const secondEndMs = actionEnds[actionEnds.length - 1];
    expect(secondEndMs).toBeGreaterThan(firstEndMs);
  });

  test("shared URL in a fresh context restores only the URL-encoded tab", async ({
    browser,
    workerUsername,
    workerPassword,
  }) => {
    // Build a URL that uses more than just `source` — the drawer's full
    // filter surface (period, source, confidence, etc.) must ride along
    // so a shared link reproduces the whole active tab, not just the
    // pivot subset.
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await signInAndWait(page1, workerUsername, workerPassword);
    await page1.goto("/detection");
    await page1.getByRole("button", { name: "Filters", exact: true }).click();
    const drawer = page1.getByRole("dialog");
    // Pick a non-default period chip so the `?period=` param exercises
    // the period-preserving branch of the URL encoder.
    await drawer.getByRole("button", { name: "Last 1 week" }).click();
    const sourceInput = drawer.getByLabel("Source", { exact: true });
    await sourceInput.fill("1.2.3.4");
    await page1.getByRole("button", { name: "Apply", exact: true }).click();
    await page1.waitForURL(/source=1\.2\.3\.4/);
    await expect(page1).toHaveURL(/period=1w/);
    const sharedUrl = page1.url();
    await context1.close();

    // Open the same URL in a fresh context (empty sessionStorage).
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await signInAndWait(page2, workerUsername, workerPassword);
    await page2.goto(sharedUrl);
    const tablist = page2.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await expect(tablist.getByRole("tab")).toHaveCount(1);
    const chipBar = page2.getByRole("toolbar", { name: "Filters" });
    await expect(chipBar.getByText("1.2.3.4")).toBeVisible();
    // The period chip carries across — otherwise the link recipient
    // would see the default 1-hour window instead of the shared 1-week.
    await expect(chipBar.getByText("Last 1 week")).toBeVisible();
    await context2.close();
  });

  test("tab strip exposes matching tab / tabpanel semantics and arrow-key navigation", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // The tab strip advertises ARIA tab semantics — the shell must
    // render a matching tabpanel (aria-labelledby points back at the
    // active tab) and the tablist must support left/right arrow
    // navigation per the WAI-ARIA Authoring Practices tabs pattern.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    // Every tab's aria-controls — active or inactive — points at an
    // element that actually exists and carries role="tabpanel" /
    // aria-labelledby, so screen readers see a complete tab /
    // tabpanel pairing for every trigger rather than an orphaned
    // aria-controls on inactive tabs.
    for (const index of [0, 1]) {
      const panelId = await tabs.nth(index).getAttribute("aria-controls");
      expect(panelId).not.toBeNull();
      const tabId = await tabs.nth(index).getAttribute("id");
      expect(tabId).not.toBeNull();
      const panel = page.locator(`#${panelId}`);
      await expect(panel).toHaveAttribute("role", "tabpanel");
      await expect(panel).toHaveAttribute("aria-labelledby", tabId ?? "");
    }

    // Keyboard-nav structural contract: nested close / reset buttons
    // inside each tab must sit at tabIndex=-1 so the Tab key lands on
    // the `role="tab"` wrapper (where arrow-key nav is handled) rather
    // than a nested button (which previously stayed in the tab order
    // even when its parent tab had tabIndex=-1, so Tab could park
    // focus on a control inside an inactive tab and the tablist's
    // arrow-key handler would never fire). Asserting tabindex on the
    // nested controls guards against regressing the Round 20 fix.
    for (const index of [0, 1]) {
      const close = tabs.nth(index).getByRole("button", {
        name: /Close tab/,
      });
      await expect(close).toHaveAttribute("tabindex", "-1");
    }
    // Title is a span, not a button — so it isn't a focus target at
    // all. Asserting the structure directly (no title button under the
    // tab) prevents a future refactor from sneaking a nested button
    // back in without noticing.
    for (const index of [0, 1]) {
      const tabButtons = tabs.nth(index).getByRole("button");
      // Exactly one button under each tab: the close affordance. (The
      // reset affordance only appears when the tab has a manual name;
      // neither tab here is renamed.)
      await expect(tabButtons).toHaveCount(1);
    }

    const tracker = trackServerActionCalls(page);
    tracker.reset();
    // Focus the active tab wrapper and drive the keyboard handler.
    // `.focus()` is fine here now that the wrapper is the only
    // focusable element inside the tab — the real keyboard flow also
    // lands on this element.
    await tabs.nth(1).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    // Arrow Right wraps back around to tab 1.
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(200);
    expect(tracker.count()).toBe(0);
  });

  test("keyboard-only operators can rename, reset, and close tabs", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // The issue calls for tab names to be editable by "double-click or
    // equivalent"; the nested reset / close buttons carry tabIndex=-1
    // so keyboard-only users need shortcuts on the role="tab" wrapper
    // itself. F2 enters rename mode (Windows / Excel / file-manager
    // convention), Delete closes the focused tab, and F2 → clear →
    // Enter commits an empty rename which falls back to the
    // auto-generated summary — the keyboard equivalent of the ↺
    // affordance. Without these shortcuts the Round 20 focus fix
    // (which removed the nested buttons from the Tab order) left
    // keyboard users with no way to rename, reset, or close.
    await openDetection(page, workerUsername, workerPassword);
    const tablist = page.getByRole("tablist", {
      name: "Detection search tabs",
    });
    await tablist.getByRole("button", { name: "Open a new tab" }).click();
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    const firstTab = tabs.nth(0);
    const secondTab = tabs.nth(1);

    // Rename via F2.
    await firstTab.focus();
    await page.keyboard.press("F2");
    const input = firstTab.locator("input[type='text']");
    await expect(input).toBeVisible();
    await input.fill("Keyboard renamed");
    await input.press("Enter");
    await expect(firstTab).toContainText("Keyboard renamed");
    // After commit the rename input unmounts; focus must land back on
    // the role="tab" wrapper instead of escaping to <body>, so the
    // tablist's arrow-key handler keeps working without having to Tab
    // back in.
    await expect(firstTab).toBeFocused();

    // Cancel rename via Escape also restores focus to the wrapper.
    await page.keyboard.press("F2");
    await expect(input).toBeVisible();
    await input.press("Escape");
    await expect(input).toBeHidden();
    await expect(firstTab).toBeFocused();

    // Reset via F2 → clear → Enter. An empty or whitespace-only
    // rename commits back to the auto summary.
    await page.keyboard.press("F2");
    await expect(input).toBeVisible();
    await input.fill("");
    await input.press("Enter");
    await expect(firstTab).not.toContainText("Keyboard renamed");
    await expect(firstTab).toContainText("Last 1 hour");
    await expect(firstTab).toBeFocused();

    // Close the focused active tab via Delete. After close, focus must
    // land on the surviving neighbour tab rather than <body>.
    // Navigate to the second tab with the keyboard so the tablist's
    // roving-tabindex state tracks focus (moveFocus activates the new
    // tab and restores focus to it).
    await expect(firstTab).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(secondTab).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0)).toBeFocused();
  });
});
