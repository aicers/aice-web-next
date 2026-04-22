/**
 * Period quick-select helpers for the Detection filter drawer.
 *
 * A "period" is a named relative window ending at "now" — e.g.
 * `1h` is the last hour, `3y` is the last three years. The drawer
 * exposes these as chips; picking one fills the explicit start/end
 * range. Editing the range clears the selection. Start/end values
 * are always carried as ISO-8601 UTC strings in the filter so they
 * survive serialization over server actions.
 */

export const PERIOD_KEYS = [
  "1h",
  "12h",
  "1d",
  "1w",
  "1m",
  "3m",
  "6m",
  "1y",
  "3y",
] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const DEFAULT_PERIOD_KEY: PeriodKey = "1h";

/**
 * Window described by a period key, in milliseconds before "now".
 *
 * Months and years use calendar math (subtracting from the date
 * fields) rather than fixed millisecond counts so that e.g. "1
 * month" ending on Jan 31 starts on Dec 31, not 30 days earlier.
 * The tuple is `[unit, amount]` and consumed by `computeStart`.
 */
type PeriodSpec =
  | { kind: "ms"; ms: number }
  | { kind: "calendar"; unit: "month" | "year"; amount: number };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PERIOD_SPECS: Record<PeriodKey, PeriodSpec> = {
  "1h": { kind: "ms", ms: HOUR_MS },
  "12h": { kind: "ms", ms: 12 * HOUR_MS },
  "1d": { kind: "ms", ms: DAY_MS },
  "1w": { kind: "ms", ms: 7 * DAY_MS },
  "1m": { kind: "calendar", unit: "month", amount: 1 },
  "3m": { kind: "calendar", unit: "month", amount: 3 },
  "6m": { kind: "calendar", unit: "month", amount: 6 },
  "1y": { kind: "calendar", unit: "year", amount: 1 },
  "3y": { kind: "calendar", unit: "year", amount: 3 },
};

export interface PeriodRange {
  start: string;
  end: string;
}

function computeStart(end: Date, spec: PeriodSpec): Date {
  if (spec.kind === "ms") {
    return new Date(end.getTime() - spec.ms);
  }
  return subtractCalendarUnit(end, spec.unit, spec.amount);
}

/**
 * Subtract `amount` months or years from `source`, clamping the
 * day-of-month so we never overflow into the following month.
 *
 * JavaScript's raw `setUTCMonth(m - n)` rolls forward when the
 * source day doesn't exist in the target month — `2026-05-31 - 1
 * month` becomes `2026-05-01` instead of landing in April, and
 * `2024-02-29 - 1 year` becomes `2023-03-01` instead of
 * `2023-02-28`. We step to day 1 first, shift the month/year,
 * then clamp the day back against the target month's length.
 */
function subtractCalendarUnit(
  source: Date,
  unit: "month" | "year",
  amount: number,
): Date {
  const originalDay = source.getUTCDate();
  const result = new Date(source.getTime());
  result.setUTCDate(1);
  if (unit === "month") {
    result.setUTCMonth(result.getUTCMonth() - amount);
  } else {
    result.setUTCFullYear(result.getUTCFullYear() - amount);
  }
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}

/**
 * Build an ISO-8601 UTC `start`/`end` pair for a period key.
 * `now` defaults to `new Date()`; tests inject a fixed clock.
 */
export function computePeriodRange(
  key: PeriodKey,
  now: Date = new Date(),
): PeriodRange {
  const end = new Date(now.getTime());
  const start = computeStart(end, PERIOD_SPECS[key]);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * If `range` matches exactly the window a quick-select chip would
 * produce at `now`, return that chip's key; otherwise return
 * `null`. Used when rehydrating the drawer so a committed filter
 * produced by a chip re-highlights that chip.
 *
 * Matches are exact because the drawer synchronises start/end the
 * moment a chip is picked — no rounding tolerance is needed for
 * that path, and user-edited ranges should not re-match a chip
 * spuriously.
 */
export function matchesPeriodKey(
  range: { start: string; end: string },
  now: Date = new Date(),
): PeriodKey | null {
  for (const key of PERIOD_KEYS) {
    const candidate = computePeriodRange(key, now);
    if (candidate.start === range.start && candidate.end === range.end) {
      return key;
    }
  }
  return null;
}
