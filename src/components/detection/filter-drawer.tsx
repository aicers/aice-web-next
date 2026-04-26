"use client";

import { ChevronDown, Filter as FilterIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

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
  isDraftRangeValid,
  isoToLocalInput,
  normalizeDraftForSubmit,
  setConfidenceMax,
  setConfidenceMin,
} from "@/lib/detection/filter-draft";
import {
  computePeriodRange,
  PERIOD_KEYS,
  type PeriodKey,
} from "@/lib/detection/period";
import type { FlowKind, LearningMethod } from "@/lib/detection/types";
import {
  TAG_FIELDS,
  type TagField,
  TEXT_FIELDS,
  type TextField,
} from "@/lib/detection/url-filters";
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
import { TagInput } from "./tag-input";

export interface TagFieldLabel {
  label: string;
  placeholder: string;
  /** Template that returns the a11y label for a tag's remove button. */
  removeLabel: (tag: string) => string;
}

export interface TextFieldLabel {
  label: string;
  placeholder: string;
}

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
  /**
   * Tooltip surfaced when the "Save this filter" affordance is
   * disabled — the parent did not wire `onSaveRequest`. Kept as a
   * separate label so the disabled-state messaging can be tuned per
   * release without crossing the active button label.
   */
  saveThisFilterDisabled: string;
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
  /**
   * Section legend for the free-form text/tag inputs (source,
   * destination, keywords, hostnames, userIds, userNames,
   * userDepartments). Renamed from the original `fieldsLegend` on the
   * branch so it no longer collides with `fields` below, which main
   * now uses for the categorical multi-select labels.
   */
  attributesLegend: string;
  /** Per-field labels for the Attributes section (text + tag inputs). */
  attributes: {
    source: TextFieldLabel;
    destination: TextFieldLabel;
    keywords: TagFieldLabel;
    hostnames: TagFieldLabel;
    userIds: TagFieldLabel;
    userNames: TagFieldLabel;
    userDepartments: TagFieldLabel;
  };
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

/**
 * Targets the drawer knows how to scroll-to and focus when a chip
 * is activated. Text and tag fields jump to their input; the
 * remaining targets land on the enclosing section (period,
 * direction, confidence, sensor, endpoints, and the categorical
 * multi-selects).
 */
export type DrawerFocusField =
  | TextField
  | TagField
  | "period"
  | "timeRange"
  | "direction"
  | "confidence"
  | "sensor"
  | "endpoints"
  | "levels"
  | "countries"
  | "learningMethods"
  | "categories"
  | "kinds";

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
  /**
   * Field to scroll into view and focus once the drawer finishes
   * opening. The shell sets this when an aggregate chip is activated
   * so operators land directly on the offending list instead of
   * scanning for it. A new non-null value re-runs the focus effect
   * even if the field name hasn't changed (second click on the same
   * chip).
   */
  focusField?: DrawerFocusField | null;
  /**
   * Monotonic token that pairs with {@link focusField}. When it
   * increments the drawer treats the focus request as fresh even if
   * `focusField` hasn't changed, so repeated clicks on the same chip
   * refocus reliably.
   */
  focusToken?: number;
  /**
   * Click handler for the "Save this filter" affordance. When provided
   * the button is enabled and bubbles the current draft (already
   * normalized for submit) up to the parent so the Save dialog can
   * open with a sensible default name. `undefined` keeps the button
   * disabled — the same contract Phase Detection-3 shipped before
   * Phase Detection-15 wired this.
   */
  onSaveRequest?: (draft: DetectionFilterDraft) => void;
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
  focusField = null,
  focusToken = 0,
  onSaveRequest,
}: FilterDrawerProps) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const [endpointPanelOpen, setEndpointPanelOpen] = useState(false);
  const fieldIdPrefix = useId();
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

  // Scroll + focus the requested field once the drawer has opened.
  // The shared `Sheet` content animates in, so we defer with
  // `requestAnimationFrame` to let the target element mount and the
  // sheet settle before calling `focus()`; otherwise the scroll-into-
  // view snaps to the wrong position on some browsers.
  //
  // `focusToken` is intentionally in the dep list so repeated clicks
  // on the same aggregate chip re-run the effect even though the
  // field name is unchanged — biome's exhaustive-deps rule can't see
  // that motivation so the dep is left in deliberately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken re-triggers repeat-click focus
  useEffect(() => {
    if (!open || !focusField) return;
    const id = resolveFocusElementId(focusField, fieldIdPrefix);
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "auto" });
      // Text / tag fields accept programmatic focus; section anchors
      // are plain fieldsets, so the focus call is a no-op there.
      if (typeof (el as HTMLInputElement).focus === "function") {
        (el as HTMLInputElement).focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, focusField, focusToken, fieldIdPrefix]);

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

  function setTextField(field: TextField, value: string) {
    onDraftChange({ ...draft, [field]: value });
  }

  function setTagField(field: TagField, value: string[]) {
    onDraftChange({ ...draft, [field]: value });
  }

  // Shared range gate for Apply and Save: rejects missing or reversed
  // start/end the same way for both paths, surfaces the inline range
  // error, and canonicalises the transient confidence text so a still-
  // focused input (Apply via Enter, Save via click) doesn't leak a
  // partial value like "0." into the next reopen of the drawer.
  function commitRangeGate(): boolean {
    if (!isDraftRangeValid(draft)) {
      setValidationError(labels.invalidRange);
      return false;
    }
    minFocusedRef.current = false;
    maxFocusedRef.current = false;
    setConfidenceMinText(formatConfidenceInput(draft.confidenceMin));
    setConfidenceMaxText(formatConfidenceInput(draft.confidenceMax));
    return true;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!commitRangeGate()) return;
    onApply(normalizeDraftForSubmit(draft));
  }

  function handleSaveClick() {
    if (!onSaveRequest) return;
    if (!commitRangeGate()) return;
    onSaveRequest(normalizeDraftForSubmit(draft));
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
            <fieldset
              id="filter-section-period"
              className="flex flex-col gap-2"
            >
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
            <fieldset
              id="filter-section-timeRange"
              className="flex flex-col gap-3"
            >
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
            <fieldset
              id="filter-section-endpoints"
              className="flex flex-col gap-2"
            >
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
            <fieldset
              id="filter-section-direction"
              className="flex flex-col gap-2"
            >
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
            <fieldset
              id="filter-section-confidence"
              className="flex flex-col gap-3"
            >
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
            <div id="filter-section-sensor">
              <SensorMultiSelect
                options={sensorOptions}
                value={draft.sensorIds}
                onChange={(next) =>
                  onDraftChange({ ...draft, sensorIds: next })
                }
                labels={labels.sensor}
                state={sensorState}
                onRetry={onSensorRetry}
              />
            </div>

            {/* Free-form fields: single-string + tag-input filters. */}
            <fieldset className="flex flex-col gap-3">
              <legend className="text-foreground text-sm font-medium">
                {labels.attributesLegend}
              </legend>
              {TEXT_FIELDS.map((field) => {
                const inputId = `${fieldIdPrefix}-${field}`;
                return (
                  <div key={field} className="flex flex-col gap-2">
                    <Label htmlFor={inputId}>
                      {labels.attributes[field].label}
                    </Label>
                    <Input
                      id={inputId}
                      type="text"
                      value={draft[field]}
                      onChange={(e) => setTextField(field, e.target.value)}
                      placeholder={labels.attributes[field].placeholder}
                    />
                  </div>
                );
              })}
              {TAG_FIELDS.map((field) => {
                const inputId = `${fieldIdPrefix}-${field}`;
                return (
                  <div key={field} className="flex flex-col gap-2">
                    <Label htmlFor={inputId}>
                      {labels.attributes[field].label}
                    </Label>
                    <TagInput
                      id={inputId}
                      value={draft[field]}
                      onChange={(next) => setTagField(field, next)}
                      placeholder={labels.attributes[field].placeholder}
                      removeLabel={labels.attributes[field].removeLabel}
                    />
                  </div>
                );
              })}
            </fieldset>

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
                disabled={!onSaveRequest}
                aria-disabled={!onSaveRequest ? "true" : undefined}
                title={
                  !onSaveRequest ? labels.saveThisFilterDisabled : undefined
                }
                onClick={handleSaveClick}
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

/**
 * Text / tag fields have a per-instance input id (`${prefix}-${field}`);
 * every other focus target is a static section anchor the drawer
 * decorates with `id="filter-section-<focus>"`. The categorical
 * multi-selects already own stable ids (`filter-levels`, etc.).
 */
function resolveFocusElementId(
  focusField: DrawerFocusField,
  prefix: string,
): string {
  switch (focusField) {
    case "source":
    case "destination":
    case "keywords":
    case "hostnames":
    case "userIds":
    case "userNames":
    case "userDepartments":
      return `${prefix}-${focusField}`;
    case "levels":
    case "countries":
    case "learningMethods":
    case "categories":
    case "kinds":
      return `filter-${focusField === "learningMethods" ? "learning-methods" : focusField}`;
    case "period":
    case "timeRange":
    case "direction":
    case "confidence":
    case "sensor":
    case "endpoints":
      return `filter-section-${focusField}`;
  }
}
