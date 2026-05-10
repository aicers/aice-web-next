"use client";

import { cn } from "@/lib/utils";

export interface WeakSignalBadgeLabels {
  badge: string;
  hint: string;
}

interface WeakSignalBadgeProps {
  className?: string;
  labels: WeakSignalBadgeLabels;
}

/**
 * "Weak" affordance applied to Tier 2 fetch rows that are not also
 * present in the Tier 1 corpus (per the dedupe key in
 * `tier2-cache.ts`). Per #453 the row itself renders with reduced
 * opacity (≈0.6) and this badge sits next to the kind cell so the
 * provenance is immediately visible.
 */
export function WeakSignalBadge({ className, labels }: WeakSignalBadgeProps) {
  return (
    <span
      title={labels.hint}
      className={cn(
        "ml-1 inline-flex items-center rounded border border-amber-300/60 bg-amber-50 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
    >
      {labels.badge}
    </span>
  );
}

/** Style helper — apply to a Tier 2-only row to dim it relative to corpus rows. */
export const WEAK_SIGNAL_ROW_CLASS = "opacity-60";
