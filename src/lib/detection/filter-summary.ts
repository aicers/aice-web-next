/**
 * Shared chip summarization for the Detection active-filter chip bar.
 *
 * `summarizeFilter(context, labels)` is the single entry point the
 * shell calls to turn an abstract `Filter` (Phase Detection-2) into
 * the chip specs the bar renders. It covers every dimension the bar
 * shows — period, pivot-backed free-form fields, confidence,
 * direction, endpoint, sensor, and categorical multi-selects — so
 * the aggregation rules (1–3 values → individual chips, more → a
 * single aggregate token) live in one place instead of drifting
 * across separate builders. Before this helper existed, the shell
 * assembled the bar through five parallel builders; removing one
 * dimension from the rule meant editing several files. The unified
 * output is a discriminated union so the shell dispatches rendering
 * by `chip.kind` and each removal handler takes only the fields it
 * actually needs.
 *
 * Forward compatibility — when `filter.mode === "query"` the chip
 * bar must not attempt per-field decomposition (the free-form query
 * can express `OR` / `NOT` / regex that chips cannot represent). v1
 * ships only the `structured` branch; the `query` branch returns an
 * empty chip set and leaves the single editable pill to a dedicated
 * query-mode renderer. See the Phase Detection-9 umbrella's
 * "Forward compatibility" section.
 */

import type { FilterDrawerOptions } from "@/components/detection/filter-drawer";
import type { FilterMultiSelectLabels } from "@/components/detection/filter-multi-select";

import { buildDirectionChips, type DirectionChipLabels } from "./direction";
import {
  buildEndpointChips,
  type EndpointChipLabels,
  type EndpointEntry,
} from "./endpoint-filter";
import type { Filter } from "./filter";
import { type ActiveFilterChip, buildMultiSelectChips } from "./filter-chips";
import {
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  formatConfidenceInput,
  isConfidenceDefault,
  isoToLocalInput,
} from "./filter-draft";
import type { PeriodKey } from "./period";
import type { FlowKind } from "./types";
import {
  buildPivotChips,
  mergePivotParams,
  type PivotChipLabels,
  type PivotFilterParams,
  type PivotKey,
  pivotParamsFromFilterInput,
} from "./url-filters";

/** Upper bound on individual chips per multi-select dimension. */
export const CHIP_DIMENSION_CAP = 3;

export type MultiSelectFieldKey =
  | "levels"
  | "countries"
  | "learningMethods"
  | "categories"
  | "kinds";

export interface SensorOption {
  id: string;
  name: string;
}

/**
 * Discriminated union carried back to the shell. Every chip is
 * render-ready (id / label / value) and carries the minimum payload
 * the shell needs to build its remove handler — which keeps the
 * rendering loop in `detection-shell.tsx` a single `switch` instead
 * of five parallel `.map` blocks over differently-typed arrays.
 */
export type FilterChipSpec =
  | {
      kind: "period";
      id: "period";
      label: string;
      value: string;
    }
  | {
      kind: "pivot";
      id: string;
      label: string;
      value: string;
      aggregate: boolean;
      field: PivotKey;
    }
  | {
      kind: "confidence";
      id: "confidence";
      label: string;
      value: string;
    }
  | {
      kind: "direction";
      id: string;
      label: string;
      value: string;
      flow: FlowKind;
    }
  | {
      kind: "endpoint";
      id: string;
      value: string;
      aggregate: boolean;
      entryId: string | null;
    }
  | {
      kind: "sensor";
      id: string;
      label: string;
      value: string;
      aggregate: boolean;
      sensorId: string | null;
    }
  | {
      kind: "multiSelect";
      id: string;
      label: string;
      value: string;
      aggregate: boolean;
      fieldKey: MultiSelectFieldKey;
      chip: ActiveFilterChip;
    };

export interface SummarizeFilterContext {
  filter: Filter;
  period: PeriodKey | null;
  /** Client-side endpoint entries — the chip bar mirrors the drawer. */
  endpoints: readonly EndpointEntry[];
  /** Pivot params without a first-class filter field (ports, proto). */
  pivotOnly: PivotFilterParams;
  /** Sensor inventory used to resolve IDs to display names. */
  sensorOptions: readonly SensorOption[];
  /** Categorical option bundles shared with the drawer. */
  drawerOptions: FilterDrawerOptions;
}

export interface SummarizeFilterLabels {
  /** Empty-state label shown when no filter is applied. */
  activeEmpty: string;
  /** "Period" prefix for the time-range chip body. */
  periodLabel: string;
  /** Localized labels for each quick-select window. */
  periodOptions: Record<PeriodKey, string>;
  /** Formatter for explicit start/end ranges (no period selected). */
  formatRange: (args: { start: string; end: string }) => string;
  /** "Confidence" chip prefix. */
  confidenceLabel: string;
  directionChips: DirectionChipLabels;
  endpointChips: EndpointChipLabels;
  /** "Sensor" chip prefix. */
  sensor: string;
  /** Template string for the aggregate sensor chip (`{count}` placeholder). */
  sensorAggregate: string;
  /** Labels for the pivot-backed chips — source / destination / tags / … */
  pivot: PivotChipLabels;
  /** Per-field labels for the categorical multi-select chips. */
  multiSelectFields: Record<MultiSelectFieldKey, string>;
  /** Shared multi-select label bundle — used for the aggregate count formatter. */
  multiSelectLabels: FilterMultiSelectLabels;
}

export interface SummarizeFilterResult {
  /**
   * Summary string rendered to the left of the chip list when no
   * time chip is shown. Either the period name, an explicit start–end
   * range, or the empty-state placeholder.
   */
  timeSummary: string;
  /**
   * Whether the committed filter carries a time window. When true the
   * shell renders the `period` chip; otherwise it shows `timeSummary`
   * as plain text. Keeps the period affordance prominent and
   * removable from the chip bar without forcing the shell to
   * re-derive the condition from `filter.input`.
   */
  hasTimeChip: boolean;
  chips: FilterChipSpec[];
}

export function summarizeFilter(
  context: SummarizeFilterContext,
  labels: SummarizeFilterLabels,
): SummarizeFilterResult {
  const { filter, period } = context;

  // TODO(phase-detection-query-mode): render `filter.text` as a
  // single editable pill that opens a dedicated query editor. Until
  // that lands we emit no per-field chips so the bar doesn't try to
  // decompose a query it cannot faithfully represent.
  if (filter.mode !== "structured") {
    return { timeSummary: labels.activeEmpty, hasTimeChip: false, chips: [] };
  }

  const input = filter.input;
  const start = input.start ?? null;
  const end = input.end ?? null;
  const hasTimeChip = Boolean(start && end);

  const timeSummary = period
    ? labels.periodOptions[period]
    : start && end
      ? labels.formatRange({
          start: isoToLocalInput(start),
          end: isoToLocalInput(end),
        })
      : labels.activeEmpty;

  const chips: FilterChipSpec[] = [];

  // Pivot chips (source, destination, kind, ports, proto, window,
  // and the tag-input free-form fields). Built once off the merged
  // params so the stable order from `buildPivotChips` is preserved.
  const pivotChipsData = buildPivotChips(
    mergePivotParams(context.pivotOnly, pivotParamsFromFilterInput(input)),
    labels.pivot,
  );
  for (const chip of pivotChipsData) {
    chips.push({
      kind: "pivot",
      id: chip.id,
      label: chip.label,
      value: chip.value,
      aggregate: chip.aggregate ?? false,
      field: chip.field,
    });
  }

  // Confidence chip — only shown when the committed range is not the
  // `[0, 1]` default.
  const confidence = resolveConfidence(
    input.confidenceMin,
    input.confidenceMax,
  );
  if (confidence) {
    chips.push({
      kind: "confidence",
      id: "confidence",
      label: labels.confidenceLabel,
      value: `${formatConfidenceInput(confidence.min)} – ${formatConfidenceInput(confidence.max)}`,
    });
  }

  // Direction chips — empty when all three flow kinds are selected
  // ("no filter").
  const directionChips = buildDirectionChips(
    input.directions ?? null,
    labels.directionChips,
  );
  for (const chip of directionChips) {
    const flow = chip.id.split(":")[1] as FlowKind;
    chips.push({
      kind: "direction",
      id: chip.id,
      label: chip.label,
      value: chip.value,
      flow,
    });
  }

  // Endpoint chips — sourced from the parallel `endpoints` state the
  // drawer manages, not from `input.endpoints`. That state carries
  // the original raw text + direction, which the BFF input shape
  // does not.
  const endpointChips = buildEndpointChips(
    context.endpoints as EndpointEntry[],
    labels.endpointChips,
  );
  for (const chip of endpointChips) {
    chips.push({
      kind: "endpoint",
      id: chip.id,
      value: chip.label,
      aggregate: chip.aggregate,
      entryId: chip.aggregate ? null : chip.id,
    });
  }

  // Sensor chips — 1–3 individual, 4+ aggregate.
  const sensors = input.sensors ?? [];
  if (sensors.length > 0 && sensors.length <= CHIP_DIMENSION_CAP) {
    const byId = new Map(context.sensorOptions.map((o) => [o.id, o.name]));
    for (const id of sensors) {
      chips.push({
        kind: "sensor",
        id: `sensor:${id}`,
        label: labels.sensor,
        value: byId.get(id) ?? id,
        aggregate: false,
        sensorId: id,
      });
    }
  } else if (sensors.length > CHIP_DIMENSION_CAP) {
    chips.push({
      kind: "sensor",
      id: "sensor:aggregate",
      label: labels.sensor,
      value: labels.sensorAggregate.replace("{count}", String(sensors.length)),
      aggregate: true,
      sensorId: null,
    });
  }

  // Categorical multi-selects: levels, countries, learning methods,
  // categories, kinds. `kinds` is an open list (seed subset rather
  // than exhaustive domain) so a saturated selection still emits
  // chips — otherwise picking every visible kind would silently
  // broaden the query.
  const aggregateCount = (n: number) => labels.multiSelectLabels.summarySome(n);

  appendMultiSelectChips(chips, "levels", {
    options: context.drawerOptions.levels,
    selected: input.levels ?? [],
    fieldLabel: labels.multiSelectFields.levels,
    aggregateValue: aggregateCount,
  });
  appendMultiSelectChips(chips, "countries", {
    options: context.drawerOptions.countries,
    selected: input.countries ?? [],
    fieldLabel: labels.multiSelectFields.countries,
    aggregateValue: aggregateCount,
  });
  appendMultiSelectChips(chips, "learningMethods", {
    options: context.drawerOptions.learningMethods,
    selected: input.learningMethods ?? [],
    fieldLabel: labels.multiSelectFields.learningMethods,
    aggregateValue: aggregateCount,
  });
  appendMultiSelectChips(chips, "categories", {
    options: context.drawerOptions.categories,
    selected: (input.categories ?? []).filter(
      (v): v is number => typeof v === "number",
    ),
    fieldLabel: labels.multiSelectFields.categories,
    aggregateValue: aggregateCount,
  });
  appendMultiSelectChips(chips, "kinds", {
    options: context.drawerOptions.kinds,
    selected: input.kinds ?? [],
    fieldLabel: labels.multiSelectFields.kinds,
    aggregateValue: aggregateCount,
    openList: true,
  });

  return { timeSummary, hasTimeChip, chips };
}

function appendMultiSelectChips<V extends string | number>(
  out: FilterChipSpec[],
  fieldKey: MultiSelectFieldKey,
  spec: {
    options: readonly { value: V; label: string }[];
    selected: readonly V[];
    fieldLabel: string;
    aggregateValue: (count: number) => string;
    openList?: boolean;
  },
): void {
  const built = buildMultiSelectChips<V>({
    fieldKey,
    fieldLabel: spec.fieldLabel,
    options: spec.options,
    selected: spec.selected,
    aggregateValue: spec.aggregateValue,
    openList: spec.openList,
  });
  for (const chip of built) {
    out.push({
      kind: "multiSelect",
      id: chip.key,
      label: chip.label,
      value: chip.value,
      aggregate: chip.aggregate,
      fieldKey,
      chip,
    });
  }
}

function resolveConfidence(
  min: number | null | undefined,
  max: number | null | undefined,
): { min: number; max: number } | null {
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
