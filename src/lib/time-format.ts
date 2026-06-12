/**
 * User-selectable time-display format (#766).
 *
 * Four orthogonal, `Intl`-backed options — formatting locale, hour cycle,
 * seconds, and timezone label — are stored as an account preference and
 * resolved here, in **one place**, into a {@link ResolvedTimeFormat}
 * object that is threaded into the sanctioned formatters in
 * `@/lib/format-date`. Mirrors aimer-web's shipped contract
 * (aicers/aimer-web#556 / #563).
 *
 * Storage is four nullable columns on `accounts`; `NULL` uniformly means
 * "use the app default" (today's format), so "never touched the setting"
 * stays distinguishable from any explicit choice. The default resolved
 * object is byte-identical to the pre-#766 output.
 */

import type { ResolvedTimeFormat } from "@/lib/format-date";

export type { ResolvedTimeFormat };

/** `'h12'` (12-hour) / `'h23'` (24-hour). `NULL` = follow locale default. */
export type TimeFormatHourCycle = "h12" | "h23";

/**
 * Sentinel value for `time_format_locale` meaning "follow the active app
 * locale" (resolves against `useLocale()`), as opposed to `NULL`
 * (follow the browser) or an explicit BCP-47 tag from the curated list.
 */
export const TIME_FORMAT_LOCALE_APP = "app";

/**
 * Curated BCP-47 list for the formatting-locale option, adopted verbatim
 * from aimer-web's shipped set (18 tags). The formatting locale drives
 * date order, separators, and AM/PM wording; month *names* never appear
 * because the formatters use `month: "numeric"`. `NULL` = follow browser,
 * {@link TIME_FORMAT_LOCALE_APP} = follow app locale.
 */
export const CURATED_TIME_FORMAT_LOCALES = [
  "en-US",
  "en-CA",
  "en-GB",
  "en-AU",
  "en-IN",
  "ko-KR",
  "ja-JP",
  "zh-CN",
  "zh-TW",
  "de-DE",
  "fr-FR",
  "fr-CA",
  "es-ES",
  "pt-BR",
  "it-IT",
  "nl-NL",
  "ru-RU",
  "sv-SE",
] as const;

/**
 * Stored time-format preference: the four nullable account columns,
 * keyed in camelCase to match the API JSON (cross-product parity with
 * aimer-web). `null` for any field means "use the app default".
 */
export interface StoredTimeFormat {
  timeFormatLocale: string | null;
  timeFormatHourCycle: TimeFormatHourCycle | null;
  timeFormatSeconds: boolean | null;
  timeFormatTzLabel: boolean | null;
}

/** Default stored preference: every field unset (app default). */
export const DEFAULT_STORED_TIME_FORMAT: StoredTimeFormat = {
  timeFormatLocale: null,
  timeFormatHourCycle: null,
  timeFormatSeconds: null,
  timeFormatTzLabel: null,
};

/**
 * Validate a `timeFormatLocale` value: either the {@link
 * TIME_FORMAT_LOCALE_APP} sentinel or a tag from the curated list.
 */
export function isValidTimeFormatLocale(tag: string): boolean {
  return (
    tag === TIME_FORMAT_LOCALE_APP ||
    (CURATED_TIME_FORMAT_LOCALES as readonly string[]).includes(tag)
  );
}

/** Validate a `timeFormatHourCycle` value. */
export function isValidHourCycle(value: string): value is TimeFormatHourCycle {
  return value === "h12" || value === "h23";
}

/**
 * Resolve a stored preference into a concrete {@link ResolvedTimeFormat}.
 *
 * - `locale`: `null` → `undefined` (follow browser); the `'app'` sentinel
 *   → the active app locale; else the explicit tag.
 * - `hourCycle`: `stored ?? undefined` (undefined = follow the locale).
 * - `seconds`: `stored ?? true` (shown by default).
 * - `tzLabel`: `stored ?? false` (hidden by default).
 *
 * The all-`NULL` default resolves to browser locale / locale-default hour
 * cycle / seconds shown / no tz label — byte-identical to today.
 *
 * @param stored    The stored preference (or `null`/partial).
 * @param appLocale The active app locale, for the `'app'` sentinel.
 */
export function resolveTimeFormat(
  stored: Partial<StoredTimeFormat> | null | undefined,
  appLocale: string,
): ResolvedTimeFormat {
  const s = stored ?? {};

  let locale: string | undefined;
  if (s.timeFormatLocale == null) {
    locale = undefined; // follow browser
  } else if (s.timeFormatLocale === TIME_FORMAT_LOCALE_APP) {
    locale = appLocale;
  } else {
    locale = s.timeFormatLocale;
  }

  return {
    locale,
    hourCycle: s.timeFormatHourCycle ?? undefined,
    seconds: s.timeFormatSeconds ?? true,
    tzLabel: s.timeFormatTzLabel ?? false,
  };
}
