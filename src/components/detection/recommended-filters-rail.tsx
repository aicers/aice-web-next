"use client";

import { Star } from "lucide-react";

import type { RecommendedPreset } from "@/lib/detection/recommended-filters";

export interface RecommendedFiltersRailLabels {
  /** Section heading. */
  title: string;
  /** Sub-line shown below the heading when no presets are configured. */
  emptyHint: string;
  /** Per-row localized name resolver. Returns the display label for a preset. */
  presetName: (preset: RecommendedPreset) => string;
}

export interface RecommendedFiltersRailProps {
  presets: readonly RecommendedPreset[];
  labels: RecommendedFiltersRailLabels;
  /**
   * Activation hook — fires the same "Load in new tab" contract the
   * Saved Filters rail uses (Phase Detection-15). The wrapper builds
   * the concrete {@link Filter} from the preset and creates a tab
   * pre-seeded with the result so the new tab lands populated.
   */
  onActivate: (preset: RecommendedPreset) => void;
}

/**
 * Slim left-rail section that exposes the system-provided filter
 * presets (Phase Detection-16). Read-only in v1: each row is a
 * one-click activation, no rename / delete affordances. Activating a
 * preset opens it in a new tab via the wrapper-provided `onActivate`
 * handler — same UX as a Saved Filter row's default click.
 */
export function RecommendedFiltersRail({
  presets,
  labels,
  onActivate,
}: RecommendedFiltersRailProps) {
  return (
    <section
      aria-label={labels.title}
      className="flex flex-col gap-2"
      data-slot="recommended-filters-rail"
    >
      <div className="text-muted-foreground flex items-center justify-center desktop:justify-start desktop:gap-2">
        <span aria-hidden="true">
          <Star className="size-4" />
        </span>
        <span className="sr-only text-xs font-medium uppercase tracking-wider desktop:not-sr-only desktop:inline">
          {labels.title}
        </span>
      </div>

      {presets.length === 0 ? (
        <p className="text-muted-foreground sr-only text-xs desktop:not-sr-only desktop:block">
          {labels.emptyHint}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {presets.map((preset) => {
            const name = labels.presetName(preset);
            return (
              <li key={preset.id}>
                <button
                  type="button"
                  className="text-foreground hover:bg-muted focus-visible:ring-ring w-full truncate rounded-md px-2 py-1.5 text-left text-xs focus-visible:ring-2 focus-visible:outline-none sr-only desktop:not-sr-only desktop:inline-block"
                  onClick={() => onActivate(preset)}
                  title={name}
                  data-preset-id={preset.id}
                >
                  {name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
