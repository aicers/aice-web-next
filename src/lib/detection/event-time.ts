/**
 * Locale-aware event-time formatter used by the Detection list and
 * Quick peek inspector. The formatter intentionally does not pin
 * `hour12` — locales like `en-US` default to 12-hour + AM/PM while
 * `en-GB`, `ko`, and most other locales default to 24-hour. Forcing
 * `hour12: false` would override the operating system's hour-cycle
 * preference and surface a non-local format to US operators.
 *
 * @param timeZone Optional IANA timezone identifier. When omitted the
 *   formatter falls back to the runtime default (browser/OS) timezone;
 *   pass the per-user timezone from `useTimezone()` so event times
 *   render in the operator's configured zone rather than UTC ISO.
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
