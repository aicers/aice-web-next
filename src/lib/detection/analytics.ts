/**
 * Top N + Time Series analytics helpers (Phase Detection-14).
 *
 * The Detection page exposes a collapsible analytics strip below the
 * result list. Each tab's strip stays in lockstep with the active
 * filter via the same `Filter` value the result list runs against.
 * This module owns:
 *
 * - The dimension vocabulary the strip's selector exposes (`SRC IP`,
 *   `DST IP`, `Country`, `Threat Category`, `Threat Level`,
 *   `Threat Name`).
 * - The bucket-size heuristic that maps a filter's time range onto
 *   the integer `period` REview's `eventFrequencySeries` query
 *   takes — REview returns one count per bucket so the heuristic
 *   has to pick a period that yields a chart with enough resolution
 *   to be useful but few enough buckets that the line renders
 *   cleanly at typical strip widths.
 *
 * Pure / serializable so server actions and client components can
 * share the same vocabulary without duplicating literals.
 */

import type { EventListFilterInput } from "./types";

export const ANALYTICS_DIMENSIONS = [
  "srcIp",
  "dstIp",
  "country",
  "category",
  "level",
  "kind",
] as const;

export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

export const DEFAULT_ANALYTICS_DIMENSION: AnalyticsDimension = "srcIp";

export const ANALYTICS_TOP_N_OPTIONS = [5, 10, 20] as const;

export type AnalyticsTopN = (typeof ANALYTICS_TOP_N_OPTIONS)[number];

export const DEFAULT_ANALYTICS_TOP_N: AnalyticsTopN = 10;

/** Reviewer Round 1 (P2 server-side trust): server-action guards. */
export function isAnalyticsDimension(
  value: unknown,
): value is AnalyticsDimension {
  return (
    typeof value === "string" &&
    (ANALYTICS_DIMENSIONS as readonly string[]).includes(value)
  );
}

export function isAnalyticsTopN(value: unknown): value is AnalyticsTopN {
  return (
    typeof value === "number" &&
    (ANALYTICS_TOP_N_OPTIONS as readonly number[]).includes(value)
  );
}

/**
 * Tiered map from "total range in seconds" to "bucket size in
 * seconds" for `eventFrequencySeries`. Tuned so each tier yields
 * roughly 30–150 buckets, matching the issue's rule-of-thumb hints
 * (1h → 60s, 1d → 600s, 1m → 6h ≈ 21600s).
 *
 * The tuple is `[upper-bound seconds, period seconds]`. The first
 * tier whose `upper` strictly exceeds the queried range wins; ranges
 * larger than every tier fall through to {@link FALLBACK_PERIOD_SECONDS}
 * so a multi-year filter still produces a sensibly-coarse series
 * instead of a forty-thousand-bucket vector REview would have to ship
 * over the wire.
 */
const PERIOD_TIERS: ReadonlyArray<readonly [number, number]> = [
  [3 * 3600, 60], // ≤ 3h → 1m buckets
  [24 * 3600, 600], // ≤ 1d → 10m buckets
  [7 * 24 * 3600, 3600], // ≤ 1w → 1h buckets
  [31 * 24 * 3600, 6 * 3600], // ≤ ~1m → 6h buckets
  [93 * 24 * 3600, 24 * 3600], // ≤ ~3m → 1d buckets
  [366 * 24 * 3600, 7 * 24 * 3600], // ≤ ~1y → 1w buckets
];

const FALLBACK_PERIOD_SECONDS = 30 * 24 * 3600;

/** Hard floor: REview rejects period < 1s, and a 1s bucket would dwarf the chart. */
const MIN_PERIOD_SECONDS = 60;

/**
 * Pick an `eventFrequencySeries` period for the filter's time range.
 *
 * The filter's `start`/`end` are ISO strings; missing or malformed
 * values fall back to the smallest tier so an unbounded filter still
 * gets a usable series rather than no series at all.
 */
export function computeFrequencyPeriodSeconds(
  input: Pick<EventListFilterInput, "start" | "end">,
): number {
  const span = filterTimeRangeSeconds(input);
  if (span === null) return MIN_PERIOD_SECONDS;
  for (const [upper, period] of PERIOD_TIERS) {
    if (span <= upper) return period;
  }
  return FALLBACK_PERIOD_SECONDS;
}

/**
 * Total time-range span (seconds) implied by a filter input, or
 * `null` if either bound is missing / unparseable / inverted.
 */
export function filterTimeRangeSeconds(
  input: Pick<EventListFilterInput, "start" | "end">,
): number | null {
  if (typeof input.start !== "string" || typeof input.end !== "string") {
    return null;
  }
  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;
  return Math.floor((endMs - startMs) / 1000);
}
