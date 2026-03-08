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
