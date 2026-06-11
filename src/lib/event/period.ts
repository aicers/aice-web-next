/**
 * Event-scoped period quick-select subset.
 *
 * The Event dataset is far larger than Detection's, so the Event filters
 * cap the quick-select windows at one week — only `1h | 12h | 1d | 1w`,
 * a strict subset of Detection's {@link PERIOD_KEYS}. The shared
 * Detection contract is intentionally *not* widened here; instead this
 * module narrows it and reuses Detection's {@link computePeriodRange} so
 * the Event `1w` window is byte-for-byte the same range Detection's `1w`
 * produces.
 *
 * The selected period is presentation-only state: it drives which pill is
 * highlighted but never reaches a Giganto query (the query is driven by
 * the resolved `start`/`end`). It round-trips through each Event view's
 * URL filter state so a reload re-lights the correct pill without
 * re-matching the stored range against a fresh `now`.
 */

import { computePeriodRange, type PeriodRange } from "@/lib/detection/period";

export const EVENT_PERIOD_KEYS = ["1h", "12h", "1d", "1w"] as const;

export type EventPeriodKey = (typeof EVENT_PERIOD_KEYS)[number];

/** Whether `value` is one of the Event-scoped period keys. */
export function isEventPeriodKey(value: string): value is EventPeriodKey {
  return (EVENT_PERIOD_KEYS as readonly string[]).includes(value);
}

/**
 * Coerce a raw URL/query value to an {@link EventPeriodKey}, or `null`
 * when it is missing, malformed, or outside the Event-scoped subset
 * (e.g. a longer Detection key like `3y`). A `null` result means no pill
 * is highlighted.
 */
export function coerceEventPeriod(
  value: string | null | undefined,
): EventPeriodKey | null {
  return value != null && isEventPeriodKey(value) ? value : null;
}

/**
 * Build the `start`/`end` range for an Event period key. Delegates to
 * Detection's {@link computePeriodRange} so an Event window matches the
 * Detection window of the same key exactly.
 */
export function computeEventPeriodRange(
  key: EventPeriodKey,
  now?: Date,
): PeriodRange {
  return computePeriodRange(key, now);
}
