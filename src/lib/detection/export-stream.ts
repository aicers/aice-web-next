import "server-only";

import type { AuthSession } from "@/lib/auth/jwt";

import {
  CSV_EXPORT_MAX_ROWS,
  type CsvColumnHeaders,
  type FormatCsvRowOptions,
  formatCsvHeader,
  formatCsvRow,
} from "./csv-export";
import type { Filter } from "./filter";
import { searchEvents } from "./server-actions";

export { CSV_EXPORT_MAX_ROWS } from "./csv-export";

/**
 * Page size used when iterating through the full result set for a
 * CSV export. Larger than the interactive page size to cut down on
 * round-trips to REview — the shell's default interactive page is
 * tuned for latency, not bulk fetches.
 */
export const CSV_EXPORT_PAGE_SIZE = 500;

/**
 * Thrown by the stream when iteration crosses
 * {@link CSV_EXPORT_MAX_ROWS}. The surrounding `start` catch block
 * forwards it to `controller.error(...)`, which aborts the client
 * download rather than letting the browser accept a truncated file
 * as a clean 200.
 */
export class CsvExportRowLimitExceededError extends Error {
  constructor() {
    super(
      `Detection CSV export exceeded the ${CSV_EXPORT_MAX_ROWS}-row hard cap`,
    );
    this.name = "CsvExportRowLimitExceededError";
  }
}

/**
 * Thrown by the stream when REview's pagination metadata is
 * internally inconsistent — either `hasNextPage` is true but no
 * `endCursor` was returned, or the cursor fails to advance between
 * pages (which would otherwise spin the loop forever or until the
 * hard cap trips). Forwarded to `controller.error(...)` so the
 * browser surfaces a failed download rather than a clean 200 with a
 * truncated body.
 */
export class CsvExportPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvExportPaginationError";
  }
}

export interface CsvExportOptions {
  session: AuthSession;
  filter: Filter;
  headers: CsvColumnHeaders;
  formatRowOptions: FormatCsvRowOptions;
  /**
   * Optional abort signal wired to the incoming `Request.signal`
   * so the pagination loop stops at the next page boundary when
   * the client disconnects. Without this the source would keep
   * fetching REview pages after a canceled download because the
   * stream's own `cancel()` hook only fires when the consumer is
   * still present to drain the body.
   */
  signal?: AbortSignal;
}

/**
 * Build a `ReadableStream` that emits the full CSV export for
 * `filter`. The stream writes the header row first, then pages
 * through the Detection result set via `searchEvents`, formatting
 * each event as one CSV row.
 *
 * Backpressure: the producer is driven by `pull()` and a small
 * per-page buffer, so new REview pages are only fetched when the
 * consumer has drained previous rows (`desiredSize > 0`). That
 * means a slow/stalled client cannot push the server into eagerly
 * buffering the whole result set — peak server memory is bounded
 * by one page of encoded rows plus whatever the platform queues
 * between the source and the network socket.
 *
 * Cancellation: when the consumer cancels (client disconnects, the
 * Chromium save picker is dismissed and `response.body.cancel()`
 * runs, etc.) the stream's `cancel()` hook flips a flag so the
 * next page boundary exits the loop promptly. The optional
 * `signal` plumbs the same cancellation through the incoming
 * `Request.signal` for the case where the consumer goes away
 * before a reader is even attached (Next.js invokes `cancel()` on
 * the body in that scenario too, but the signal gives us a
 * belt-and-braces hook that also works if the runtime's cancel
 * semantics drift).
 *
 * Errors mid-stream (REview hiccup, connection reset) surface as
 * stream aborts rather than partial-but-plausible files: the
 * underlying `ReadableStream.controller.error(...)` call causes
 * the client's `fetch` promise to reject with a network error, so
 * the download is discarded by the browser. That matches the
 * acceptance "Errors during streaming surface clearly without
 * corrupting partial files" — the half-written file never reaches
 * a plausible terminal state because the stream never signals
 * clean closure.
 */
export function createCsvExportStream(
  options: CsvExportOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { session, filter, headers, formatRowOptions, signal } = options;

  let after: string | undefined;
  let emitted = 0;
  let headerWritten = false;
  let exhausted = false;
  let cancelled = false;
  // Buffer of already-formatted rows waiting to be enqueued. Bounded
  // by `CSV_EXPORT_PAGE_SIZE` — `pull()` only fetches a new page
  // when the buffer has been fully drained.
  const pending: Uint8Array[] = [];

  const onAbort = () => {
    cancelled = true;
  };
  if (signal) {
    if (signal.aborted) cancelled = true;
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        controller.close();
        return;
      }
      try {
        if (!headerWritten) {
          headerWritten = true;
          controller.enqueue(encoder.encode(formatCsvHeader(headers)));
        }
        // Loop while the consumer wants more bytes. `desiredSize`
        // drops to 0 (or negative) when the downstream queue fills
        // up, at which point we return and the stream machinery
        // calls `pull()` again after the consumer drains. This is
        // the backpressure-aware branch Reviewer Round 9 asked for:
        // no fetch happens when the consumer isn't reading.
        while ((controller.desiredSize ?? 1) > 0) {
          if (cancelled) return;
          if (pending.length > 0) {
            controller.enqueue(pending.shift() as Uint8Array);
            continue;
          }
          if (exhausted) {
            controller.close();
            return;
          }
          const connection = await searchEvents(session, filter, {
            first: CSV_EXPORT_PAGE_SIZE,
            after,
          });
          // Re-check after the await in case the consumer went away
          // (save picker dismissed, client disconnected) while we
          // were waiting on REview. Dropping the fetched page here
          // costs one extra round-trip but avoids encoding + holding
          // 500 rows we'll never ship.
          if (cancelled) return;
          for (const edge of connection.edges) {
            if (emitted >= CSV_EXPORT_MAX_ROWS) {
              // Preflight should reject counts above the cap before
              // we start streaming — reaching this point means the
              // underlying result set grew concurrently. Abort the
              // stream so the browser surfaces a failed download
              // rather than accepting a silently truncated 200.
              throw new CsvExportRowLimitExceededError();
            }
            pending.push(
              encoder.encode(formatCsvRow(edge.node, formatRowOptions)),
            );
            emitted += 1;
          }
          if (!connection.pageInfo.hasNextPage) {
            exhausted = true;
          } else {
            const nextCursor = connection.pageInfo.endCursor;
            if (!nextCursor) {
              // REview signalled more pages but gave us no cursor
              // to fetch them with. Treating this as a clean close
              // would hand the browser a truncated file under a
              // 200; abort instead so the download fails visibly.
              throw new CsvExportPaginationError(
                "Detection CSV export aborted: hasNextPage was true but endCursor was missing",
              );
            }
            if (nextCursor === after) {
              // Cursor failed to advance. Without this guard the
              // loop would either spin forever or silently stop
              // when `emitted` crosses the hard cap, both of which
              // violate the "failures surface clearly" acceptance.
              throw new CsvExportPaginationError(
                "Detection CSV export aborted: endCursor did not advance between pages",
              );
            }
            after = nextCursor;
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      // Consumer gave up (body.cancel(), pipe abort, client
      // disconnect). Flip the flag so the pagination loop exits at
      // the next iteration instead of continuing to fetch pages
      // into a stream nobody is reading.
      cancelled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  });
}

/**
 * Fetch only the total count for `filter` — used before the stream
 * begins so the large-export confirmation has a row count to quote.
 * Issues a single `searchEvents` call with `first: 1` so REview
 * returns `totalCount` alongside a trivial page; the one-row
 * payload is discarded.
 */
export async function fetchExportRowCount(
  session: AuthSession,
  filter: Filter,
): Promise<string> {
  const connection = await searchEvents(session, filter, { first: 1 });
  return connection.totalCount;
}
