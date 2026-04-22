"use client";

import { Filter as FilterIcon } from "lucide-react";
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
import type { FlowKind } from "@/lib/detection/types";
import { cn } from "@/lib/utils";

import {
  EndpointFilterPanel,
  type EndpointFilterPanelLabels,
} from "./endpoint-filter-panel";

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
}

interface FilterDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: DetectionFilterDraft;
  onDraftChange: (draft: DetectionFilterDraft) => void;
  onApply: (draft: DetectionFilterDraft) => void;
  labels: FilterDrawerLabels;
  /**
   * When true, the Network/IP advanced panel opens alongside the
   * drawer the moment the drawer opens. The DetectionShell sets
   * this when the operator activates the aggregate Network chip.
   */
  openEndpointPanelOnOpen?: boolean;
  onEndpointPanelOpenChange?: (open: boolean) => void;
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
  labels,
  openEndpointPanelOnOpen,
  onEndpointPanelOpenChange,
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
