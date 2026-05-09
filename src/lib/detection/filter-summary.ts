/**
 * Shared active-filter chip summarisation for the Detection page
 * (Phase Detection-9).
 *
 * `summarizeFilter(filter: Filter): FilterChip[]` is the single
 * entry point the chip bar uses. It takes the abstract
 * {@link Filter} from Phase Detection-2 — not a raw
 * {@link EventListFilterInput} — so the future search-language
 * branch can be folded in without reshaping callers.
 *
 * Aggregation rules (from the umbrella issue):
 *
 *  - Single-valued fields render one chip with the concrete value.
 *  - Array fields with ≤ {@link CHIP_DIMENSION_CAP} values render
 *    one chip per value.
 *  - Larger array fields collapse to a single aggregate chip like
 *    `Sensors: 7 selected`.
 *
 * Forward-compatibility note (umbrella #271 — "Forward
 * compatibility"): the v1 chip bar only supports
 * `mode === "structured"`. `mode === "query"` should render the
 * query text as a single editable pill that opens a dedicated
 * query editor; the editor itself is out of scope for v1. Until
 * the editor lands, the query branch below returns **no chips**
 * so the shell can render a plain pill fallback rather than
 * per-field decomposition — the query language can express OR /
 * NOT / regex that structured chips cannot represent, and any
 * attempt to decompose would be misleading.
 */

import type { ChipRemoveTarget } from "./active-filters";
import { FLOW_KINDS, isAllDirections } from "./direction";
import type { Filter } from "./filter";
import {
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  formatConfidenceInput,
  isConfidenceDefault,
  isoToLocalInput,
} from "./filter-draft";
import type { PeriodKey } from "./period";
import type {
  EventListFilterInput,
  FlowKind,
  LearningMethod,
  ThreatLevel,
} from "./types";

/**
 * A chip the active filter bar can render and — via {@link field}
 * or {@link focus} — deactivate or reopen in the drawer. The shell
 * decides the exact interaction; summarisation is presentation-
 * neutral.
 */
export interface FilterChip {
  /** Stable id used as React key and test lookup. */
  id: string;
  /** Human-readable field prefix — e.g. `Sensor`. */
  label: string;
  /** Concrete value or aggregate token. */
  value: string;
  /**
   * Target for chip body activation. When set, activating the chip
   * body reopens the filter drawer focused on this field / section.
   * Left unset for chips whose body activation has no sensible
   * drawer target (e.g. pivot-only URL fields not yet editable in
   * the drawer).
   */
  focus?: FilterChipFocus;
  /**
   * Payload for the × (remove) button. Passing a concrete target
   * here keeps the shell from re-deriving it by parsing `id`.
   */
  remove?: ChipRemoveTarget;
  /**
   * True when the chip collapses an array field with more values
   * than {@link CHIP_DIMENSION_CAP}. The shell uses this to choose
   * between per-value removal and clearing the whole field.
   */
  aggregate?: boolean;
  /**
   * True when this chip represents the query-mode pill (the whole
   * query string as a single editable token). Reserved for forward-
   * compat; v1 never emits one.
   */
  queryPill?: boolean;
}

/**
 * Sections / inputs the drawer can scroll-to and focus when a chip
 * body is activated. A superset of the drawer's internal
 * `DrawerFocusField` — the shell validates membership before
 * handing it to the drawer so widening one side does not silently
 * break the other.
 */
export type FilterChipFocus =
  | "period"
  | "timeRange"
  | "direction"
  | "confidence"
  | "sensor"
  | "endpoints"
  | "source"
  | "destination"
  | "keywords"
  | "hostnames"
  | "userIds"
  | "userNames"
  | "userDepartments"
  | "levels"
  | "countries"
  | "learningMethods"
  | "categories"
  | "kinds"
  | "customers";

export interface SensorOption {
  id: string;
  name: string;
}

export interface MultiSelectOption<TValue extends string | number> {
  value: TValue;
  label: string;
}

export interface SummarizeFilterLabels {
  /** Prefix for per-value sensor chips. */
  sensor: string;
  /** Aggregate chip template — `{count}` substituted. */
  sensorAggregate: string;
  /** Prefix for the period chip (e.g. `Period`). */
  period: string;
  /** Localised period option labels — `Last 1h`, etc. */
  periodOptions: Record<PeriodKey, string>;
  /** Format a concrete start–end time range (no period key). */
  formatRange: (args: { start: string; end: string }) => string;
  /** Prefix for the direction chip. */
  direction: string;
  /** Per-value localised labels for each {@link FlowKind}. */
  directionValues: Record<FlowKind, string>;
  /** Prefix for the confidence chip. */
  confidence: string;
  /** Prefix for scalar source / destination chips. */
  source: string;
  destination: string;
  /** Prefixes for the five tag fields. */
  keywords: string;
  hostnames: string;
  userIds: string;
  userNames: string;
  userDepartments: string;
  /** Prefixes for the five categorical multi-selects. */
  levels: string;
  countries: string;
  learningMethods: string;
  categories: string;
  kinds: string;
  /** Prefix for customer chips (#384). */
  customers: string;
  /** Aggregate chip template for categorical multi-selects. */
  categoricalAggregate: (args: { label: string; count: number }) => string;
  /**
   * Aggregate chip text for the customer field (#384). Returns the
   * full chip value (label included) — e.g. `Customer: 4 selected` —
   * so the customer aggregate can speak the issue's prescribed
   * "{label}: {N} selected" wording instead of falling back to the
   * generic categorical "{label}: {N}" template.
   */
  customerAggregate: (count: number) => string;
}

export interface SummarizeFilterContext {
  /**
   * Committed period key, if the operator chose one of the preset
   * periods. When null the summariser falls back to the structured
   * start / end range.
   */
  period: PeriodKey | null;
  /** Session-cached sensor options for id → name resolution. */
  sensorOptions: readonly SensorOption[];
  /**
   * Session-cached customer options (#384) for id → name resolution.
   * The drawer fetches `getEffectiveCustomerScope(session).customers`
   * once per page session and threads it here so chips render the
   * customer name rather than the raw `IDScalar` (`"42"`).
   *
   * The committed `Filter` carries `customers` as `string[]` (REview's
   * wire format); this list is keyed by the same string so the
   * lookup is one Map hit per chip. The shell builds the entries by
   * mapping the helper's `{id: number, name: string}` to
   * `{value: String(id), label: name}`.
   */
  customerOptions: readonly MultiSelectOption<string>[];
  /** Drawer option lists for categorical labels. */
  categoricalOptions: {
    levels: readonly MultiSelectOption<ThreatLevel>[];
    countries: readonly MultiSelectOption<string>[];
    learningMethods: readonly MultiSelectOption<LearningMethod>[];
    categories: readonly MultiSelectOption<number>[];
    kinds: readonly MultiSelectOption<string>[];
  };
}

/** Upper bound on individual chips per multi-select dimension. */
export const CHIP_DIMENSION_CAP = 3;

/**
 * Produce display chips for the active filter bar.
 *
 * Query-mode filters return an empty list today — the forward-
 * compat note at the top of the file. The shell renders a dedicated
 * pill outside this helper in query mode.
 */
export function summarizeFilter(
  filter: Filter,
  labels: SummarizeFilterLabels,
  context: SummarizeFilterContext,
): FilterChip[] {
  if (filter.mode !== "structured") {
    // TODO(Phase Detection-*): Return a single query-mode pill with
    // `queryPill: true` once the dedicated query editor lands. See
    // issue #271 "Forward compatibility" — the query language can
    // express OR / NOT / regex that structured chips cannot
    // represent, so no per-field decomposition is attempted.
    return [];
  }

  const chips: FilterChip[] = [];
  const input = filter.input;

  // ── Period / time range ────────────────────────────────────────
  const periodValue = periodChipValue(filter, context.period, labels);
  if (periodValue) {
    chips.push({
      id: "period",
      label: labels.period,
      value: periodValue,
      focus: context.period ? "period" : "timeRange",
      remove: { kind: "period" },
    });
  }

  // ── Scalar text fields ─────────────────────────────────────────
  if (typeof input.source === "string" && input.source.length > 0) {
    chips.push({
      id: "source",
      label: labels.source,
      value: input.source,
      focus: "source",
      remove: { kind: "scalarField", field: "source" },
    });
  }
  if (typeof input.destination === "string" && input.destination.length > 0) {
    chips.push({
      id: "destination",
      label: labels.destination,
      value: input.destination,
      focus: "destination",
      remove: { kind: "scalarField", field: "destination" },
    });
  }

  // ── Tag fields (array of free-form strings) ────────────────────
  for (const field of TAG_FIELD_DEFS) {
    chips.push(
      ...tagChips({
        field: field.key,
        label: labels[field.labelKey],
        values: input[field.key] ?? null,
        aggregate: (count) =>
          labels.categoricalAggregate({
            label: labels[field.labelKey],
            count,
          }),
      }),
    );
  }

  // ── Direction ──────────────────────────────────────────────────
  chips.push(...directionChips(input.directions ?? null, labels));

  // ── Confidence ─────────────────────────────────────────────────
  const confidence = confidenceRange(input);
  if (confidence) {
    chips.push({
      id: "confidence",
      label: labels.confidence,
      value: `${formatConfidenceInput(confidence.min)} – ${formatConfidenceInput(confidence.max)}`,
      focus: "confidence",
      remove: { kind: "confidence" },
    });
  }

  // ── Sensors ────────────────────────────────────────────────────
  chips.push(
    ...sensorChips(input.sensors ?? null, context.sensorOptions, labels),
  );

  // ── Customers (#384) ───────────────────────────────────────────
  // Customers use a dedicated `customerAggregate` formatter instead
  // of the generic `categoricalAggregate` so the aggregate chip
  // reads `Customer: 4 selected` per the issue's acceptance wording
  // rather than the categorical default `Customer: 4`.
  chips.push(
    ...categoricalChips<string>({
      fieldKey: "customers",
      label: labels.customers,
      values: (input.customers ?? []) as readonly string[],
      options: context.customerOptions,
      aggregate: labels.customerAggregate,
      makeRemove: (value) => ({
        kind: "categoricalValue",
        field: "customers",
        value,
      }),
    }),
  );

  // ── Categorical multi-selects ──────────────────────────────────
  const opts = context.categoricalOptions;
  chips.push(
    ...categoricalChips<ThreatLevel>({
      fieldKey: "levels",
      label: labels.levels,
      values: (input.levels ?? []) as readonly ThreatLevel[],
      options: opts.levels,
      aggregate: (count) =>
        labels.categoricalAggregate({ label: labels.levels, count }),
      makeRemove: (value) => ({
        kind: "categoricalValue",
        field: "levels",
        value,
      }),
    }),
  );
  chips.push(
    ...categoricalChips<string>({
      fieldKey: "countries",
      label: labels.countries,
      values: (input.countries ?? []) as readonly string[],
      options: opts.countries,
      aggregate: (count) =>
        labels.categoricalAggregate({ label: labels.countries, count }),
      makeRemove: (value) => ({
        kind: "categoricalValue",
        field: "countries",
        value,
      }),
    }),
  );
  chips.push(
    ...categoricalChips<LearningMethod>({
      fieldKey: "learningMethods",
      label: labels.learningMethods,
      values: (input.learningMethods ?? []) as readonly LearningMethod[],
      options: opts.learningMethods,
      aggregate: (count) =>
        labels.categoricalAggregate({ label: labels.learningMethods, count }),
      makeRemove: (value) =>
        value === "UNSUPERVISED" || value === "SEMI_SUPERVISED"
          ? {
              kind: "categoricalValue",
              field: "learningMethods",
              value,
            }
          : null,
    }),
  );
  chips.push(
    ...categoricalChips<number>({
      fieldKey: "categories",
      label: labels.categories,
      values: (input.categories ?? []).filter(
        (v): v is number => typeof v === "number",
      ),
      options: opts.categories,
      aggregate: (count) =>
        labels.categoricalAggregate({ label: labels.categories, count }),
      makeRemove: (value) => ({
        kind: "categoricalValue",
        field: "categories",
        value,
      }),
    }),
  );
  chips.push(
    ...categoricalChips<string>({
      fieldKey: "kinds",
      label: labels.kinds,
      values: (input.kinds ?? []) as readonly string[],
      options: opts.kinds,
      aggregate: (count) =>
        labels.categoricalAggregate({ label: labels.kinds, count }),
      makeRemove: (value) => ({
        kind: "categoricalValue",
        field: "kinds",
        value,
      }),
    }),
  );

  return chips;
}

interface TagFieldDef {
  key: "keywords" | "hostnames" | "userIds" | "userNames" | "userDepartments";
  labelKey:
    | "keywords"
    | "hostnames"
    | "userIds"
    | "userNames"
    | "userDepartments";
}

const TAG_FIELD_DEFS: readonly TagFieldDef[] = [
  { key: "keywords", labelKey: "keywords" },
  { key: "hostnames", labelKey: "hostnames" },
  { key: "userIds", labelKey: "userIds" },
  { key: "userNames", labelKey: "userNames" },
  { key: "userDepartments", labelKey: "userDepartments" },
];

function periodChipValue(
  filter: Filter,
  period: PeriodKey | null,
  labels: SummarizeFilterLabels,
): string | null {
  if (period) return labels.periodOptions[period];
  if (filter.mode !== "structured") return null;
  const { start, end } = filter.input;
  if (!start || !end) return null;
  return labels.formatRange({
    start: isoToLocalInput(start),
    end: isoToLocalInput(end),
  });
}

function tagChips({
  field,
  label,
  values,
  aggregate,
}: {
  field: "keywords" | "hostnames" | "userIds" | "userNames" | "userDepartments";
  label: string;
  values: readonly string[] | null;
  aggregate: (count: number) => string;
}): FilterChip[] {
  if (!values || values.length === 0) return [];
  if (values.length > CHIP_DIMENSION_CAP) {
    return [
      {
        id: `${field}:aggregate`,
        label,
        value: aggregate(values.length),
        focus: field,
        aggregate: true,
        remove: { kind: "arrayAggregate", field },
      },
    ];
  }
  return values.map((value, idx) => ({
    id: `${field}:${value}:${idx}`,
    label,
    value,
    focus: field,
    remove: { kind: "arrayValue", field, value },
  }));
}

function stringifyChipValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function directionChips(
  values: readonly FlowKind[] | null,
  labels: SummarizeFilterLabels,
): FilterChip[] {
  // "All three" is the no-filter state; suppress the chip bar entirely
  // rather than showing three redundant chips.
  if (!values || values.length === 0 || isAllDirections(values)) return [];
  return FLOW_KINDS.filter((k) => values.includes(k)).map((value) => ({
    id: `direction:${value}`,
    label: labels.direction,
    value: labels.directionValues[value] ?? value,
    focus: "direction" as const,
    remove: { kind: "directionValue", value },
  }));
}

function confidenceRange(
  input: EventListFilterInput,
): { min: number; max: number } | null {
  const min = input.confidenceMin;
  const max = input.confidenceMax;
  if (min == null && max == null) return null;
  const range = {
    min: min ?? CONFIDENCE_DEFAULT_MIN,
    max: max ?? CONFIDENCE_DEFAULT_MAX,
  };
  if (
    isConfidenceDefault({
      confidenceMin: range.min,
      confidenceMax: range.max,
    })
  ) {
    return null;
  }
  return range;
}

function sensorChips(
  ids: readonly string[] | null,
  options: readonly SensorOption[],
  labels: SummarizeFilterLabels,
): FilterChip[] {
  if (!ids || ids.length === 0) return [];
  if (ids.length > CHIP_DIMENSION_CAP) {
    // Aggregate chips keep the field label so the operator can still
    // tell which filter the collapsed token belongs to — the shell
    // strips the `prefix` for aggregate chips, so the field identity
    // has to live inside `value` itself (matches the issue's
    // `Level: 3 selected` / `Hostnames: 7` shape).
    const count = labels.sensorAggregate.replace("{count}", String(ids.length));
    return [
      {
        id: "sensor:aggregate",
        label: labels.sensor,
        value: `${labels.sensor}: ${count}`,
        focus: "sensor",
        aggregate: true,
        remove: { kind: "arrayAggregate", field: "sensors" },
      },
    ];
  }
  const byId = new Map(options.map((o) => [o.id, o.name]));
  return ids.map((id) => ({
    id: `sensor:${id}`,
    label: labels.sensor,
    value: byId.get(id) ?? id,
    focus: "sensor",
    remove: { kind: "arrayValue", field: "sensors", value: id },
  }));
}

function categoricalChips<TValue extends string | number>({
  fieldKey,
  label,
  values,
  options,
  aggregate,
  makeRemove,
}: {
  fieldKey:
    | "levels"
    | "countries"
    | "learningMethods"
    | "categories"
    | "kinds"
    | "customers";
  label: string;
  values: readonly TValue[];
  options: readonly MultiSelectOption<TValue>[];
  aggregate: (count: number) => string;
  makeRemove: (value: TValue) => ChipRemoveTarget | null;
}): FilterChip[] {
  if (values.length === 0) return [];
  if (values.length > CHIP_DIMENSION_CAP) {
    return [
      {
        id: `${fieldKey}:aggregate`,
        label,
        value: aggregate(values.length),
        focus: fieldKey,
        aggregate: true,
        remove: { kind: "categoricalAggregate", field: fieldKey },
      },
    ];
  }
  const byValue = new Map<TValue, string>(
    options.map((o) => [o.value, o.label]),
  );
  return values.flatMap((value) => {
    const remove = makeRemove(value);
    if (!remove) return [];
    return [
      {
        id: `${fieldKey}:${stringifyChipValue(value)}`,
        label,
        value: byValue.get(value) ?? String(value),
        focus: fieldKey,
        remove,
      } satisfies FilterChip,
    ];
  });
}
