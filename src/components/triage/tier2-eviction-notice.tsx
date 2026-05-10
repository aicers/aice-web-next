"use client";

import type { PivotDimensionId } from "@/lib/triage/pivot";
import type { Tier2EvictionEvent } from "@/lib/triage/tier2-cache";

export interface Tier2EvictionNoticeLabels {
  /** Template uses `{dimension}` and `{value}` placeholders. */
  template: string;
  dismiss: string;
  /** Map of dimension id → human-readable label (matches panel labels). */
  dimensions: Record<PivotDimensionId, string>;
}

interface Tier2EvictionNoticeProps {
  evictions: Tier2EvictionEvent[];
  onDismiss: (cacheKey: string) => void;
  labels: Tier2EvictionNoticeLabels;
}

/**
 * Non-blocking notice surfaced when the Tier 2 cache evicts a
 * dimension result to keep within its 100 MB byte cap (#453). Each
 * eviction shows once, names the dimension and value, and can be
 * dismissed by the operator.
 */
export function Tier2EvictionNotice({
  evictions,
  onDismiss,
  labels,
}: Tier2EvictionNoticeProps) {
  if (evictions.length === 0) return null;
  return (
    <ul className="space-y-1" role="status">
      {evictions.map((eviction) => {
        const dimensionLabel =
          labels.dimensions[eviction.dimensionId as PivotDimensionId] ??
          eviction.dimensionId;
        const message = labels.template
          .replace("{dimension}", dimensionLabel)
          .replace("{value}", eviction.valueKey);
        return (
          <li
            key={eviction.cacheKey}
            className="flex items-start justify-between gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <span>{message}</span>
            <button
              type="button"
              onClick={() => onDismiss(eviction.cacheKey)}
              className="font-medium underline hover:no-underline"
            >
              {labels.dismiss}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
