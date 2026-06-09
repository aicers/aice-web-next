import { expect, test } from "./fixtures";

import { resetRateLimits, signInAndWait } from "./helpers/auth";
import { resetAccountDefaults } from "./helpers/setup-db";
import { mockServerSession } from "./mock-server-admin";

/**
 * Per-type UI coverage for the E1 network raw-event slice. The E0 Conn
 * slice is exercised by `event.spec.ts`; this spec drives a representative
 * spread of the 19 E1 types through the live mock Giganto backend to verify
 * the descriptor-driven table + detail render the irregular shapes called
 * out in the issue:
 *
 *   - Http — a wide type: a curated summary column set, with the long tail
 *     of fields living in the row detail.
 *   - MalformedDns — its own (non-Dns) mapping of DNS-header counts and
 *     raw-byte payloads.
 *   - Icmp — no ports: bare addresses, disabled port filter inputs.
 *   - DceRpc — nested sub-records rendered readably in the detail view.
 *
 * Plus Relay Prev/Next pagination on a non-Conn type (Http).
 */

const session = mockServerSession("giganto");

test.beforeAll(async () => {
  await resetRateLimits();

  // Sensor list (single-sensor selector source).
  await session.registerStub({
    operation: "sensors",
    response: { kind: "fixture", fixture: "external/giganto/sensors.json" },
  });

  // Each type keys on the default page size (50) the SSR search sends.
  await session.registerStub({
    operation: "httpRawEvents",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "external/giganto/httpRawEvents.page1.json",
    },
  });
  // Http forward step: Next sends `first/after` with page 1's endCursor.
  await session.registerStub({
    operation: "httpRawEvents",
    matchVariables: { first: 50, after: "Y3Vyc29yOjE=" },
    response: {
      kind: "fixture",
      fixture: "external/giganto/httpRawEvents.page2.json",
    },
  });
  // Http backward step: Previous sends `last/before` with page 2's
  // startCursor, returning to page 1.
  await session.registerStub({
    operation: "httpRawEvents",
    matchVariables: { last: 50, before: "Y3Vyc29yOjI=" },
    response: {
      kind: "fixture",
      fixture: "external/giganto/httpRawEvents.page1.json",
    },
  });
  await session.registerStub({
    operation: "malformedDnsRawEvents",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "external/giganto/malformedDnsRawEvents.page1.json",
    },
  });
  await session.registerStub({
    operation: "icmpRawEvents",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "external/giganto/icmpRawEvents.page1.json",
    },
  });
  await session.registerStub({
    operation: "dceRpcRawEvents",
    matchVariables: { first: 50 },
    response: {
      kind: "fixture",
      fixture: "external/giganto/dceRpcRawEvents.page1.json",
    },
  });
});

test.beforeEach(async ({ workerUsername }) => {
  await resetRateLimits();
  await resetAccountDefaults(workerUsername);
});

test.afterAll(async () => {
  await session.clear();
});

/** Open the record-type selector and choose `label`, then select sensor-a. */
async function search(
  page: import("@playwright/test").Page,
  recordType: string,
) {
  await page.locator("#event-record-type").click();
  await page.getByRole("option", { name: recordType, exact: true }).click();

  // Sensor persists across record-type changes, but selecting it is
  // idempotent and keeps each search self-contained.
  await page.locator("#event-sensor").click();
  await page.getByRole("option", { name: "sensor-a" }).click();

  await page.getByRole("button", { name: "Apply" }).click();
}

test("Http renders a curated wide column set with the long tail in detail", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");
  await expect(page.getByLabel("Record type")).toBeVisible({ timeout: 10_000 });

  await search(page, "HTTP (Http)");

  // Curated summary columns (method/host/uri/statusCode), not the full set.
  await expect(
    page.getByRole("columnheader", { name: "HTTP Method" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("columnheader", { name: "Host" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "URI" })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Status Code" }),
  ).toBeVisible();
  // A wide-tail field (User Agent) is NOT a summary column.
  await expect(
    page.getByRole("columnheader", { name: "User Agent" }),
  ).toBeHidden();

  await expect(page.getByText("page1.example.test")).toBeVisible();

  // Row detail carries the full field list, including the long tail.
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(
    page.getByRole("heading", { name: "HTTP (Http)" }),
  ).toBeVisible();
  await expect(page.getByText("User Agent")).toBeVisible();
  await expect(page.getByText("Content Type")).toBeVisible();
  // A wide-tail value rendered verbatim in the detail (unique to this row).
  await expect(page.getByText("no-cache")).toBeVisible();
  await page.keyboard.press("Escape");

  // Relay Prev/Next pagination on a non-Conn type.
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("page2.example.test")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("page1.example.test")).toBeHidden();
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("page1.example.test")).toBeVisible({
    timeout: 10_000,
  });
});

test("MalformedDns uses its own non-Dns header-count + byte-payload mapping", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");
  await expect(page.getByLabel("Record type")).toBeVisible({ timeout: 10_000 });

  await search(page, "Malformed DNS (MalformedDns)");

  // MalformedDns-specific columns (DNS-header counts), never the Dns
  // query/answer/rcode columns.
  await expect(
    page.getByRole("columnheader", { name: "Transaction ID" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("columnheader", { name: "Question Record count" }),
  ).toBeVisible();
  // Its counts are the DNS-header record counts, not the Dns
  // query/answer/rcode columns (those Dns-only fields are absent from the
  // MalformedDns descriptor — asserted in descriptors.test.ts).
  await expect(
    page.getByRole("columnheader", { name: "Captured malformed query count" }),
  ).toBeVisible();

  // Detail: raw-byte payloads and string-typed byte/count scalars.
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Malformed DNS (MalformedDns)" }),
  ).toBeVisible();
  await expect(page.getByText("Total malformed query bytes")).toBeVisible();
  await expect(page.getByText("Raw malformed query payloads")).toBeVisible();
  // The U64 query-bytes scalar is carried as a string and formatted via
  // BigInt locale grouping — not rounded through a lossy JS number (which
  // would surface 18446744073709552000).
  await expect(page.getByText("18,446,744,073,709,551,615")).toBeVisible();
  // The [[Int!]!]! payload renders one byte row per line.
  await expect(page.getByText("[1, 2]")).toBeVisible();
});

test("Icmp omits ports in table, detail, and the filter inputs", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");
  await expect(page.getByLabel("Record type")).toBeVisible({ timeout: 10_000 });

  // Selecting Icmp disables the port filter inputs and shows the notice.
  await page.locator("#event-record-type").click();
  await page.getByRole("option", { name: "ICMP (Icmp)", exact: true }).click();
  await expect(page.locator("#event-orig-port-start")).toBeDisabled();
  await expect(page.locator("#event-resp-port-start")).toBeDisabled();
  await expect(
    page.getByText(
      "ICMP records have no ports, so port ranges are not applied.",
    ),
  ).toBeVisible();

  await page.locator("#event-sensor").click();
  await page.getByRole("option", { name: "sensor-a" }).click();
  await page.getByRole("button", { name: "Apply" }).click();

  // Icmp-specific summary columns.
  await expect(
    page.getByRole("columnheader", { name: "ICMP Type" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("columnheader", { name: "Sequence Number" }),
  ).toBeVisible();

  // Source/destination cells render bare addresses (no `:port`).
  const sourceCell = page.getByRole("cell", {
    name: "192.0.2.10",
    exact: true,
  });
  await expect(sourceCell).toBeVisible();

  // Detail endpoint summary is portless (`orig → resp`, no colons).
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(
    page.getByRole("heading", { name: "ICMP (Icmp)" }),
  ).toBeVisible();
  await expect(page.getByText("192.0.2.10 → 192.0.2.20")).toBeVisible();
  await expect(page.getByText("Payload")).toBeVisible();
});

test("DceRpc renders nested bind-context sub-records in the detail view", async ({
  page,
  workerUsername,
  workerPassword,
}) => {
  await signInAndWait(page, workerUsername, workerPassword);
  await page.goto("/event");
  await expect(page.getByLabel("Record type")).toBeVisible({ timeout: 10_000 });

  await search(page, "DCE/RPC (DceRpc)");

  await expect(
    page.getByRole("columnheader", { name: "Bind Contexts" }),
  ).toBeVisible({ timeout: 10_000 });

  // Detail: the `context: [DceRpcContextRawEvent!]!` sub-records render as
  // labelled mini definition lists.
  await page.getByRole("row", { name: "View details" }).first().click();
  await expect(
    page.getByRole("heading", { name: "DCE/RPC (DceRpc)" }),
  ).toBeVisible();
  await expect(
    page.getByText("Abstract syntax", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("00000000000000000000000000000000"),
  ).toBeVisible();
});
