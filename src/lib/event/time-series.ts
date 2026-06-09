/**
 * The Event-menu Periodic Time Series view (E5 Part 2): filter model and
 * the mapping onto Giganto's `periodicTimeSeries` query arguments.
 *
 * Like the other Event views the filter rides in the URL so a chart is
 * shareable and survives a reload. Giganto's `TimeSeriesFilter.id` is a
 * required `String!`, so an unset `id` is the "no query yet" state — the
 * id is chosen from REview's `samplingPolicyList` (see the selector in
 * `time-series-filter-form.tsx`). `time` is an optional window.
 */

import type { TimeSeriesFilterInput } from "./types";

/**
 * Committed Periodic Time Series filter. `id` is the sampling policy to
 * chart (required before a query runs); `start` / `end` are an optional
 * ISO-8601 UTC window.
 */
export interface TimeSeriesFilter {
  id: string | null;
  /** ISO-8601 UTC, inclusive. */
  start: string | null;
  /** ISO-8601 UTC, exclusive. */
  end: string | null;
}

export const EMPTY_TIME_SERIES_FILTER: TimeSeriesFilter = {
  id: null,
  start: null,
  end: null,
};

/**
 * URL query-string names that persist the Time Series filter. Distinct
 * from the Events and Statistics keys so all three views' state can
 * coexist in one URL.
 */
export const TIME_SERIES_PARAM_KEYS = {
  id: "tsId",
  start: "tsStart",
  end: "tsEnd",
} as const;

function readString(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const raw = source[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decode the committed Time Series filter from URL search params.
 * Malformed values are ignored — the URL is a best-effort handoff, not a
 * validated form. A repeated (array) param is ignored rather than
 * mis-parsed.
 */
export function parseTimeSeriesFilterFromSearchParams(
  source: Record<string, string | string[] | undefined>,
): TimeSeriesFilter {
  return {
    id: readString(source, TIME_SERIES_PARAM_KEYS.id),
    start: readString(source, TIME_SERIES_PARAM_KEYS.start),
    end: readString(source, TIME_SERIES_PARAM_KEYS.end),
  };
}

/**
 * Encode a Time Series filter into URL-safe entries. Only set fields are
 * written so a fresh view URL stays tidy.
 */
export function timeSeriesFilterToSearchEntries(
  filter: TimeSeriesFilter,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (filter.id) entries.push([TIME_SERIES_PARAM_KEYS.id, filter.id]);
  if (filter.start) entries.push([TIME_SERIES_PARAM_KEYS.start, filter.start]);
  if (filter.end) entries.push([TIME_SERIES_PARAM_KEYS.end, filter.end]);
  return entries;
}

/**
 * Map the committed filter onto the `TimeSeriesFilter` input. Returns
 * `null` when no id is selected — the caller renders the pre-query
 * prompt rather than dispatching a query Giganto would reject for a
 * missing required `id`. `time` is emitted only when a bound is set.
 */
export function toTimeSeriesFilterInput(
  filter: TimeSeriesFilter,
): TimeSeriesFilterInput | null {
  if (!filter.id) return null;

  const input: TimeSeriesFilterInput = { id: filter.id };
  if (filter.start || filter.end) {
    input.time = { start: filter.start, end: filter.end };
  }
  return input;
}
