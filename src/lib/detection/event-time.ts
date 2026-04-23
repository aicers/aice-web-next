/**
 * Locale-aware event-time formatter used by the Detection list and
 * Quick peek inspector. The formatter intentionally does not pin
 * `hour12` — locales like `en-US` default to 12-hour + AM/PM while
 * `en-GB`, `ko`, and most other locales default to 24-hour. Forcing
 * `hour12: false` would override the operating system's hour-cycle
 * preference and surface a non-local format to US operators.
 */
export function formatEventTime(
  iso: string,
  locale: string,
  fallback: string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat(locale, {
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
