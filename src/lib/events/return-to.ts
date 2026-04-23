/**
 * Validate a `returnTo` back-link target supplied via a URL
 * search param. The Investigation page accepts the param so
 * that any menu opening the route — Detection's list, a Quick
 * peek inspector, Triage, etc. — can round-trip the user back
 * to their prior tab state without server-side session storage.
 *
 * Only same-origin relative paths are accepted. Protocol-
 * relative (`//evil.tld`) and backslash-prefixed forms are
 * rejected so a crafted link cannot bounce the user off-site.
 */
const DEFAULT_BACK_HREF = "/detection";

export function sanitizeReturnTo(value: string | string[] | undefined): string {
  if (typeof value !== "string") return DEFAULT_BACK_HREF;
  if (value.length === 0 || value.length > 2048) return DEFAULT_BACK_HREF;
  if (!value.startsWith("/")) return DEFAULT_BACK_HREF;
  if (value.startsWith("//") || value.startsWith("/\\")) {
    return DEFAULT_BACK_HREF;
  }
  return value;
}

/**
 * Build a locale-stripped `returnTo` target for the Investigation
 * page. The caller should pass the current locale-stripped pathname
 * (e.g. from next-intl's `usePathname`) and the query string for the
 * active URL. The Investigation back-link renders through the
 * locale-aware `<Link>`, so the returned path must NOT carry a locale
 * prefix — the `<Link>` re-adds it per the user's current locale.
 */
export function buildInvestigationReturnTo(
  pathname: string,
  search: string,
): string {
  const qs = search.startsWith("?") ? search.slice(1) : search;
  return qs.length > 0 ? `${pathname}?${qs}` : pathname;
}

export { DEFAULT_BACK_HREF };
