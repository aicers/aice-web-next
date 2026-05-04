/**
 * Helpers for the presets-dropdown "Save current filter…" entry
 * (issue #428).
 *
 * The header dropdown's save action persists the **committed** filter
 * — whatever the URL `?f=` blob already encodes — verbatim. It is
 * intentionally a different code path from the drawer's "Save this
 * filter" footer, which runs the drawer draft through
 * `buildAppliedFilter` and the same Apply-side customer / sensor
 * "live" gates that protect against persisting fields the drawer
 * had disabled.
 *
 * The committed filter is already the canonical payload running the
 * active query, not a draft that might hold values the drawer
 * disabled, so re-stripping fields on save here would persist a
 * different filter than the one the operator just triaged. Keeping
 * the contract in a pure helper lets the unit test pin the gating
 * decision: a regression that swaps in `buildAppliedFilter` (or any
 * other recomputation) fails the assertion that the returned filter
 * is referentially identical to the input.
 */

import type { Filter } from "./filter";
import {
  type SummarizeFilterContext,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "./filter-summary";
import { autoTabName } from "./tabs";

export interface BuildSaveCurrentFilterDialogStateArgs {
  committedFilter: Filter;
  committedPeriod: SummarizeFilterContext["period"];
  summarizeLabels: SummarizeFilterLabels;
  sensorOptions: SummarizeFilterContext["sensorOptions"];
  customerSummaryOptions: SummarizeFilterContext["customerOptions"];
  categoricalOptions: SummarizeFilterContext["categoricalOptions"];
  /**
   * Fallback name when the committed filter produces no display
   * chips (e.g. the default-window filter on a freshly-opened tab).
   * Mirrors the period-label fallback the drawer save path already
   * uses via `autoTabName`.
   */
  defaultPeriodLabel: string;
}

export interface SaveCurrentFilterDialogState {
  /** The exact filter that should be persisted — the committed value. */
  filter: Filter;
  /** Auto-generated dialog default name, derived from chip text. */
  defaultName: string;
}

export function buildSaveCurrentFilterDialogState(
  args: BuildSaveCurrentFilterDialogStateArgs,
): SaveCurrentFilterDialogState {
  const chips = summarizeFilter(args.committedFilter, args.summarizeLabels, {
    period: args.committedPeriod,
    sensorOptions: args.sensorOptions,
    customerOptions: args.customerSummaryOptions,
    categoricalOptions: args.categoricalOptions,
  });
  const defaultName = autoTabName(
    chips.map((chip) => chip.value),
    args.defaultPeriodLabel,
  );
  return { filter: args.committedFilter, defaultName };
}
