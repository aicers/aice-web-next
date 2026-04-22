"use client";

import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Filter } from "@/lib/detection/filter";
import { matchesPeriodKey, type PeriodKey } from "@/lib/detection/period";
import {
  type ChipFieldId,
  type ChipSpec,
  removeChipFromFilter,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/summarize-filter";
import type { ThreatLevel } from "@/lib/detection/types";
import { cn } from "@/lib/utils";

export interface ActiveFilterChipBarLabels extends SummarizeFilterLabels {
  /** `Remove {label}` — accessible name for the per-chip × button. */
  remove: string;
  /** Empty-state text rendered when the chip list is empty. */
  empty: string;
  /** Accessible name for the toolbar region itself. */
  region: string;
  /** `N values` summary text at the top of an aggregate popover. */
  aggregateCount: string;
  /**
   * Explanatory text shown inside the value popover for chips whose
   * field the drawer does not yet expose a control for. Phase
   * Detection-9 only ships period / time-range controls; chips
   * arriving via pivot URLs or saved state (Source, Destination,
   * Kind, Hostname, …) still need an "activate the body to see /
   * remove this field" path, so we render a value popover here until
   * later phases add the matching drawer controls. At that point the
   * field moves into `DRAWER_SUPPORTED_FIELDS` and the body opens the
   * drawer focused on it instead.
   */
  valuePopoverHint: string;
  /** Button label for removing the field from the value popover. */
  valuePopoverRemove: string;
}

/**
 * Fields the Phase Detection-9 drawer actually exposes controls for.
 * Non-aggregate chip bodies for fields in this set open the drawer
 * via `onChipFocus`; fields outside it open a value popover instead
 * (a drawer with no matching control would be a dead-end per the
 * Round 9 / Round 10 review feedback). Later phases will expand the
 * drawer and grow this set — the forward-compat intent is already
 * encoded in `onChipFocus`, which receives the `ChipSpec` so the
 * drawer can focus the matching field once the control lands.
 */
const DRAWER_SUPPORTED_FIELDS: ReadonlySet<ChipFieldId> = new Set<ChipFieldId>([
  "period",
  "range",
]);

interface ActiveFilterChipBarProps {
  filter: Filter;
  labels: ActiveFilterChipBarLabels;
  /**
   * The period chip the committed filter was produced from, if any.
   * When provided, the chip bar uses it verbatim instead of trying
   * to reverse-engineer it from `start`/`end`. That reverse lookup
   * compares against `computePeriodRange(key, new Date())`, so the
   * client's clock drifting past the server's render time made the
   * comparison spuriously fail after page load.
   */
  period?: PeriodKey | null;
  /** Called with the filter that should replace the active one. */
  onChange: (next: Filter) => void;
  /** Called when a chip body (label) is activated; opens the drawer. */
  onChipFocus?: (chip: ChipSpec) => void;
}

/**
 * The persistent chip bar above the result list. Reflects the
 * currently committed `Filter` via `summarizeFilter()` and emits a
 * new `Filter` when an `×` is pressed (self-contained commit per
 * the umbrella spec — no draft staging for single-field removal).
 *
 * Chip-body activation has three variants:
 * - Aggregate chips render their own inline popover in `ChipPill`
 *   that lists the underlying values.
 * - Non-aggregate chips whose field is in `DRAWER_SUPPORTED_FIELDS`
 *   call `onChipFocus`, which the shell wires to the drawer (with
 *   focus on the matching control in a later phase once those
 *   controls land).
 * - Non-aggregate chips whose field is NOT in that set render a
 *   value popover via `ChipPill` — see the `DRAWER_SUPPORTED_FIELDS`
 *   comment for why.
 */
export function ActiveFilterChipBar({
  filter,
  labels,
  period,
  onChange,
  onChipFocus,
}: ActiveFilterChipBarProps) {
  const chips = summarizeFilter(filter, labels, {
    matchedPeriod: period ?? derivePeriod(filter),
  });

  return (
    <div
      role="toolbar"
      aria-label={labels.region}
      className={cn(
        "flex min-h-9 flex-1 flex-wrap items-center gap-1.5 rounded-md border border-dashed border-[var(--sidebar-border)] px-2 py-1",
        chips.length === 0 && "text-muted-foreground text-xs",
      )}
    >
      {chips.length === 0 ? (
        <span className="px-1">{labels.empty}</span>
      ) : (
        chips.map((chip) => (
          <ChipPill
            key={chip.id}
            chip={chip}
            removeLabel={labels.remove.replace("{label}", chip.label)}
            aggregateCountTemplate={labels.aggregateCount}
            valuePopoverHint={labels.valuePopoverHint}
            valuePopoverRemove={labels.valuePopoverRemove}
            onActivate={
              chip.kind !== "aggregate" &&
              DRAWER_SUPPORTED_FIELDS.has(chip.field)
                ? () => onChipFocus?.(chip)
                : undefined
            }
            onRemove={() => onChange(removeChipFromFilter(filter, chip))}
          />
        ))
      )}
    </div>
  );
}

function ChipPill({
  chip,
  removeLabel,
  aggregateCountTemplate,
  valuePopoverHint,
  valuePopoverRemove,
  onActivate,
  onRemove,
}: {
  chip: ChipSpec;
  removeLabel: string;
  aggregateCountTemplate: string;
  valuePopoverHint: string;
  valuePopoverRemove: string;
  /**
   * Invoked when the chip body (label + value) is activated for a
   * drawer-supported field (period / range in this phase). For other
   * non-aggregate chips `onActivate` is `undefined` and the body
   * instead renders an inline value popover — see the parent-level
   * `DRAWER_SUPPORTED_FIELDS` comment. Aggregate chips ignore this
   * prop entirely and render their own popover.
   */
  onActivate: (() => void) | undefined;
  onRemove: () => void;
}) {
  const body = (
    <span className="focus-visible:ring-ring flex items-center gap-1 rounded px-1 text-xs focus-visible:ring-2 focus-visible:outline-none">
      <span className="text-muted-foreground">{chip.label}</span>
      <span className="text-foreground font-medium">{chip.value}</span>
    </span>
  );
  const removeButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={removeLabel}
      onClick={onRemove}
      className="text-muted-foreground hover:text-foreground h-5 px-1"
    >
      <X className="size-3" aria-hidden="true" />
    </Button>
  );

  if (chip.kind === "aggregate" && chip.values && chip.values.length > 0) {
    const count = chip.values.length;
    return (
      <Badge
        variant="secondary"
        className="flex h-7 items-center gap-1 px-1 font-normal"
      >
        <Popover>
          <PopoverTrigger asChild>
            <button type="button">{body}</button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <p className="text-foreground text-xs font-medium">{chip.label}</p>
            <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
              {aggregateCountTemplate.replace("{count}", String(count))}
            </p>
            <ul className="mt-2 max-h-60 overflow-y-auto text-xs">
              {chip.values.map((value) => (
                <li
                  key={value}
                  className="border-t border-[var(--sidebar-border)] py-1 first:border-t-0"
                >
                  {value}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
        {removeButton}
      </Badge>
    );
  }

  if (onActivate) {
    return (
      <Badge
        variant="secondary"
        className="flex h-7 items-center gap-1 px-1 font-normal"
      >
        <button type="button" onClick={onActivate}>
          {body}
        </button>
        {removeButton}
      </Badge>
    );
  }

  // Non-aggregate chip whose field has no drawer control yet: render
  // a value popover so the chip body still has a meaningful action.
  // The popover shows the committed value and offers an in-popover
  // Remove button in addition to the chip's `×` so the operator can
  // confirm and clear the field from the same surface that opened.
  return (
    <Badge
      variant="secondary"
      className="flex h-7 items-center gap-1 px-1 font-normal"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button type="button">{body}</button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          <p className="text-foreground text-xs font-medium">{chip.label}</p>
          <p className="text-foreground mt-1 break-words text-xs">
            {chip.value}
          </p>
          <p className="text-muted-foreground mt-2 text-[10px] leading-tight">
            {valuePopoverHint}
          </p>
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRemove}
              className="h-7 px-2 text-xs"
            >
              {valuePopoverRemove}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {removeButton}
    </Badge>
  );
}

function derivePeriod(filter: Filter): PeriodKey | null {
  if (filter.mode !== "structured") return null;
  const { start, end } = filter.input;
  if (!start || !end) return null;
  return matchesPeriodKey({ start, end });
}

/**
 * Build a `SummarizeFilterLabels` instance from a flat translation
 * map. Exposed so the page-level loader can hand `t(...)` outputs
 * directly into the chip bar without reproducing the formatter
 * wiring everywhere.
 */
export function buildSummarizeLabels(input: {
  period: string;
  range: string;
  source: string;
  destination: string;
  confidenceMin: string;
  confidenceMax: string;
  customers: string;
  endpoints: string;
  directions: string;
  keywords: string;
  networkTags: string;
  sensors: string;
  os: string;
  devices: string;
  hostnames: string;
  userIds: string;
  userNames: string;
  userDepartments: string;
  countries: string;
  categories: string;
  levels: string;
  kinds: string;
  learningMethods: string;
  triagePolicies: string;
  remove: string;
  aggregateOne: string;
  aggregateOther: string;
  aggregateCount: string;
  empty: string;
  region: string;
  levelHigh: string;
  levelMedium: string;
  levelLow: string;
  rangeFormat: string;
  periodOptions: Record<string, string>;
  valuePopoverHint: string;
  valuePopoverRemove: string;
}): ActiveFilterChipBarLabels {
  const levelMap: Record<ThreatLevel, string> = {
    HIGH: input.levelHigh,
    MEDIUM: input.levelMedium,
    LOW: input.levelLow,
  };
  return {
    ...input,
    levelName: (level) => levelMap[level],
    aggregate: (count) =>
      (count === 1 ? input.aggregateOne : input.aggregateOther).replace(
        "{count}",
        String(count),
      ),
    rangeFormatter: (start, end) =>
      input.rangeFormat
        .replace("{start}", formatRange(start))
        .replace("{end}", formatRange(end)),
  };
}

function formatRange(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
