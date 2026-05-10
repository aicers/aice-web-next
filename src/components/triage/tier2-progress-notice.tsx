"use client";

import type { PivotDimensionId } from "@/lib/triage/pivot";
import type { Tier2FetchInFlight } from "@/lib/triage/use-tier2-pivot";

export interface Tier2ProgressNoticeLabels {
  /** Fallback label when the per-dimension template is absent. */
  progress: string;
  /** Template uses `{dimension}` and `{value}` placeholders. */
  progressTemplate: string;
  /** Map of dimension id → human-readable label (matches panel labels). */
  dimensions: Record<PivotDimensionId, string>;
}

interface Tier2ProgressNoticeProps {
  inFlight: Tier2FetchInFlight[];
  labels: Tier2ProgressNoticeLabels;
}

/**
 * Non-blocking progress indicator surfaced after the first page of a
 * Tier 2 fetch fires (#453 acceptance: "the fetch hook surfaces a
 * progress indicator after the first page so the analyst sees
 * motion"). Each in-flight dimension fetch shows one row; the row
 * disappears when the fetch resolves.
 */
export function Tier2ProgressNotice({
  inFlight,
  labels,
}: Tier2ProgressNoticeProps) {
  if (inFlight.length === 0) return null;
  return (
    <ul className="space-y-1" aria-live="polite" role="status">
      {inFlight.map((entry) => {
        const dimensionLabel =
          labels.dimensions[entry.dimension as PivotDimensionId] ??
          entry.dimension;
        const message = labels.progressTemplate
          ? labels.progressTemplate
              .replace("{dimension}", dimensionLabel)
              .replace("{value}", entry.valueKey)
          : labels.progress;
        return (
          <li
            key={`${entry.dimension}|${entry.valueKey}`}
            className="rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-500/40 dark:bg-sky-950/40 dark:text-sky-200"
          >
            {message}
          </li>
        );
      })}
    </ul>
  );
}
