"use client";

import { useTranslations } from "next-intl";

import { EVENT_PERIOD_KEYS, type EventPeriodKey } from "@/lib/event";
import { cn } from "@/lib/utils";

/**
 * Period quick-select pills shared by all three Event filter forms.
 *
 * Visually identical to the Detection drawer's period fieldset (see
 * `filter-drawer.tsx`'s `filter-section-period`): rounded-full bordered
 * pills whose selected state is carried by `aria-pressed` and the
 * `bg-primary`/`text-primary-foreground` treatment.
 *
 * The highlighted pill is driven by the explicit `selected` field, never
 * by re-matching a range against a fresh `now` — the stored `start`/`end`
 * were computed against the `now` at click time, so a later
 * `matchesPeriodKey(range, new Date())` would drift by the elapsed
 * milliseconds and fail to re-light the just-clicked pill. Picking a pill
 * raises `onSelect`; the parent fills the explicit range and records the
 * key. Editing `start`/`end` by hand clears the key in the parent.
 */
export function EventPeriodPills({
  selected,
  onSelect,
}: {
  selected: EventPeriodKey | null;
  onSelect: (key: EventPeriodKey) => void;
}) {
  const tf = useTranslations("event.filters");
  const tp = useTranslations("event.periods");

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-foreground text-sm font-medium">
        {tf("periodLabel")}
      </legend>
      <div className="flex flex-wrap gap-2">
        {EVENT_PERIOD_KEYS.map((key) => {
          const isSelected = selected === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(key)}
              className={cn(
                "focus-visible:ring-ring rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none",
                isSelected
                  ? "bg-primary text-primary-foreground border-transparent"
                  : "bg-background text-foreground hover:bg-muted border-[var(--sidebar-border)]",
              )}
            >
              {tp(key)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
