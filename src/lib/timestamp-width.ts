/**
 * Reserved placeholder-width sizing for `<Timestamp>` (#764 / #766).
 *
 * The pre-mount placeholder reserves a worst-case width so the
 * placeholder → resolved-value swap never shifts the line. The chosen
 * time-display format (#766) changes that worst case — 24-hour + seconds
 * + timezone label is widest, and a `ko` `h23` value spells out 시/분/초
 * (wider still) — so the reservation is recomputed from the resolved
 * options rather than pinned to a single constant.
 *
 * When the formatting locale follows the browser / app (`locale` is
 * `undefined`) the actual locale is unknown at sizing time, so the width
 * is the **global worst case across the entire curated BCP-47 list** —
 * not just `en` / `ko` (a `fr-CA` value spells the time `11 h 59 min
 * 59 s`, wider than the `en` / `ko` samples).
 */

import type { ResolvedTimeFormat } from "@/lib/format-date";
import { CURATED_TIME_FORMAT_LOCALES } from "@/lib/time-format";

/**
 * Worst-case instant: every field two digits, a PM hour, late December
 * so no field shrinks. December 30 keeps the ISO week-of-year out of the
 * picture and the day two digits.
 */
const WORST_INSTANT = new Date("2026-12-30T23:59:59Z");

/**
 * Timezone used only when sizing a value that carries a tz label: a
 * fractional, large offset produces the widest `shortOffset` form
 * (`GMT+12:45`). When no tz label is shown the zone does not affect the
 * width, so `UTC` is used.
 */
const WORST_TZ_FOR_LABEL = "Pacific/Chatham";

/** One extra cell of slack so a hair-wide glyph never clips. */
const SAFETY_CH = 1;

/**
 * Approximate the rendered column width of a string in `ch`: CJK /
 * Hangul glyphs occupy ~2 monospace cells, everything else ~1. Mirrors
 * the budgeting the reserved-width pin test measures against.
 */
function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[ᄀ-ᇿ⺀-鿿가-힯＀-￯]/.test(ch) ? 2 : 1;
  }
  return width;
}

function intlOptions(
  options: ResolvedTimeFormat,
  compact: boolean,
): Intl.DateTimeFormatOptions {
  if (compact) {
    // Compact never renders the year, seconds, or tz label, so they are
    // folded out of its sizing regardless of the preference.
    return {
      timeZone: "UTC",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      ...(options.hourCycle ? { hourCycle: options.hourCycle } : {}),
    };
  }
  return {
    timeZone: options.tzLabel ? WORST_TZ_FOR_LABEL : "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    ...(options.seconds ? { second: "numeric" } : {}),
    ...(options.hourCycle ? { hourCycle: options.hourCycle } : {}),
    ...(options.tzLabel ? { timeZoneName: "shortOffset" } : {}),
  };
}

// `<Timestamp>` renders many instances; the worst-case sweep formats up
// to 18 locales, so memoize per (format, variant) key.
const cache = new Map<string, number>();

function compute(options: ResolvedTimeFormat, compact: boolean): number {
  const locales = options.locale
    ? [options.locale]
    : CURATED_TIME_FORMAT_LOCALES;
  const fmtOptions = intlOptions(options, compact);

  let max = 0;
  for (const locale of locales) {
    let formatted: string;
    try {
      formatted = WORST_INSTANT.toLocaleString(locale, fmtOptions);
    } catch {
      continue;
    }
    max = Math.max(max, visualWidth(formatted));
  }
  return max + SAFETY_CH;
}

/**
 * Compute the reserved placeholder width (in `ch`) for the given resolved
 * format and variant. Memoized across calls.
 *
 * @param options Resolved time-display preference.
 * @param compact `true` for the compact variant (no year / seconds / tz).
 */
export function reservedTimestampCh(
  options: ResolvedTimeFormat,
  compact: boolean,
): number {
  const key = `${compact ? "c" : "g"}|${options.locale ?? ""}|${
    options.hourCycle ?? ""
  }|${options.seconds ? 1 : 0}|${options.tzLabel ? 1 : 0}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = compute(options, compact);
  cache.set(key, value);
  return value;
}
