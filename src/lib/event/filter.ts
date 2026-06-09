/**
 * The Event-menu shared filter model and its mapping onto Giganto's
 * `NetworkFilter`.
 *
 * The filter is carried in the URL so a search is shareable/bookmarkable
 * and survives a full page load (the page is a server component that
 * reads `searchParams`). All values are plain strings/numbers so they
 * round-trip through the query string and server-action boundary.
 */

import {
  coerceRecordType,
  DEFAULT_RECORD_TYPE,
  type RecordTypeId,
} from "./record-types";
import type { NetworkFilterInput } from "./types";

/**
 * Committed Event filter. `sensor` is required by Giganto
 * (`NetworkFilter.sensor: String!`); a search cannot run until one is
 * chosen, so `sensor: null` is the "no query yet" state.
 */
export interface EventFilter {
  recordType: RecordTypeId;
  sensor: string | null;
  /** ISO-8601 UTC, inclusive. */
  start: string | null;
  /** ISO-8601 UTC, exclusive. */
  end: string | null;
  origAddrStart: string | null;
  origAddrEnd: string | null;
  respAddrStart: string | null;
  respAddrEnd: string | null;
  origPortStart: number | null;
  origPortEnd: number | null;
  respPortStart: number | null;
  respPortEnd: number | null;
}

export const EMPTY_EVENT_FILTER: EventFilter = {
  recordType: DEFAULT_RECORD_TYPE,
  sensor: null,
  start: null,
  end: null,
  origAddrStart: null,
  origAddrEnd: null,
  respAddrStart: null,
  respAddrEnd: null,
  origPortStart: null,
  origPortEnd: null,
  respPortStart: null,
  respPortEnd: null,
};

/** Inclusive 16-bit port bounds Giganto accepts in a `PortRange`. */
export const MIN_PORT = 0;
export const MAX_PORT = 65535;

/**
 * Whether a parsed port is a whole number within Giganto's range. The
 * form and the URL parser share this so a port the form accepts is
 * never silently dropped server-side (and vice versa).
 */
export function isPortInRange(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/**
 * Whether a raw port string is an acceptable port: a base-10 integer
 * literal (no sign, decimal point, or exponent) that lands in range.
 *
 * This is the single integer-literal contract shared by the URL parser
 * ({@link readPort}) and the filter form. The form must not parse with
 * `Number.parseInt`, which truncates `"443.5"` to `443` and `"1e3"` to
 * `1` — values that look valid but silently differ from what the
 * operator typed. Requiring all-digit input rejects those outright so
 * the form can block Apply instead of querying a different port.
 */
export function isPortString(raw: string): boolean {
  return /^\d+$/.test(raw) && isPortInRange(Number.parseInt(raw, 10));
}

/** URL query-string names that persist the filter. */
export const FILTER_PARAM_KEYS = {
  recordType: "type",
  sensor: "sensor",
  start: "start",
  end: "end",
  origAddrStart: "origAddrStart",
  origAddrEnd: "origAddrEnd",
  respAddrStart: "respAddrStart",
  respAddrEnd: "respAddrEnd",
  origPortStart: "origPortStart",
  origPortEnd: "origPortEnd",
  respPortStart: "respPortStart",
  respPortEnd: "respPortEnd",
} as const;

/**
 * Map the committed filter onto Giganto's `NetworkFilter`. Returns
 * `null` when no sensor is selected — the caller renders the pre-query
 * prompt rather than dispatching a query that Giganto would reject for
 * a missing required `sensor`.
 *
 * Only populated bounds are emitted; an `IpRange` / `PortRange` is
 * included only when at least one of its endpoints is set, and a
 * `TimeRange` only when start or end is set. Giganto treats every
 * endpoint as optional within its range input.
 */
export function toNetworkFilter(
  filter: EventFilter,
): NetworkFilterInput | null {
  if (!filter.sensor) return null;

  const input: NetworkFilterInput = { sensor: filter.sensor };

  if (filter.start || filter.end) {
    input.time = { start: filter.start, end: filter.end };
  }
  if (filter.origAddrStart || filter.origAddrEnd) {
    input.origAddr = { start: filter.origAddrStart, end: filter.origAddrEnd };
  }
  if (filter.respAddrStart || filter.respAddrEnd) {
    input.respAddr = { start: filter.respAddrStart, end: filter.respAddrEnd };
  }
  // Icmp records carry no ports, so port bounds are meaningless for them
  // and Giganto's port filter would never match. Drop them for Icmp so
  // the rest of the filter still applies. The form disables the port
  // inputs for Icmp too, but stripping here keeps a stale URL param (or
  // a record-type switch after typing ports) from silently emptying the
  // result set.
  if (filter.recordType !== "icmp") {
    if (filter.origPortStart !== null || filter.origPortEnd !== null) {
      input.origPort = { start: filter.origPortStart, end: filter.origPortEnd };
    }
    if (filter.respPortStart !== null || filter.respPortEnd !== null) {
      input.respPort = { start: filter.respPortStart, end: filter.respPortEnd };
    }
  }

  return input;
}

function readString(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const raw = source[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPort(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number | null {
  const raw = readString(source, key);
  if (raw === null) return null;
  return isPortString(raw) ? Number.parseInt(raw, 10) : null;
}

/**
 * Decode the committed filter from URL search params. Unknown /
 * malformed values are dropped silently — the URL is a best-effort
 * handoff, not a validated form.
 */
export function parseFilterFromSearchParams(
  source: Record<string, string | string[] | undefined>,
): EventFilter {
  return {
    recordType: coerceRecordType(
      readString(source, FILTER_PARAM_KEYS.recordType) ?? undefined,
    ),
    sensor: readString(source, FILTER_PARAM_KEYS.sensor),
    start: readString(source, FILTER_PARAM_KEYS.start),
    end: readString(source, FILTER_PARAM_KEYS.end),
    origAddrStart: readString(source, FILTER_PARAM_KEYS.origAddrStart),
    origAddrEnd: readString(source, FILTER_PARAM_KEYS.origAddrEnd),
    respAddrStart: readString(source, FILTER_PARAM_KEYS.respAddrStart),
    respAddrEnd: readString(source, FILTER_PARAM_KEYS.respAddrEnd),
    origPortStart: readPort(source, FILTER_PARAM_KEYS.origPortStart),
    origPortEnd: readPort(source, FILTER_PARAM_KEYS.origPortEnd),
    respPortStart: readPort(source, FILTER_PARAM_KEYS.respPortStart),
    respPortEnd: readPort(source, FILTER_PARAM_KEYS.respPortEnd),
  };
}

/**
 * Encode a filter into URL-safe entries. Only set fields are written
 * so a fresh `/event` URL stays tidy; the record type is omitted when
 * it is the default.
 */
export function filterToSearchEntries(
  filter: EventFilter,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (filter.recordType !== DEFAULT_RECORD_TYPE) {
    entries.push([FILTER_PARAM_KEYS.recordType, filter.recordType]);
  }
  const push = (key: string, value: string | number | null): void => {
    if (value !== null && value !== "") entries.push([key, String(value)]);
  };
  push(FILTER_PARAM_KEYS.sensor, filter.sensor);
  push(FILTER_PARAM_KEYS.start, filter.start);
  push(FILTER_PARAM_KEYS.end, filter.end);
  push(FILTER_PARAM_KEYS.origAddrStart, filter.origAddrStart);
  push(FILTER_PARAM_KEYS.origAddrEnd, filter.origAddrEnd);
  push(FILTER_PARAM_KEYS.respAddrStart, filter.respAddrStart);
  push(FILTER_PARAM_KEYS.respAddrEnd, filter.respAddrEnd);
  push(FILTER_PARAM_KEYS.origPortStart, filter.origPortStart);
  push(FILTER_PARAM_KEYS.origPortEnd, filter.origPortEnd);
  push(FILTER_PARAM_KEYS.respPortStart, filter.respPortStart);
  push(FILTER_PARAM_KEYS.respPortEnd, filter.respPortEnd);
  return entries;
}
