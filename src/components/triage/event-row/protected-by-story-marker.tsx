"use client";

import type { ReactNode } from "react";

/**
 * Story-protected event marker (#471 §3). Rendered on per-event row
 * surfaces — Asset detail event rows, Pivot related-events panel, and
 * Story-detail member rows — when the row was kept on Story
 * membership rather than score alone (i.e. `baseline_score <
 * slider_cutoff` AND the row is a Story member).
 *
 * Asset aggregate rows do NOT show the marker — the marker is
 * per-event, and an aggregate row hides individual scores. The
 * `protectedByStory` slot on those tables stays `undefined`.
 *
 * The four-condition appearance rule from #471 is collapsed at the
 * data source: `selectAssetDetailEventsBatch` projects
 * `protected_by_story = (baseline_score < $5 AND in_story)`. At the
 * "All" stop the cutoff is `0`, so the expression is always `false`
 * by construction and the marker never shows.
 */
export interface ProtectedByStoryMarkerLabels {
  /**
   * Aria-label / hover-tooltip template. `{score}` is the read-time
   * `baseline_score` of the row.
   */
  template: string;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

export function renderProtectedByStoryMarker(
  labels: ProtectedByStoryMarkerLabels,
): (props: { score: number }) => ReactNode {
  return ({ score }) => {
    const label = labels.template.replace(
      "{score}",
      SCORE_FORMAT.format(score),
    );
    return (
      <span
        role="img"
        data-testid="triage-event-protected-marker"
        aria-label={label}
        title={label}
        className="mr-1 inline-block align-middle text-amber-600 dark:text-amber-300"
      >
        {"\u{1F517}"}
      </span>
    );
  };
}
