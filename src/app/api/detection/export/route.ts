import "server-only";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import {
  AVERAGE_CSV_ROW_BYTES,
  buildExportFilename,
  CSV_COLUMN_KEYS,
  type CsvColumnHeaders,
  type FormatCsvRowOptions,
  LARGE_EXPORT_ROW_THRESHOLD,
} from "@/lib/detection/csv-export";
import {
  DetectionForbiddenError,
  DetectionUnauthorizedError,
} from "@/lib/detection/errors";
import {
  CSV_EXPORT_MAX_ROWS,
  createCsvExportStream,
  fetchExportRowCount,
} from "@/lib/detection/export-stream";
import type { Filter } from "@/lib/detection/filter";

interface ExportRequestBody {
  filter?: Filter;
  /**
   * Set by the client after the operator acknowledges the large-
   * export confirmation dialog. Skipping the threshold check on a
   * request without this flag means the BFF cannot stream huge
   * payloads by mistake — every large export is deliberate.
   */
  confirmedLargeExport?: boolean;
  /**
   * Optional period slug for the filename summary. The client
   * passes `"1h"`, `"24h"`, etc. when the committed filter was
   * applied via a period chip; the server falls back to the
   * explicit start/end range when this is absent.
   */
  periodKey?: string | null;
  /**
   * Per-locale CSV header labels (column names) and friendly
   * category / severity label maps. Sending the client-side
   * labels lets the CSV stay in lockstep with what the operator
   * sees in the result list.
   */
  headers?: CsvColumnHeaders;
  formatRowOptions?: FormatCsvRowOptions;
  /**
   * Client-decided filename (e.g.
   * `detection-events_2026-04-20T15-32_last-1h.csv`). The client
   * pins this at click time so the Chromium save picker's
   * `suggestedName` and the response's `Content-Disposition` stay
   * aligned. The server validates the shape and falls back to a
   * freshly built name when the field is absent or malformed.
   */
  filename?: string;
}

/**
 * Whitelist of characters permitted in a client-supplied filename.
 * Mirrors the output of `sanitizeFilenameSegment` in `csv-export.ts`
 * (alphanumerics, `.`, `_`, `-`) so a malicious client cannot inject
 * quotes, path separators, CR/LF, or control characters into the
 * Content-Disposition header — which would enable header smuggling
 * or filename spoofing.
 */
const SAFE_CSV_FILENAME = /^[A-Za-z0-9._-]+\.csv$/;

function isSafeFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    SAFE_CSV_FILENAME.test(value)
  );
}

function isFilter(value: unknown): value is Filter {
  if (!value || typeof value !== "object") return false;
  const mode = (value as { mode?: unknown }).mode;
  if (mode === "structured") {
    const input = (value as { input?: unknown }).input;
    return typeof input === "object" && input !== null;
  }
  if (mode === "query") {
    return typeof (value as { text?: unknown }).text === "string";
  }
  return false;
}

function isCsvColumnHeaders(value: unknown): value is CsvColumnHeaders {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of CSV_COLUMN_KEYS) {
    if (typeof record[key] !== "string") return false;
  }
  return true;
}

function isFormatRowOptions(value: unknown): value is FormatCsvRowOptions {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.categoryLabels === "object" &&
    record.categoryLabels !== null &&
    typeof record.levelLabels === "object" &&
    record.levelLabels !== null &&
    typeof record.countryUnknown === "string" &&
    typeof record.countryUnavailable === "string" &&
    typeof record.triageSummaryTemplate === "string" &&
    typeof record.moreCountSuffixTemplate === "string"
  );
}

/**
 * POST /api/detection/export
 *
 * Streams the current tab's filtered result set as CSV. Body:
 *
 * ```json
 * {
 *   "filter": <Filter>,
 *   "periodKey": "1h" | null,
 *   "confirmedLargeExport": false,
 *   "headers": {...},
 *   "formatRowOptions": {"categoryLabels": {...}, "levelLabels": {...}}
 * }
 * ```
 *
 * Response shapes:
 * - `200 text/csv` — streamed CSV body.
 * - `409 application/json` — `{ code: "confirmation-required",
 *   totalCount, estimatedBytes }` when the estimated row count is
 *   at or above the large-export threshold and the request did not
 *   set `confirmedLargeExport: true`. The client shows a
 *   confirmation with the quoted count / size and re-POSTs with
 *   the flag set when the operator continues.
 * - `413 application/json` — `{ code: "row-limit-exceeded",
 *   totalCount, limit }` when the estimated row count is above the
 *   hard per-export ceiling. The cap exists so a single export
 *   cannot stream an unbounded result set; the client surfaces it
 *   as a dedicated error that instructs the operator to narrow the
 *   filter.
 * - `400` on a malformed body, `403` on missing permission / scope,
 *   `500` on an unknown failure.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    let body: ExportRequestBody;
    try {
      body = (await request.json()) as ExportRequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!isFilter(body.filter)) {
      return NextResponse.json(
        { error: "Missing or malformed `filter`" },
        { status: 400 },
      );
    }
    if (!isCsvColumnHeaders(body.headers)) {
      return NextResponse.json(
        { error: "Missing or malformed `headers`" },
        { status: 400 },
      );
    }
    if (!isFormatRowOptions(body.formatRowOptions)) {
      return NextResponse.json(
        { error: "Missing or malformed `formatRowOptions`" },
        { status: 400 },
      );
    }

    const filter = body.filter;
    const headers = body.headers;
    const formatRowOptions = body.formatRowOptions;
    const confirmedLargeExport = body.confirmedLargeExport === true;

    try {
      const totalCount = await fetchExportRowCount(
        session,
        filter,
        request.signal,
      );
      const asNumber = Number.parseInt(totalCount, 10);
      if (Number.isFinite(asNumber) && asNumber > CSV_EXPORT_MAX_ROWS) {
        // Hard ceiling: fail loudly instead of silently truncating
        // the download. See `CSV_EXPORT_MAX_ROWS` — the streaming
        // loop would otherwise stop at the cap and return a 200
        // with fewer rows than `X-Total-Count` advertised.
        return NextResponse.json(
          {
            code: "row-limit-exceeded",
            totalCount,
            limit: CSV_EXPORT_MAX_ROWS,
          },
          { status: 413 },
        );
      }
      if (
        Number.isFinite(asNumber) &&
        asNumber >= LARGE_EXPORT_ROW_THRESHOLD &&
        !confirmedLargeExport
      ) {
        return NextResponse.json(
          {
            code: "confirmation-required",
            totalCount,
            estimatedBytes: asNumber * AVERAGE_CSV_ROW_BYTES,
            threshold: LARGE_EXPORT_ROW_THRESHOLD,
          },
          { status: 409 },
        );
      }

      // Prefer the client-pinned filename so the Chromium save
      // picker and the Content-Disposition header quote the same
      // timestamp and filter summary. Fall back to a freshly-built
      // name when the client didn't send one or when the value
      // failed sanitization (header-smuggling guard).
      const filename = isSafeFilename(body.filename)
        ? body.filename
        : buildExportFilename(filter, {
            periodKey: body.periodKey ?? null,
          });
      const stream = createCsvExportStream({
        session,
        filter,
        headers,
        formatRowOptions,
        // Propagate client disconnect into the pagination loop so
        // the exporter stops fetching REview pages at the next
        // boundary when the consumer goes away before the stream
        // even attaches a reader.
        signal: request.signal,
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Total-Count": totalCount,
          // Streamed responses must not be cached — each export is
          // freshly derived from the current committed filter.
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof DetectionForbiddenError) {
        // #384 BFF intersection check: the inbound `filter.input.customers`
        // contains an ID outside the caller's effective scope. Distinct
        // `code` so the client can surface an actionable message instead
        // of the generic Detection-access denial.
        return NextResponse.json(
          { error: "Forbidden", code: "forbidden-customer-scope" },
          { status: 403 },
        );
      }
      if (err instanceof DetectionUnauthorizedError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return NextResponse.json(
        { error: "Failed to export detection events" },
        { status: 500 },
      );
    }
  },
  { requiredPermissions: ["detection:read"] },
);
