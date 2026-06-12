"use client";

import { useTimestampFormatter } from "@/components/timestamp";
import {
  describePivotStep,
  displayPivotValueLabel,
  type PivotDimensionId,
  type PivotOrigin,
  type PivotStep,
} from "@/lib/triage/pivot";
import { cn } from "@/lib/utils";

export interface TriagePivotBreadcrumbLabels {
  ariaLabel: string;
  rootCrumbPrefix: string;
  dimensionCrumbTemplate: string;
  /** Map of dimension id → human-readable label. */
  dimensions: Record<PivotDimensionId, string>;
  /**
   * Template for the Story-origin segment (#553). Receives one
   * placeholder, `{id}`, substituted with `customerId/storyId`.
   * Required only when a Story-origin trail can reach the breadcrumb
   * — callers that never emit a Story origin may omit it.
   */
  storyOriginTemplate?: string;
}

interface TriagePivotBreadcrumbProps {
  trail: readonly PivotStep[];
  origin?: PivotOrigin;
  /**
   * Called when the operator clicks a trail crumb. `index` is the
   * inclusive index of the surviving crumb after the click — same
   * contract as before #553. The Story-origin segment uses
   * {@link onSelectStoryOrigin} instead so the consumer can pop the
   * pivot back to the Story detail panel rather than truncating the
   * trail (the two reset semantics are different).
   */
  onSelect: (indexInclusive: number) => void;
  /**
   * Called when the operator clicks the Story-origin segment.
   * Required when `origin.kind === "story"`; ignored otherwise.
   */
  onSelectStoryOrigin?: () => void;
  labels: TriagePivotBreadcrumbLabels;
}

export function TriagePivotBreadcrumb({
  trail,
  origin = { kind: "asset" },
  onSelect,
  onSelectStoryOrigin,
  labels,
}: TriagePivotBreadcrumbProps) {
  const { formatCompact } = useTimestampFormatter();
  const isStoryOrigin = origin.kind === "story";
  if (!isStoryOrigin && trail.length === 0) return null;
  const lastTrailIndex = trail.length - 1;
  const trailHasDimensionCrumb = trail.some((s) => s.kind === "dimension");
  // When the origin is a Story, the Story-origin segment is the
  // "last" crumb iff no dimension steps are appended yet — at that
  // point the operator has not pivoted away from the Story root and
  // the segment renders non-interactive (current page) per the
  // standard breadcrumb pattern.
  const storyOriginIsCurrent = isStoryOrigin && !trailHasDimensionCrumb;
  return (
    <nav
      aria-label={labels.ariaLabel}
      className="flex flex-wrap items-center gap-1 text-sm"
    >
      <ol className="flex flex-wrap items-center gap-1">
        {isStoryOrigin && origin.kind === "story" ? (
          <li className="flex items-center gap-1">
            {storyOriginIsCurrent ? (
              <span
                aria-current="page"
                data-testid="triage-pivot-breadcrumb-story-origin"
                className="font-semibold text-foreground"
              >
                {storyOriginText(labels, origin.customerId, origin.storyId)}
              </span>
            ) : (
              <button
                type="button"
                data-testid="triage-pivot-breadcrumb-story-origin"
                onClick={() => onSelectStoryOrigin?.()}
                className={cn(
                  "rounded px-1 text-muted-foreground hover:text-foreground hover:underline",
                )}
              >
                {storyOriginText(labels, origin.customerId, origin.storyId)}
              </button>
            )}
          </li>
        ) : null}
        {trail.map((step, index) => {
          const isLastTrailCrumb = index === lastTrailIndex;
          const labelParts = describePivotStep(
            step,
            (id) => labels.dimensions[id],
          );
          // A `sameKindWithin15Min` step stores a machine-readable label
          // embedding a raw `toISOString()` instant; route the dimension
          // value through the central display helper (compact form) so the
          // crumb shows a localized time and never flashes raw UTC ISO
          // pre-mount — the same contract the chip/header/baseline surfaces
          // already use (Part 3 of #764).
          const valueLabel =
            step.kind === "dimension"
              ? displayPivotValueLabel(
                  step.dimension,
                  step.value,
                  formatCompact,
                )
              : labelParts.valueLabel;
          const text =
            step.kind === "asset"
              ? `${labels.rootCrumbPrefix} ${labelParts.valueLabel}`
              : labels.dimensionCrumbTemplate
                  .replace("{dimension}", labelParts.dimensionLabel)
                  .replace("{value}", valueLabel);
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb is positional and a duplicate step is appended-collapsed
              key={`${stepKey(step)}@${index}`}
              className="flex items-center gap-1"
            >
              {index > 0 || isStoryOrigin ? (
                <span aria-hidden className="text-muted-foreground">
                  ›
                </span>
              ) : null}
              {isLastTrailCrumb ? (
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

function storyOriginText(
  labels: TriagePivotBreadcrumbLabels,
  customerId: number,
  storyId: string,
): string {
  // The template lives in the locale bundle. Fall back to a stable
  // English-looking string if the caller forgot to supply one — the
  // breadcrumb still renders identifiably rather than crashing.
  const template = labels.storyOriginTemplate ?? "Story #{id}";
  return template.replace("{id}", `${customerId}/${storyId}`);
}

function stepKey(step: PivotStep): string {
  if (step.kind === "asset") {
    return `asset:${step.customerId}/${step.address}`;
  }
  return `dim:${step.dimension}:${step.value.key}`;
}
