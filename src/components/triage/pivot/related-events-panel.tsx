"use client";

/**
 * Related-events panel — Tier 1 client-side pivot over the Triage
 * corpus loaded by #451 / #476.
 *
 * Per #447 §6 deprecatable seam: this subtree must not import from
 * the policy modules. Tier 2 (#453) wires the weak-signal toggle on
 * top of this panel, not inside it.
 */

import { useMemo, useState } from "react";

import { useTimezone } from "@/components/providers/timezone-provider";
import { formatDateTime } from "@/lib/format-date";
import type { ScoredTriageEvent } from "@/lib/triage";
import {
  LEARNING_METHOD_VALUES,
  type LearningMethodValue,
} from "@/lib/triage/learning-methods";
import {
  getPivotDimension,
  PIVOT_GROUP_DEFAULT_ROWS,
  PIVOT_GROUP_EXPANDED_ROWS,
  type PivotDimensionId,
  type PivotPanelSection,
  type PivotStep,
  type PivotValue,
} from "@/lib/triage/pivot";
import { cn } from "@/lib/utils";

import {
  WEAK_SIGNAL_ROW_CLASS,
  WeakSignalBadge,
  type WeakSignalBadgeLabels,
} from "../weak-signal-badge";

export interface TriagePivotPanelLabels {
  title: string;
  empty: string;
  truncatedHint: string;
  noFocusHint: string;
  showMore: string;
  showLess: string;
  /** Template: `Showing {visible} of {total}`. */
  showingOfTemplate: string;
  /** Template: `Pivot to {dimension}: {value}` (used for buttons). */
  pivotActionTemplate: string;
  /** Template: `Focus values for this asset: {values}`. */
  focusValuesTemplate: string;
  /** Map of dimension id → human-readable label. */
  dimensions: Record<PivotDimensionId, string>;
  family: Record<
    "network" | "application" | "tls" | "dns" | "time-structure" | "tier2-only",
    string
  >;
  timeColumn: string;
  kindColumn: string;
  scoreColumn: string;
  pivotColumn: string;
  weakSignal?: WeakSignalBadgeLabels;
  /** Tooltip surfaced on the deferred Tier 2 sensor row (#453). */
  sameSensorUnavailable?: string;
  /**
   * Per-value labels for the static Tier-2-only `learningMethods`
   * section (#498). Keys are the GraphQL `LearningMethod` enum
   * literals (`UNSUPERVISED`, `SEMI_SUPERVISED`); values are the
   * localized button labels.
   */
  learningMethodValues?: Record<LearningMethodValue, string>;
}

interface TriagePivotPanelProps {
  sections: PivotPanelSection[];
  truncated: boolean;
  hasFocus: boolean;
  onPivot: (step: PivotStep) => void;
  labels: TriagePivotPanelLabels;
  /**
   * Returns `true` for events that came from a Tier 2 fetch and are
   * not also present in the Tier 1 corpus. Such rows render at
   * reduced opacity with a "weak" badge per #453 acceptance.
   */
  isWeakSignal?: (event: ScoredTriageEvent) => boolean;
  /**
   * When `true`, render a disabled placeholder showing the sensor
   * dimension as deferred under Tier 2 with an explanatory tooltip
   * (#453 — sensor name→ID lookup is gated on `triage:read`).
   */
  deferredSensorDimension?: boolean;
  /**
   * When `true`, render the static-options "Learning method" section
   * (#498) below the focus-driven sections. The section appears
   * regardless of the focus event values because `LearningMethod` is
   * a fixed two-value SDL enum with no per-event extractor; it is
   * only meaningful in Tier 2 mode (where the click action issues a
   * server-filtered fetch).
   */
  showLearningMethodSection?: boolean;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const COUNT_FORMAT = new Intl.NumberFormat();

export function TriagePivotPanel({
  sections,
  truncated,
  hasFocus,
  onPivot,
  labels,
  isWeakSignal,
  deferredSensorDimension = false,
  showLearningMethodSection = false,
}: TriagePivotPanelProps) {
  const showDeferredSensor =
    deferredSensorDimension && labels.sameSensorUnavailable !== undefined;
  const showLearningMethods =
    showLearningMethodSection && labels.learningMethodValues !== undefined;
  return (
    <section
      aria-labelledby="triage-pivot-heading"
      className="rounded-md border bg-card shadow-xs"
    >
      <header className="flex flex-col gap-1 border-b px-4 py-3">
        <h2
          id="triage-pivot-heading"
          className="text-sm font-semibold text-muted-foreground"
        >
          {labels.title}
        </h2>
        {truncated ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {labels.truncatedHint}
          </p>
        ) : null}
      </header>
      {!hasFocus ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {labels.noFocusHint}
        </p>
      ) : sections.length === 0 &&
        !showDeferredSensor &&
        !showLearningMethods ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {labels.empty}
        </p>
      ) : (
        <ul className="divide-y">
          {sections.map((section) => (
            <PivotSection
              key={section.dimension}
              section={section}
              onPivot={onPivot}
              labels={labels}
              isWeakSignal={isWeakSignal}
            />
          ))}
          {showDeferredSensor ? (
            <DeferredDimensionRow
              dimensionLabel={labels.dimensions.sameSensor}
              tooltip={labels.sameSensorUnavailable as string}
            />
          ) : null}
          {showLearningMethods ? (
            <LearningMethodSection
              labels={labels}
              valueLabels={
                labels.learningMethodValues as Record<
                  LearningMethodValue,
                  string
                >
              }
              onPivot={onPivot}
            />
          ) : null}
        </ul>
      )}
    </section>
  );
}

function LearningMethodSection({
  labels,
  valueLabels,
  onPivot,
}: {
  labels: TriagePivotPanelLabels;
  valueLabels: Record<LearningMethodValue, string>;
  onPivot: (step: PivotStep) => void;
}) {
  const dimensionLabel = labels.dimensions.learningMethods;
  const familyLabel = labels.family["tier2-only"];
  return (
    <li className="px-4 py-3" data-testid="triage-pivot-learning-methods">
      <div className="mb-2 flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">
          {dimensionLabel}
        </h3>
        <p className="text-xs text-muted-foreground">{familyLabel}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {LEARNING_METHOD_VALUES.map((valueKey) => {
          const label = valueLabels[valueKey];
          return (
            <button
              key={valueKey}
              type="button"
              onClick={() =>
                onPivot({
                  kind: "dimension",
                  dimension: "learningMethods",
                  value: { key: valueKey, label },
                })
              }
              aria-label={labels.pivotActionTemplate
                .replace("{dimension}", dimensionLabel)
                .replace("{value}", label)}
              className={cn(
                "rounded border border-border/60 px-3 py-1 text-xs",
                "text-foreground hover:bg-accent",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </li>
  );
}

function DeferredDimensionRow({
  dimensionLabel,
  tooltip,
}: {
  dimensionLabel: string;
  tooltip: string;
}) {
  return (
    <li
      className="px-4 py-3 opacity-60"
      data-testid="triage-pivot-deferred-row"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          {dimensionLabel}
        </h3>
        <span title={tooltip} className="text-xs text-muted-foreground italic">
          {tooltip}
        </span>
      </div>
    </li>
  );
}

function PivotSection({
  section,
  onPivot,
  labels,
  isWeakSignal,
}: {
  section: PivotPanelSection;
  onPivot: (step: PivotStep) => void;
  labels: TriagePivotPanelLabels;
  isWeakSignal?: (event: ScoredTriageEvent) => boolean;
}) {
  const timezone = useTimezone();
  const [expanded, setExpanded] = useState(false);
  const visibleRows = expanded
    ? section.events.slice(0, PIVOT_GROUP_EXPANDED_ROWS)
    : section.events.slice(0, PIVOT_GROUP_DEFAULT_ROWS);
  const dimensionLabel = labels.dimensions[section.dimension];
  const familyLabel =
    labels.family[section.family as keyof typeof labels.family];
  const focusValuesText = useMemo(
    () => describeFocusValues(section.focusValues),
    [section.focusValues],
  );
  const showMoreVisible =
    !expanded && section.events.length > PIVOT_GROUP_DEFAULT_ROWS;
  const showLessVisible =
    expanded && section.events.length > PIVOT_GROUP_DEFAULT_ROWS;
  // Only render the "Showing X of N" hint when the user has expanded the
  // group; collapsed groups show the default 10 rows and the hint would
  // contradict what is actually on screen. Once expanded, the visible
  // count is min(events.length, PIVOT_GROUP_EXPANDED_ROWS) — not just 50 —
  // so the number reflects what is rendered when a group has between 11
  // and 50 matches as well.
  const visibleCount = visibleRows.length;
  const cappedHint =
    expanded && section.totalCount > visibleCount
      ? labels.showingOfTemplate
          .replace("{visible}", COUNT_FORMAT.format(visibleCount))
          .replace("{total}", COUNT_FORMAT.format(section.totalCount))
      : null;

  return (
    <li className="px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-foreground">
            {dimensionLabel}
          </h3>
          <p className="text-xs text-muted-foreground">
            {familyLabel} ·{" "}
            {labels.focusValuesTemplate.replace("{values}", focusValuesText)}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {COUNT_FORMAT.format(section.totalCount)}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="py-1.5 pr-2 text-left font-medium">
              {labels.timeColumn}
            </th>
            <th scope="col" className="py-1.5 pr-2 text-left font-medium">
              {labels.kindColumn}
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right font-medium">
              {labels.scoreColumn}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              {labels.pivotColumn}
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((event, index) => (
            <PivotRow
              // biome-ignore lint/suspicious/noArrayIndexKey: events have no unique id; the index disambiguates rows that share time+typename inside the score-sorted slice
              key={`${event.time}-${event.__typename}-${index}`}
              event={event}
              dimension={section.dimension}
              onPivot={onPivot}
              labels={labels}
              timezone={timezone}
              weak={isWeakSignal?.(event) ?? false}
            />
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{cappedHint}</span>
        <div className="flex gap-2">
          {showMoreVisible ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-xs font-medium text-primary hover:underline"
            >
              {labels.showMore}
            </button>
          ) : null}
          {showLessVisible ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-xs font-medium text-primary hover:underline"
            >
              {labels.showLess}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function PivotRow({
  event,
  dimension,
  onPivot,
  labels,
  timezone,
  weak,
}: {
  event: ScoredTriageEvent;
  dimension: PivotDimensionId;
  onPivot: (step: PivotStep) => void;
  labels: TriagePivotPanelLabels;
  timezone: string;
  weak: boolean;
}) {
  const dim = labels.dimensions[dimension];
  return (
    <tr className={cn("border-b last:border-0", weak && WEAK_SIGNAL_ROW_CLASS)}>
      <td className="py-1.5 pr-2 font-mono text-xs">
        {formatDateTime(event.time, timezone)}
      </td>
      <td className="py-1.5 pr-2">
        {event.__typename}
        {weak && labels.weakSignal ? (
          <WeakSignalBadge labels={labels.weakSignal} />
        ) : null}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono">
        {SCORE_FORMAT.format(event.score)}
      </td>
      <td className="py-1.5 text-right">
        <PivotRowActions
          event={event}
          dimension={dimension}
          dimensionLabel={dim}
          actionTemplate={labels.pivotActionTemplate}
          onPivot={onPivot}
        />
      </td>
    </tr>
  );
}

function PivotRowActions({
  event,
  dimension,
  dimensionLabel,
  actionTemplate,
  onPivot,
}: {
  event: ScoredTriageEvent;
  dimension: PivotDimensionId;
  dimensionLabel: string;
  actionTemplate: string;
  onPivot: (step: PivotStep) => void;
}) {
  // Re-extract this row's values for the dimension so the row's
  // pivot button targets the value carried by *this* row, not by the
  // focused asset. A single (asset, dimension) section can list events
  // that share *some* of the asset's focus values; pivoting from the
  // row should jump to that row's value.
  const values = useMemo(
    () => extractRowValues(event, dimension),
    [event, dimension],
  );
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {values.map((value) => (
        <button
          key={value.key}
          type="button"
          onClick={() => onPivot({ kind: "dimension", dimension, value })}
          aria-label={actionTemplate
            .replace("{dimension}", dimensionLabel)
            .replace("{value}", value.label)}
          className={cn(
            "max-w-[24ch] truncate rounded border border-border/60 px-2 py-0.5 text-xs",
            "text-foreground hover:bg-accent",
          )}
        >
          {value.label}
        </button>
      ))}
    </div>
  );
}

function describeFocusValues(values: PivotValue[]): string {
  if (values.length === 0) return "—";
  if (values.length === 1) return values[0].label;
  if (values.length <= 3) return values.map((v) => v.label).join(", ");
  const head = values
    .slice(0, 3)
    .map((v) => v.label)
    .join(", ");
  return `${head} (+${values.length - 3})`;
}

function extractRowValues(
  event: ScoredTriageEvent,
  dimension: PivotDimensionId,
): PivotValue[] {
  return getPivotDimension(dimension).extract(event);
}
