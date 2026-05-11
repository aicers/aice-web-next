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
  MAX_KEYWORD_LENGTH,
  validateKeywordInput,
} from "@/lib/triage/keywords";
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
  /**
   * Localized strings for the Tier-2-only free-form `keywords` section
   * (#499). Optional: the section is gated on
   * `showKeywordsSection` so panels that never render it (Tier 1) do
   * not have to provide them. Present-but-missing falls back to a
   * disabled section so a TypeScript-clean caller never crashes the
   * panel.
   */
  keywords?: KeywordsSectionLabels;
}

export interface KeywordsSectionLabels {
  /** Hint text shown above the input. */
  hint: string;
  /** Accessible label for the typed-input field. */
  inputLabel: string;
  /** Placeholder shown inside the input when empty. */
  inputPlaceholder: string;
  /** Submit button label. */
  submit: string;
  /** Heading for the recent-chips strip. */
  recentHeading: string;
  /**
   * Template for a recent-chip's accessible name. `{value}` is the
   * keyword text. Used for the aria-label so screen readers announce
   * the actual keyword rather than just "chip".
   */
  recentChipTemplate: string;
  /** Validation messages — inline below the input, role="alert". */
  errorEmpty: string;
  /**
   * Template for the too-long validation message. `{max}` is the
   * maximum length (typically 256). Rendered when the trimmed value
   * exceeds {@link MAX_KEYWORD_LENGTH}.
   */
  errorTooLongTemplate: string;
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
  /**
   * When `true`, render the Tier-2-only free-form `keywords` section
   * (#499) — a typed-input chip with explicit submit and a recent-
   * chips strip. Only meaningful in Tier 2 mode; Tier 1 panels never
   * receive the prop.
   */
  showKeywordsSection?: boolean;
  /**
   * Most-recent-first list of operator-submitted keywords, scoped to
   * the page session. The panel renders each as a clickable chip that
   * re-fires the same Tier 2 fetch. Owned by the parent so the same
   * list survives across the panel mount/unmount cycle that pivoting
   * triggers.
   */
  recentKeywords?: readonly string[];
  /**
   * Called when the operator submits a valid keyword (explicit submit:
   * Enter or button click only). The trimmed value is passed through;
   * the panel does not call this for invalid input.
   */
  onSubmitKeyword?: (value: string) => void;
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
  showKeywordsSection = false,
  recentKeywords,
  onSubmitKeyword,
}: TriagePivotPanelProps) {
  const showDeferredSensor =
    deferredSensorDimension && labels.sameSensorUnavailable !== undefined;
  const showLearningMethods =
    showLearningMethodSection && labels.learningMethodValues !== undefined;
  const showKeywords =
    showKeywordsSection &&
    labels.keywords !== undefined &&
    onSubmitKeyword !== undefined;
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
      {/*
       * Render order:
       *   1. Focus-driven sections + the deferred-sensor placeholder
       *      need a focus event to be meaningful; when `hasFocus` is
       *      false we render only the focus hint for them.
       *   2. Static Tier 2 sections (`learningMethods` static options
       *      and `keywords` free-form input) do not depend on focus
       *      values — the operator must be able to submit a new
       *      keyword or pick an enum row even after a zero-result
       *      fetch leaves the focus list empty. They render whenever
       *      Tier 2 scope flips them on, regardless of `hasFocus`.
       */}
      {!hasFocus && !showLearningMethods && !showKeywords ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {labels.noFocusHint}
        </p>
      ) : hasFocus &&
        sections.length === 0 &&
        !showDeferredSensor &&
        !showLearningMethods &&
        !showKeywords ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {labels.empty}
        </p>
      ) : (
        <ul className="divide-y">
          {hasFocus
            ? sections.map((section) => (
                <PivotSection
                  key={section.dimension}
                  section={section}
                  onPivot={onPivot}
                  labels={labels}
                  isWeakSignal={isWeakSignal}
                />
              ))
            : null}
          {hasFocus && showDeferredSensor ? (
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
          {showKeywords ? (
            <KeywordsSection
              dimensionLabel={labels.dimensions.keywords}
              familyLabel={labels.family["tier2-only"]}
              keywordsLabels={labels.keywords as KeywordsSectionLabels}
              recents={recentKeywords ?? []}
              onSubmit={onSubmitKeyword as (value: string) => void}
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

function KeywordsSection({
  dimensionLabel,
  familyLabel,
  keywordsLabels,
  recents,
  onSubmit,
}: {
  dimensionLabel: string;
  familyLabel: string;
  keywordsLabels: KeywordsSectionLabels;
  recents: readonly string[];
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<null | "empty" | "tooLong">(null);

  const submit = () => {
    const result = validateKeywordInput(value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setValue("");
    onSubmit(result.value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setValue("");
      setError(null);
    }
  };

  const errorMessage =
    error === "empty"
      ? keywordsLabels.errorEmpty
      : error === "tooLong"
        ? keywordsLabels.errorTooLongTemplate.replace(
            "{max}",
            String(MAX_KEYWORD_LENGTH),
          )
        : null;

  return (
    <li className="px-4 py-3" data-testid="triage-pivot-keywords">
      <div className="mb-2 flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">
          {dimensionLabel}
        </h3>
        <p className="text-xs text-muted-foreground">{familyLabel}</p>
        <p className="text-xs text-muted-foreground">{keywordsLabels.hint}</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <input
          type="text"
          value={value}
          aria-label={keywordsLabels.inputLabel}
          placeholder={keywordsLabels.inputPlaceholder}
          onChange={(e) => {
            setValue(e.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "min-w-[14rem] flex-1 rounded border border-border/60 bg-background px-2 py-1 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-primary/40",
          )}
        />
        <button
          type="button"
          onClick={submit}
          className={cn(
            "rounded border border-border/60 bg-primary px-3 py-1 text-xs font-medium text-primary-foreground",
            "hover:bg-primary/90",
          )}
        >
          {keywordsLabels.submit}
        </button>
      </div>
      {errorMessage !== null ? (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
          {errorMessage}
        </p>
      ) : null}
      {recents.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {keywordsLabels.recentHeading}
          </p>
          <div className="flex flex-wrap gap-2">
            {recents.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => onSubmit(chip)}
                aria-label={keywordsLabels.recentChipTemplate.replace(
                  "{value}",
                  chip,
                )}
                className={cn(
                  "max-w-[32ch] truncate rounded border border-border/60 px-2 py-0.5 text-xs",
                  "text-foreground hover:bg-accent",
                )}
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      ) : null}
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
