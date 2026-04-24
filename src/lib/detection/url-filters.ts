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
import type { PeriodKey } from "./period";
import type { EventListFilterInput } from "./types";

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

export interface PivotFilterParams {
  source?: string;
  destination?: string;
  kind?: string;
  origPort?: number;
  respPort?: number;
  proto?: number;
  window?: PivotWindow;
  keywords?: string[];
  hostnames?: string[];
  userIds?: string[];
  userNames?: string[];
  userDepartments?: string[];
}

export type PivotKey = keyof PivotFilterParams;

const WINDOW_VALUES: readonly PivotWindow[] = ["1d", "7d"];

function isPivotWindow(value: string): value is PivotWindow {
  return (WINDOW_VALUES as readonly string[]).includes(value);
}

/**
 * Map a pivot URL `window=` value onto the drawer's {@link PeriodKey}
 * vocabulary. `1d` matches the "last 24 hours" period chip; `7d` maps
 * onto `1w` (last week) since the drawer speaks in calendar units.
 * Returns `null` when the pivot carries no window so callers can fall
 * back to the page default. Kept as a dedicated helper so the
 * Detection server page and any future client-side pivot handlers
 * share a single encoding.
 */
export function pivotWindowToPeriodKey(
  window: PivotWindow | undefined,
): PeriodKey | null {
  if (window === "1d") return "1d";
  if (window === "7d") return "1w";
  return null;
}

/**
 * Inverse of {@link pivotWindowToPeriodKey}. Returns the pivot URL
 * `window=` token that round-trips the given {@link PeriodKey}, or
 * `undefined` when the committed period has no pivot-URL
 * representation (`30m`, `1h`, `6h`, …). Used by the URL writer to
 * re-emit `window=` from the committed period rather than a
 * first-render snapshot, so a period change in the drawer clears the
 * stale pivot window on the next `history.replaceState`.
 */
export function periodKeyToPivotWindow(
  period: PeriodKey | null | undefined,
): PivotWindow | undefined {
  if (period === "1d") return "1d";
  if (period === "1w") return "7d";
  return undefined;
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
  return {
    source: readString(source, "source"),
    destination: readString(source, "destination"),
    kind: readString(source, "kind"),
    origPort: readFiniteInt(source, "origPort"),
    respPort: readFiniteInt(source, "respPort"),
    proto: readFiniteInt(source, "proto"),
    window: window && isPivotWindow(window) ? window : undefined,
    keywords: readStringList(source, "keywords"),
    hostnames: readStringList(source, "hostnames"),
    userIds: readStringList(source, "userIds"),
    userNames: readStringList(source, "userNames"),
    userDepartments: readStringList(source, "userDepartments"),
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
  if (params.kind) search.set("kind", params.kind);
  if (params.origPort !== undefined) {
    search.set("origPort", String(params.origPort));
  }
  if (params.respPort !== undefined) {
    search.set("respPort", String(params.respPort));
  }
  if (params.proto !== undefined) search.set("proto", String(params.proto));
  if (params.window) search.set("window", params.window);
  writeList(search, "keywords", params.keywords);
  writeList(search, "hostnames", params.hostnames);
  writeList(search, "userIds", params.userIds);
  writeList(search, "userNames", params.userNames);
  writeList(search, "userDepartments", params.userDepartments);
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
 * Lift the drawer-backed fields out of the committed filter so the
 * shell can reuse one chip builder / URL writer for both URL-seeded
 * pivots and the committed filter. `kind` and `window` are extracted
 * from `kinds` / the committed `period` — not from a first-render
 * snapshot — so editing those fields in the drawer clears the stale
 * pivot tokens on the next `history.replaceState`. Multi-kind
 * selections have no single-valued pivot URL representation, so
 * `kind` is only emitted when exactly one kind is committed.
 */
export function pivotParamsFromFilterInput(
  input: EventListFilterInput,
  period?: PeriodKey | null,
): PivotFilterParams {
  return {
    source: input.source ?? undefined,
    destination: input.destination ?? undefined,
    kind: input.kinds?.length === 1 ? input.kinds[0] : undefined,
    window: periodKeyToPivotWindow(period),
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
 * Merge pivot-only chip fields (ports / proto — not yet wired to the
 * filter drawer) with the drawer-backed filter fields into a single
 * params object so {@link buildPivotChips} produces the drawer chips
 * alongside the Investigation-handoff chips. Filter-side is the sole
 * source of truth for anything the drawer owns — including `kind`
 * and `window` once the operator edits them — so stale URL tokens
 * are not re-emitted after a chip removal or Apply that drops them.
 */
export function mergePivotParams(
  pivotOnly: PivotFilterParams,
  filterSide: PivotFilterParams,
): PivotFilterParams {
  return {
    // Ports / proto have no filter-drawer representation yet; keep
    // them riding through the URL via `pivotOnly` so the
    // Investigation handoff survives until Phase Network/IP lands.
    origPort: pivotOnly.origPort,
    respPort: pivotOnly.respPort,
    proto: pivotOnly.proto,
    // Drawer-owned fields: always reflect the committed filter.
    // `filterSide.kind` / `filterSide.window` go through verbatim
    // (including `undefined`) rather than falling back to
    // `pivotOnly`, since the committed filter is now the source of
    // truth once the operator has edited kinds or the period.
    kind: filterSide.kind,
    window: filterSide.window,
    source: filterSide.source,
    destination: filterSide.destination,
    keywords: filterSide.keywords,
    hostnames: filterSide.hostnames,
    userIds: filterSide.userIds,
    userNames: filterSide.userNames,
    userDepartments: filterSide.userDepartments,
  };
}
