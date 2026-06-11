/**
 * Breadcrumb labels on the event and node detail pages (#746).
 *
 * The dashboard breadcrumb must render a meaningful label for the two
 * dynamic detail routes instead of the opaque token / id:
 *
 *   - `events/[token]` → `{compact time} · {event kind}`, time-first
 *     with no year and no seconds, honouring the user's timezone and the
 *     active app locale; the kind reuses `EVENT_KIND_FRIENDLY_NAMES`.
 *   - `nodes/[id]` → the node display name shown as the page `h1`.
 *
 * Drives the live mock backends. The event fixture `evt-manual-dynamic-1`
 * carries `__typename: HttpThreat` ("HTTP Threat") at `2026-04-22T12:00Z`;
 * the node fixture `nodeDetail.alpha.json` is id `11`, name `alpha-node`
 * (`nameDraft` null → display name "alpha-node").
 */
import type { Page } from "@playwright/test";

import { encodeEventLocator } from "@/lib/events/event-locator";

import { expect, test } from "./fixtures";
import {
  resetRateLimits,
  signInAndWait,
  signInAndWaitKo,
} from "./helpers/auth";
import { mockServerSession } from "./mock-server-admin";

const EVENT_ID = "evt-manual-dynamic-1";
const EVENT_TOKEN = encodeEventLocator({ id: EVENT_ID });
if (!EVENT_TOKEN) throw new Error("failed to build event token");

const session = mockServerSession();

const breadcrumb = (page: Page) =>
  page.getByRole("navigation", { name: "Breadcrumb" });

test.beforeAll(async () => {
  // Only the `event` query (scoped to this token's id) and the `node`
  // query (scoped to id 11) are stubbed, both keyed by matchVariables so
  // they cannot match another parallel spec's request on the shared mock
  // server. Everything else is left unstubbed on purpose: the breadcrumb
  // derives solely from `event.time` / `event.__typename` (and the node
  // display name), so the client-side investigation charts
  // (eventCountsByOriginatorIpAddress / eventFrequencySeries) and the
  // node status list need no stubs here. Registering those without
  // matchVariables would leak the manual fixtures into other specs (e.g.
  // the triage funnel's 30-day eventFrequencySeries) and break them.
  await session.registerStub({
    operation: "event",
    matchVariables: { id: EVENT_ID },
    response: {
      kind: "fixture",
      fixture: "detection/event.manual-detail.json",
    },
  });
  await session.registerStub({
    operation: "node",
    matchVariables: { id: "11" },
    response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
  });
});

test.afterAll(async () => {
  await session.clear();
});

test.beforeEach(async () => {
  await resetRateLimits();
});

test.describe
  .serial("Detail-page breadcrumb labels (#746)", () => {
    test("event detail shows {time} · {kind}, never the opaque token (EN)", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto(`/detection/events/${EVENT_TOKEN}`);
      await expect(
        page.getByRole("heading", { name: "HTTP Threat" }),
      ).toBeVisible({ timeout: 30_000 });

      const nav = breadcrumb(page);
      // The rich label is published by a client effect after hydration —
      // these retrying assertions wait for it to commit.
      await expect(nav).toContainText("HTTP Threat"); // event kind
      await expect(nav).toContainText("·"); // time · kind separator

      const text = (await nav.textContent()) ?? "";
      expect(text).not.toContain(EVENT_TOKEN); // never the opaque token
      expect(text).not.toContain("2026"); // year dropped
      expect(text).not.toMatch(/\d:\d\d:\d\d/); // no HH:MM:SS → seconds dropped
      expect(text).toMatch(/AM|PM/i); // EN locale time marker
    });

    test("event detail time honours the active KO locale", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto(`/ko/detection/events/${EVENT_TOKEN}`);
      await expect(
        page.getByRole("heading", { name: "HTTP Threat" }),
      ).toBeVisible({ timeout: 30_000 });

      const nav = breadcrumb(page);
      await expect(nav).toContainText("이벤트"); // translated parent
      await expect(nav).toContainText("HTTP Threat"); // kind stays English

      const text = (await nav.textContent()) ?? "";
      expect(text).not.toContain(EVENT_TOKEN);
      expect(text).not.toContain("2026");
      // KO `Intl` time output uses 오전/오후, not the Latin AM/PM the EN
      // locale renders — proves the active app locale reached the label.
      expect(text).not.toMatch(/AM|PM/i);
    });

    test("node detail shows the display name, never the raw id", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/nodes/11");
      await page
        .getByTestId("node-detail-page")
        .or(page.getByTestId("manager-unavailable-panel"))
        .waitFor({ timeout: 30_000 });

      const nav = breadcrumb(page);
      await expect(nav).toContainText("Nodes"); // translated parent
      await expect(nav).toContainText("alpha-node"); // display name
      // The breadcrumb name matches the page `h1` title.
      await expect(page.getByTestId("node-detail-title")).toContainText(
        "alpha-node",
      );
    });

    test("/nodes list breadcrumb is translated (EN Nodes / KO 노드)", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);
      await page.goto("/nodes");
      await expect(breadcrumb(page)).toContainText("Nodes");

      await signInAndWaitKo(page, workerUsername, workerPassword);
      await page.goto("/ko/nodes");
      await expect(breadcrumb(page)).toContainText("노드");
    });

    test("direct nav between two detail pages keeps the destination label", async ({
      page,
      workerUsername,
      workerPassword,
    }) => {
      await signInAndWait(page, workerUsername, workerPassword);

      await page.goto(`/detection/events/${EVENT_TOKEN}`);
      await expect(
        page.getByRole("heading", { name: "HTTP Threat" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(breadcrumb(page)).toContainText("HTTP Threat");

      // Navigate straight to node detail — the compare-and-clear cleanup
      // must keep the destination's label and not leave the stale one.
      await page.goto("/nodes/11");
      await page
        .getByTestId("node-detail-page")
        .or(page.getByTestId("manager-unavailable-panel"))
        .waitFor({ timeout: 30_000 });
      const nav = breadcrumb(page);
      await expect(nav).toContainText("alpha-node");
      await expect(nav).not.toContainText("HTTP Threat"); // no stale label
    });
  });
