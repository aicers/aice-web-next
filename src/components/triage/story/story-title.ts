/**
 * Auto-generate a Story card title from the `summary_payload` and the
 * row's primary asset. Pure function so it can be unit-tested without
 * a renderer harness.
 *
 *   `<primary_asset> · <duration> · <category-top-3>`
 *
 * Examples:
 *   "192.168.1.20 · 12 min · COMMAND_AND_CONTROL, EXFILTRATION, IMPACT"
 *   "192.168.1.20 · < 1 min · DEFENSE_EVASION"
 *
 * `manualTitle` (analyst-curated only) takes precedence over the auto
 * format when present.
 *
 * Duration text is rendered through the locale-supplied `duration`
 * labels — the Korean locale, for instance, replaces "min" with "분".
 */

import type { StorySummaryPayload } from "@/lib/triage/story/types";

export interface StoryDurationLabels {
  /** Shown when the Story spans less than one minute. */
  lessThanMinute: string;
  /** "{n} min" — minutes-only duration. `{n}` is the count. */
  minutesTemplate: string;
  /** "{n} h" — hours-only duration. */
  hoursTemplate: string;
  /** "{h} h {m} min" — mixed hours/minutes duration. */
  hoursMinutesTemplate: string;
}

export function autoStoryTitle(
  primaryAsset: string | null,
  summary: StorySummaryPayload,
  durationLabels: StoryDurationLabels,
): string {
  const assetPart = primaryAsset ?? "—";
  const durationPart = formatDuration(summary.durationMs, durationLabels);
  const categories = topCategories(summary.categoryHistogram, 3);
  const categoryPart = categories.length === 0 ? "—" : categories.join(", ");
  return `${assetPart} · ${durationPart} · ${categoryPart}`;
}

export function renderStoryTitle(
  primaryAsset: string | null,
  summary: StorySummaryPayload,
  durationLabels: StoryDurationLabels,
): string {
  if (summary.manualTitle !== undefined && summary.manualTitle.length > 0) {
    return summary.manualTitle;
  }
  return autoStoryTitle(primaryAsset, summary, durationLabels);
}

export function topCategories(
  histogram: Record<string, number>,
  topN: number,
): string[] {
  return Object.entries(histogram)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, topN)
    .map(([cat]) => cat);
}

const MIN_MS = 60 * 1000;

function formatDuration(
  durationMs: number,
  labels: StoryDurationLabels,
): string {
  if (durationMs < MIN_MS) return labels.lessThanMinute;
  // Round to a single total-minutes value first, then split into
  // hours / leftover minutes. Splitting before rounding allowed the
  // minute component to round up to 60 (e.g. 1h59m40s → "1 h 60 min"
  // / "1시간 60분") instead of normalizing to the next hour.
  const totalMinutes = Math.round(durationMs / MIN_MS);
  if (totalMinutes < 60) {
    return labels.minutesTemplate.replace("{n}", String(totalMinutes));
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (mins === 0) return labels.hoursTemplate.replace("{n}", String(hours));
  return labels.hoursMinutesTemplate
    .replace("{h}", String(hours))
    .replace("{m}", String(mins));
}
