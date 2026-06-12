/**
 * Timezone-aware date formatting utility.
 */

/**
 * Format a date/time string for display.
 *
 * @param date       ISO string or Date object.
 * @param timezone   IANA timezone identifier. When `null`/`undefined`,
 *                   falls back to the runtime default (browser or server).
 */
export function formatDateTime(
  date: string | Date,
  timezone?: string | null,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    timeZone: timezone ?? undefined,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
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
 * @param date      ISO string or Date object.
 * @param timezone  IANA timezone identifier. When `null`/`undefined`,
 *                  falls back to the runtime default (browser or server).
 * @param locale    BCP 47 locale tag (e.g. `en`, `ko`). When
 *                  `null`/`undefined`, falls back to the runtime default.
 */
export function formatDateTimeCompact(
  date: string | Date,
  timezone?: string | null,
  locale?: string | null,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(locale ?? undefined, {
    timeZone: timezone ?? undefined,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
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
 * @param iso       ISO instant string.
 * @param locale    BCP 47 locale tag (e.g. `en`, `ko`).
 * @param fallback  Returned verbatim when `iso` is unparseable.
 * @param timeZone  Optional IANA timezone identifier. When omitted the
 *   formatter falls back to the runtime default (browser/OS) timezone;
 *   pass the per-user timezone from `useTimezone()` so event times render
 *   in the operator's configured zone rather than UTC ISO.
 */
export function formatEventTime(
  iso: string,
  locale: string,
  fallback: string,
  timeZone?: string | null,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timeZone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
}
