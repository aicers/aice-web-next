/**
 * IANA timezone validation.
 *
 * Uses `Intl.supportedValuesOf("timeZone")` which is available in
 * Node 18+ and all modern browsers.
 */

let cachedTimezones: Set<string> | null = null;

function getTimezoneSet(): Set<string> {
  if (!cachedTimezones) {
    cachedTimezones = new Set(Intl.supportedValuesOf("timeZone"));
  }
  return cachedTimezones;
}

/** Returns `true` when `tz` is a recognized IANA timezone identifier. */
export function isValidTimezone(tz: string): boolean {
  return getTimezoneSet().has(tz);
}

/** Returns the full list of IANA timezone identifiers. */
export function getTimezones(): string[] {
  return Intl.supportedValuesOf("timeZone");
}
