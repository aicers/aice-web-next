/**
 * Full `Filter` ↔ URL round-trip for the Detection page's active tab.
 *
 * Built on top of {@link ./url-filters.ts}, which already encodes the
 * pivot/free-form subset used by Investigation hand-off links. This
 * module layers the rest of the `EventListFilterInput` fields plus the
 * drawer-side period, endpoint rows, and committed pivot-only params
 * so a shared URL reproduces the full active tab — not just the pivot
 * hand-off subset.
 *
 * Every field is best-effort: malformed or unknown values are dropped
 * silently so a hand-edited URL can't poison shell state. The reader
 * (Detection page / shell) treats the URL as advisory, not as a form to
 * validate.
 */
import { FLOW_KINDS } from "./direction";
import {
  type EndpointEntry,
  type EndpointEntryDirection,
  endpointsToEndpointInputs,
  parseEndpointInput,
} from "./endpoint-filter";
import type { Filter } from "./filter";
import { normalizeStructuredInput } from "./filter-input-normalize";
import { LEARNING_METHOD_VALUES } from "./filter-options";
import { PERIOD_KEYS, type PeriodKey } from "./period";
import { createTabId, TAB_CAP, type TabSnapshot } from "./tabs";
import type { EventListFilterInput, FlowKind, LearningMethod } from "./types";
import {
  buildDetectionSearchParams,
  type PivotFilterParams,
  parsePivotSearchParams,
  pivotParamsFromFilterInput,
} from "./url-filters";

/**
 * Shape of the active tab's state as it lands in the URL. Everything
 * is optional; absent fields mean "the shell's default wins" rather
 * than "clear this field".
 *
 * `filter` is the abstract `Filter` discriminated union — both
 * `mode: "structured"` and `mode: "query"` round-trip through the URL
 * so a shared link reproduces the author's tab without the persistence
 * layer having to care which search-language branch is active.
 *
 * `autoRun` is `true` by default; the `false` variant is emitted as
 * `?pending=1` so a reload of a freshly-opened `+` tab doesn't rerun
 * the default query and clobber the pre-query empty panel.
 */
export interface TabUrlState {
  filter: Filter;
  period: PeriodKey | null;
  endpoints: EndpointEntry[];
  pivotOnly: PivotFilterParams;
  autoRun?: boolean;
  /**
   * `true` when the URL carried `notime=1` — the operator explicitly
   * removed the time chip on a committed tab and the shell must not
   * silently restore the default period on reload. `false` / absent
   * means "no explicit intent expressed" — cold-start seeding is
   * allowed by upstream callers (see `snapshotFromSingleTabUrl`).
   */
  noTimeFilter?: boolean;
}

/** Search param holding the full tab set as compact JSON. */
const TABS_PARAM = "tabs";
/** Search param emitted for a `+` tab that has not run its query. */
const PENDING_PARAM = "pending";
/**
 * Search param emitted for a *committed* tab whose time chip the
 * operator has removed. Without this marker, a URL with no `period`
 * and no `start` / `end` is ambiguous: it could be a cold-start load
 * (no intent expressed → the page should seed the default
 * `Last 1 hour`), a pivot hand-off from Investigation (no time was
 * ever supplied → default applies), or a user who explicitly cleared
 * the chip and wants "no time filter" preserved across reload.
 * `notime=1` disambiguates the last case — its presence tells the
 * reader "treat the missing time as intentional, do not fall back".
 */
const NOTIME_PARAM = "notime";
/**
 * Search params for the `mode: "query"` branch of the abstract `Filter`
 * discriminated union. `?mode=query&q=<text>` carries the raw query-
 * language text so a shared URL reproduces a query-mode tab once the
 * search-language front-end lands. `?mode=structured` is implicit
 * (omitted) so existing structured-mode links stay short.
 */
const MODE_PARAM = "mode";
const QUERY_TEXT_PARAM = "q";

/**
 * Max URL-length budget for the `tabs=<json>` param. When the encoded
 * URL (including origin + path + the full query string) would exceed
 * this cap, `buildAllTabsSearchParams` falls back to the single-tab
 * shape: only the active tab rides in the URL, and sessionStorage is
 * left to carry the rest on the originating browser. Picked
 * conservatively — Safari / IE / Slack all accept more, but some link
 * previewers and email clients start truncating around this length.
 */
export const TABS_URL_BUDGET = 4000;

/** Chips for the `directions` multi-select, ordered by {@link FLOW_KINDS}. */
const FLOW_KIND_SET: ReadonlySet<FlowKind> = new Set(FLOW_KINDS);

const LEARNING_METHOD_SET: ReadonlySet<LearningMethod> = new Set(
  LEARNING_METHOD_VALUES,
);

const PERIOD_KEY_SET: ReadonlySet<PeriodKey> = new Set(PERIOD_KEYS);

function readString(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Full-string decimal float: optional sign, digits, optional fraction,
 * optional exponent. Rejects trailing garbage (`0.8oops`), hex (`0x1`),
 * and whitespace. */
const STRICT_FLOAT_RE = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
/** Full-string decimal integer: optional sign, digits only. Rejects
 * fractional values (`1.5`), trailing garbage (`1junk`), explicit
 * leading `+`, hex (`0x1`). */
const STRICT_INT_RE = /^-?\d+$/;

function readFloat(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  // Strict match: `Number.parseFloat` silently accepts trailing garbage
  // (e.g. `0.8oops` → 0.8). A hand-edited or corrupted shared link
  // must not silently activate the wrong confidence bound.
  if (!STRICT_FLOAT_RE.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function readCommaList(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string[] | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function readIntList(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number[] | undefined {
  const parts = readCommaList(source, key);
  if (!parts) return undefined;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const p of parts) {
    // Strict match: `Number.parseInt` accepts trailing garbage and
    // truncates fractional values (`1junk` → 1, `1.5` → 1). Drop
    // non-integer tokens so a hand-edited `?levels=1junk` does not
    // silently activate level 1.
    if (!STRICT_INT_RE.test(p)) continue;
    const n = Number(p);
    if (!Number.isFinite(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

function readFilteredCommaList<T extends string>(
  source: Record<string, string | string[] | undefined>,
  key: string,
  allowed: ReadonlySet<T>,
): T[] | undefined {
  const parts = readCommaList(source, key);
  if (!parts) return undefined;
  const out: T[] = [];
  for (const p of parts) {
    if ((allowed as ReadonlySet<string>).has(p)) out.push(p as T);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Encode an array of endpoint rows as `raw|dir|sel;raw|dir|sel`.
 * `raw` is URL-safe because `URLSearchParams` percent-encodes the
 * final value; we only need our internal separators to be distinct
 * from the characters `parseEndpointInput` accepts (`.`, `-`, `/`,
 * digits, whitespace).
 */
const ENDPOINT_ENTRY_SEPARATOR = ";";
const ENDPOINT_FIELD_SEPARATOR = "|";

function directionShort(dir: EndpointEntryDirection): "b" | "s" | "d" {
  if (dir === "SOURCE") return "s";
  if (dir === "DESTINATION") return "d";
  return "b";
}

function directionLong(short: string): EndpointEntryDirection | null {
  if (short === "s") return "SOURCE";
  if (short === "d") return "DESTINATION";
  if (short === "b") return "BOTH";
  return null;
}

function encodeEndpoints(entries: EndpointEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const parts: string[] = [];
  for (const entry of entries) {
    parts.push(
      [
        entry.raw,
        directionShort(entry.direction),
        entry.selected ? "1" : "0",
      ].join(ENDPOINT_FIELD_SEPARATOR),
    );
  }
  return parts.join(ENDPOINT_ENTRY_SEPARATOR);
}

function decodeEndpoints(raw: string | undefined): EndpointEntry[] {
  if (!raw) return [];
  const out: EndpointEntry[] = [];
  let counter = 0;
  for (const chunk of raw.split(ENDPOINT_ENTRY_SEPARATOR)) {
    const [rawText, dirShort, selFlag] = chunk.split(ENDPOINT_FIELD_SEPARATOR);
    if (!rawText) continue;
    const parsed = parseEndpointInput(rawText);
    if (!parsed) continue;
    const direction = directionLong(dirShort ?? "b");
    if (!direction) continue;
    counter += 1;
    out.push({
      id: `endpoint-url-${counter}`,
      raw: rawText,
      kind: parsed.kind,
      host: parsed.host,
      network: parsed.network,
      range: parsed.range,
      direction,
      selected: selFlag !== "0",
    });
  }
  return out;
}

/**
 * Serialize a tab's state into `URLSearchParams`. The pivot/free-form
 * subset is delegated to {@link buildDetectionSearchParams} so
 * Investigation hand-off URLs keep producing the same shape.
 *
 * Non-shareable per-tab UI state (e.g. the analytics-strip expansion
 * flag) is never serialized here — that belongs in sessionStorage.
 */
export function buildActiveTabSearchParams(
  state: TabUrlState,
): URLSearchParams {
  const merged = mergeForUrl(state);
  const search = buildDetectionSearchParams(merged);
  if (state.autoRun === false) {
    search.set(PENDING_PARAM, "1");
  }
  if (state.filter.mode === "query") {
    // Query-mode tabs only carry the raw search-language text. Period
    // / endpoint / pivot fields are not meaningful in this branch;
    // structured-only params stay off the URL so the shape is obvious
    // to a recipient.
    search.set(MODE_PARAM, "query");
    search.set(QUERY_TEXT_PARAM, state.filter.text);
    return search;
  }
  const input = state.filter.input;

  if (state.period) {
    search.set("period", state.period);
  } else if (input.start || input.end) {
    // Explicit range: carry `start` / `end` so a shared link reproduces
    // the exact committed window. Period chips imply `start` / `end`
    // are rolling-derived at load, so they stay off the URL when set.
    if (input.start) search.set("start", input.start);
    if (input.end) search.set("end", input.end);
  } else if (state.autoRun !== false) {
    // Committed tab with no time filter at all — the operator removed
    // the time chip via the chip bar's `×`. Write `notime=1` so a
    // reload can distinguish this from a bare cold-start URL (which
    // should still default to `Last 1 hour`). Pending `+` tabs already
    // carry `pending=1`; their no-time state needs no extra marker.
    search.set(NOTIME_PARAM, "1");
  }
  if (input.directions && input.directions.length > 0) {
    search.set("directions", input.directions.join(","));
  }
  if (input.confidenceMin !== undefined && input.confidenceMin !== null) {
    search.set("cmin", String(input.confidenceMin));
  }
  if (input.confidenceMax !== undefined && input.confidenceMax !== null) {
    search.set("cmax", String(input.confidenceMax));
  }
  if (input.levels && input.levels.length > 0) {
    search.set("levels", input.levels.join(","));
  }
  if (input.countries && input.countries.length > 0) {
    search.set("countries", input.countries.join(","));
  }
  if (input.categories && input.categories.length > 0) {
    search.set(
      "categories",
      input.categories
        .filter((c): c is number => typeof c === "number")
        .join(","),
    );
  }
  // Plural `kinds` (categorical) is distinct from the pivot-only
  // singular `kind` already handled by `buildDetectionSearchParams`.
  if (input.kinds && input.kinds.length > 0) {
    search.set("kinds", input.kinds.join(","));
  }
  if (input.learningMethods && input.learningMethods.length > 0) {
    search.set("learningMethods", input.learningMethods.join(","));
  }
  if (input.sensors && input.sensors.length > 0) {
    search.set("sensors", input.sensors.join(","));
  }
  const endpointsEncoded = encodeEndpoints(state.endpoints);
  if (endpointsEncoded) {
    search.set("endpoints", endpointsEncoded);
  }
  return search;
}

function mergeForUrl(state: TabUrlState): PivotFilterParams {
  const filterSide =
    state.filter.mode === "structured"
      ? pivotParamsFromFilterInput(state.filter.input)
      : {};
  return {
    ...state.pivotOnly,
    ...filterSide,
    // Explicit merge so both overlapping fields resolve to filter-side
    // (matching `mergePivotParams`).
    source: filterSide.source ?? state.pivotOnly.source,
    destination: filterSide.destination ?? state.pivotOnly.destination,
  };
}

/**
 * Reconstruct a tab's state from URL search params. Missing fields
 * fall through to the caller's defaults (default period, empty
 * endpoints, etc.).
 */
export function parseActiveTabSearchParams(
  source: Record<string, string | string[] | undefined>,
): TabUrlState {
  // Query-mode branch: `?mode=query` takes precedence so the abstract
  // `Filter` discriminator survives the URL round-trip. The pending
  // marker and active-tab index are still honoured; all structured-
  // only fields are ignored in this branch.
  const modeRaw = readString(source, MODE_PARAM);
  if (modeRaw === "query") {
    const text = readString(source, QUERY_TEXT_PARAM) ?? "";
    const autoRun = readString(source, PENDING_PARAM) !== "1";
    const state: TabUrlState = {
      filter: { mode: "query", text },
      period: null,
      endpoints: [],
      pivotOnly: {},
      autoRun,
      // Query-mode tabs never carry a period; "no time filter is
      // intentional" is implicit for them, so flag the state as
      // such to short-circuit `snapshotFromSingleTabUrl`'s cold-start
      // default-period seeding.
      noTimeFilter: true,
    };
    return state;
  }

  const pivot = parsePivotSearchParams(source);
  const input: EventListFilterInput = {};

  const periodRaw = readString(source, "period");
  const period: PeriodKey | null =
    periodRaw && PERIOD_KEY_SET.has(periodRaw as PeriodKey)
      ? (periodRaw as PeriodKey)
      : null;

  // An explicit range is only meaningful when both bounds are
  // present: a one-sided `?start=…` (or `?end=…`) is a malformed URL
  // that would otherwise boot a committed tab with a hidden half-
  // range — the chip summarizer hides the period chip, the SSR path
  // still forwards the half-range to `searchEvents`, and
  // `snapshotFromSingleTabUrl` sees "time intent expressed" and
  // suppresses the cold-start `Last 1 hour` default. Drop both
  // silently (matching this module's other malformed-value branches,
  // e.g. bad `period` / `cmin` / list params) so hand-edited links
  // fall back to cold-start defaults rather than a stuck empty state.
  const startIso = readString(source, "start");
  const endIso = readString(source, "end");
  if (startIso && endIso) {
    input.start = startIso;
    input.end = endIso;
  }

  if (pivot.source) input.source = pivot.source;
  if (pivot.destination) input.destination = pivot.destination;
  for (const f of [
    "keywords",
    "hostnames",
    "userIds",
    "userNames",
    "userDepartments",
  ] as const) {
    const vals = pivot[f];
    if (vals && vals.length > 0) input[f] = vals;
  }

  const directions = readFilteredCommaList<FlowKind>(
    source,
    "directions",
    FLOW_KIND_SET,
  );
  if (directions) input.directions = directions;

  const cmin = readFloat(source, "cmin");
  if (cmin !== undefined) input.confidenceMin = cmin;
  const cmax = readFloat(source, "cmax");
  if (cmax !== undefined) input.confidenceMax = cmax;

  const levels = readIntList(source, "levels");
  if (levels) input.levels = levels;
  const countries = readCommaList(source, "countries");
  if (countries) input.countries = countries;
  const categories = readIntList(source, "categories");
  if (categories) input.categories = categories;
  const kinds = readCommaList(source, "kinds");
  if (kinds) input.kinds = kinds;
  const learningMethods = readFilteredCommaList<LearningMethod>(
    source,
    "learningMethods",
    LEARNING_METHOD_SET,
  );
  if (learningMethods) input.learningMethods = learningMethods;
  const sensors = readCommaList(source, "sensors");
  if (sensors) input.sensors = sensors;

  const endpointsRaw = readString(source, "endpoints");
  const endpoints = decodeEndpoints(endpointsRaw);
  // Rebuild `input.endpoints` from the decoded UI-side list so the SSR
  // fetch, Refresh, and chip-remove paths — all of which query
  // `filter.input` directly — include the endpoint constraints the
  // chip bar is rendering. The `tabs=<json>` decoder does the same
  // via `deserializeTabFromUrl`; skipping it here previously left
  // single-tab reloads (and multi-tab working sets that overflowed
  // the `tabs=` URL budget) showing endpoint chips while querying the
  // unfiltered result set.
  if (endpoints.length > 0) {
    input.endpoints = endpointsToEndpointInputs(endpoints);
  }

  const filter: Filter = { mode: "structured", input };
  const pivotOnly: PivotFilterParams = {
    kind: pivot.kind,
    origPort: pivot.origPort,
    respPort: pivot.respPort,
    proto: pivot.proto,
    window: pivot.window,
  };
  const autoRun = readString(source, PENDING_PARAM) !== "1";
  const state: TabUrlState = {
    filter,
    period,
    endpoints,
    pivotOnly,
    autoRun,
  };
  if (readString(source, NOTIME_PARAM) === "1") state.noTimeFilter = true;
  return state;
}

/* -------------------------------------------------------------------
 * Full tab-set URL encoding (`?tabs=<json>`).
 *
 * The active tab rides in the top-level search params (so pivot/hand-
 * off links keep working). When the working set fits inside
 * `TABS_URL_BUDGET`, every tab's filter snapshot also rides along in
 * a single compact JSON-encoded `tabs` param. A URL recipient with
 * an empty sessionStorage then lands on the author's entire tab
 * strip instead of just the active one.
 *
 * Per-tab UI state (`analyticsOpen`, manual names) is intentionally
 * excluded — that belongs in sessionStorage per the shareable /
 * non-shareable split documented in ./tabs.ts.
 * ------------------------------------------------------------------- */

/** JSON-friendly shape we drop into the `tabs` param. Keyed short so
 * the URL stays under the budget even with 8 tabs. */
interface SerializedTabForUrl {
  f: Filter;
  p: PeriodKey | null;
  // Endpoint rows as `raw|dir|selected` strings (same encoding as the
  // top-level `endpoints` param).
  e?: string;
  po?: PivotFilterParams;
  ar: boolean;
}

function serializeTabForUrl(tab: TabSnapshot): SerializedTabForUrl {
  // Canonicalize the filter payload the same way the decoder already
  // does on read so the URL budget is not consumed by bytes the reader
  // will throw away:
  //   - `input.endpoints` is rebuilt from `e` by `deserializeTabFromUrl`
  //     (the raw nested `EndpointInput` shape is not deep-validated and
  //     the UI-side endpoint list owns the conversion into GraphQL).
  //   - A relative-period tab's `input.start` / `input.end` are rolled
  //     to "now" by `resolveTabPeriod` on every load and
  //     `sameTabFingerprint` already treats them as derivable noise,
  //     so carrying the committed timestamps wastes budget on fields
  //     the read side never consults.
  let filter: Filter = tab.filter;
  if (filter.mode === "structured") {
    const { endpoints: _endpointsOmitted, ...rest } = filter.input;
    let input: EventListFilterInput = rest;
    if (tab.period !== null) {
      const { start: _startOmitted, end: _endOmitted, ...withoutRange } = input;
      input = withoutRange;
    }
    filter = { mode: "structured", input };
  }
  const out: SerializedTabForUrl = {
    f: filter,
    p: tab.period,
    ar: tab.autoRun,
  };
  const endpoints = encodeEndpoints(tab.endpoints);
  if (endpoints) out.e = endpoints;
  if (tab.pivotOnly && Object.keys(tab.pivotOnly).length > 0) {
    out.po = tab.pivotOnly;
  }
  return out;
}

function deserializeTabFromUrl(raw: SerializedTabForUrl): TabSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.f || typeof raw.f !== "object") return null;
  const mode = (raw.f as { mode?: unknown }).mode;
  if (mode !== "structured" && mode !== "query") return null;
  let filter: Filter;
  if (mode === "structured") {
    // Reject `{ mode: "structured", input: null }` explicitly —
    // `typeof null === "object"` would otherwise let it through and
    // crash consumers that spread `filter.input`.
    const input = (raw.f as { input?: unknown }).input;
    if (input === null || typeof input !== "object") return null;
    // Field-level normalization: a hand-edited payload like
    // `{"confidenceMin":"0.8oops","levels":["1junk"],"categories":[1.5]}`
    // would otherwise forward garbage types into `searchEvents()` and
    // diverge from the single-tab URL contract that malformed values
    // are dropped silently.
    filter = {
      mode: "structured",
      input: normalizeStructuredInput(input),
    };
  } else {
    const text = (raw.f as { text?: unknown }).text;
    if (typeof text !== "string") return null;
    filter = { mode: "query", text };
  }
  // Distinguish "no period" (null/undefined) from "unknown period key".
  // The former is a legitimate state — a committed tab whose operator
  // cleared the time chip, or a query-mode tab. The latter is a
  // hand-edited / tampered payload that would otherwise hydrate as a
  // committed no-time tab and silently change query semantics, so
  // reject the entry instead of falling back to `null`.
  let period: PeriodKey | null;
  if (raw.p === null || raw.p === undefined) {
    period = null;
  } else if (
    typeof raw.p === "string" &&
    PERIOD_KEY_SET.has(raw.p as PeriodKey)
  ) {
    period = raw.p as PeriodKey;
  } else {
    return null;
  }
  const endpoints = decodeEndpoints(
    typeof raw.e === "string" ? raw.e : undefined,
  );
  const pivotOnly: PivotFilterParams =
    raw.po && typeof raw.po === "object" ? raw.po : {};
  // Rebuild `input.endpoints` from the separately-validated UI-side
  // `EndpointEntry[]` rather than trusting the raw JSON. The first
  // auto-run of a shared tab would otherwise submit whatever nested
  // `EndpointInput` objects the URL carried — and the normalizer above
  // does not deep-validate that shape.
  if (filter.mode === "structured" && endpoints.length > 0) {
    filter = {
      mode: "structured",
      input: {
        ...filter.input,
        endpoints: endpointsToEndpointInputs(endpoints),
      },
    };
  }
  return {
    id: createTabId(),
    filter,
    period,
    endpoints,
    pivotOnly,
    name: null,
    autoRun: raw.ar === true,
    analyticsOpen: false,
  };
}

/**
 * Build the URL search params for the full tab set. The active tab
 * is mirrored in top-level params (for pivot compatibility); if the
 * resulting URL stays under {@link TABS_URL_BUDGET}, all tabs also
 * ride along in a `tabs` param so a shared link reproduces the
 * author's whole strip.
 *
 * `activeIndex > 0` is written as `?tab=<index>`; a 0 active index
 * stays off the URL (same shape as a no-tabs pivot link).
 *
 * `pathname` is used only to compute the encoded URL length against
 * the budget. Pass the current `window.location.pathname` when
 * calling from the browser.
 */
export function buildAllTabsSearchParams(args: {
  tabs: TabSnapshot[];
  activeIndex: number;
  pathname?: string;
}): { search: URLSearchParams; tabsIncluded: boolean } {
  const { tabs, activeIndex } = args;
  const index = activeIndex >= 0 && activeIndex < tabs.length ? activeIndex : 0;
  const active = tabs[index];
  const search = active
    ? buildActiveTabSearchParams({
        filter: active.filter,
        period: active.period,
        endpoints: active.endpoints,
        pivotOnly: active.pivotOnly,
        autoRun: active.autoRun,
      })
    : new URLSearchParams();
  if (index > 0) search.set("tab", String(index));
  if (tabs.length <= 1) {
    return { search, tabsIncluded: false };
  }
  const serialized = tabs.map(serializeTabForUrl);
  const json = JSON.stringify(serialized);
  // Copy so we can test the length before committing.
  const candidate = new URLSearchParams(search);
  candidate.set(TABS_PARAM, json);
  const qs = candidate.toString();
  const pathLen = (args.pathname ?? "").length;
  if (qs.length + pathLen + 1 > TABS_URL_BUDGET) {
    return { search, tabsIncluded: false };
  }
  return { search: candidate, tabsIncluded: true };
}

/**
 * Decode the `tabs=<json>` param into a full tab set when present.
 * Returns `null` if the param is missing or malformed so callers can
 * fall back to the single-tab URL shape.
 */
export function parseTabsJsonParam(
  source: Record<string, string | string[] | undefined>,
): TabSnapshot[] | null {
  const raw = readString(source, TABS_PARAM);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    // Decode-time enforcement of the issue's 8-tab cap. A shared
    // `?tabs=` link that would hydrate more than TAB_CAP tabs is
    // rejected rather than silently expanding the strip past the
    // documented limit.
    parsed.length > TAB_CAP
  ) {
    return null;
  }
  const out: TabSnapshot[] = [];
  for (const entry of parsed) {
    const tab = deserializeTabFromUrl(entry as SerializedTabForUrl);
    if (!tab) return null;
    out.push(tab);
  }
  return out;
}

/**
 * Read the `tab=<index>` param into a validated active index. Returns
 * `null` for unset / malformed / out-of-range values.
 */
export function readActiveTabIndex(
  source: Record<string, string | string[] | undefined>,
  tabCount: number,
): number | null {
  const raw = readString(source, "tab");
  if (!raw) return null;
  // Strict integer parse. `Number.parseInt` tolerates trailing garbage
  // (`"1junk"` → 1) and fractional values (`"1.5"` → 1); both would
  // silently activate the wrong tab on a hand-edited or corrupted URL.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (tabCount > 0 && n >= tabCount) return null;
  return n;
}
