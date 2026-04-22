"use client";

import { Filter as FilterIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
import type { EndpointEntry } from "@/lib/detection/endpoint-filter";
import {
  computePeriodRange,
  PERIOD_KEYS,
  type PeriodKey,
} from "@/lib/detection/period";
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

export interface FilterDrawerDraft {
  period: PeriodKey | null;
  startLocal: string;
  endLocal: string;
  /**
   * ISO-8601 UTC strings used on Apply. Kept in sync with the
   * local-input fields: a chip selection writes the raw
   * `computePeriodRange()` instants here (seconds/ms intact). A
   * manual edit to either input normalizes BOTH sides from their
   * visible `datetime-local` values so the submitted range exactly
   * matches what the drawer shows — otherwise a one-sided edit
   * after a chip selection would leave the un-edited side at
   * full precision while the visible field shows minute precision.
   */
  startIso: string | null;
  endIso: string | null;
  endpoints: EndpointEntry[];
}

interface FilterDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: FilterDrawerDraft;
  onDraftChange: (draft: FilterDrawerDraft) => void;
  onApply: (draft: FilterDrawerDraft) => void;
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

/**
 * Convert an ISO-8601 UTC string to the `YYYY-MM-DDTHH:mm` format
 * `<input type="datetime-local">` expects, in the user's local
 * timezone. Returns `""` on an unparseable input so the input
 * renders empty rather than with `NaN`.
 */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Convert a `<input type="datetime-local">` string (interpreted in
 * the browser's local timezone) back to an ISO-8601 UTC string
 * suitable for `EventListFilterInput.start`/`end`. Returns `null`
 * on an empty or unparseable input.
 */
export function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Draft transition for a manual Start edit. Clears the selected
 * Period chip and normalizes BOTH ISO fields from the visible
 * `datetime-local` strings so a one-sided edit after a chip
 * selection cannot leave `endIso` at full precision while the End
 * input shows minute precision.
 */
export function applyManualStart(
  draft: FilterDrawerDraft,
  value: string,
): FilterDrawerDraft {
  return {
    ...draft,
    period: null,
    startLocal: value,
    startIso: localInputToIso(value),
    endIso: localInputToIso(draft.endLocal),
  };
}

/** Symmetric counterpart of `applyManualStart` for the End input. */
export function applyManualEnd(
  draft: FilterDrawerDraft,
  value: string,
): FilterDrawerDraft {
  return {
    ...draft,
    period: null,
    endLocal: value,
    startIso: localInputToIso(draft.startLocal),
    endIso: localInputToIso(value),
  };
}
