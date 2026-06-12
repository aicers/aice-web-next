/**
 * Timezone-aware date formatting utility.
 */

/**
 * Resolved time-display options for the sanctioned formatters (#766).
 *
 * Produced once by `resolveTimeFormat` (see `@/lib/time-format`) from the
 * stored account preference and threaded into the formatters — never
 * spread option-by-option into call sites. The default object (browser
 * locale, locale-default hour cycle, seconds shown, no timezone label)
 * makes every formatter byte-identical to its pre-#766 output, so a user
 * who never touches the setting sees no change.
 */
export interface ResolvedTimeFormat {
  /**
   * Locale override for the formatter. `undefined` means "no override":
   * the formatter keeps its own base locale (browser for the general
   * formatter, the explicit `locale` argument for the compact / event
   * formatters).
   */
  locale: string | undefined;
  /** `'h12'` / `'h23'`, or `undefined` to follow the locale default. */
  hourCycle: "h12" | "h23" | undefined;
  /** Whether to show seconds (general / event formatters only). */
  seconds: boolean;
  /** Whether to show the timezone offset label (general / event only). */
  tzLabel: boolean;
}

/**
 * Format a date/time string for display.
 *
 * @param date       ISO string or Date object.
 * @param timezone   IANA timezone identifier. When `null`/`undefined`,
 *                   falls back to the runtime default (browser or server).
 * @param options    Resolved time-display preference (#766). When omitted,
 *                   the output is byte-identical to the pre-#766 default:
 *                   browser locale, locale-default hour cycle, seconds
 *                   shown, no timezone label. All four options apply here.
 */
export function formatDateTime(
  date: string | Date,
  timezone?: string | null,
  options?: ResolvedTimeFormat,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(options?.locale ?? undefined, {
    timeZone: timezone ?? undefined,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    ...((options?.seconds ?? true) ? { second: "numeric" } : {}),
    ...(options?.hourCycle ? { hourCycle: options.hourCycle } : {}),
    ...(options?.tzLabel ? { timeZoneName: "shortOffset" } : {}),
  });
}

/**
 * Format a date/time string in a compact form suitable for tight UI
 * surfaces such as breadcrumbs: drops the year and seconds the full
 * {@link formatDateTime} carries, keeping only month, day, hour, and
 * minute (e.g. `06-11 14:23` in English).
 *
 * Unlike {@link formatDateTime}, this variant takes an **explicit**
 * `locale` rather than following the browser locale, because its
 * callers (the breadcrumb registrars) must honour the Next.js active
 * locale obtained from `useLocale()`. The exact order and separators
 * are produced by `Intl` for the active locale — the contract is
 * "no year, no seconds, timezone + locale honoured", not a fixed
 * string.
 *
 * Per #766 the compact form honours **only** the formatting locale and
 * hour cycle: the seconds and timezone-label preferences have no effect
 * here (the year, seconds, and tz label are always omitted, because a
 * wide tz label would defeat the compact surface and diverge from the
 * breadcrumb form).
 *
 * @param date      ISO string or Date object.
 * @param timezone  IANA timezone identifier. When `null`/`undefined`,
 *                  falls back to the runtime default (browser or server).
 * @param locale    BCP 47 locale tag (e.g. `en`, `ko`). When
 *                  `null`/`undefined`, falls back to the runtime default.
 * @param options   Resolved time-display preference (#766). Only
 *                  `locale` (override) and `hourCycle` are observed.
 */
export function formatDateTimeCompact(
  date: string | Date,
  timezone?: string | null,
  locale?: string | null,
  options?: ResolvedTimeFormat,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(options?.locale ?? locale ?? undefined, {
    timeZone: timezone ?? undefined,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    ...(options?.hourCycle ? { hourCycle: options.hourCycle } : {}),
  });
}

/**
 * Locale-aware event-time formatter used by the Detection list and
 * Quick peek inspector — the detection-grid variant of the sanctioned
 * formatters, with explicit 2-digit fields and seconds. The formatter
 * intentionally does not pin `hour12`: locales like `en-US` default to
 * 12-hour + AM/PM while `en-GB`, `ko`, and most other locales default to
 * 24-hour. Forcing `hour12: false` would override the operating system's
 * hour-cycle preference and surface a non-local format to US operators.
 *
 * This is the **full** form (2-digit fields + seconds), not compact, so
 * per #766 all four time-display options apply here, same as the general
 * formatter. The `options.locale` override (when set) takes precedence
 * over the explicit `locale` argument, so "follow browser / explicit"
 * overrides the app-locale prop the call sites pass today.
 *
 * @param iso       ISO instant string.
 * @param locale    BCP 47 locale tag (e.g. `en`, `ko`).
 * @param fallback  Returned verbatim when `iso` is unparseable.
 * @param timeZone  Optional IANA timezone identifier. When omitted the
 *   formatter falls back to the runtime default (browser/OS) timezone;
 *   pass the per-user timezone from `useTimezone()` so event times render
 *   in the operator's configured zone rather than UTC ISO.
 * @param options   Resolved time-display preference (#766). All four
 *   options apply; `options.locale` overrides the `locale` argument.
 */
export function formatEventTime(
  iso: string,
  locale: string,
  fallback: string,
  timeZone?: string | null,
  options?: ResolvedTimeFormat,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat(options?.locale ?? locale, {
      timeZone: timeZone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...((options?.seconds ?? true) ? { second: "2-digit" } : {}),
      ...(options?.hourCycle ? { hourCycle: options.hourCycle } : {}),
      ...(options?.tzLabel ? { timeZoneName: "shortOffset" } : {}),
    }).format(d);
  } catch {
    return iso;
  }
}
