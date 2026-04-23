import type { Filter } from "./filter";
import {
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  formatConfidenceInput,
  isConfidenceDefault,
  isoToLocalInput,
} from "./filter-draft";
import type { PeriodKey } from "./period";
import type { PivotChip, PivotKey } from "./url-filters";

export interface DetectionFilterBarChip {
  id: string;
  label: string;
  value: string;
  /**
   * Pass-through from {@link PivotChip}: when the chip represents an
   * aggregated multi-value (e.g. "Keywords: 12"), activating it opens
   * the drawer focused on the underlying field. The shell consults
   * these to decide whether to render the chip as a button.
   */
  aggregate?: boolean;
  field?: PivotKey;
}

export interface DetectionFilterBarState {
  /**
   * Short textual summary of the committed period / explicit time
   * range (e.g. `Last 1 hour`, `2026-04-22T11:00 – 2026-04-22T12:00`,
   * or the empty-state fallback). Always rendered in the active
   * filter bar alongside any chips so applying a non-time filter
   * (confidence, pivots) never hides the time window the query is
   * scoped to.
   */
  summary: string;
  chips: DetectionFilterBarChip[];
}

export interface DetectionFilterBarLabels {
  confidenceChipLabel: string;
  activeChipsEmpty: string;
  periodOptions: Record<PeriodKey, string>;
  formatRange: (args: { start: string; end: string }) => string;
}

export function buildDetectionFilterBar({
  filter,
  period,
  pivotChips,
  labels,
}: {
  filter: Filter;
  period: PeriodKey | null;
  pivotChips: readonly PivotChip[];
  labels: DetectionFilterBarLabels;
}): DetectionFilterBarState {
  const start = structuredStart(filter);
  const end = structuredEnd(filter);
  const confidence = structuredConfidence(filter);

  const summary = period
    ? labels.periodOptions[period]
    : start && end
      ? labels.formatRange({
          start: isoToLocalInput(start),
          end: isoToLocalInput(end),
        })
      : labels.activeChipsEmpty;

  const chips: DetectionFilterBarChip[] = [...pivotChips];
  if (confidence) {
    chips.push({
      id: "confidence",
      label: labels.confidenceChipLabel,
      value: `${formatConfidenceInput(confidence.min)} – ${formatConfidenceInput(confidence.max)}`,
    });
  }

  return { summary, chips };
}

function structuredStart(filter: Filter): string | null {
  if (filter.mode !== "structured") return null;
  return filter.input.start ?? null;
}

function structuredEnd(filter: Filter): string | null {
  if (filter.mode !== "structured") return null;
  return filter.input.end ?? null;
}

function structuredConfidence(
  filter: Filter,
): { min: number; max: number } | null {
  if (filter.mode !== "structured") return null;
  const min = filter.input.confidenceMin;
  const max = filter.input.confidenceMax;
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
