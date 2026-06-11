/**
 * The Event-menu Statistics view: filter model, the allowed protocol
 * keys, and the mapping onto Giganto's `statistics` query arguments.
 *
 * Like the Conn search filter, the Statistics filter is carried in the
 * URL so a view is shareable and survives a full page load. Unlike that
 * filter, `statistics` takes `sensors: [String!]!` (multi-sensor), so
 * the Statistics view ships its **own** dedicated multi-select sensor
 * control rather than reusing the single-sensor event search.
 */

import { coerceEventPeriod, type EventPeriodKey } from "./period";
import type { StatisticsVariables } from "./types";

/**
 * The `RawEventKind` strings the `statistics` API accepts, per the
 * 0.27.0 SDL doc-comment on `Query.statistics`. Giganto rejects any
 * other value at runtime, so the protocol picker is constrained to this
 * exact set.
 */
export const STATISTICS_PROTOCOLS = [
  "conn",
  "dns",
  "malformed_dns",
  "radius",
  "rdp",
  "http",
  "smtp",
  "ntlm",
  "kerberos",
  "ssh",
  "dce_rpc",
  "ftp",
  "mqtt",
  "ldap",
  "tls",
  "smb",
  "nfs",
  "bootp",
  "dhcp",
  "icmp",
  "statistics",
] as const;

export type StatisticsProtocol = (typeof STATISTICS_PROTOCOLS)[number];

export function isStatisticsProtocol(
  value: string,
): value is StatisticsProtocol {
  return (STATISTICS_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * The per-protocol metrics a `StatisticsDetail` carries. The chart
 * draws one metric at a time (one series per protocol) — drawing every
 * metric × protocol at once is unreadable — so the view exposes a
 * metric selector backed by this list.
 *
 * `bps` / `pps` / `eps` are `Float`; `count` / `size` are
 * `StringNumberU64` (64-bit, parsed BigInt-safe before charting).
 */
export const STATISTICS_METRICS = [
  "bps",
  "pps",
  "eps",
  "count",
  "size",
] as const;

export type StatisticsMetric = (typeof STATISTICS_METRICS)[number];

export const DEFAULT_STATISTICS_METRIC: StatisticsMetric = "bps";

export function isStatisticsMetric(value: string): value is StatisticsMetric {
  return (STATISTICS_METRICS as readonly string[]).includes(value);
}

export function coerceStatisticsMetric(
  value: string | undefined,
): StatisticsMetric {
  return value !== undefined && isStatisticsMetric(value)
    ? value
    : DEFAULT_STATISTICS_METRIC;
}

/**
 * Committed Statistics filter. `sensors` is required by Giganto
 * (`statistics(sensors: [String!]!)`); a view cannot run until at least
 * one sensor is chosen, so an empty `sensors` array is the "no query
 * yet" state. `protocols` is an optional subset — empty means "all
 * protocols the API returns".
 */
export interface StatisticsFilter {
  sensors: string[];
  /** ISO-8601 UTC, inclusive. */
  start: string | null;
  /** ISO-8601 UTC, exclusive. */
  end: string | null;
  /**
   * Selected period quick-select pill, or `null` when none is active.
   * Presentation-only: highlights a pill and round-trips through the URL,
   * but never reaches the `statistics` query (driven by `start`/`end`).
   */
  period: EventPeriodKey | null;
  protocols: StatisticsProtocol[];
}

export const EMPTY_STATISTICS_FILTER: StatisticsFilter = {
  sensors: [],
  start: null,
  end: null,
  period: null,
  protocols: [],
};

/** URL query-string names that persist the Statistics filter. */
export const STATISTICS_PARAM_KEYS = {
  sensors: "sensors",
  start: "statStart",
  end: "statEnd",
  period: "statPeriod",
  protocols: "protocols",
} as const;

/**
 * Split a comma-joined URL value into trimmed, de-duplicated, non-empty
 * tokens. Order is preserved (first occurrence wins) so a shared URL
 * round-trips to the same selection.
 */
function splitList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
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

/**
 * Decode the committed Statistics filter from URL search params. Unknown
 * protocol tokens are dropped (the picker can only emit known keys, but
 * a hand-edited URL might not); malformed values are ignored — the URL
 * is a best-effort handoff, not a validated form.
 */
export function parseStatisticsFilterFromSearchParams(
  source: Record<string, string | string[] | undefined>,
): StatisticsFilter {
  const sensorsRaw = readString(source, STATISTICS_PARAM_KEYS.sensors);
  const protocolsRaw = readString(source, STATISTICS_PARAM_KEYS.protocols);
  return {
    sensors: sensorsRaw ? splitList(sensorsRaw) : [],
    start: readString(source, STATISTICS_PARAM_KEYS.start),
    end: readString(source, STATISTICS_PARAM_KEYS.end),
    period: coerceEventPeriod(readString(source, STATISTICS_PARAM_KEYS.period)),
    protocols: protocolsRaw
      ? splitList(protocolsRaw).filter(isStatisticsProtocol)
      : [],
  };
}

/**
 * Encode a Statistics filter into URL-safe entries. Only set fields are
 * written so a fresh Statistics view URL stays tidy; the sensor and
 * protocol lists are comma-joined.
 */
export function statisticsFilterToSearchEntries(
  filter: StatisticsFilter,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (filter.sensors.length > 0) {
    entries.push([STATISTICS_PARAM_KEYS.sensors, filter.sensors.join(",")]);
  }
  if (filter.start) entries.push([STATISTICS_PARAM_KEYS.start, filter.start]);
  if (filter.end) entries.push([STATISTICS_PARAM_KEYS.end, filter.end]);
  if (filter.period) {
    entries.push([STATISTICS_PARAM_KEYS.period, filter.period]);
  }
  if (filter.protocols.length > 0) {
    entries.push([STATISTICS_PARAM_KEYS.protocols, filter.protocols.join(",")]);
  }
  return entries;
}

/**
 * Map the committed filter onto the `statistics` query variables.
 * Returns `null` when no sensor is selected — the caller renders the
 * pre-query prompt rather than dispatching a query Giganto would reject
 * for an empty required `sensors` list.
 *
 * `time` is emitted only when a bound is set; `protocols` only when the
 * subset is non-empty (an omitted/empty list means "all protocols").
 */
export function toStatisticsVariables(
  filter: StatisticsFilter,
): StatisticsVariables | null {
  if (filter.sensors.length === 0) return null;

  const variables: StatisticsVariables = { sensors: filter.sensors };
  if (filter.start || filter.end) {
    variables.time = { start: filter.start, end: filter.end };
  }
  if (filter.protocols.length > 0) {
    variables.protocols = [...filter.protocols];
  }
  return variables;
}
