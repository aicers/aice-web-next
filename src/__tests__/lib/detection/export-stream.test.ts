import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/lib/auth/jwt";
import {
  type CsvColumnHeaders,
  DEFAULT_CSV_HEADERS,
  type FormatCsvRowOptions,
} from "@/lib/detection/csv-export";
import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";

const mockSearchEvents = vi.hoisted(() => vi.fn());

vi.mock("@/lib/detection/server-actions", () => ({
  searchEvents: mockSearchEvents,
}));

const ROW_OPTIONS: FormatCsvRowOptions = {
  levelLabels: {
    VERY_LOW: "Very Low",
    LOW: "Low",
    MEDIUM: "Medium",
    HIGH: "High",
    VERY_HIGH: "Very High",
  },
  categoryLabels: {},
  countryUnknown: "??",
  countryUnavailable: "—",
  triageSummaryTemplate: "{count} policies · {max} max",
  moreCountSuffixTemplate: "+{count} more",
};

const HEADERS: CsvColumnHeaders = { ...DEFAULT_CSV_HEADERS };

const FILTER = {
  mode: "structured" as const,
  input: {
    start: "2026-04-22T00:00:00.000Z",
    end: "2026-04-22T01:00:00.000Z",
  },
};

function buildSession(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Security Monitor"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0",
    sessionBrowserFingerprint: "Chrome/131",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
  };
}

const EVENT = {
  __typename: "HttpThreat",
  time: "2026-04-22T00:00:00.000Z",
  sensor: "sensor-1",
  confidence: 0.8,
  category: null,
  level: "LOW",
  triageScores: null,
  origAddr: "10.0.0.5",
  respAddr: "10.0.0.6",
};

describe("createCsvExportStream", () => {
  beforeEach(() => {
    mockSearchEvents.mockReset();
  });

  // #405 P1: review 0.47.0 rejects `first` / `last` outside [0,100]
  // with a GraphQL-level error. The CSV export shares the same
  // connection shape as the interactive list, so its page size must
  // also be capped at REVIEW_MAX_PAGE_SIZE — otherwise the preflight
  // (`first: 1`) succeeds, the route emits a 200 with headers, and
  // the stream fails the download as soon as it pulls the first
  // page. This test pins the cap at the dispatch boundary.
  it("dispatches each page with first <= REVIEW_MAX_PAGE_SIZE", async () => {
    mockSearchEvents.mockResolvedValue({
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [],
      nodes: [],
      totalCount: "0",
    });

    const { createCsvExportStream, CSV_EXPORT_PAGE_SIZE } = await import(
      "@/lib/detection/export-stream"
    );
    expect(CSV_EXPORT_PAGE_SIZE).toBeLessThanOrEqual(REVIEW_MAX_PAGE_SIZE);

    const stream = createCsvExportStream({
      session: buildSession(),
      filter: FILTER,
      headers: HEADERS,
      formatRowOptions: ROW_OPTIONS,
    });
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(mockSearchEvents).toHaveBeenCalled();
    for (const call of mockSearchEvents.mock.calls) {
      const args = call[2] as { first?: number };
      expect(args.first).toBeLessThanOrEqual(REVIEW_MAX_PAGE_SIZE);
    }
  });

  it("does not fetch additional pages while the consumer has not drained the first page", async () => {
    // Page 1 claims a next page exists; if the stream did not
    // respect backpressure it would eagerly fetch page 2 even
    // though the consumer has not yet requested any chunks.
    mockSearchEvents
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        edges: Array.from({ length: 5 }, (_, i) => ({
          cursor: `c${i}`,
          node: EVENT,
        })),
        nodes: Array.from({ length: 5 }, () => EVENT),
        totalCount: "10",
      })
      .mockResolvedValueOnce({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: Array.from({ length: 5 }, (_, i) => ({
          cursor: `d${i}`,
          node: EVENT,
        })),
        nodes: Array.from({ length: 5 }, () => EVENT),
        totalCount: "10",
      });

    const { createCsvExportStream } = await import(
      "@/lib/detection/export-stream"
    );
    const stream = createCsvExportStream({
      session: buildSession(),
      filter: FILTER,
      headers: HEADERS,
      formatRowOptions: ROW_OPTIONS,
    });

    const reader = stream.getReader();
    // Read one chunk (the header). The page-1 buffer is now loaded
    // so the producer can serve subsequent rows without another
    // fetch, but it must NOT have issued the page-2 fetch yet.
    await reader.read();
    // Yield so any stray pending microtasks in the producer can
    // settle before we assert.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSearchEvents).toHaveBeenCalledTimes(1);

    // Drain the buffered rows and the next page to make sure the
    // stream still terminates cleanly under backpressure.
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(mockSearchEvents).toHaveBeenCalledTimes(2);
  });

  it("stops fetching pages when the consumer cancels the body", async () => {
    mockSearchEvents.mockResolvedValue({
      pageInfo: { hasNextPage: true, endCursor: "cursor-n" },
      edges: Array.from({ length: 5 }, (_, i) => ({
        cursor: `c${i}`,
        node: EVENT,
      })),
      nodes: Array.from({ length: 5 }, () => EVENT),
      totalCount: "10000",
    });

    const { createCsvExportStream } = await import(
      "@/lib/detection/export-stream"
    );
    const stream = createCsvExportStream({
      session: buildSession(),
      filter: FILTER,
      headers: HEADERS,
      formatRowOptions: ROW_OPTIONS,
    });

    const reader = stream.getReader();
    await reader.read(); // header
    await reader.read(); // first data row (forces page fetch)
    const fetchesBeforeCancel = mockSearchEvents.mock.calls.length;

    await reader.cancel();
    // Give the producer a tick to notice the flip.
    await Promise.resolve();
    await Promise.resolve();

    // Drain whatever the runtime has queued so we can observe
    // whether the loop tried to fetch another page after cancel.
    // It must not — `cancel()` flipped the flag, so the producer
    // returns at the top of the next `pull()` iteration.
    const later = mockSearchEvents.mock.calls.length;
    // Allow at most one in-flight fetch that was already awaited
    // before the cancel arrived; assert we did not keep looping.
    expect(later - fetchesBeforeCancel).toBeLessThanOrEqual(1);

    // A subsequent read must reflect the cancelled stream.
    const next = await reader.read();
    expect(next.done).toBe(true);
  });

  it("stops fetching pages when the upstream abort signal fires", async () => {
    mockSearchEvents.mockResolvedValue({
      pageInfo: { hasNextPage: true, endCursor: "cursor-n" },
      edges: Array.from({ length: 5 }, (_, i) => ({
        cursor: `c${i}`,
        node: EVENT,
      })),
      nodes: Array.from({ length: 5 }, () => EVENT),
      totalCount: "10000",
    });

    const { createCsvExportStream } = await import(
      "@/lib/detection/export-stream"
    );
    const controller = new AbortController();
    const stream = createCsvExportStream({
      session: buildSession(),
      filter: FILTER,
      headers: HEADERS,
      formatRowOptions: ROW_OPTIONS,
      signal: controller.signal,
    });

    const reader = stream.getReader();
    await reader.read(); // header
    await reader.read(); // first data row (forces page fetch)
    const fetchesBeforeAbort = mockSearchEvents.mock.calls.length;

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    // Drain the stream; the signal-driven flag must stop the loop.
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const later = mockSearchEvents.mock.calls.length;
    expect(later - fetchesBeforeAbort).toBeLessThanOrEqual(1);
  });

  // The pre-#342 export waited for the in-flight page to complete
  // before checking the cancel flag, so a Cancel mid-stream still
  // burned tens of seconds on the active REview round-trip. The fix
  // forwards the abort signal into each `searchEvents` page request
  // so the in-flight page rejects with `AbortError` and the loop
  // exits within one microtask of the abort. These tests pin both
  // halves of that contract: the signal reaches `searchEvents`, and
  // an in-flight rejection is treated as a clean cancel rather than
  // a producer-side error.
  it("forwards the upstream abort signal into each searchEvents page request", async () => {
    mockSearchEvents.mockResolvedValue({
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [],
      nodes: [],
      totalCount: "0",
    });

    const { createCsvExportStream } = await import(
      "@/lib/detection/export-stream"
    );
    const controller = new AbortController();
    const stream = createCsvExportStream({
      session: buildSession(),
      filter: FILTER,
      headers: HEADERS,
      formatRowOptions: ROW_OPTIONS,
      signal: controller.signal,
    });

    const reader = stream.getReader();
    await reader.read(); // header
    await reader.read(); // forces page fetch
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // searchEvents was called with (session, filter, args, signal).
    // The 4th argument must be the AbortSignal we passed in so that
    // graphqlRequest can forward it to undici.
    expect(mockSearchEvents).toHaveBeenCalled();
    for (const call of mockSearchEvents.mock.calls) {
      expect(call[3]).toBe(controller.signal);
    }
  });

  it("ends the in-flight page promptly when the signal aborts mid-fetch", async () => {
    // Simulate a slow REview page: the resolver never resolves on
    // its own; it only rejects when the forwarded AbortSignal fires.
    let pageResolves = 0;
    let pageRejects = 0;
    mockSearchEvents.mockImplementation(
      (
        _session: unknown,
        _filter: unknown,
        _args: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise((resolve, reject) => {
          if (!signal) {
            // Without forwarding, the producer would block forever.
            // Track this so a regression to "signal not threaded"
            // surfaces as a leaked never-resolving fetch.
            return;
          }
          if (signal.aborted) {
            pageRejects += 1;
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              pageRejects += 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          void resolve;
          void (() => {
            pageResolves += 1;
          });
        }),
    );

    const { createCsvExportStream } = await import(
      "@/lib/detection/export-stream"
    );
    const controller = new AbortController();
    const stream = createCsvExportStream({
      session: buildSession(),
      filter: FILTER,
      headers: HEADERS,
      formatRowOptions: ROW_OPTIONS,
      signal: controller.signal,
    });

    const reader = stream.getReader();
    await reader.read(); // header
    const dataReadPromise = reader.read(); // triggers the in-flight page fetch
    // Yield so the pull() loop has time to enter the awaited page.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSearchEvents).toHaveBeenCalledTimes(1);

    controller.abort();
    // The page promise should now reject promptly with AbortError;
    // the stream's catch block must treat it as a clean cancel
    // (controller.close()) rather than a producer error so the next
    // read resolves to `{ done: true }`.
    const result = await dataReadPromise;
    expect(result.done).toBe(true);
    expect(pageRejects).toBe(1);
    expect(pageResolves).toBe(0);
    // No additional pages were attempted after the abort.
    expect(mockSearchEvents).toHaveBeenCalledTimes(1);
  });

  // `EVENT_LIST_QUERY` only selects the per-typename inline fragments
  // (addressing fields, identity fields, etc.) under the `nodes` path
  // — `edges.node` carries the bare common interface fields. Streaming
  // CSV rows from `edges.node` would emit the new `User` / `Host`
  // identity columns empty even when the row's typename emits those
  // fields, because the request never asked for them on `edges.node`.
  // This regression locks the producer to read from `connection.nodes`
  // by mocking the two sibling paths with deliberately divergent
  // shapes: identity-bearing rich nodes under `nodes`, and bare
  // common-field nodes under `edges`. If the producer drifts back to
  // iterating `edges`, the assertion on the `User` / `Host` cells in
  // the streamed body fails.
  it("streams identity columns from connection.nodes, not edges.node", async () => {
    const RICH_HTTP_THREAT = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "LOW",
      triageScores: null,
      origAddr: "10.0.0.5",
      origPort: 4444,
      respAddr: "10.0.0.6",
      respPort: 80,
      username: "alice",
      host: "example.test",
    };
    const COMMON_FIELDS_ONLY = {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: null,
      level: "LOW",
      triageScores: null,
    };
    mockSearchEvents.mockResolvedValueOnce({
      pageInfo: { hasNextPage: false, endCursor: null },
      // `edges.node` mirrors what the EVENT_LIST_QUERY actually selects
      // there — interface-level fields only, no identity fragments.
      edges: [{ cursor: "c0", node: COMMON_FIELDS_ONLY }],
      // `nodes` carries the rich per-typename selection set — this is
      // where `username` / `host` arrive in the real response.
      nodes: [RICH_HTTP_THREAT],
      totalCount: "1",
    });

    const { createCsvExportStream } = await import(
      "@/lib/detection/export-stream"
    );
    const stream = createCsvExportStream({
      session: buildSession(),
      filter: FILTER,
      headers: HEADERS,
      formatRowOptions: ROW_OPTIONS,
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();

    const lines = body.split("\r\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2); // header + 1 data row
    const dataRow = lines[1];
    // The trailing two columns are `User` and `Host` per
    // `CSV_COLUMN_KEYS` / `DEFAULT_CSV_HEADERS`. They must reflect
    // the values from `connection.nodes` — not the empty values the
    // bare `edges.node` shape would produce.
    const cells = dataRow.split(",");
    expect(cells[cells.length - 2]).toBe("alice");
    expect(cells[cells.length - 1]).toBe("example.test");
  });
});
