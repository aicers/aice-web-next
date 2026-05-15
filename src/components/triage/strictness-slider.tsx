"use client";

/**
 * Strictness slider (#471). Five discrete stops, ordered loose →
 * strict in the UI. Rendered as a radiogroup of stop chips backed by
 * native `<input type="radio">` so the slider is keyboard-navigable
 * (arrow keys move between stops, Space selects the focused stop)
 * and screen-readers announce it as a single named radiogroup.
 *
 * Persistence and re-fetch are owned by the parent
 * (`triage-shell.tsx`) — this component is a pure controlled-input
 * that surfaces the change via `onChange`. See the strictness RFC
 * §7 for the persistence contract.
 */

import {
  STRICTNESS_STOPS,
  type StrictnessStopId,
} from "@/lib/triage/strictness/stops";

export interface TriageStrictnessSliderLabels {
  legend: string;
  /** Hover tooltip / aria-description for the slider as a whole. */
  hint: string;
  stops: Record<StrictnessStopId, string>;
  /** "All" stop tooltip explaining cadence-threshold floor. */
  allStopHint: string;
}

interface TriageStrictnessSliderProps {
  stop: StrictnessStopId;
  onChange: (next: StrictnessStopId) => void;
  pending?: boolean;
  labels: TriageStrictnessSliderLabels;
}

export function TriageStrictnessSlider({
  stop,
  onChange,
  pending = false,
  labels,
}: TriageStrictnessSliderProps) {
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby="triage-strictness-hint"
      aria-busy={pending || undefined}
    >
      <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {labels.legend}
      </legend>
      <div className="flex items-center gap-1 rounded-md border border-input bg-background p-1 shadow-xs">
        {STRICTNESS_STOPS.map((s) => {
          const selected = s.id === stop;
          const label = labels.stops[s.id];
          const title = s.id === "all" ? labels.allStopHint : undefined;
          return (
            <label
              key={s.id}
              title={title}
              className={
                selected
                  ? "cursor-pointer rounded-sm bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors"
                  : "cursor-pointer rounded-sm bg-transparent px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              }
            >
              <input
                type="radio"
                name="triage-strictness"
                value={s.id}
                checked={selected}
                disabled={pending && !selected}
                onChange={() => {
                  if (selected) return;
                  onChange(s.id);
                }}
                className="sr-only"
              />
              {label}
            </label>
          );
        })}
      </div>
      <span
        id="triage-strictness-hint"
        className="text-xs text-muted-foreground"
      >
        {labels.hint}
      </span>
    </fieldset>
  );
}
