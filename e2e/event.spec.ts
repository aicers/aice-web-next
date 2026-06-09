import { expect, test } from "./fixtures";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
} from "./helpers/setup-db";
import { mockServerSession } from "./mock-server-admin";

const NOPERM_PASS = "Noperm1234!";

let NOPERM_USER: string;
let NOPERM_ROLE: string;

const session = mockServerSession("giganto");

test.beforeAll(async ({ workerUsername, workerPrefix }) => {
  await resetRateLimits();
  const prefix = workerPrefix("e2e-event-");

  NOPERM_USER = `${prefix}noperm`;
  NOPERM_ROLE = `${prefix}No Event`;

  await resetAccountDefaults(workerUsername);

  // Role without event:read.
  await createTestRole(NOPERM_ROLE, ["accounts:read"]);
  await createTestAccount(NOPERM_USER, NOPERM_PASS, NOPERM_ROLE);

  // Sensor list (single-sensor selector source).
  await session.registerStub({
    operation: "sensors",
    response: { kind: "fixture", fixture: "external/giganto/sensors.json" },
  });

  // Conn page keyed on the default page size (50) so the SSR search
  // resolves the fixture connection (2 edges, hasNextPage true).
  await session.registerStub({
    operation: "connRawEvents",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "external/giganto/connRawEvents.page1.json",
    },
  });

  // Forward step: Next sends `first/after` with page 1's endCursor.
  // Page 2 reports hasPreviousPage true / hasNextPage false.
  await session.registerStub({
    operation: "connRawEvents",
    matchVariables: { first: 50, after: "Y3Vyc29yOjE=" },
    response: {
      kind: "fixture",
      fixture: "external/giganto/connRawEvents.page2.json",
    },
  });

  // Backward step: Previous sends `last/before` with page 2's
  // startCursor, returning to page 1.
  await session.registerStub({
    operation: "connRawEvents",
    matchVariables: { last: 50, before: "Y3Vyc29yOjI=" },
    response: {
      kind: "fixture",
      fixture: "external/giganto/connRawEvents.page1.json",
    },
  });

  // Representative Sysmon type (Process create) for the endpoint-event
  // path. The matcher pins the **exact** sysmon filter shape — sensor +
  // agentId only, with NO orig/resp IP or port fields — so this stub is
  // also the stale-filter regression guard: if the browser flow leaked
  // an IP/port range left over from the Conn type into the sysmon
  // request (the highest-risk defect in #726), the request filter would
  // no longer match this matcher, no stub would fire, the mock would
  // return a GraphQL error, and the result assertions below would fail.
  // Keyed on the default page size so the SSR search resolves the
  // fixture connection (1 ProcessCreate edge).
  await session.registerStub({
    operation: "processCreateEvents",
    matchVariables: {
      first: 50,
      filter: { sensor: "sensor-a", agentId: "agent-007" },
    },
    response: {
      kind: "fixture",
      fixture: "external/giganto/processCreateEvents.page1.json",
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

test("event page redirects for user without event:read", async ({ page }) => {
  await signInAndWait(page, NOPERM_USER, NOPERM_PASS);
  await page.goto("/event");
  await page.waitForURL((url) => !url.pathname.includes("/event"), {
    timeout: 10_000,
  });
});

// ── Render + Conn search + pagination + detail ───────────────────

test("event page renders filter form, Conn search, pagination, detail", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");

  // Filter form mounted.
  await expect(page.getByRole("heading", { name: "Event" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel("Record type")).toBeVisible();

  // Single-sensor selector populated from the sensors query.
  const sensorTrigger = page.locator("#event-sensor");
  await sensorTrigger.click();
  await expect(page.getByRole("option", { name: "sensor-a" })).toBeVisible();
  await expect(page.getByRole("option", { name: "sensor-b" })).toBeVisible();
  await expect(page.getByRole("option", { name: "sensor-c" })).toBeVisible();
  await page.getByRole("option", { name: "sensor-a" }).click();

  // Run the search.
  await page.getByRole("button", { name: "Apply" }).click();

  // Results table: headers + a Conn row (state + service from fixture).
  await expect(page.getByRole("columnheader", { name: "State" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole("columnheader", { name: "Service" }),
  ).toBeVisible();
  await expect(page.getByText("ShDdAaFf")).toBeVisible();
  await expect(page.getByRole("cell", { name: "ssl" })).toBeVisible();

  // Pagination driven off pageInfo: Prev disabled, Next enabled.
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();

  // Next steps forward via `first/after`: page 2 content appears, the
  // cursor lands in the URL, and pageInfo flips Prev on / Next off.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("cell", { name: "http" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("ShDdAaFf")).toBeHidden();
  await expect(page).toHaveURL(/after=Y3Vyc29yOjE%3D/);
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

  // Previous steps backward via `last/before`: page 1 content returns
  // and the backward cursor lands in the URL.
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("ShDdAaFf")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("cell", { name: "http" })).toBeHidden();
  await expect(page).toHaveURL(/before=Y3Vyc29yOjI%3D/);

  // Page-size selector exposes 25 / 50 / 100.
  const pageSizeTrigger = page.getByLabel("Rows per page");
  await expect(pageSizeTrigger).toContainText("50");
  await pageSizeTrigger.click();
  await expect(page.getByRole("option", { name: "25" })).toBeVisible();
  await expect(page.getByRole("option", { name: "50" })).toBeVisible();
  await expect(page.getByRole("option", { name: "100" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Row detail sheet opens with the full record.
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(page.getByText("Connection detail")).toBeVisible();

  // Same-type history-navigation guard. A row detail must not survive a
  // browser Back that swaps the committed result set even when the
  // record type is unchanged — the edge the Round 4 review flagged.
  // Close the sheet, step forward to page 2 (still the Conn type, a
  // different result set), open a detail there, then walk history back
  // to page 1. The selection is keyed on the committed search identity
  // (the URL query string), so the page-2 detail is suppressed against
  // the now-committed page-1 search rather than lingering over rows that
  // have scrolled off. A record-type-only guard would miss this, since
  // both pages share the Conn type.
  await page.keyboard.press("Escape");
  await expect(page.getByText("Connection detail")).toBeHidden();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("cell", { name: "http" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(page.getByText("Connection detail")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("ShDdAaFf")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Connection detail")).toBeHidden();
});

// ── Sysmon type: filter adapts + endpoint results + stale-filter guard ──

test("sysmon type swaps IP/port for agent id, drops stale IP/port, lists endpoint events", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");

  await expect(page.getByRole("heading", { name: "Event" })).toBeVisible({
    timeout: 10_000,
  });

  // Default (Conn, network family): IP/port inputs present, no agent id.
  await expect(page.locator("#event-orig-addr-start")).toBeVisible();
  await expect(page.locator("#event-agent-id")).toHaveCount(0);

  // Enter stale IP/port values while on the network (Conn) type. These
  // must be dropped from the sysmon request after the switch below — the
  // stale-filter regression. The draft is retained across the record-type
  // switch (only `recordType` changes), so without the per-family
  // allow-list in `toNetworkFilter` these would leak into the sysmon
  // query.
  await page.locator("#event-orig-addr-start").fill("10.0.0.1");
  await page.locator("#event-orig-port-start").fill("11111");
  await page.locator("#event-resp-port-end").fill("22222");

  // Switch the record type to a Sysmon type.
  await page.locator("#event-record-type").click();
  await page.getByRole("option", { name: "Process create" }).click();

  // The filter adapts: agent-id input appears, IP/port inputs are gone.
  await expect(page.locator("#event-agent-id")).toBeVisible();
  await expect(page.locator("#event-orig-addr-start")).toHaveCount(0);
  await expect(page.locator("#event-resp-port-end")).toHaveCount(0);

  // Run a search for the sysmon type with sensor + agent id. The stub
  // matcher pins the request filter to exactly `{ sensor, agentId }`, so
  // the page only renders results if the stale IP/port values entered
  // above were dropped from the sent NetworkFilter.
  await page.locator("#event-agent-id").fill("agent-007");
  await page.locator("#event-sensor").click();
  await page.getByRole("option", { name: "sensor-a" }).click();
  await page.getByRole("button", { name: "Apply" }).click();

  // Generic results table renders the record's columns + a row value.
  await expect(page.getByRole("columnheader", { name: "Image" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole("columnheader", { name: "Command line" }),
  ).toBeVisible();
  await expect(page.getByText("cmd.exe /c whoami")).toBeVisible();

  // Row detail opens with the type-named title and full record.
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Process create" }),
  ).toBeVisible();
  await expect(page.getByText("Windows Command Processor")).toBeVisible();

  // The detail sheet is modal: its overlay blocks the filter form, so a
  // user must dismiss the sheet before changing the record type. Closing
  // it clears the committed selection, so no stale node can survive into
  // a subsequent search under a different record definition. (The
  // navigate-time `setDetail(null)` guard in `event-search.tsx` is the
  // defensive backstop for that same invariant.)
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Process create" }),
  ).toBeHidden();

  // Browser Back does not go through the in-page `navigate()` helper, so
  // it cannot rely on the navigate-time `setDetail(null)` guard. Reopen
  // the sysmon detail, then walk history back to the prior (network /
  // Conn) URL: the committed record type changes under the surviving
  // client selection. The detail must be suppressed against the
  // now-committed type rather than rendered through the wrong record
  // definition — this exercises the render-time `activeDetail` guard.
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Process create" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Process create" }),
  ).toBeHidden();

  // The filter form must resync to the committed URL after history
  // navigation, not keep rendering the surviving Sysmon draft. Back
  // landed on the default Conn `/event`, so the network IP/port inputs
  // return, the Sysmon-only agent-id input is gone, and the record-type
  // selector reads Conn — otherwise an Apply here would submit the stale
  // Sysmon draft over a committed Conn result.
  await expect(page.locator("#event-orig-addr-start")).toBeVisible();
  await expect(page.locator("#event-resp-port-end")).toBeVisible();
  await expect(page.locator("#event-agent-id")).toHaveCount(0);
  await expect(page.locator("#event-record-type")).toContainText(
    "Connection (Conn)",
  );
});

// ── Korean locale ────────────────────────────────────────────────

test("event page renders in Korean locale", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/ko/event");
  await expect(page.locator("#event-sensor")).toBeVisible({ timeout: 10_000 });
  // Localized prequery state (no sensor selected yet).
  await expect(
    page.getByText("센서를 선택하고 필터를 적용하여 원본 이벤트를 검색하세요."),
  ).toBeVisible();
});
