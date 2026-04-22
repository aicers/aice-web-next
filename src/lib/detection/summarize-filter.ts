/**
 * Shared chip summarisation for the active filter chip bar.
 *
 * Operates on the abstract `Filter` from Phase Detection-2 (not the
 * raw `EventListFilterInput`) so any caller that already speaks
 * `Filter` — the Detection shell, future tab manager, saved-filter
 * previews — can reuse the same chip set.
 *
 * Aggregation rule (umbrella issue #271, Phase Detection-9):
 *
 * - Single-valued fields render their value (e.g. `source: 10.0.0.5`).
 * - Array fields with ≤ `MAX_INDIVIDUAL_VALUES` entries render each
 *   entry as its own chip.
 * - Array fields with more entries collapse to a single aggregate
 *   chip carrying the count (`Hostnames: 7`). The chip body opens a
 *   popover listing the individual values; the `×` removes the whole
 *   field.
 *
 * Forward-compatibility (`mode: "query"`):
 *   The future search-language mode can express OR / NOT / regex that
 *   per-field chips cannot represent without losing meaning. When
 *   `filter.mode === "query"` the bar must render the query text as a
 *   single editable pill; that branch lands in a later phase. v1
 *   returns an empty list and the chip-bar consumer is expected to
 *   render the query-pill itself. See the Forward compatibility
 *   section of the umbrella for details.
 *   TODO(Phase Detection — search language): replace the empty
 *   shortcut with a single `query`-kind chip carrying `filter.text`
 *   so the bar can render the editable pill via the same channel.
 */

import type { Filter } from "./filter";
import type { EndpointInput, EventListFilterInput, ThreatLevel } from "./types";

/**
 * Threshold above which an array-valued filter collapses into an
 * aggregate chip. The umbrella spec says "around 3" — we pick three
 * exactly so the helper is deterministic.
 */
export const MAX_INDIVIDUAL_VALUES = 3;

/**
 * Stable identifier for each chip-producing field. The id pairs the
 * filter field name with a discriminator so the chip-bar removal
 * handler can map a click back to a single mutation on the abstract
 * `Filter` without re-deriving the field from the label text.
 */
export type ChipFieldId =
  | "period"
  | "range"
  | "source"
  | "destination"
  | "confidenceMin"
  | "confidenceMax"
  | "customers"
  | "endpoints"
  | "directions"
  | "keywords"
  | "networkTags"
  | "sensors"
  | "os"
  | "devices"
  | "hostnames"
  | "userIds"
  | "userNames"
  | "userDepartments"
  | "countries"
  | "categories"
  | "levels"
  | "kinds"
  | "learningMethods"
  | "triagePolicies";

/**
 * One row in the chip bar. `kind` distinguishes how clicking the
 * chip body should behave:
 *
 * - `value` — opens the filter drawer focused on `field` (single
 *   value, or one of an array field's < MAX_INDIVIDUAL_VALUES
 *   chips).
 * - `aggregate` — opens a popover listing the underlying values
 *   before optionally hopping to the drawer.
 */
export interface ChipSpec {
  /**
   * `field`-derived id; for array fields broken into individual
   * chips, the `index` differentiates the entries so React keys are
   * stable.
   */
  id: string;
  field: ChipFieldId;
  kind: "value" | "aggregate";
  /** Localised left-side label (e.g. `"Source"` / `"Hostnames"`). */
  label: string;
  /**
   * Right-side display text. For `value` chips this is the value
   * itself; for `aggregate` it's the localised "N selected" form.
   */
  value: string;
  /**
   * For `value` chips backed by a single entry of an array field,
   * the entry index — used by the removal handler to splice that
   * entry out without affecting the others. Absent for non-array
   * fields and for aggregate chips (which remove the whole field).
   */
  arrayIndex?: number;
  /**
   * For aggregate chips, the underlying values so the popover can
   * render them without re-walking the filter.
   */
  values?: readonly string[];
}

/**
 * Localised labels supplied by the caller so the helper itself
 * stays free of i18n machinery (and so it remains usable from
 * server components and tests with synthetic labels).
 *
 * The `aggregate(label, count)` callback formats the right-hand
 * side of an aggregate chip; consumers typically wire it to
 * `t("filters.chips.aggregate", { label, count })`.
 */
export interface SummarizeFilterLabels {
  period: string;
  range: string;
  source: string;
  destination: string;
  confidenceMin: string;
  confidenceMax: string;
  customers: string;
  endpoints: string;
  directions: string;
  keywords: string;
  networkTags: string;
  sensors: string;
  os: string;
  devices: string;
  hostnames: string;
  userIds: string;
  userNames: string;
  userDepartments: string;
  countries: string;
  categories: string;
  levels: string;
  kinds: string;
  learningMethods: string;
  triagePolicies: string;
  /** `Last 1h`-style label for a recognised period quick-select. */
  periodOptions: Partial<Record<string, string>>;
  /** Localised `<start> – <end>` formatter for an explicit range. */
  rangeFormatter: (start: string, end: string) => string;
  /** Localised level-name lookup (e.g. `HIGH` → `"High"`). */
  levelName: (level: ThreatLevel) => string;
  /** Right-side text for an aggregate chip, e.g. `"7 selected"`. */
  aggregate: (count: number) => string;
}

/**
 * Optional contextual info: the matched period key (when the
 * current `start`/`end` exactly match a quick-select), so the
 * Period chip can render `Last 1h` instead of the raw range. The
 * caller resolves this via `matchesPeriodKey()` from
 * `@/lib/detection/period`.
 */
export interface SummarizeFilterContext {
  matchedPeriod?: string | null;
}

/**
 * Produce the active-filter chip list. Chip ordering is stable
 * across renders so React keying is straightforward and screenshots
 * are deterministic.
 */
export function summarizeFilter(
  filter: Filter,
  labels: SummarizeFilterLabels,
  context: SummarizeFilterContext = {},
): ChipSpec[] {
  if (filter.mode === "query") {
    // TODO(Phase Detection — search language): emit a single
    // `query`-kind chip carrying `filter.text`. v1 leaves the chip
    // bar empty for this branch; consumers render the editable pill
    // separately.
    return [];
  }

  const input = filter.input;
  const chips: ChipSpec[] = [];

  pushPeriodChip(chips, input, labels, context);
  pushSingleValueChip(chips, "source", labels.source, input.source);
  pushSingleValueChip(
    chips,
    "destination",
    labels.destination,
    input.destination,
  );
  pushArrayChips(chips, "kinds", labels.kinds, input.kinds, labels.aggregate);
  pushArrayChips(
    chips,
    "categories",
    labels.categories,
    formatNullableNumberArray(input.categories),
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "levels",
    labels.levels,
    input.levels?.map(numberToThreatLevel).map(labels.levelName),
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "directions",
    labels.directions,
    input.directions,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "countries",
    labels.countries,
    input.countries,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "hostnames",
    labels.hostnames,
    input.hostnames,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "userIds",
    labels.userIds,
    input.userIds,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "userNames",
    labels.userNames,
    input.userNames,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "userDepartments",
    labels.userDepartments,
    input.userDepartments,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "sensors",
    labels.sensors,
    input.sensors,
    labels.aggregate,
  );
  pushArrayChips(chips, "os", labels.os, input.os, labels.aggregate);
  pushArrayChips(
    chips,
    "devices",
    labels.devices,
    input.devices,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "keywords",
    labels.keywords,
    input.keywords,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "networkTags",
    labels.networkTags,
    input.networkTags,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "customers",
    labels.customers,
    input.customers,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "learningMethods",
    labels.learningMethods,
    input.learningMethods,
    labels.aggregate,
  );
  pushArrayChips(
    chips,
    "triagePolicies",
    labels.triagePolicies,
    input.triagePolicies,
    labels.aggregate,
  );
  // `endpoints` is a structured array — format each rule into a
  // compact string and feed it through the shared array-chip path so
  // the umbrella's array rules apply uniformly: ≤ MAX_INDIVIDUAL_VALUES
  // entries render per-rule chips (each removable individually),
  // larger arrays collapse into one aggregate chip whose popover
  // lists the same formatted strings.
  pushArrayChips(
    chips,
    "endpoints",
    labels.endpoints,
    input.endpoints?.map(formatEndpointValue),
    labels.aggregate,
  );

  pushSingleValueChip(
    chips,
    "confidenceMin",
    labels.confidenceMin,
    input.confidenceMin !== undefined && input.confidenceMin !== null
      ? input.confidenceMin.toFixed(2)
      : undefined,
  );
  pushSingleValueChip(
    chips,
    "confidenceMax",
    labels.confidenceMax,
    input.confidenceMax !== undefined && input.confidenceMax !== null
      ? input.confidenceMax.toFixed(2)
      : undefined,
  );

  return chips;
}

function pushPeriodChip(
  chips: ChipSpec[],
  input: EventListFilterInput,
  labels: SummarizeFilterLabels,
  context: SummarizeFilterContext,
) {
  if (!input.start || !input.end) return;
  const matched = context.matchedPeriod;
  if (matched) {
    const periodLabel = labels.periodOptions[matched] ?? matched;
    chips.push({
      id: "period",
      field: "period",
      kind: "value",
      label: labels.period,
      value: periodLabel,
    });
    return;
  }
  chips.push({
    id: "range",
    field: "range",
    kind: "value",
    label: labels.range,
    value: labels.rangeFormatter(input.start, input.end),
  });
}

function pushSingleValueChip(
  chips: ChipSpec[],
  field: ChipFieldId,
  label: string,
  value: string | undefined | null,
) {
  if (value === undefined || value === null || value === "") return;
  chips.push({
    id: field,
    field,
    kind: "value",
    label,
    value,
  });
}

function pushArrayChips(
  chips: ChipSpec[],
  field: ChipFieldId,
  label: string,
  values: readonly string[] | undefined | null,
  aggregate: (count: number) => string,
) {
  if (!values || values.length === 0) return;
  if (values.length > MAX_INDIVIDUAL_VALUES) {
    chips.push({
      id: field,
      field,
      kind: "aggregate",
      label,
      value: aggregate(values.length),
      values: [...values],
    });
    return;
  }
  values.forEach((value, index) => {
    chips.push({
      id: `${field}:${index}`,
      field,
      kind: "value",
      label,
      value,
      arrayIndex: index,
    });
  });
}

const NUMBER_TO_LEVEL: Record<number, ThreatLevel> = {
  1: "LOW",
  2: "MEDIUM",
  3: "HIGH",
};

function numberToThreatLevel(level: number): ThreatLevel {
  return NUMBER_TO_LEVEL[level] ?? "LOW";
}

/**
 * Format a single `EndpointInput` into the compact string the chip
 * popover displays. Direction prefixes the rule when set; the body
 * is either the predefined host-network group id (prefixed with `#`
 * to disambiguate from literal addresses) or a comma-joined list of
 * the custom group's hosts, networks, and ranges. Pure string
 * transformation — no i18n needed, since the pieces (`FROM`/`TO`,
 * addresses, CIDRs) are already stable identifiers.
 */
function formatEndpointValue(endpoint: EndpointInput): string {
  const parts: string[] = [];
  if (endpoint.direction) parts.push(endpoint.direction);
  if (endpoint.predefined) {
    parts.push(`#${endpoint.predefined}`);
  } else if (endpoint.custom) {
    const pieces: string[] = [];
    pieces.push(...endpoint.custom.hosts);
    pieces.push(...endpoint.custom.networks);
    pieces.push(...endpoint.custom.ranges.map((r) => `${r.start}–${r.end}`));
    if (pieces.length > 0) parts.push(pieces.join(", "));
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function formatNullableNumberArray(
  values: readonly (number | null)[] | null | undefined,
): string[] | undefined {
  if (!values) return undefined;
  return values.map((v) => (v === null ? "—" : String(v)));
}

/**
 * Return a new `Filter` with the field referenced by `chip`
 * removed. Aggregate chips remove the whole field; per-value chips
 * splice that single entry from an array field. The Period / Range
 * chip removes both `start` and `end`.
 *
 * Always returns a `Filter` of the same `mode`. The `query` mode is
 * untouched in v1 (the chip bar suppresses per-field chips for it).
 */
export function removeChipFromFilter(filter: Filter, chip: ChipSpec): Filter {
  if (filter.mode === "query") return filter;
  const next: EventListFilterInput = { ...filter.input };
  switch (chip.field) {
    case "period":
    case "range":
      delete next.start;
      delete next.end;
      break;
    case "source":
      delete next.source;
      break;
    case "destination":
      delete next.destination;
      break;
    case "confidenceMin":
      delete next.confidenceMin;
      break;
    case "confidenceMax":
      delete next.confidenceMax;
      break;
    default:
      removeArrayEntry(next, chip);
      break;
  }
  return { mode: "structured", input: next };
}

function removeArrayEntry(input: EventListFilterInput, chip: ChipSpec) {
  const field = chip.field as Exclude<
    ChipFieldId,
    | "period"
    | "range"
    | "source"
    | "destination"
    | "confidenceMin"
    | "confidenceMax"
  >;
  if (chip.kind === "aggregate" || chip.arrayIndex === undefined) {
    delete (input as Record<string, unknown>)[field];
    return;
  }
  const current = (input as Record<string, unknown>)[field];
  if (!Array.isArray(current)) return;
  const next = current.filter((_, i) => i !== chip.arrayIndex);
  if (next.length === 0) {
    delete (input as Record<string, unknown>)[field];
  } else {
    (input as Record<string, unknown>)[field] = next;
  }
}
