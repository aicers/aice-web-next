/**
 * Menu-neutral pivot-filter encoding for Detection URLs.
 *
 * The Investigation page's Overview and Related tabs build pivot
 * links into Detection (`/detection?source=...&window=1d`). This
 * module owns that URL shape so both sides — the link builders on
 * the Investigation page and the reader on the Detection page —
 * stay in sync without depending on each other.
 *
 * The same URL shape doubles as persistence for the drawer's
 * free-form filter fields: the Apply handler round-trips source,
 * destination, keywords, hostnames, userIds, userNames, and
 * userDepartments through the URL so a page refresh restores the
 * active tab's filter state.
 */
import type { EventListFilterInput, FlowKind, LearningMethod } from "./types";

/**
 * Free-form tag-input fields in the filter drawer. Kept as a named
 * set so the draft, chip builder, and URL encoder all iterate the
 * same list and can't drift out of sync when a new tag-valued field
 * is added. Lives in the lib (non-client) module so server code —
 * the Detection page — can import it without tripping Next.js's
 * server-reference wrapping of exports from `"use client"` modules.
 */
export const TAG_FIELDS = [
  "keywords",
  "hostnames",
  "userIds",
  "userNames",
  "userDepartments",
] as const;
export type TagField = (typeof TAG_FIELDS)[number];

/** Single-string fields in the drawer (`source`, `destination`). */
export const TEXT_FIELDS = ["source", "destination"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export type PivotWindow = "1d" | "7d";

const FLOW_KIND_VALUES: readonly FlowKind[] = [
  "INBOUND",
  "OUTBOUND",
  "INTERNAL",
];
const LEARNING_METHOD_VALUES_INT: readonly LearningMethod[] = [
  "UNSUPERVISED",
  "SEMI_SUPERVISED",
];

/**
 * URL round-trip shape for the Detection page.
 *
 * Historically this represented only the pivot subset (source,
 * destination, kind, window, tag fields) that Investigation-side
 * pivot links build. It now also carries every committed filter
 * dimension that has a straightforward URL representation so the
 * browser address bar, reload, link share, and the Investigation
 * `returnTo` round-trip preserve the full in-session filter — not
 * just the pivot context the operator originally arrived with. Per
 * reviewer round 6, the previous narrow shape dropped `levels` /
 * `countries` / `categories` / `directions` / `confidence` / `sensors`
 * / multi-kind / custom time ranges off the URL whenever a chip was
 * removed or the drawer was Applied.
 *
 * Endpoints (the Network/IP Advanced rows) are the only filter
 * dimension still absent from the URL — their `ParsedEndpoint` shape
 * is compound (direction × kind × host/network/range) and the
 * round-trip needs client-side state with stable IDs that the URL
 * cannot carry cleanly. They stay in memory + chip bar until a
 * future phase lifts them into the URL shape.
 */
export interface PivotFilterParams {
  source?: string;
  destination?: string;
  /** Single-kind pivot (back-compat with pre-#280 Investigation links). Prefer {@link kinds} when serializing from the committed filter. */
  kind?: string;
  /** Multi-kind selection. Mutually exclusive with {@link kind} on serialize; on parse either may be present and both are merged. */
  kinds?: string[];
  origPort?: number;
  respPort?: number;
  proto?: number;
  /** `1d` / `7d` pivot window. Overridden by an explicit {@link start} / {@link end} pair. */
  window?: PivotWindow;
  /** ISO start of a custom time range (used when the active period has no `window=` shorthand, e.g. `1h`, `1m`, or an explicit custom range). */
  start?: string;
  /** ISO end of a custom time range — see {@link start}. */
  end?: string;
  /**
   * Explicit "no time filter" marker. Distinct from "no time-related
   * params" (which the parser interprets as "use the default 1h
   * period"): when the operator clears the Period chip we have to
   * round-trip that intent through reload / share / `returnTo`, or the
   * next page load silently re-introduces `Last 1 hour`. Emitted as
   * `time=none` in the URL. Mutually exclusive with {@link window} /
   * {@link start} / {@link end}.
   */
  noTime?: boolean;
  keywords?: string[];
  hostnames?: string[];
  userIds?: string[];
  userNames?: string[];
  userDepartments?: string[];
  /** Numeric ThreatLevel values (1 = LOW, 2 = MEDIUM, 3 = HIGH). */
  levels?: number[];
  countries?: string[];
  /** Numeric ThreatCategory values. */
  categories?: number[];
  learningMethods?: LearningMethod[];
  directions?: FlowKind[];
  /** Decimal 0..1, two decimals. Omitted when the range is the full `[0, 1]` default. */
  confMin?: number;
  confMax?: number;
  sensors?: string[];
}

export type PivotKey = keyof PivotFilterParams;

const WINDOW_VALUES: readonly PivotWindow[] = ["1d", "7d"];

function isPivotWindow(value: string): value is PivotWindow {
  return (WINDOW_VALUES as readonly string[]).includes(value);
}

function isFlowKind(value: string): value is FlowKind {
  return (FLOW_KIND_VALUES as readonly string[]).includes(value);
}

function isLearningMethod(value: string): value is LearningMethod {
  return (LEARNING_METHOD_VALUES_INT as readonly string[]).includes(value);
}

function readString(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFiniteInt(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/**
 * Parse an ISO-8601 timestamp. Returns `undefined` for missing or
 * unparseable input — a garbage `start=foo` in the URL must not leak
 * into the committed filter, where the chip bar would later render a
 * bogus `formatRange("", "")` summary and the query would forward the
 * raw string back to REview.
 *
 * Normalizes to the canonical ISO string (`toISOString()`) so the
 * value round-trips identically through subsequent `urlParamsForCommitted`
 * emissions — otherwise a pivot URL with `start=2026-04-22T12:00:00Z`
 * would re-serialize as `2026-04-22T12:00:00.000Z` on the first
 * dispatch, forcing the browser URL to flicker between two equivalent
 * representations.
 */
function readIsoTimestamp(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString();
}

/** Parse a decimal in `[0, 1]`. Out-of-range / NaN inputs are dropped. */
function readConfidence(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
  return n;
}

/**
 * Decode a comma-separated list of non-negative integers. Empty
 * entries and duplicates are dropped; entirely empty lists return
 * `undefined` so callers can treat "missing" and "explicitly empty"
 * identically.
 */
function readNumberList(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number[] | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Decode a comma-separated list filtered through a value predicate.
 * Used to enforce the closed enums for {@link FlowKind} and
 * {@link LearningMethod} — a user-controlled URL with
 * `direction=ZZTOP` should not inject a garbage direction into the
 * filter.
 */
function readEnumList<T extends string>(
  source: Record<string, string | string[] | undefined>,
  key: string,
  isMember: (v: string) => v is T,
): T[] | undefined {
  const list = readStringList(source, key);
  if (!list) return undefined;
  const out: T[] = [];
  const seen = new Set<T>();
  for (const v of list) {
    if (isMember(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Decode a comma-separated list param. Empty strings and
 * whitespace-only entries are dropped so stray separators don't
 * produce empty tags; duplicates are collapsed (first-seen wins) so
 * a user-controlled URL can't inject duplicate chip ids or unstable
 * tag-input React keys. Returns `undefined` when nothing usable
 * remains so callers can treat "missing" and "explicitly empty"
 * identically.
 */
function readStringList(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string[] | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push(trimmed);
  }
  return parts.length > 0 ? parts : undefined;
}

/**
 * Decode Detection pivot search params. Unknown or malformed entries
 * are dropped silently — the Detection page treats the URL as a
 * best-effort handoff, not a form to validate.
 */
export function parsePivotSearchParams(
  source: Record<string, string | string[] | undefined>,
): PivotFilterParams {
  const window = readString(source, "window");
  // `time=none` is the explicit "no time filter" marker. When present
  // it suppresses every other time-related param (`window`, `start`,
  // `end`) so an unrelated stale value can't leak back into the
  // committed range.
  const noTime = readString(source, "time") === "none";
  // Validate `start=` / `end=` strictly. An unparseable timestamp (or
  // an inverted range) is dropped entirely so the parser's
  // "malformed entries are dropped silently" contract actually holds
  // for the time dimension — otherwise `applyPivotHandoff` would
  // forward `start=foo` into the filter input (breaking the REview
  // query) and `summarizeFilter` would render a bogus chip via
  // `formatRange("", "")`. Only a complete, well-ordered pair is
  // accepted; a lone `start=` or `end=` falls back to `window=` or
  // the default-1h period below.
  const rawStart = noTime ? undefined : readIsoTimestamp(source, "start");
  const rawEnd = noTime ? undefined : readIsoTimestamp(source, "end");
  const hasWellOrderedRange =
    rawStart !== undefined &&
    rawEnd !== undefined &&
    Date.parse(rawStart) < Date.parse(rawEnd);
  const start = hasWellOrderedRange ? rawStart : undefined;
  const end = hasWellOrderedRange ? rawEnd : undefined;
  return {
    source: readString(source, "source"),
    destination: readString(source, "destination"),
    kind: readString(source, "kind"),
    kinds: readStringList(source, "kinds"),
    origPort: readFiniteInt(source, "origPort"),
    respPort: readFiniteInt(source, "respPort"),
    proto: readFiniteInt(source, "proto"),
    window: noTime
      ? undefined
      : window && isPivotWindow(window)
        ? window
        : undefined,
    start,
    end,
    noTime: noTime || undefined,
    keywords: readStringList(source, "keywords"),
    hostnames: readStringList(source, "hostnames"),
    userIds: readStringList(source, "userIds"),
    userNames: readStringList(source, "userNames"),
    userDepartments: readStringList(source, "userDepartments"),
    levels: readNumberList(source, "level"),
    countries: readStringList(source, "country"),
    categories: readNumberList(source, "category"),
    learningMethods: readEnumList(source, "learningMethod", isLearningMethod),
    directions: readEnumList(source, "direction", isFlowKind),
    confMin: readConfidence(source, "confMin"),
    confMax: readConfidence(source, "confMax"),
    sensors: readStringList(source, "sensor"),
  };
}

/**
 * Encode pivot params into a `/detection?…` URL. Undefined or empty
 * fields are omitted so shared URLs stay tidy.
 */
export function buildDetectionPivotUrl(params: PivotFilterParams): string {
  const search = buildDetectionSearchParams(params);
  const qs = search.toString();
  return qs ? `/detection?${qs}` : "/detection";
}

/**
 * Serialize pivot params into a `URLSearchParams`. Exposed separately
 * from {@link buildDetectionPivotUrl} so client-side callers can merge
 * the result with `usePathname()` and `router.replace()` without
 * parsing the URL back out.
 */
export function buildDetectionSearchParams(
  params: PivotFilterParams,
): URLSearchParams {
  const search = new URLSearchParams();
  if (params.source) search.set("source", params.source);
  if (params.destination) search.set("destination", params.destination);
  // `kind=` is preferred for a single-value selection (matches the
  // pre-#280 pivot-link shape that Investigation-side links still
  // emit); `kinds=` covers multi-select. Never emit both — on re-parse
  // they'd be merged, duplicating the single kind.
  if (params.kind) search.set("kind", params.kind);
  else writeList(search, "kinds", params.kinds);
  if (params.origPort !== undefined) {
    search.set("origPort", String(params.origPort));
  }
  if (params.respPort !== undefined) {
    search.set("respPort", String(params.respPort));
  }
  if (params.proto !== undefined) search.set("proto", String(params.proto));
  if (params.noTime) {
    // Explicit "no time filter" — overrides any stale window/start/end
    // so reload, share, and Investigation `returnTo` all decode back
    // into the same no-time committed state instead of falling into
    // the parser's default-1h branch.
    search.set("time", "none");
  } else if (params.window) {
    search.set("window", params.window);
  } else {
    // Only emit an explicit range when no `window=` shorthand applies
    // (e.g. `1h` / `1m` periods, or a custom start–end range the
    // operator typed in the drawer). Otherwise the two would be
    // redundant and could drift on re-parse.
    if (params.start) search.set("start", params.start);
    if (params.end) search.set("end", params.end);
  }
  writeList(search, "keywords", params.keywords);
  writeList(search, "hostnames", params.hostnames);
  writeList(search, "userIds", params.userIds);
  writeList(search, "userNames", params.userNames);
  writeList(search, "userDepartments", params.userDepartments);
  writeList(
    search,
    "level",
    params.levels?.map((v) => String(v)),
  );
  writeList(search, "country", params.countries);
  writeList(
    search,
    "category",
    params.categories?.map((v) => String(v)),
  );
  writeList(search, "learningMethod", params.learningMethods);
  writeList(search, "direction", params.directions);
  if (params.confMin !== undefined) {
    search.set("confMin", params.confMin.toFixed(2));
  }
  if (params.confMax !== undefined) {
    search.set("confMax", params.confMax.toFixed(2));
  }
  writeList(search, "sensor", params.sensors);
  return search;
}

function writeList(
  search: URLSearchParams,
  key: string,
  values: string[] | undefined,
): void {
  if (!values || values.length === 0) return;
  // Commas are URL-reserved but not encoded by default; use them as
  // the list separator so the value stays human-readable when copied.
  search.set(key, values.join(","));
}

export interface PivotChipLabels {
  source: string;
  destination: string;
  kind: string;
  origPort: string;
  respPort: string;
  proto: string;
  window: string;
  windowLastDay: string;
  windowLastWeek: string;
  keywords: string;
  hostnames: string;
  userIds: string;
  userNames: string;
  userDepartments: string;
  /** Rendered for an aggregated multi-value chip (e.g. "Keywords: 12"). */
  countAggregate: (label: string, count: number) => string;
}

export interface PivotChip {
  /** Stable id used as React key; also encodes which field the chip represents. */
  id: string;
  /** Underlying filter field the chip belongs to — used when the operator activates an aggregate chip to open the drawer focused on that field. */
  field: PivotKey;
  label: string;
  value: string;
  /** Whether this chip represents an aggregated count rather than a single value. */
  aggregate?: boolean;
}

/**
 * Per the shared aggregation rule, array fields expand to individual
 * chips when there are three or fewer values and collapse to a single
 * "Keywords: N" token once there are more.
 */
const AGGREGATE_THRESHOLD = 3;

/**
 * Build a display-ready chip descriptor list from pivot params.
 * Order is stable (same order as `PivotKey` declarations) so the
 * chip bar is deterministic across renders. Array fields follow the
 * shared aggregation rule: 1–3 values → individual chips, more →
 * aggregate count token.
 */
export function buildPivotChips(
  params: PivotFilterParams,
  labels: PivotChipLabels,
): PivotChip[] {
  const chips: PivotChip[] = [];
  if (params.source) {
    chips.push({
      id: "source",
      field: "source",
      label: labels.source,
      value: params.source,
    });
  }
  if (params.destination) {
    chips.push({
      id: "destination",
      field: "destination",
      label: labels.destination,
      value: params.destination,
    });
  }
  if (params.kind) {
    chips.push({
      id: "kind",
      field: "kind",
      label: labels.kind,
      value: params.kind,
    });
  }
  if (params.origPort !== undefined) {
    chips.push({
      id: "origPort",
      field: "origPort",
      label: labels.origPort,
      value: String(params.origPort),
    });
  }
  if (params.respPort !== undefined) {
    chips.push({
      id: "respPort",
      field: "respPort",
      label: labels.respPort,
      value: String(params.respPort),
    });
  }
  if (params.proto !== undefined) {
    chips.push({
      id: "proto",
      field: "proto",
      label: labels.proto,
      value: String(params.proto),
    });
  }
  if (params.window) {
    chips.push({
      id: "window",
      field: "window",
      label: labels.window,
      value:
        params.window === "1d" ? labels.windowLastDay : labels.windowLastWeek,
    });
  }
  appendArrayChips(chips, "keywords", params.keywords, labels.keywords, labels);
  appendArrayChips(
    chips,
    "hostnames",
    params.hostnames,
    labels.hostnames,
    labels,
  );
  appendArrayChips(chips, "userIds", params.userIds, labels.userIds, labels);
  appendArrayChips(
    chips,
    "userNames",
    params.userNames,
    labels.userNames,
    labels,
  );
  appendArrayChips(
    chips,
    "userDepartments",
    params.userDepartments,
    labels.userDepartments,
    labels,
  );
  return chips;
}

function appendArrayChips(
  chips: PivotChip[],
  field: PivotKey,
  values: string[] | undefined,
  label: string,
  labels: PivotChipLabels,
): void {
  if (!values || values.length === 0) return;
  if (values.length > AGGREGATE_THRESHOLD) {
    chips.push({
      id: `${field}:agg`,
      field,
      label,
      value: labels.countAggregate(label, values.length),
      aggregate: true,
    });
    return;
  }
  for (const value of values) {
    chips.push({
      id: `${field}:${value}`,
      field,
      label,
      value,
    });
  }
}

/**
 * Lift the free-form drawer fields out of a concrete filter input so
 * the shell can reuse one chip builder for both URL-seeded pivots and
 * the committed filter. Only fields this module knows how to render
 * as chips/URL params are extracted; the rest (start/end, categorical
 * inputs, network tags, etc.) stay where they are.
 */
export function pivotParamsFromFilterInput(
  input: EventListFilterInput,
): PivotFilterParams {
  return {
    source: input.source ?? undefined,
    destination: input.destination ?? undefined,
    keywords: input.keywords?.length ? input.keywords : undefined,
    hostnames: input.hostnames?.length ? input.hostnames : undefined,
    userIds: input.userIds?.length ? input.userIds : undefined,
    userNames: input.userNames?.length ? input.userNames : undefined,
    userDepartments: input.userDepartments?.length
      ? input.userDepartments
      : undefined,
  };
}

/**
 * Merge pivot-only chip fields (kind/ports/proto/window — not yet
 * wired to the filter drawer) with the free-form filter fields into
 * a single params object so {@link buildPivotChips} produces the
 * drawer-backed chips alongside the Investigation-handoff chips.
 */
export function mergePivotParams(
  pivotOnly: PivotFilterParams,
  filterSide: PivotFilterParams,
): PivotFilterParams {
  return {
    // Filter-side fields win for any overlap because the committed
    // filter is the source of truth once Apply fires. Kind and
    // window used to be pivot-only because the filter side had no
    // way to represent them; they now round-trip through the
    // committed state (see `urlParamsForCommitted` in
    // `pivot-handoff.ts`), so filter-side takes precedence when set.
    kind: filterSide.kind ?? pivotOnly.kind,
    kinds: filterSide.kinds ?? pivotOnly.kinds,
    origPort: pivotOnly.origPort,
    respPort: pivotOnly.respPort,
    proto: pivotOnly.proto,
    window: filterSide.window ?? pivotOnly.window,
    start: filterSide.start ?? pivotOnly.start,
    end: filterSide.end ?? pivotOnly.end,
    noTime: filterSide.noTime ?? pivotOnly.noTime,
    source: filterSide.source ?? pivotOnly.source,
    destination: filterSide.destination ?? pivotOnly.destination,
    keywords: filterSide.keywords,
    hostnames: filterSide.hostnames,
    userIds: filterSide.userIds,
    userNames: filterSide.userNames,
    userDepartments: filterSide.userDepartments,
    levels: filterSide.levels ?? pivotOnly.levels,
    countries: filterSide.countries ?? pivotOnly.countries,
    categories: filterSide.categories ?? pivotOnly.categories,
    learningMethods: filterSide.learningMethods ?? pivotOnly.learningMethods,
    directions: filterSide.directions ?? pivotOnly.directions,
    confMin: filterSide.confMin ?? pivotOnly.confMin,
    confMax: filterSide.confMax ?? pivotOnly.confMax,
    sensors: filterSide.sensors ?? pivotOnly.sensors,
  };
}
