import { expect, test } from "./fixtures";

import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
} from "./helpers/setup-db";
import { mockServerSession } from "./mock-server-admin";

// ── Constants ────────────────────────────────────────────────────

const NOPERM_PASS = "Noperm1234!";

// ── Prefix-derived constants (initialized in beforeAll) ─────────

let NOPERM_USER: string;
let NOPERM_ROLE: string;

// Per-spec mock-server session so the stub registered below is cleared
// in `afterAll` without touching other specs' state.
const session = mockServerSession();

// ── Setup / Teardown ─────────────────────────────────────────────

test.beforeAll(async ({ workerUsername, workerPrefix }) => {
  await resetRateLimits();
  const prefix = workerPrefix("e2e-detection-");

  NOPERM_USER = `${prefix}noperm`;
  NOPERM_ROLE = `${prefix}No Detection`;

  await resetAccountDefaults(workerUsername);

  // Role with no detection permissions
  await createTestRole(NOPERM_ROLE, ["accounts:read"]);
  await createTestAccount(NOPERM_USER, NOPERM_PASS, NOPERM_ROLE);

  // #405 Reviewer Round 2 P1: the Detection page bootstrap now
  // re-throws unrecognised review GraphQL errors (the new
  // `ReviewUnknownGraphQLError`) to the route's error boundary
  // instead of masking them as the generic results banner. The
  // mock server answers an `eventList` request with no registered
  // stub by emitting `errors: [{ message: "no stub registered..." }]`,
  // which now classifies as `ReviewUnknownGraphQLError` and crashes
  // the SSR render before the shell mounts. Register an empty
  // `eventList` stub keyed on the default page size so every test
  // in this file lands on the rendered shell — these tests only
  // assert on shell affordances (filters drawer, chips, drawer
  // inputs), not the results list, so empty rows are fine.
  //
  // The stub is keyed on `first: 50` (Detection's default page
  // size) so it does not steal traffic from sibling specs that
  // pin to different page sizes (`detection-pivot-identity` uses
  // `first: 100`).
  await session.registerStub({
    operation: "eventList",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "detection/eventList.empty.json",
    },
  });
});

test.beforeEach(async ({ workerUsername }) => {
  await resetRateLimits();
  await resetAccountDefaults(workerUsername);
});

test.afterAll(async () => {
  try {
    await deleteTestAccount(NOPERM_USER);
    await deleteTestRole(NOPERM_ROLE);
  } catch {
    // best-effort cleanup
  }
  await session.clear();
});

// ── Permission gate ──────────────────────────────────────────────

test("detection page redirects for user without detection:read", async ({
  page,
}) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);
  await page.goto("/detection");

  // `requirePermission` redirects to "/" when the permission is missing.
  await page.waitForURL((url) => !url.pathname.includes("/detection"), {
    timeout: 10_000,
  });
});

test("detection page renders shell for admin worker", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  // Filters affordance and the on-demand Presets trigger confirm the
  // shell mounted. Issue #428 replaced the always-visible left rail
  // with a Presets dropdown that sits next to Filters in the toolbar.
  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await expect(filtersButton).toBeEnabled();
  await expect(filtersButton).toHaveAttribute("aria-expanded", "false");

  const presetsTrigger = page.getByRole("button", { name: "Presets" });
  await expect(presetsTrigger).toBeVisible();
  await expect(presetsTrigger).toBeEnabled();

  // Opening the dropdown reveals the Recommended section, the Saved
  // section, and the trailing Save-current action — the three
  // visually-separated groups the issue's "preset menu" requires.
  await presetsTrigger.click();
  // `exact: true` keeps the assertion scoped to the recommended preset
  // row itself; #429's "Open in new tab" icon renders a sibling
  // menuitem whose aria-label embeds the preset name ("Open 3 years
  // in a new tab"), which would otherwise match by substring.
  await expect(
    page.getByRole("menuitem", { name: "3 years", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Save current filter/ }),
  ).toBeVisible();
});

// ── Filter drawer ───────────────────────────────────────────────

test("filter drawer opens from the Filters button and exposes chips + inputs", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();

  // Drawer heading + period chip + time range fields all render.
  await expect(page.getByRole("heading", { name: "Filters" })).toBeVisible();
  // Scope chip-button queries to the drawer — the active filter chip
  // bar on the page also renders "Last 1 hour" and would otherwise
  // match by substring.
  const drawer = page.getByRole("dialog");
  await expect(
    drawer.getByRole("button", { name: "Last 1 hour" }),
  ).toBeVisible();
  await expect(page.getByLabel("Start", { exact: true })).toBeVisible();
  await expect(page.getByLabel("End", { exact: true })).toBeVisible();
  const applyButton = page.getByRole("button", { name: "Apply", exact: true });
  await expect(applyButton).toBeEnabled();

  // Save this filter is wired in Phase Detection-15: the drawer button
  // is enabled because the saved-filters hook owns the rail in this
  // page. The save dialog itself is exercised by the unit + action
  // tests under `src/__tests__`; the drawer affordance just opens it.
  const saveButton = drawer.getByRole("button", { name: "Save this filter" });
  await expect(saveButton).toBeEnabled();

  // Picking a different chip toggles its pressed state.
  const weekChip = drawer.getByRole("button", { name: "Last 1 week" });
  await weekChip.click();
  await expect(weekChip).toHaveAttribute("aria-pressed", "true");
  await expect(
    drawer.getByRole("button", { name: "Last 1 hour" }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("drawer renders Customer field and Sensor fallback while REview endpoint is absent", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();

  // Customer is now a functional multi-select sourced from
  // `getEffectiveCustomerScope`. The fieldset is always rendered;
  // its enabled/disabled state depends on whether the session has
  // any customers in scope. The Sensor control collapses to a
  // disabled state while the vendored REview schema does not
  // expose the sensor-list query — a "Coming soon" button under
  // the Sensor legend appears then.
  const customerSection = page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "Customer" }) });
  await expect(customerSection).toBeVisible();

  const sensorSection = page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "Sensor" }) });
  await expect(sensorSection).toBeVisible();
  // Until REview ships the endpoint the sensor trigger is disabled.
  // The sensor fieldset may render a second button (the inline
  // "Retry" action) when the lazy fetch lands in the error state —
  // e.g. because the e2e DB has no customer scope seeded — so scope
  // the disabled-state assertion to the trigger (always the first
  // button in the fieldset) rather than any button under the legend.
  await expect(sensorSection.getByRole("button").first()).toBeDisabled();
});

test("closing the drawer without Apply preserves in-flight edits", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });

  // First open: default chip is "Last 1 hour". Scope chip queries to
  // the drawer — the active filter chip bar on the page also renders
  // "Last 1 hour" and would otherwise match by substring.
  await filtersButton.click();
  const drawer = page.getByRole("dialog");
  await expect(
    drawer.getByRole("button", { name: "Last 1 hour" }),
  ).toHaveAttribute("aria-pressed", "true");

  // Edit the draft: pick a different chip, then dismiss via Escape.
  // Dismissal must NOT commit the filter — the active chip bar on the
  // page should still say "Last 1 hour".
  await drawer.getByRole("button", { name: "Last 1 week" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Filters" }),
  ).not.toBeVisible();
  await expect(filtersButton).toHaveAttribute("aria-expanded", "false");
  const chipBar = page.getByRole("toolbar", { name: "Filters" });
  await expect(chipBar.getByText("Last 1 hour")).toBeVisible();

  // Reopening reveals the edited-but-uncommitted draft — "Last 1 week"
  // is still pressed, proving the draft persisted across close/reopen.
  await filtersButton.click();
  const reopenedDrawer = page.getByRole("dialog");
  await expect(
    reopenedDrawer.getByRole("button", { name: "Last 1 week" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    reopenedDrawer.getByRole("button", { name: "Last 1 hour" }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("editing the time range manually clears the Period chip selection", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();

  // Default chip is "Last 1 hour" on first open. Scope to the drawer —
  // the active filter chip bar on the page also shows "Last 1 hour".
  const drawer = page.getByRole("dialog");
  const hourChip = drawer.getByRole("button", { name: "Last 1 hour" });
  await expect(hourChip).toHaveAttribute("aria-pressed", "true");

  // Typing an explicit end time clears the chip — an edited range is
  // no longer a quick-select window.
  await page.getByLabel("End", { exact: true }).fill("2026-04-22T13:00");
  await expect(hourChip).toHaveAttribute("aria-pressed", "false");
});

test("Apply with an invalid range keeps the drawer open and shows validation", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();

  // Force end <= start: set end to the same timestamp as start.
  await page.getByLabel("Start", { exact: true }).fill("2026-04-22T12:00");
  await page.getByLabel("End", { exact: true }).fill("2026-04-22T12:00");

  await page.getByRole("button", { name: "Apply", exact: true }).click();

  // Drawer stays open, error is announced via role="alert".
  await expect(page.getByRole("alert")).toHaveText(
    "End must be later than start.",
  );
  await expect(page.getByRole("heading", { name: "Filters" })).toBeVisible();
});

// ── Direction multi-select ──────────────────────────────────────

test("direction chips start all-selected and toggle off independently", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();

  const outbound = page.getByRole("button", { name: "Inside → Outside" });
  const internal = page.getByRole("button", { name: "Inside → Inside" });
  const inbound = page.getByRole("button", { name: "Outside → Inside" });

  for (const chip of [outbound, internal, inbound]) {
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  }

  await outbound.click();
  await expect(outbound).toHaveAttribute("aria-pressed", "false");
  await expect(internal).toHaveAttribute("aria-pressed", "true");
  await expect(inbound).toHaveAttribute("aria-pressed", "true");
});

test("direction multi-select reverts to all three when the last is deselected", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  await page.getByRole("button", { name: "Filters" }).click();

  const outbound = page.getByRole("button", { name: "Inside → Outside" });
  const internal = page.getByRole("button", { name: "Inside → Inside" });
  const inbound = page.getByRole("button", { name: "Outside → Inside" });

  // Turn two off; inbound is the last remaining selection.
  await outbound.click();
  await internal.click();
  await expect(outbound).toHaveAttribute("aria-pressed", "false");
  await expect(internal).toHaveAttribute("aria-pressed", "false");
  await expect(inbound).toHaveAttribute("aria-pressed", "true");

  // Clicking the last-remaining chip silently reverts to all three —
  // an empty selection would mean "no rows" and is not allowed, so
  // we return to the default "no filter" state instead.
  await inbound.click();
  await expect(outbound).toHaveAttribute("aria-pressed", "true");
  await expect(internal).toHaveAttribute("aria-pressed", "true");
  await expect(inbound).toHaveAttribute("aria-pressed", "true");
});

test("Apply with a direction subset renders chips in the active filter bar", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  await page.getByRole("button", { name: "Filters" }).click();

  // Deselect Outbound, leaving Internal + Inbound.
  await page.getByRole("button", { name: "Inside → Outside" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Filters" }),
  ).not.toBeVisible();

  // Chip bar shows two chips in canonical order (Internal, Inbound).
  const toolbar = page.getByRole("toolbar", { name: "Filters" });
  await expect(toolbar.getByText("Internal")).toBeVisible();
  await expect(toolbar.getByText("Inbound")).toBeVisible();
  await expect(toolbar.getByText("Outbound")).not.toBeVisible();
});

// ── Categorical multi-select filters ─────────────────────────────

test("categorical multi-select: All toggle, substring search, and chip summary", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const filtersButton = page.getByRole("button", { name: "Filters" });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await filtersButton.click();

  // 1 ── Closed-list field (Threat Level): expand, flip the master
  // "All" toggle on, and confirm the trigger summary switches from
  // "All" (the shared "no filter" wording) to the mid-state "N
  // selected" format. Saturating a closed list still reads as "All"
  // because saturated = no filter for Threat Level.
  const levelsTrigger = page.getByRole("button", { name: /Threat Level/ });
  await expect(levelsTrigger).toBeVisible();
  await expect(levelsTrigger).toHaveAttribute("aria-expanded", "false");
  await levelsTrigger.click();
  await expect(levelsTrigger).toHaveAttribute("aria-expanded", "true");

  // Scope further interactions to the disclosure panel itself (the
  // outer fieldset around the trigger also has `role=group` with the
  // same accessible name, so use the stable panel id).
  const levelsPanel = page.locator("#filter-levels-panel");
  await expect(levelsPanel).toBeVisible();

  // Click a single option (Low) — trigger summary becomes "1 selected".
  await levelsPanel.getByLabel("Low").check();
  await expect(levelsTrigger).toContainText("1 selected");

  // Clicking "All" selects every remaining option → 3/3 checked →
  // trigger reads "All" again (saturated = no filter for closed list).
  await levelsPanel.getByLabel("All", { exact: true }).check();
  await expect(levelsPanel.getByLabel("Low")).toBeChecked();
  await expect(levelsPanel.getByLabel("Medium")).toBeChecked();
  await expect(levelsPanel.getByLabel("High")).toBeChecked();
  await expect(levelsTrigger).toContainText("All");

  // Unchecking "All" clears everything → back to "All" (empty = no
  // filter). Leave Threat Level cleared so the chip bar assertions
  // below are not polluted.
  await levelsPanel.getByLabel("All", { exact: true }).uncheck();
  await expect(levelsPanel.getByLabel("Low")).not.toBeChecked();

  // 2 ── Long list with substring search (Threat Country): searching
  // by raw ISO code narrows the visible options.
  const countriesTrigger = page.getByRole("button", {
    name: /Threat Country/,
  });
  await countriesTrigger.click();
  await expect(countriesTrigger).toHaveAttribute("aria-expanded", "true");

  const countriesPanel = page.locator("#filter-countries-panel");
  const countrySearch = countriesPanel.getByRole("searchbox", {
    name: "Search options",
  });
  await countrySearch.fill("KR");
  // Korea remains visible; a disjoint code does not. `Korea` appears
  // in both KP and KR labels, so anchor on the KR-only "(KR)" suffix.
  await expect(countriesPanel.getByText(/\(KR\)/)).toBeVisible();
  await expect(countriesPanel.getByText(/\(US\)/)).toHaveCount(0);

  // Searching `unknown` finds the REview sentinel `XX` via its
  // localized label + search aliases (the fix for Round 4).
  await countrySearch.fill("unknown");
  await expect(countriesPanel.getByText(/\(XX\)/)).toBeVisible();

  await countrySearch.fill("KR");
  await countriesPanel.getByLabel(/\(KR\)/).check();
  await expect(countriesTrigger).toContainText("1 selected");

  // 3 ── Apply and verify the chip bar reflects the single selection
  // as a per-value chip (1–3 selected → individual chip per value).
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Filters" }),
  ).not.toBeVisible();

  const chipBar = page.getByRole("toolbar", { name: "Filters" });
  await expect(chipBar).toBeVisible();
  // The chip for a single-value selection is the per-value label, not
  // the "N selected" aggregate token.
  await expect(chipBar.getByText(/\(KR\)/)).toBeVisible();
});

// ── Analytics strip collapsed-by-default ─────────────────────────

test("analytics strip starts collapsed and toggles open", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/detection");

  const toggle = page.getByRole("button", { name: /Top N & Time Series/i });
  await expect(toggle).toBeVisible({ timeout: 10_000 });

  // Collapsed by default: aria-expanded="false". The panel container is
  // always in the DOM (it carries `aria-controls`), but its inner content
  // only renders when expanded — the dimension dropdown stays hidden.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("combobox", { name: /Dimension/i })).toHaveCount(
    0,
  );

  await toggle.click();

  // After click: aria-expanded="true" and the dimension selector renders.
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("combobox", { name: /Dimension/i }),
  ).toBeVisible();
});

// ── Localization ─────────────────────────────────────────────────

test("Korean locale: detection shell renders localized placeholders", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWaitKo(page, workerUsername, workerPassword);
  await page.goto("/ko/detection");

  await expect(
    page.getByRole("button", { name: "필터", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
});
