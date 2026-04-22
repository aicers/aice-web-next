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

export { DEFAULT_BACK_HREF };
