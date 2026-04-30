"use client";

import { ChevronDown, RefreshCw, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface CustomerOption {
  id: number;
  name: string;
}

export interface CustomerMultiSelectLabels {
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  selectAll: string;
  clearAll: string;
  /** Copy shown when the caller has no customers in scope (`kind: 'empty'`). */
  emptyScope: string;
  /** Copy shown when the search box does not match any option. */
  noMatches: string;
  /** Trigger summary `"{count} selected"`. */
  selectedSummary: string;
  /** A11y label template `"Remove {name}"` for chip × buttons. */
  removeSelection: string;
  loadingLabel: string;
  loadingHint: string;
  errorLabel: string;
  errorHint: string;
  retry: string;
  /** Tooltip + a11y label for the manual-refresh `↻` icon button. */
  refresh: string;
}

/**
 * Runtime status of the customer inventory the control should
 * render. Mirrors `SensorMultiSelectState` (#278) one-for-one so the
 * two drawer fields share their fetch / loading / error UX, except
 * that customers have no "endpoint absent" branch (the helper
 * `getEffectiveCustomerScope` is always available).
 *
 *   - `ready`: the customer list is loaded and the multi-select
 *     renders interactively. The `empty` sub-state is folded in:
 *     options.length === 0 means the caller has no customer access
 *     (`kind: 'empty'`) and the trigger is disabled with the
 *     "No customer access" affordance.
 *   - `loading`: a `fetchCustomersForFilter()` request is in flight.
 *   - `error`: the last fetch failed transiently — a disabled
 *     control with a Retry button.
 */
export type CustomerMultiSelectState = "ready" | "loading" | "error";

interface CustomerMultiSelectProps {
  options: readonly CustomerOption[];
  value: readonly number[];
  onChange: (next: number[]) => void;
  labels: CustomerMultiSelectLabels;
  state?: CustomerMultiSelectState;
  /**
   * Invoked when the user clicks the inline refresh `↻` button in
   * the panel header (or the Retry button in the `error` state). The
   * shell fires the same `fetchCustomersForFilter()` it ran on first
   * open and replaces the cached options with the result.
   */
  onRefresh?: () => void;
}

/**
 * Case-insensitive substring filter over customer names. Mirrors
 * the equivalent helper in `sensor-multi-select.tsx` so the two
 * drawer fields agree on the search semantics.
 */
export function filterCustomersBySearch(
  options: readonly CustomerOption[],
  search: string,
): readonly CustomerOption[] {
  const q = search.trim().toLowerCase();
  if (!q) return options;
  return options.filter((opt) => opt.name.toLowerCase().includes(q));
}

export function areAllFilteredCustomersSelected(
  filtered: readonly CustomerOption[],
  value: readonly number[],
): boolean {
  if (filtered.length === 0) return false;
  const selected = new Set(value);
  return filtered.every((opt) => selected.has(opt.id));
}

export function computeCustomerToggleNext(
  value: readonly number[],
  id: number,
): number[] {
  return value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
}

export function computeCustomerToggleAllNext(
  value: readonly number[],
  filtered: readonly CustomerOption[],
  allFilteredSelected: boolean,
): number[] {
  if (allFilteredSelected) {
    const filteredIds = new Set(filtered.map((o) => o.id));
    return value.filter((v) => !filteredIds.has(v));
  }
  const next = new Set(value);
  for (const opt of filtered) next.add(opt.id);
  return Array.from(next);
}

export function computeSelectedCustomerChips(
  options: readonly CustomerOption[],
  value: readonly number[],
): CustomerOption[] {
  return value
    .map((id) => options.find((opt) => opt.id === id))
    .filter((opt): opt is CustomerOption => Boolean(opt));
}

/**
 * Multi-select for the Detection filter drawer's Customer field
 * (#384). Mirrors {@link SensorMultiSelect} so the two categorical
 * drawer fields share their interaction model: a compact trigger
 * that expands to a search input, a "Select all / Clear all"
 * toggle, and a checkbox list. Selections echo below the panel as
 * removable chips.
 *
 * Options are sourced from `getEffectiveCustomerScope(session)` via
 * the page-session cache in `DetectionShell` — the same helper that
 * drives the page-header customer scope indicator (#383), so the
 * drawer and indicator can never disagree about which customers
 * are visible.
 *
 * The empty-scope edge case (`kind: 'empty'`) is folded into the
 * `ready` state with `options.length === 0`: the trigger is disabled
 * with the "No customer access" copy and submission of `customers`
 * never fires. The defense-in-depth check on the dispatch side
 * (`validateFilterScope`) is the authoritative gate; the disabled
 * control here is a UI affordance only.
 */
export function CustomerMultiSelect({
  options,
  value,
  onChange,
  labels,
  state = "ready",
  onRefresh,
}: CustomerMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const panelId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(
    () => filterCustomersBySearch(options, search),
    [options, search],
  );

  const allFilteredSelected = areAllFilteredCustomersSelected(filtered, value);

  function toggle(id: number) {
    onChange(computeCustomerToggleNext(value, id));
  }

  function toggleAll() {
    onChange(
      computeCustomerToggleAllNext(value, filtered, allFilteredSelected),
    );
  }

  function handleToggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        queueMicrotask(() => searchRef.current?.focus());
      }
      return next;
    });
  }

  if (state !== "ready") {
    const { displayLabel, displayHint } =
      state === "loading"
        ? { displayLabel: labels.loadingLabel, displayHint: labels.loadingHint }
        : { displayLabel: labels.errorLabel, displayHint: labels.errorHint };
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
          {state === "error" && onRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
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

  // `ready` + empty options ≡ `kind: 'empty'` — render the disabled
  // affordance and never submit a `customers` value. The intersection
  // check on the dispatch side rejects the same condition server-side.
  if (options.length === 0) {
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-foreground text-sm font-medium">
          {labels.label}
        </legend>
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={labels.emptyScope}
          className="border-input bg-background text-muted-foreground flex h-9 items-center justify-between rounded-md border px-3 text-sm opacity-60"
        >
          <span>{labels.emptyScope}</span>
          <ChevronDown className="size-4" aria-hidden="true" />
        </button>
      </fieldset>
    );
  }

  const selectedOptions = computeSelectedCustomerChips(options, value);

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
          <div className="flex items-center gap-2">
            <Input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={labels.searchPlaceholder}
              aria-label={labels.searchPlaceholder}
              className="flex-1"
            />
            {onRefresh ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                aria-label={labels.refresh}
                title={labels.refresh}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>

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
