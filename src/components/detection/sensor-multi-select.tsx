"use client";

import { ChevronDown, RefreshCw, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SensorOption {
  id: string;
  name: string;
}

export interface SensorMultiSelectLabels {
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  selectAll: string;
  clearAll: string;
  empty: string;
  noMatches: string;
  selectedSummary: string;
  removeSelection: string;
  comingSoonLabel: string;
  comingSoonHint: string;
  loadingLabel: string;
  loadingHint: string;
  errorLabel: string;
  errorHint: string;
  retry: string;
}

/**
 * Runtime status of the sensor inventory the control should render:
 *
 *   - `ready`: options are loaded and REview has published the
 *     sensor-list query — the functional multi-select is shown.
 *   - `loading`: a `fetchSensors()` request is in flight — a
 *     disabled control with a "Loading sensors…" affordance is
 *     shown so the user is not misled into thinking the endpoint
 *     is absent.
 *   - `error`: the last fetch failed transiently — a disabled
 *     control with a distinct error copy plus a **Retry** action
 *     is shown. The retry fires `onRetry` rather than being frozen
 *     until the next drawer open.
 *   - `unavailable`: REview has not yet published the sensor-list
 *     query (`SENSOR_LIST_ENDPOINT_AVAILABLE === false` in
 *     `src/lib/detection/sensors.ts`). The "Coming soon" placeholder
 *     is shown, identical in shape to the Customer control.
 */
export type SensorMultiSelectState =
  | "ready"
  | "loading"
  | "error"
  | "unavailable";

interface SensorMultiSelectProps {
  options: readonly SensorOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  labels: SensorMultiSelectLabels;
  state?: SensorMultiSelectState;
  /**
   * Invoked when the user clicks the retry button in the `error`
   * state. No-op in other states.
   */
  onRetry?: () => void;
}

/**
 * Case-insensitive substring filter over sensor names. An empty or
 * whitespace-only query returns the input unchanged so callers can
 * pass the raw search box value without trimming at the call site.
 */
export function filterSensorsBySearch(
  options: readonly SensorOption[],
  search: string,
): readonly SensorOption[] {
  const q = search.trim().toLowerCase();
  if (!q) return options;
  return options.filter((opt) => opt.name.toLowerCase().includes(q));
}

export function areAllFilteredSelected(
  filtered: readonly SensorOption[],
  value: readonly string[],
): boolean {
  if (filtered.length === 0) return false;
  const selected = new Set(value);
  return filtered.every((opt) => selected.has(opt.id));
}

/**
 * Computes the next `value` array when the single-row checkbox for
 * `id` is toggled. Mirrors what the component calls on `onChange`.
 */
export function computeToggleNext(
  value: readonly string[],
  id: string,
): string[] {
  return value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
}

/**
 * Computes the next `value` array when the "Select all / Clear all"
 * toggle is clicked. The toggle operates only on the currently-
 * filtered subset so a search-scoped deselect does not wipe hidden
 * selections; when every filtered option is already selected the
 * click clears just that subset, otherwise it unions the subset
 * into the existing selection.
 */
export function computeToggleAllNext(
  value: readonly string[],
  filtered: readonly SensorOption[],
  allFilteredSelected: boolean,
): string[] {
  if (allFilteredSelected) {
    const filteredIds = new Set(filtered.map((o) => o.id));
    return value.filter((v) => !filteredIds.has(v));
  }
  const next = new Set(value);
  for (const opt of filtered) next.add(opt.id);
  return Array.from(next);
}

/**
 * Resolves the selected-chip list for display. Chip order follows
 * the selection order in `value` so freshly-added IDs render last;
 * IDs absent from `options` are dropped because we have no name to
 * render for them.
 */
export function computeSelectedChips(
  options: readonly SensorOption[],
  value: readonly string[],
): SensorOption[] {
  return value
    .map((id) => options.find((opt) => opt.id === id))
    .filter((opt): opt is SensorOption => Boolean(opt));
}

/**
 * Multi-select for the Detection filter drawer's Sensor field.
 *
 * Layout: a compact trigger button that shows selected count,
 * expanding to a search input, a "Select all / Clear all" toggle,
 * and a scrollable checkbox list. Selections echo below the panel
 * as removable chips so the user can see what is committed without
 * scrolling the list. The options list is already filtered to the
 * caller's customer scope by REview — the component does not apply
 * any additional access control.
 */
export function SensorMultiSelect({
  options,
  value,
  onChange,
  labels,
  state = "ready",
  onRetry,
}: SensorMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const panelId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(
    () => filterSensorsBySearch(options, search),
    [options, search],
  );

  const allFilteredSelected = areAllFilteredSelected(filtered, value);

  function toggle(id: string) {
    onChange(computeToggleNext(value, id));
  }

  function toggleAll() {
    onChange(computeToggleAllNext(value, filtered, allFilteredSelected));
  }

  function handleToggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        // Focus the search input on the next tick so the user can
        // start filtering immediately.
        queueMicrotask(() => searchRef.current?.focus());
      }
      return next;
    });
  }

  if (state !== "ready") {
    const { displayLabel, displayHint } =
      state === "loading"
        ? { displayLabel: labels.loadingLabel, displayHint: labels.loadingHint }
        : state === "error"
          ? { displayLabel: labels.errorLabel, displayHint: labels.errorHint }
          : {
              displayLabel: labels.comingSoonLabel,
              displayHint: labels.comingSoonHint,
            };
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-foreground text-sm font-medium">
          {labels.label}
        </legend>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-busy={state === "loading"}
            title={displayHint}
            className={cn(
              "border-input bg-background text-muted-foreground flex h-9 flex-1 items-center justify-between rounded-md border px-3 text-sm opacity-60",
              state === "error" && "border-destructive/60 text-destructive",
            )}
          >
            <span>{displayLabel}</span>
            <ChevronDown className="size-4" aria-hidden="true" />
          </button>
          {state === "error" && onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetry}
              aria-label={labels.retry}
              title={labels.errorHint}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              <span>{labels.retry}</span>
            </Button>
          ) : null}
        </div>
      </fieldset>
    );
  }

  const selectedOptions = computeSelectedChips(options, value);

  const triggerText =
    value.length === 0
      ? labels.placeholder
      : labels.selectedSummary.replace("{count}", String(value.length));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-foreground text-sm font-medium">
        {labels.label}
      </legend>

      <button
        type="button"
        onClick={handleToggleOpen}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="listbox"
        className={cn(
          "border-input bg-background text-foreground flex h-9 items-center justify-between rounded-md border px-3 text-sm transition-shadow",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
        )}
      >
        <span
          className={
            value.length === 0 ? "text-muted-foreground" : "text-foreground"
          }
        >
          {triggerText}
        </span>
        <ChevronDown
          className={cn("size-4 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          id={panelId}
          className="border-input bg-background flex flex-col gap-2 rounded-md border p-2"
        >
          <Input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={labels.searchPlaceholder}
            aria-label={labels.searchPlaceholder}
          />

          {options.length === 0 ? (
            <p className="text-muted-foreground px-1 py-2 text-sm">
              {labels.empty}
            </p>
          ) : (
            <>
              <div className="text-foreground flex items-center gap-2 px-1 py-1 text-sm">
                <Checkbox
                  id={`${panelId}-all`}
                  checked={allFilteredSelected}
                  onCheckedChange={() => toggleAll()}
                />
                <label htmlFor={`${panelId}-all`} className="cursor-pointer">
                  {allFilteredSelected ? labels.clearAll : labels.selectAll}
                </label>
              </div>

              {filtered.length === 0 ? (
                <p className="text-muted-foreground px-1 py-2 text-sm">
                  {labels.noMatches}
                </p>
              ) : (
                <ul className="max-h-48 overflow-y-auto">
                  {filtered.map((opt) => {
                    const checkboxId = `${panelId}-opt-${opt.id}`;
                    const isChecked = selected.has(opt.id);
                    return (
                      <li
                        key={opt.id}
                        className={cn(
                          "text-foreground hover:bg-muted flex items-center gap-2 rounded px-1 py-1.5 text-sm",
                        )}
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={isChecked}
                          onCheckedChange={() => toggle(opt.id)}
                        />
                        <label
                          htmlFor={checkboxId}
                          className="flex-1 cursor-pointer"
                        >
                          {opt.name}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      ) : null}

      {selectedOptions.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5">
          {selectedOptions.map((opt) => (
            <li key={opt.id}>
              <Badge variant="secondary" className="gap-1 font-normal">
                <span className="text-foreground text-xs">{opt.name}</span>
                <button
                  type="button"
                  onClick={() => toggle(opt.id)}
                  aria-label={labels.removeSelection.replace(
                    "{name}",
                    opt.name,
                  )}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mr-1 rounded-full p-0.5 focus-visible:ring-2 focus-visible:outline-none"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
