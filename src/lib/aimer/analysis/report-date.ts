/**
 * Calendar-date helpers for the Phase 2 report summary routes (#646).
 *
 * The upstream report resource path is
 * `/analysis/report/{LIVE|DAILY}/{bucket_date}/summary` (aimer-web#297).
 * `bucket_date` must be a calendar-valid ISO date or the upstream
 * returns `400 invalid_report_path`; LIVE pins it to the sentinel
 * `1970-01-01`. The DAILY route validates the incoming `{date}`
 * segment locally with {@link isValidReportDate} before composing the
 * upstream URL so a malformed date never reaches aimer-web.
 */

/**
 * Sentinel `bucket_date` the upstream uses for the LIVE period. LIVE is
 * a rolling minute-cadence summary with no calendar bucket, so the
 * path pins to the Unix epoch date to stay calendar-valid (#646
 * "Upstream read contract").
 */
export const LIVE_BUCKET_DATE = "1970-01-01" as const;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Strict, timezone-free `YYYY-MM-DD` calendar validation.
 *
 * Parses the three integer fields out of a literal `YYYY-MM-DD` string
 * and confirms the day is valid for that month / year (including leap
 * years). Deliberately does **not** use `new Date(str)` parsing, which
 * silently rolls over invalid dates (`2026-02-30` → March 2) and is
 * affected by the runtime timezone — the DAILY route mirrors the
 * upstream `invalid_report_path` rule and the story route's
 * `isDecimalString` guard by rejecting bad input *before* any upstream
 * call.
 */
export function isValidReportDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

/**
 * The current calendar date in `timezone`, formatted as `YYYY-MM-DD`.
 *
 * Used by the DAILY dashboard card so a viewer whose timezone resolves
 * to a different calendar day than the server fetches *that* day's
 * report (#646 "Date handling"). Uses `Intl.DateTimeFormat` parts
 * rather than `toISOString()` so the date reflects the target timezone,
 * not UTC.
 */
export function todayInTimezone(
  timezone: string,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
}
