"use client";

import type { PivotDimensionId } from "@/lib/triage/pivot";
import type { Tier2FetchError } from "@/lib/triage/use-tier2-pivot";

export interface Tier2ErrorNoticeLabels {
  /** Template uses `{dimension}`, `{value}`, and `{message}` placeholders. */
  template: string;
  dismiss: string;
  /** Fallback when REview returned no message. */
  fallbackMessage: string;
  /** Map of dimension id → human-readable label (matches panel labels). */
  dimensions: Record<PivotDimensionId, string>;
}

interface Tier2ErrorNoticeProps {
  errors: Tier2FetchError[];
  onDismiss: (
    dimension: Tier2FetchError["dimension"],
    valueKey: string,
    customerId: number,
  ) => void;
  labels: Tier2ErrorNoticeLabels;
}

/**
 * Surfaces a Tier 2 fetch failure as a dismissible notice. Without
 * this surface, an error reply from REview leaves the panel stuck
 * with a "loading" pivot row that never resolves — the operator has
 * no signal that the click failed and no way to retry.
 */
export function Tier2ErrorNotice({
  errors,
  onDismiss,
  labels,
}: Tier2ErrorNoticeProps) {
  if (errors.length === 0) return null;
  return (
    <ul className="space-y-1" role="alert">
      {errors.map((err) => {
        const dimensionLabel =
          labels.dimensions[err.dimension as PivotDimensionId] ?? err.dimension;
        const message = labels.template
          .replace("{dimension}", dimensionLabel)
          .replace("{value}", err.valueKey)
          .replace(
            "{message}",
            err.message.length > 0 ? err.message : labels.fallbackMessage,
          );
        return (
          <li
            key={`${err.dimension}|${err.valueKey}|${err.customerId}`}
            className="flex items-start justify-between gap-2 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <span>{message}</span>
            <button
              type="button"
              onClick={() =>
                onDismiss(err.dimension, err.valueKey, err.customerId)
              }
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
