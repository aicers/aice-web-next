"use client";

import { ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface FilterMultiSelectOption<V extends string | number> {
  value: V;
  label: string;
  /**
   * Optional secondary text searched alongside the primary `label`.
   * Typically set when the label is a localized name and callers
   * still want the underlying code (e.g. ISO country code, enum
   * identifier) to match search input.
   */
  searchText?: string;
}

/**
 * Pure derivations split out of the component body so they can be
 * unit-tested directly (and shared by the panel) without a render
 * tree. Keeping them here means a regression in the component's
 * search/summary/all-state behaviour is caught by the same helper
 * the UI actually calls, not a copy in a test file.
 */
export function filterMultiSelectOptions<V extends string | number>(
  options: readonly FilterMultiSelectOption<V>[],
  query: string,
): readonly FilterMultiSelectOption<V>[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((option) => {
    if (option.label.toLowerCase().includes(q)) return true;
    if (option.searchText?.toLowerCase().includes(q)) return true;
    return false;
  });
}

export type MasterToggleState = "all" | "none" | "mixed";

export function masterToggleState(
  selectedCount: number,
  optionCount: number,
): MasterToggleState {
  if (optionCount === 0 || selectedCount === 0) return "none";
  if (selectedCount >= optionCount) return "all";
  return "mixed";
}

/**
 * Trigger summary text — exported so the same derivation runs in
 * tests as in the rendered component.
 *
 * For a closed list, the saturated ("every option checked") state
 * is "no filter" and renders `summaryAll`. For an open list, the
 * same state still actively constrains the query to the visible
 * subset and must keep reading as `summarySome(count)`.
 */
export function multiSelectSummary(
  selectedCount: number,
  optionCount: number,
  openList: boolean,
  labels: Pick<
    FilterMultiSelectLabels,
    "summaryNone" | "summaryAll" | "summarySome"
  >,
): string {
  if (selectedCount === 0) return labels.summaryNone;
  if (!openList && optionCount > 0 && selectedCount >= optionCount) {
    return labels.summaryAll;
  }
  return labels.summarySome(selectedCount);
}

export interface FilterMultiSelectLabels {
  /** Screen-reader description for the "master" toggle. */
  allToggle: string;
  searchPlaceholder: string;
  noOptionsMatch: string;
  /**
   * Trigger summaries. The drawer renders one of these beside the
   * field label:
   *   - `summaryNone` when nothing is checked
   *   - `summaryAll` when every option is checked on a closed list
   *     (shared "all = no filter" rule)
   *   - `summarySome(count)` otherwise, and also when an open-list
   *     field (see `openList`) has every visible option checked —
   *     the field is still actively filtering to the visible subset
   *     in that case, so it must not read as "no filter".
   */
  summaryNone: string;
  summaryAll: string;
  summarySome: (count: number) => string;
  /** Screen-reader wording for the disclosure affordance. */
  expand: string;
  collapse: string;
}

interface FilterMultiSelectProps<V extends string | number> {
  /** Stable id used to anchor the list panel to the trigger. */
  id: string;
  /** UI label shown above the trigger (e.g. "Threat Level"). */
  label: string;
  options: readonly FilterMultiSelectOption<V>[];
  selected: readonly V[];
  onChange: (next: V[]) => void;
  /** Show a search input above the option list. */
  searchable?: boolean;
  /**
   * When `true`, the rendered options are a seed subset of the real
   * domain (e.g. Threat Name before a live REview completion source
   * exists). In that case a saturated selection is NOT "no filter" —
   * the trigger summary must keep reading as an active selection
   * (`N selected`) rather than `All`, because the submitted filter
   * still constrains to the visible list. Matches the `openList`
   * semantics in `selectionForSubmission` / `buildMultiSelectChips`.
   * Defaults to `false` (closed list).
   */
  openList?: boolean;
  labels: FilterMultiSelectLabels;
}

/**
 * Shared categorical multi-select used by the Detection filter
 * drawer. Rendered as an inline disclosure (button + collapsible
 * panel) so the drawer's own scroll context handles long option
 * lists without a second floating surface.
 *
 * Accessibility notes:
 *   - Trigger is a `<button aria-expanded aria-controls>` paired
 *     with the panel's id, so screen readers announce the expanded
 *     state and the contained group.
 *   - Options are native `<label><Checkbox/></label>` pairs — no
 *     custom `role="option"` bookkeeping — so standard checkbox
 *     semantics, focus, and keyboard behavior all come for free.
 *   - The "master" toggle uses the checkbox's `indeterminate` state
 *     when some but not all options are checked, so a screen reader
 *     announces "mixed" correctly.
 */
export function FilterMultiSelect<V extends string | number>({
  id,
  label,
  options,
  selected,
  onChange,
  searchable = false,
  openList = false,
  labels,
}: FilterMultiSelectProps<V>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const fallbackId = useId();
  const baseId = id || fallbackId;
  const panelId = `${baseId}-panel`;
  const searchId = `${baseId}-search`;
  const allToggleId = `${baseId}-all`;

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggleState = masterToggleState(selectedSet.size, options.length);
  const allChecked = toggleState === "all";
  const someChecked = toggleState === "mixed";

  const filtered = useMemo(
    () => filterMultiSelectOptions(options, query),
    [options, query],
  );

  const summary = multiSelectSummary(
    selectedSet.size,
    options.length,
    openList,
    labels,
  );

  function toggleValue(value: V, checked: boolean) {
    if (checked) {
      if (selectedSet.has(value)) return;
      onChange([...selected, value]);
    } else {
      onChange(selected.filter((v) => v !== value));
    }
  }

  function toggleAll(next: boolean) {
    if (next) {
      onChange(options.map((o) => o.value));
    } else {
      onChange([]);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{label}</legend>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className="focus-visible:ring-ring hover:bg-muted flex items-center justify-between gap-2 rounded-md border border-[var(--sidebar-border)] bg-background px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-foreground font-medium">{label}</span>
          <span className="text-muted-foreground text-xs">{summary}</span>
        </span>
        <span className="sr-only">
          {open ? labels.collapse : labels.expand}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <fieldset
          id={panelId}
          aria-label={label}
          className="flex flex-col gap-2 rounded-md border border-[var(--sidebar-border)] bg-card p-3"
        >
          {searchable ? (
            <Input
              id={searchId}
              type="search"
              autoComplete="off"
              placeholder={labels.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={labels.searchPlaceholder}
              className="h-8"
            />
          ) : null}

          <div
            className={cn(
              "flex items-center gap-2 rounded px-1 py-1 text-sm",
              "hover:bg-muted",
            )}
          >
            <Checkbox
              id={allToggleId}
              checked={
                allChecked ? true : someChecked ? "indeterminate" : false
              }
              onCheckedChange={(state) => toggleAll(state === true)}
            />
            <label
              htmlFor={allToggleId}
              className="text-foreground cursor-pointer font-medium"
            >
              {labels.allToggle}
            </label>
          </div>

          <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="text-muted-foreground px-1 py-1 text-xs">
                {labels.noOptionsMatch}
              </li>
            ) : (
              filtered.map((option) => {
                const optionId = `${baseId}-opt-${String(option.value)}`;
                const checked = selectedSet.has(option.value);
                return (
                  <li
                    key={String(option.value)}
                    className={cn(
                      "flex items-center gap-2 rounded px-1 py-1 text-sm",
                      "hover:bg-muted",
                    )}
                  >
                    <Checkbox
                      id={optionId}
                      checked={checked}
                      onCheckedChange={(state) =>
                        toggleValue(option.value, state === true)
                      }
                    />
                    <label
                      htmlFor={optionId}
                      className="text-foreground cursor-pointer"
                    >
                      {option.label}
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        </fieldset>
      ) : null}
    </fieldset>
  );
}
