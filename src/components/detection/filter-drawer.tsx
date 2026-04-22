"use client";

import { ChevronDown, Filter as FilterIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FLOW_KINDS, toggleDirection } from "@/lib/detection/direction";
import {
  applyConfidenceMax,
  applyConfidenceMin,
  applyManualEnd,
  applyManualStart,
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  CONFIDENCE_STEP,
  type DetectionFilterDraft,
  formatConfidenceInput,
  isoToLocalInput,
  setConfidenceMax,
  setConfidenceMin,
} from "@/lib/detection/filter-draft";
import {
  computePeriodRange,
  PERIOD_KEYS,
  type PeriodKey,
} from "@/lib/detection/period";
import type { FlowKind, LearningMethod } from "@/lib/detection/types";
import { cn } from "@/lib/utils";
import {
  EndpointFilterPanel,
  type EndpointFilterPanelLabels,
} from "./endpoint-filter-panel";
import {
  FilterMultiSelect,
  type FilterMultiSelectLabels,
  type FilterMultiSelectOption,
} from "./filter-multi-select";
import {
  SensorMultiSelect,
  type SensorMultiSelectLabels,
  type SensorMultiSelectState,
  type SensorOption,
} from "./sensor-multi-select";

export interface FilterDrawerLabels {
  title: string;
  description: string;
  periodLabel: string;
  periodOptions: Record<PeriodKey, string>;
  timeRangeLabel: string;
  startLabel: string;
  endLabel: string;
  directionLabel: string;
  directionOptions: Record<FlowKind, string>;
  confidenceLabel: string;
  confidenceMinLabel: string;
  confidenceMaxLabel: string;
  apply: string;
  saveThisFilter: string;
  saveThisFilterComingSoon: string;
  invalidRange: string;
  close: string;
  endpointLabel: string;
  endpointAdvanced: string;
  endpointEmpty: string;
  endpointCount: string;
  endpointPanel: EndpointFilterPanelLabels;
  customerLabel: string;
  customerComingSoon: string;
  customerComingSoonHint: string;
  sensor: SensorMultiSelectLabels;
  categoricalSectionLabel: string;
  fields: {
    levels: string;
    countries: string;
    learningMethods: string;
    categories: string;
    kinds: string;
  };
}

/**
 * Multi-select option bundles for each categorical field. The parent
 * owns the option lists (localised once at page level) so the drawer
 * stays a pure renderer and tests can supply fixtures without Next's
 * i18n context.
 */
export interface FilterDrawerOptions {
  levels: readonly FilterMultiSelectOption<number>[];
  countries: readonly FilterMultiSelectOption<string>[];
  learningMethods: readonly FilterMultiSelectOption<LearningMethod>[];
  categories: readonly FilterMultiSelectOption<number>[];
  kinds: readonly FilterMultiSelectOption<string>[];
}

interface FilterDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: DetectionFilterDraft;
  onDraftChange: (draft: DetectionFilterDraft) => void;
  onApply: (draft: DetectionFilterDraft) => void;
  options: FilterDrawerOptions;
  labels: FilterDrawerLabels;
  multiSelectLabels: FilterMultiSelectLabels;
  /**
   * When true, the Network/IP advanced panel opens alongside the
   * drawer the moment the drawer opens. The DetectionShell sets
   * this when the operator activates the aggregate Network chip.
   */
  openEndpointPanelOnOpen?: boolean;
  onEndpointPanelOpenChange?: (open: boolean) => void;
  /**
   * Sensor options from REview, already scoped to the caller's
   * accessible customers. Only consumed when `sensorState` is
   * `"ready"`; otherwise the control renders a state-specific
   * disabled affordance (loading / error / unavailable) and
   * `sensorIds` is not populated — the filter submits no `sensors`
   * value in any non-ready state.
   */
  sensorOptions: readonly SensorOption[];
  sensorState: SensorMultiSelectState;
  /**
   * Invoked when the user clicks the retry button surfaced in the
   * `error` state. The parent should re-issue the fetch.
   */
  onSensorRetry?: () => void;
}

/**
 * Drawer for editing the active tab's filter. Owns no committed
 * state itself — the parent keeps both the committed filter and
 * the in-flight draft so "close without apply" preserves the
 * edits. Apply hands the draft back up; the parent converts it
 * into a `Filter` and triggers the query.
 */
export function FilterDrawer({
  open,
  onOpenChange,
  draft,
  onDraftChange,
  onApply,
  options,
  labels,
  multiSelectLabels,
  openEndpointPanelOnOpen,
  onEndpointPanelOpenChange,
  sensorOptions,
  sensorState,
  onSensorRetry,
}: FilterDrawerProps) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const [endpointPanelOpen, setEndpointPanelOpen] = useState(false);
  // Transient text state for the two confidence inputs: the input's
  // displayed value is owned here while the user is typing, instead
  // of being reformatted back through `formatConfidenceInput()` on
  // every keystroke. Without this, typing `0.7` character-by-character
  // is impossible because each intermediate value (`0`, `0.`) would
  // be snapped to the last committed two-decimal string.
  //
  // The committed numeric values still live on the draft and are
  // updated on every keystroke so the min/max invariant and the
  // outgoing submission stay in sync with what the user has typed.
  // `*FocusedRef` flags gate the unfocused-sync effect so a cross-
  // snap (typing a large min that snaps max upward) can still refresh
  // the other input's text, without clobbering the one the user is
  // actively editing.
  const [confidenceMinText, setConfidenceMinText] = useState(() =>
    formatConfidenceInput(draft.confidenceMin),
  );
  const [confidenceMaxText, setConfidenceMaxText] = useState(() =>
    formatConfidenceInput(draft.confidenceMax),
  );
  const minFocusedRef = useRef(false);
  const maxFocusedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setValidationError(null);
      setEndpointPanelOpen(false);
      return;
    }
    if (openEndpointPanelOnOpen) {
      setEndpointPanelOpen(true);
    }
  }, [open, openEndpointPanelOnOpen]);

  function handleEndpointPanelOpenChange(next: boolean) {
    setEndpointPanelOpen(next);
    onEndpointPanelOpenChange?.(next);
  }

  useEffect(() => {
    if (!minFocusedRef.current) {
      setConfidenceMinText(formatConfidenceInput(draft.confidenceMin));
    }
  }, [draft.confidenceMin]);

  useEffect(() => {
    if (!maxFocusedRef.current) {
      setConfidenceMaxText(formatConfidenceInput(draft.confidenceMax));
    }
  }, [draft.confidenceMax]);

  function selectPeriod(key: PeriodKey) {
    const range = computePeriodRange(key);
    onDraftChange({
      ...draft,
      period: key,
      startLocal: isoToLocalInput(range.start),
      endLocal: isoToLocalInput(range.end),
      startIso: range.start,
      endIso: range.end,
    });
    setValidationError(null);
  }

  function onStartChange(value: string) {
    onDraftChange(applyManualStart(draft, value));
    setValidationError(null);
  }

  function onEndChange(value: string) {
    onDraftChange(applyManualEnd(draft, value));
    setValidationError(null);
  }

  function onToggleDirection(kind: FlowKind) {
    onDraftChange({
      ...draft,
      directions: toggleDirection(draft.directions, kind),
    });
  }

  function onConfidenceMinChange(value: string) {
    setConfidenceMinText(value);
    onDraftChange(applyConfidenceMin(draft, value));
  }

  function onConfidenceMaxChange(value: string) {
    setConfidenceMaxText(value);
    onDraftChange(applyConfidenceMax(draft, value));
  }

  function onConfidenceMinBlur() {
    minFocusedRef.current = false;
    // Re-render the formatted numeric on blur so an in-progress edit
    // like "0." snaps back to the committed "0.00".
    setConfidenceMinText(formatConfidenceInput(draft.confidenceMin));
  }

  function onConfidenceMaxBlur() {
    maxFocusedRef.current = false;
    setConfidenceMaxText(formatConfidenceInput(draft.confidenceMax));
  }

  function onConfidenceMinKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Home") {
      e.preventDefault();
      const nextDraft = setConfidenceMin(draft, CONFIDENCE_DEFAULT_MIN);
      onDraftChange(nextDraft);
      setConfidenceMinText(formatConfidenceInput(nextDraft.confidenceMin));
    } else if (e.key === "End") {
      e.preventDefault();
      const nextDraft = setConfidenceMin(draft, draft.confidenceMax);
      onDraftChange(nextDraft);
      setConfidenceMinText(formatConfidenceInput(nextDraft.confidenceMin));
    }
  }

  function onConfidenceMaxKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Home") {
      e.preventDefault();
      const nextDraft = setConfidenceMax(draft, draft.confidenceMin);
      onDraftChange(nextDraft);
      setConfidenceMaxText(formatConfidenceInput(nextDraft.confidenceMax));
    } else if (e.key === "End") {
      e.preventDefault();
      const nextDraft = setConfidenceMax(draft, CONFIDENCE_DEFAULT_MAX);
      onDraftChange(nextDraft);
      setConfidenceMaxText(formatConfidenceInput(nextDraft.confidenceMax));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !draft.startIso ||
      !draft.endIso ||
      Date.parse(draft.startIso) >= Date.parse(draft.endIso)
    ) {
      setValidationError(labels.invalidRange);
      return;
    }
    // Submit via Enter doesn't fire blur on the focused confidence
    // input, so an intermediate value like "0." or "" would otherwise
    // stay in the transient text after the drawer closes. The drawer
    // is kept mounted by the shell and reopened with the same draft,
    // so without this sync the next open would show stale raw text
    // while the committed filter already used the fallback numeric.
    // Clear the focus refs so a re-focus after reopen starts clean.
    minFocusedRef.current = false;
    maxFocusedRef.current = false;
    setConfidenceMinText(formatConfidenceInput(draft.confidenceMin));
    setConfidenceMaxText(formatConfidenceInput(draft.confidenceMax));
    onApply(draft);
  }

  const endpointCount = draft.endpoints.filter((e) => e.selected).length;
  const endpointSummary =
    endpointCount === 0
      ? labels.endpointEmpty
      : labels.endpointCount.replace("{count}", String(endpointCount));

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="sm:max-w-md"
          aria-describedby="detection-filter-drawer-description"
          closeLabel={labels.close}
        >
          <SheetHeader>
            <SheetTitle>{labels.title}</SheetTitle>
            <SheetDescription id="detection-filter-drawer-description">
              {labels.description}
            </SheetDescription>
          </SheetHeader>

          <form
            onSubmit={handleSubmit}
            className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4"
          >
            {/* Period quick-select */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-foreground text-sm font-medium">
                {labels.periodLabel}
              </legend>
              <div className="flex flex-wrap gap-2">
                {PERIOD_KEYS.map((key) => {
                  const selected = draft.period === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => selectPeriod(key)}
                      className={cn(
                        "focus-visible:ring-ring rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none",
                        selected
                          ? "bg-primary text-primary-foreground border-transparent"
                          : "bg-background text-foreground hover:bg-muted border-[var(--sidebar-border)]",
                      )}
                    >
                      {labels.periodOptions[key]}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Explicit time range */}
            <fieldset className="flex flex-col gap-3">
              <legend className="text-foreground text-sm font-medium">
                {labels.timeRangeLabel}
              </legend>
              <div className="flex flex-col gap-2">
                <Label htmlFor="filter-start">{labels.startLabel}</Label>
                <Input
                  id="filter-start"
                  type="datetime-local"
                  step="60"
                  value={draft.startLocal}
                  onChange={(e) => onStartChange(e.target.value)}
                  aria-describedby={
                    validationError ? "filter-range-error" : undefined
                  }
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="filter-end">{labels.endLabel}</Label>
                <Input
                  id="filter-end"
                  type="datetime-local"
                  step="60"
                  value={draft.endLocal}
                  onChange={(e) => onEndChange(e.target.value)}
                  aria-describedby={
                    validationError ? "filter-range-error" : undefined
                  }
                />
              </div>
              {validationError ? (
                <p
                  id="filter-range-error"
                  role="alert"
                  className="text-destructive text-xs"
                >
                  {validationError}
                </p>
              ) : null}
            </fieldset>

            {/* Network / IP — opens the advanced panel. */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-foreground text-sm font-medium">
                {labels.endpointLabel}
              </legend>
              <div className="flex items-center gap-2 rounded-md border border-[var(--sidebar-border)] px-3 py-2">
                <span className="text-muted-foreground flex-1 text-xs">
                  {endpointSummary}
                </span>
                {endpointCount > 0 ? (
                  <Badge variant="secondary" className="text-xs font-normal">
                    {endpointCount}
                  </Badge>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={labels.endpointAdvanced}
                  onClick={() => handleEndpointPanelOpenChange(true)}
                >
                  <FilterIcon className="size-4" />
                </Button>
              </div>
            </fieldset>

            {/* Direction multi-select */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-foreground text-sm font-medium">
                {labels.directionLabel}
              </legend>
              <div className="flex flex-wrap gap-2">
                {FLOW_KINDS.map((kind) => {
                  const selected = draft.directions.includes(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onToggleDirection(kind)}
                      className={cn(
                        "focus-visible:ring-ring rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none",
                        selected
                          ? "bg-primary text-primary-foreground border-transparent"
                          : "bg-background text-foreground hover:bg-muted border-[var(--sidebar-border)]",
                      )}
                    >
                      {labels.directionOptions[kind]}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Confidence range */}
            <fieldset className="flex flex-col gap-3">
              <legend className="text-foreground text-sm font-medium">
                {labels.confidenceLabel}
              </legend>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="filter-confidence-min">
                    {labels.confidenceMinLabel}
                  </Label>
                  <Input
                    id="filter-confidence-min"
                    type="number"
                    inputMode="decimal"
                    min={CONFIDENCE_DEFAULT_MIN}
                    max={CONFIDENCE_DEFAULT_MAX}
                    step={CONFIDENCE_STEP}
                    value={confidenceMinText}
                    onChange={(e) => onConfidenceMinChange(e.target.value)}
                    onFocus={() => {
                      minFocusedRef.current = true;
                    }}
                    onBlur={onConfidenceMinBlur}
                    onKeyDown={onConfidenceMinKeyDown}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="filter-confidence-max">
                    {labels.confidenceMaxLabel}
                  </Label>
                  <Input
                    id="filter-confidence-max"
                    type="number"
                    inputMode="decimal"
                    min={CONFIDENCE_DEFAULT_MIN}
                    max={CONFIDENCE_DEFAULT_MAX}
                    step={CONFIDENCE_STEP}
                    value={confidenceMaxText}
                    onChange={(e) => onConfidenceMaxChange(e.target.value)}
                    onFocus={() => {
                      maxFocusedRef.current = true;
                    }}
                    onBlur={onConfidenceMaxBlur}
                    onKeyDown={onConfidenceMaxKeyDown}
                  />
                </div>
              </div>
            </fieldset>

            {/*
             * Customer placeholder. The Customer directory is not yet
             * modelled (#271 umbrella); render a disabled control
             * with the same shape as its eventual neighbours and
             * never submit its value. Forward-compatibility note:
             * `triagePolicies` will share the picker component built
             * by the Triage menu effort — when that lands, swap this
             * placeholder for the same component so the look is
             * consistent across surfaces. Update the call site in
             * `detection-shell.tsx` to populate the active-filter
             * chip bar once the directory ships.
             */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-foreground text-sm font-medium">
                {labels.customerLabel}
              </legend>
              <button
                type="button"
                disabled
                aria-disabled="true"
                title={labels.customerComingSoonHint}
                className="border-input bg-background text-muted-foreground flex h-9 items-center justify-between rounded-md border px-3 text-sm opacity-60"
              >
                <span>{labels.customerComingSoon}</span>
                <ChevronDown className="size-4" aria-hidden="true" />
              </button>
            </fieldset>

            {/*
             * Sensor multi-select. Options come from REview via
             * `fetchSensors()`. The control switches on `sensorState`:
             *   - `ready`   — functional multi-select.
             *   - `loading` — disabled, "Loading sensors…" affordance
             *                 while the in-flight request resolves.
             *   - `error`   — disabled with a retry button; the user
             *                 is not forced to close/reopen the drawer
             *                 to recover from a transient failure.
             *   - `unavailable` — "Coming soon" placeholder while the
             *                 REview sensor-list query is absent from
             *                 the vendored schema
             *                 (`SENSOR_LIST_ENDPOINT_AVAILABLE` is
             *                 `false` in `src/lib/detection/sensors.ts`).
             * In every non-`ready` state `sensorIds` stays empty so no
             * `sensors` value reaches the filter.
             */}
            <SensorMultiSelect
              options={sensorOptions}
              value={draft.sensorIds}
              onChange={(next) => onDraftChange({ ...draft, sensorIds: next })}
              labels={labels.sensor}
              state={sensorState}
              onRetry={onSensorRetry}
            />

            {/* Categorical multi-select filters */}
            <fieldset className="flex flex-col gap-3">
              <legend className="text-foreground text-sm font-medium">
                {labels.categoricalSectionLabel}
              </legend>
              <FilterMultiSelect
                id="filter-levels"
                label={labels.fields.levels}
                options={options.levels}
                selected={draft.levels}
                onChange={(next) => onDraftChange({ ...draft, levels: next })}
                labels={multiSelectLabels}
              />
              <FilterMultiSelect
                id="filter-countries"
                label={labels.fields.countries}
                options={options.countries}
                selected={draft.countries}
                onChange={(next) =>
                  onDraftChange({ ...draft, countries: next })
                }
                searchable
                labels={multiSelectLabels}
              />
              <FilterMultiSelect
                id="filter-learning-methods"
                label={labels.fields.learningMethods}
                options={options.learningMethods}
                selected={draft.learningMethods}
                onChange={(next) =>
                  onDraftChange({ ...draft, learningMethods: next })
                }
                labels={multiSelectLabels}
              />
              <FilterMultiSelect
                id="filter-categories"
                label={labels.fields.categories}
                options={options.categories}
                selected={draft.categories}
                onChange={(next) =>
                  onDraftChange({ ...draft, categories: next })
                }
                searchable
                labels={multiSelectLabels}
              />
              <FilterMultiSelect
                id="filter-kinds"
                label={labels.fields.kinds}
                options={options.kinds}
                selected={draft.kinds}
                onChange={(next) => onDraftChange({ ...draft, kinds: next })}
                searchable
                openList
                labels={multiSelectLabels}
              />
            </fieldset>

            <div className="mt-auto flex flex-col gap-2 pt-2">
              <Button type="submit">{labels.apply}</Button>
              <Button
                type="button"
                variant="outline"
                disabled
                aria-disabled="true"
                title={labels.saveThisFilterComingSoon}
              >
                {labels.saveThisFilter}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <EndpointFilterPanel
        open={endpointPanelOpen}
        onOpenChange={handleEndpointPanelOpenChange}
        entries={draft.endpoints}
        onEntriesChange={(entries) =>
          onDraftChange({ ...draft, endpoints: entries })
        }
        labels={labels.endpointPanel}
        expandCustomOnOpen={openEndpointPanelOnOpen}
      />
    </>
  );
}
