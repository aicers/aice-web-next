/**
 * SPA return-navigation coverage for issue #668.
 *
 * The sidebar Detection link is a bare `/detection` route. Before the
 * fix, an in-app navigation away to another top-level menu and back
 * unmounted the Detection shell, minted a fresh default tab, and the
 * rehydrated tabs came back with an empty result cache — so the
 * operator's previously active tab and its results vanished. The fix
 * (option 3) mirrors the active tab's query string into a scope-isolated
 * `sessionStorage` slot and reconstructs `/detection?<qs>` on a plain
 * left-click of the sidebar link, routing the SPA return through the
 * same SSR restore path a full reload (F5) already uses.
 *
 * These tests verify the live behaviour the PR test plan calls for:
 *   - the previously active tab id + filter (and its results) survive a
 *     sidebar away/back hop (not a fresh default tab);
 *   - the stored slot carries only a query string, never result rows;
 *   - opening a `+` tab still does not auto-run a query (#281 / #429).
 */
import { expect, test } from "./fixtures";

import { signInAndWait } from "./helpers/auth";
import { mockServerSession } from "./mock-server-admin";

const session = mockServerSession();

test.beforeAll(async () => {
  // Every detection query in this file resolves to a populated first
  // page so the result list is visible both on first load and after the
  // SPA return. Keyed on Detection's default page size (`first: 50`) so
  // it does not collide with sibling specs pinned to other sizes.
  await session.registerStub({
    operation: "eventList",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "detection/eventList.manual-page.json",
    },
  });
});

test.afterAll(async () => {
  await session.clear();
});

function tabParam(rawUrl: string): string | null {
  return new URL(rawUrl).searchParams.get("tab");
}

test("sidebar away/back restores the active tab + results (not a fresh default)", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);

  await page.goto("/detection");
  // The populated list confirms the active tab ran its query.
  //
  // `.first()` (here and in the other result-row assertions below):
  // the route's `loading.tsx` (#751) makes `/detection` a Suspense-
  // streamed route, so during the SSR streaming/hydration window the
  // result content exists transiently in both the live DOM and the
  // hidden Next streaming staging container (`<div hidden id="S:…">`,
  // appended at body end). A bare `getByText` would then hit a strict-
  // mode "resolved to 2 elements" violation mid-stream. The live copy
  // is first in DOM order; `.first()` targets it and is strict-safe.
  await expect(page.getByText("mail.example.test").first()).toBeVisible({
    timeout: 15_000,
  });

  // The live shell mirrors the active tab's `?f=...&tab=...` into the
  // address bar (replaceState) and into the scoped sessionStorage slot.
  await expect
    .poll(() => tabParam(page.url()), { timeout: 5_000 })
    .not.toBeNull();
  const activeUrl = page.url();
  const activeTab = tabParam(activeUrl);
  expect(activeTab).toBeTruthy();

  // The stored slot carries only a query string — never result rows —
  // so the sessionStorage quota is never threatened (test-plan item 4).
  const stored = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key) out[key] = window.sessionStorage.getItem(key) ?? "";
    }
    return out;
  });
  const lastUrlEntry = Object.entries(stored).find(([k]) =>
    k.startsWith("detection:last-url:v1:"),
  );
  expect(lastUrlEntry, "scoped last-url slot is written").toBeTruthy();
  const lastUrlPayload = JSON.parse((lastUrlEntry as [string, string])[1]);
  expect(typeof lastUrlPayload.search).toBe("string");
  expect(lastUrlPayload.search).toContain(`tab=${activeTab}`);
  // No result-row shapes leak into any sessionStorage value.
  for (const value of Object.values(stored)) {
    expect(value).not.toContain("mail.example.test");
    expect(value).not.toContain('"edges"');
    expect(value).not.toContain("eventList");
  }

  // SPA-navigate away to another top-level menu, then back via the
  // sidebar Detection link (a plain left-click).
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/dashboard"), {
    timeout: 15_000,
  });
  // Sidebar still shows the Detection link while on Dashboard.
  await page.getByRole("link", { name: "Detection", exact: true }).click();

  await page.waitForURL((url) => url.pathname.endsWith("/detection"), {
    timeout: 15_000,
  });
  // The fix routed to the stored `/detection?<qs>` rather than the bare
  // route, so the SAME tab id is active again (a bare route would mint a
  // fresh default tab with a new id).
  await expect
    .poll(() => tabParam(page.url()), { timeout: 10_000 })
    .toBe(activeTab);
  // …and that tab shows its results, not the pre-query empty state.
  await expect(page.getByText("mail.example.test").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Open filters" })).toHaveCount(
    0,
  );
});

test("a + tab does not auto-run a query; in-menu switching keeps results", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");
  // `.first()` — strict-safe against the `loading.tsx` streaming
  // transient (see the note in the first test).
  await expect(page.getByText("mail.example.test").first()).toBeVisible({
    timeout: 15_000,
  });

  // Open a fresh tab via the `+` affordance.
  await page.getByRole("button", { name: "New tab", exact: true }).click();

  // The new tab lands on the pre-query empty state — the "Open filters"
  // call to action — and must NOT have silently run a query (#281 / #429).
  await expect(page.getByRole("button", { name: "Open filters" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("mail.example.test")).toHaveCount(0);

  // In-menu tab switching is unchanged: returning to the original tab
  // reveals its in-memory cached results, with no pre-query empty state
  // (test-plan item 2). The shell stays mounted across the switch, so
  // this path never consults sessionStorage.
  await page.getByRole("tab").first().click();
  await expect(page.getByText("mail.example.test").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Open filters" })).toHaveCount(
    0,
  );
});

test("navigating to Detection shows pending nav feedback + loading skeleton (#751)", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  // `eventList` is fetched server-side during the Detection page's SSR
  // (the Next server queries the mock REView server), so a browser-level
  // `page.route` cannot intercept it. Delay the response at the mock
  // server / stub level so the route `loading.tsx` skeleton and the nav
  // pending state stay observable while the SSR query is in flight.
  // Scoped to its own session and cleared at the end of the test so the
  // delay never bleeds into the sibling tests' immediate stub.
  const delayed = mockServerSession();
  await delayed.registerStub({
    operation: "eventList",
    matchVariables: { first: 50 },
    delayMs: 3_000,
    response: {
      kind: "fixture",
      fixture: "detection/eventList.manual-page.json",
    },
  });

  try {
    await signInAndWait(page, workerUsername, workerPassword);

    // Start from another menu so the navigation actually crosses into
    // the Detection route (and triggers its blocking SSR query).
    await page.goto("/dashboard");
    await page.waitForURL((url) => url.pathname.endsWith("/dashboard"), {
      timeout: 15_000,
    });

    const detectionLink = page.getByRole("link", {
      name: "Detection",
      exact: true,
    });
    await detectionLink.click();

    // The nav item enters its pending state the instant it is clicked —
    // before the delayed SSR query resolves and the page commits.
    await expect(detectionLink).toHaveAttribute("aria-busy", "true", {
      timeout: 2_000,
    });

    // The route-level loading skeleton paints immediately, reusing the
    // existing "Running query…" copy, while the SSR response is still in
    // flight (no result rows yet).
    await expect(page.getByText("Running query…")).toBeVisible({
      timeout: 2_000,
    });
    await expect(page.getByText("mail.example.test")).toHaveCount(0);

    // Once the delayed response lands, results render and the pending
    // state clears. `.first()` — strict-safe against the streaming
    // transient (see the note in the first test).
    await expect(page.getByText("mail.example.test").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(detectionLink).not.toHaveAttribute("aria-busy", "true");
  } finally {
    await delayed.clear();
  }
});
