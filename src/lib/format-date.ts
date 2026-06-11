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
