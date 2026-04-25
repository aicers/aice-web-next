import {
  EVENT_KIND_FRIENDLY_NAMES,
  readEventAddressing,
  readEventIdentity,
} from "@/components/events/event-display-helpers";

import type { Filter } from "./filter";
import type { Event, EventListFilterInput } from "./types";

/**
 * Row-count threshold at which the BFF asks the client to confirm
 * before streaming a Detection export. Chosen per #284's "Large-
 * export guardrail" acceptance: below this the export starts
 * immediately; at or above it the confirmation carries the row
 * count and an estimated payload size so the operator can narrow
 * the filter or continue deliberately.
 */
export const LARGE_EXPORT_ROW_THRESHOLD = 100_000;

/**
 * Rough average bytes per CSV row. Used only to quote an estimated
 * payload size in the large-export confirmation — the real streamed
 * size varies with the field lengths of each event (IP strings,
 * sensor names, attack kinds).
 */
export const AVERAGE_CSV_ROW_BYTES = 220;

/**
 * Hard upper bound on the number of rows a single export will
 * stream. The route rejects the export in preflight when the
 * row-count probe exceeds this (see
 * `src/app/api/detection/export/route.ts`) and the streamer also
 * guards runaway iteration if REview keeps returning
 * `hasNextPage: true` indefinitely. Kept in this client-safe module
 * so the `useCsvExport` hook can gate known-over-cap exports on the
 * client before opening the native save picker — the server's 413
 * response remains the backstop for cases where the client's known
 * count is stale or missing.
 */
export const CSV_EXPORT_MAX_ROWS = 1_000_000;

/**
 * Columns emitted by the Detection CSV export, in the order the
 * header row is written. Mirrors the visible columns rendered by
 * `ResultList` in left-to-right reading order: the severity badge /
 * time / kind / attack kind / category / confidence / triage token
 * on the top line (`result-list.tsx` → `EventRow`), followed by
 * the source → destination endpoint line, the sensor, and the
 * Phase Detection-28 identity columns (userName, hostname). Country
 * is inlined into the source/destination tokens instead of being
 * split into separate columns, and triage is emitted as a single
 * cell mirroring the `TriageSummary` token ("{count} policies ·
 * {max} max"), rather than the previous two-column split, so the
 * export matches the #284 contract of "CSV columns match the
 * currently visible result columns in the same order". The
 * userName / hostname cells follow `IdentitySummary`'s placement
 * after the sensor on the second line and write `""` (empty cell)
 * for subtypes whose schema does not emit the field — the same
 * `—` fallback the UI uses, but rendered as an empty cell so the
 * column position never shifts. When a new column is added to the
 * UI, a matching entry here keeps the download in sync.
 */
export const CSV_COLUMN_KEYS = [
  "level",
  "time",
  "kind",
  "attackKind",
  "category",
  "confidence",
  "triage",
  "source",
  "destination",
  "sensor",
  "userName",
  "hostname",
] as const;

export type CsvColumnKey = (typeof CSV_COLUMN_KEYS)[number];

export type CsvColumnHeaders = Record<CsvColumnKey, string>;

/**
 * Escape a CSV field per RFC 4180: fields containing commas,
 * double-quotes, CR, or LF are wrapped in double-quotes and any
 * embedded double-quote is doubled. Empty and plain values pass
 * through unquoted so typical rows stay compact.
 */
export function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Defuse spreadsheet-formula injection (CWE-1236): when an event-
 * derived cell starts with `=`, `+`, `-`, `@`, `\t`, or `\r`,
 * Excel and Google Sheets evaluate the cell as a formula even
 * after RFC 4180 quoting. Prefixing the value with a single quote
 * makes those tools treat the cell as a literal string. Header
 * labels are not run through this — they are hard-coded i18n
 * strings and never start with a formula trigger.
 */
export function neutralizeFormula(value: string): string {
  if (value === "") return value;
  const first = value.charCodeAt(0);
  // 0x3D `=`, 0x2B `+`, 0x2D `-`, 0x40 `@`, 0x09 `\t`, 0x0D `\r`
  if (
    first === 0x3d ||
    first === 0x2b ||
    first === 0x2d ||
    first === 0x40 ||
    first === 0x09 ||
    first === 0x0d
  ) {
    return `'${value}`;
  }
  return value;
}

function joinHeaderRow(cells: readonly string[]): string {
  return `${cells.map(csvEscape).join(",")}\r\n`;
}

function joinDataRow(cells: readonly string[]): string {
  return `${cells.map((c) => csvEscape(neutralizeFormula(c))).join(",")}\r\n`;
}

/**
 * Render the CSV header row from the per-locale column labels.
 * Kept as a pure function so tests can assert the exact bytes
 * emitted without standing up the streaming route.
 */
export function formatCsvHeader(headers: CsvColumnHeaders): string {
  return joinHeaderRow(CSV_COLUMN_KEYS.map((key) => headers[key]));
}

/**
 * Mirror `pickEndpoint` in `ResultList`: prefer the singular
 * address/port/country field when present, otherwise fall back to
 * the first entry of the plural field with the remainder counted as
 * extras. Several curated subtypes (e.g. `ExternalDdos`,
 * `MultiHostPortScan`, `PortScan`, `RdpBruteForce`,
 * `UnusualDestinationPattern`) only populate the plural fields, so
 * reading only the singular column would drop the primary endpoint
 * the row displays. Country is appended in parens after the
 * address, using the same `formatCountryShort` mapping `EndpointPart`
 * uses so that `XX`/`ZZ` sentinel codes land as the locale-specific
 * "unknown" / "unavailable" labels. Extra countries are deliberately
 * not surfaced because the result row does not surface them either.
 */
function formatEndpointCell(
  singularAddr: string | null,
  singularPort: number | null,
  pluralAddrs: string[],
  pluralPorts: number[],
  singularCountry: string | null,
  pluralCountries: string[],
  countryLabels: { unknown: string; unavailable: string },
  moreCountSuffixTemplate: string,
): string {
  let address = singularAddr;
  let extraAddresses: string[] = [];
  if (!address && pluralAddrs.length > 0) {
    address = pluralAddrs[0];
    extraAddresses = pluralAddrs.slice(1);
  }
  if (!address) return "";
  let port = singularPort;
  let extraPorts: number[] = [];
  if (port === null && pluralPorts.length > 0) {
    port = pluralPorts[0];
    extraPorts = pluralPorts.slice(1);
  }
  let country = singularCountry;
  if (!country && pluralCountries.length > 0) {
    country = pluralCountries[0];
  }
  let cell = port !== null ? `${address}:${port}` : address;
  const addressExtras = extraAddresses.length + extraPorts.length;
  if (addressExtras > 0) {
    cell += ` (${formatMoreCountSuffix(addressExtras, moreCountSuffixTemplate)})`;
  }
  if (country) {
    cell += ` (${formatCountryShort(country, countryLabels)})`;
  }
  return cell;
}

/**
 * Render the plural-endpoint "+N more" hint using the locale's
 * `moreCountSuffix` ICU template — the same string the result row
 * renders through `ResultListLabels.moreCountSuffix`. Kept as a
 * raw template substitution (like `formatTriageCell`) so the
 * server-side streamer stays free of a next-intl formatter. Falls
 * back to a plain `+N more` when the template is missing the
 * `{count}` placeholder so a malformed locale bundle still ends
 * up with a readable cell instead of a literal `{count}`.
 */
function formatMoreCountSuffix(count: number, template: string): string {
  if (template.includes("{count}")) {
    return template.replace(/\{count\}/g, String(count));
  }
  return `+${count} more`;
}

/**
 * Mirror `formatCountryShort` in `ResultList`: the two sentinel
 * codes from the upstream datasource (`XX` unknown / `ZZ`
 * unavailable) are surfaced as the locale's "unknown" / "unavailable"
 * labels; every other code — already an ISO two-letter country code
 * — is written through unchanged. Kept in sync with
 * `src/components/detection/result-list.tsx` so the CSV cell reads
 * the same as the result row's country span.
 */
function formatCountryShort(
  code: string,
  labels: { unknown: string; unavailable: string },
): string {
  if (code === "XX") return labels.unknown;
  if (code === "ZZ") return labels.unavailable;
  return code;
}

/**
 * Mirror `TriageSummary` in the result row (`result-list.tsx`):
 * render the triage scores as a single token formatted via the
 * locale's `triageSummary` message (e.g. `"3 policies · 0.90 max"`).
 * Empty / missing scores render as an empty cell, which is what the
 * UI does — `TriageSummary` returns `null` in that case. The
 * template must contain `{count}` and `{max}` placeholders; anything
 * else is written through unchanged, matching next-intl's ICU
 * substitution for the same key on the client.
 */
function formatTriageCell(
  scores: Event["triageScores"] | null | undefined,
  template: string,
): string {
  if (!scores || scores.length === 0) return "";
  let max = scores[0].score;
  for (const s of scores) if (s.score > max) max = s.score;
  return template
    .replace(/\{count\}/g, String(scores.length))
    .replace(/\{max\}/g, max.toFixed(2));
}

export interface FormatCsvRowOptions {
  /**
   * Per-locale friendly category labels (matches
   * `ResultListLabels.categoryLabels`). When the event's raw
   * category key is not in the map the raw value is written
   * through — safer than dropping the cell silently.
   */
  categoryLabels: Record<string, string>;
  /**
   * Per-locale severity labels (matches
   * `ResultListLabels.levelLabels`). Falls back to the raw
   * level value when no label is registered.
   */
  levelLabels: Record<string, string>;
  /**
   * Per-locale labels for the `XX` (unknown origin) and `ZZ`
   * (unavailable) sentinel country codes. Matches
   * `ResultListLabels.countryUnknown` /
   * `ResultListLabels.countryUnavailable` so the CSV cell reads
   * the same friendly text the UI renders in the source /
   * destination column.
   */
  countryUnknown: string;
  countryUnavailable: string;
  /**
   * Raw ICU template for the `triageSummary` message — the same
   * string the result row uses to render its triage token (e.g.
   * `"{count} policies · {max} max"`). Passed as a raw template
   * (via `t.raw(...)` on the client) so the server can substitute
   * `{count}` and `{max}` without standing up a full next-intl
   * message formatter inside the CSV streamer. Matches
   * `ResultListLabels.triageSummary` so the downloaded cell reads
   * the same string the operator sees in the result list.
   */
  triageSummaryTemplate: string;
  /**
   * Raw ICU template for the `moreCountSuffix` message used to
   * summarize plural-endpoint extras (e.g. `"+{count} more"` in EN,
   * `"+{count}개 더"` in KR). The server substitutes `{count}` on
   * each endpoint cell so subtypes such as `ExternalDdos`,
   * `MultiHostPortScan`, `PortScan`, `RdpBruteForce`, and
   * `UnusualDestinationPattern` — which only populate the plural
   * addressing fields — render the same suffix the UI shows via
   * `ResultListLabels.moreCountSuffix`. Passed as a raw template
   * (via `t.raw(...)`) for the same reason as
   * `triageSummaryTemplate`: a server-side formatter is avoided.
   */
  moreCountSuffixTemplate: string;
}

/**
 * Format a single event into one CSV line (terminated by CRLF).
 * Column order matches {@link CSV_COLUMN_KEYS}; missing fields are
 * written as empty cells so a column's position never shifts
 * across subtypes with different addressing shapes.
 */
export function formatCsvRow(
  event: Event,
  options: FormatCsvRowOptions,
): string {
  const addressing = readEventAddressing(event);
  const kind = EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  const level = options.levelLabels[event.level] ?? event.level ?? "";
  const category = event.category
    ? (options.categoryLabels[event.category] ?? event.category)
    : "";
  const countryLabels = {
    unknown: options.countryUnknown,
    unavailable: options.countryUnavailable,
  };
  const source = formatEndpointCell(
    addressing.origAddr,
    addressing.origPort,
    addressing.origAddrs,
    [],
    addressing.origCountry,
    addressing.origCountries,
    countryLabels,
    options.moreCountSuffixTemplate,
  );
  const destination = formatEndpointCell(
    addressing.respAddr,
    addressing.respPort,
    addressing.respAddrs,
    addressing.respPorts,
    addressing.respCountry,
    addressing.respCountries,
    countryLabels,
    options.moreCountSuffixTemplate,
  );
  const triage = formatTriageCell(
    event.triageScores,
    options.triageSummaryTemplate,
  );
  const identity = readEventIdentity(event);
  return joinDataRow([
    level,
    event.time ?? "",
    kind,
    addressing.attackKind ?? "",
    category,
    typeof event.confidence === "number" ? event.confidence.toFixed(2) : "",
    triage,
    source,
    destination,
    event.sensor ?? "",
    identity.userName ?? "",
    identity.hostname ?? "",
  ]);
}

/**
 * Default CSV header labels — used when the caller does not supply
 * translated headers (for example, server-side fallback when the
 * locale is unknown). Keep the keys in lockstep with
 * {@link CSV_COLUMN_KEYS}.
 */
export const DEFAULT_CSV_HEADERS: CsvColumnHeaders = {
  level: "Severity",
  time: "Time",
  kind: "Kind",
  attackKind: "Attack Kind",
  category: "Category",
  confidence: "Confidence",
  triage: "Triage",
  source: "Source",
  destination: "Destination",
  sensor: "Sensor",
  userName: "User",
  hostname: "Host",
};

/**
 * Strip characters that would be invalid or confusing in a
 * filename (path separators, NUL, colons) and collapse runs of
 * whitespace into a single hyphen so the server-supplied filename
 * survives Windows, macOS, and Linux download paths without needing
 * the browser to rewrite it.
 */
function sanitizeFilenameSegment(raw: string): string {
  // Reserved filename characters across Windows / macOS / Linux and
  // ASCII control characters (U+0000..U+001F) expressed via
  // `\p{Cc}` to stay within Biome's lint rule against raw control-
  // character escapes in source regexes.
  return raw
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

/**
 * Format a UTC timestamp as `YYYY-MM-DDTHH-MM` — the ISO 8601
 * form with filename-safe substitutes for the `:` separators. A
 * bare `toISOString()` would embed colons that Windows rejects.
 */
export function formatFilenameTimestamp(date: Date = new Date()): string {
  const iso = date.toISOString();
  // "2026-04-20T15:32:00.123Z" → "2026-04-20T15-32"
  return iso.slice(0, 16).replace(/:/g, "-");
}

/**
 * Derive a terse filter summary for the download filename. Uses
 * the period slug when the filter was applied via a period chip,
 * falling back to the explicit range when the operator edited the
 * start/end. Returns `all` when the filter has no time bounds at
 * all — the worst case where the server-side scope is the only
 * narrowing in effect.
 */
export function formatFilterSummary(
  filter: Filter,
  options: { periodKey?: string | null } = {},
): string {
  if (options.periodKey) return `last-${options.periodKey}`;
  const input: EventListFilterInput | null =
    filter.mode === "structured" ? filter.input : null;
  if (!input) return "query";
  const start = input.start ?? null;
  const end = input.end ?? null;
  if (!start && !end) return "all";
  if (start && end) {
    return `${start.slice(0, 10)}_to_${end.slice(0, 10)}`;
  }
  if (start) return `from_${start.slice(0, 10)}`;
  return `until_${(end ?? "").slice(0, 10)}`;
}

export interface BuildFilenameOptions {
  periodKey?: string | null;
  timestamp?: Date;
}

/**
 * Compose the full download filename. Shape:
 *   `detection-events_<timestamp>_<summary>.csv`
 * e.g. `detection-events_2026-04-20T15-32_last-1h.csv`.
 */
export function buildExportFilename(
  filter: Filter,
  options: BuildFilenameOptions = {},
): string {
  const timestamp = formatFilenameTimestamp(options.timestamp);
  const summary = sanitizeFilenameSegment(
    formatFilterSummary(filter, { periodKey: options.periodKey ?? null }),
  );
  return `detection-events_${timestamp}_${summary || "all"}.csv`;
}
