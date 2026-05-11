"use client";

import {
  describePivotStep,
  type PivotDimensionId,
  type PivotStep,
} from "@/lib/triage/pivot";
import { cn } from "@/lib/utils";

export interface TriagePivotBreadcrumbLabels {
  ariaLabel: string;
  rootCrumbPrefix: string;
  dimensionCrumbTemplate: string;
  /** Map of dimension id → human-readable label. */
  dimensions: Record<PivotDimensionId, string>;
}

interface TriagePivotBreadcrumbProps {
  trail: readonly PivotStep[];
  onSelect: (indexInclusive: number) => void;
  labels: TriagePivotBreadcrumbLabels;
}

export function TriagePivotBreadcrumb({
  trail,
  onSelect,
  labels,
}: TriagePivotBreadcrumbProps) {
  if (trail.length === 0) return null;
  const lastIndex = trail.length - 1;
  return (
    <nav
      aria-label={labels.ariaLabel}
      className="flex flex-wrap items-center gap-1 text-sm"
    >
      <ol className="flex flex-wrap items-center gap-1">
        {trail.map((step, index) => {
          const isLast = index === lastIndex;
          const labelParts = describePivotStep(
            step,
            (id) => labels.dimensions[id],
          );
          const text =
            step.kind === "asset"
              ? `${labels.rootCrumbPrefix} ${labelParts.valueLabel}`
              : labels.dimensionCrumbTemplate
                  .replace("{dimension}", labelParts.dimensionLabel)
                  .replace("{value}", labelParts.valueLabel);
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb is positional and a duplicate step is appended-collapsed
              key={`${stepKey(step)}@${index}`}
              className="flex items-center gap-1"
            >
              {index > 0 ? (
                <span aria-hidden className="text-muted-foreground">
                  ›
                </span>
              ) : null}
              {isLast ? (
                <span
                  aria-current="page"
                  className="font-semibold text-foreground"
                >
                  {text}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(index)}
                  className={cn(
                    "rounded px-1 text-muted-foreground hover:text-foreground hover:underline",
                  )}
                >
                  {text}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function stepKey(step: PivotStep): string {
  if (step.kind === "asset") {
    return `asset:${step.customerId}/${step.address}`;
  }
  return `dim:${step.dimension}:${step.value.key}`;
}
