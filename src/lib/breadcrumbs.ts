/** Segments that map to translation keys in "nav" namespace. */
export const NAV_SEGMENTS = new Set([
  "home",
  "dashboard",
  "event",
  "detection",
  "triage",
  "report",
  "settings",
]);

/** Segments that map to translation keys in "settings" namespace. */
export const SETTINGS_SEGMENTS = new Set(["accounts", "roles", "profile"]);

export interface BreadcrumbSegment {
  label: string;
  href: string;
}

/**
 * Parse a pathname into breadcrumb segments with translated labels.
 *
 * @param pathname - URL pathname without locale prefix (e.g. "/settings/accounts")
 * @param translate - Resolves a segment to a translated label, or returns `null`
 *   to fall back to the capitalised segment name.
 */
export function parseBreadcrumbs(
  pathname: string,
  translate: (ns: "nav" | "settings", key: string) => string | null,
): BreadcrumbSegment[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: BreadcrumbSegment[] = [];

  let currentPath = "";
  for (const segment of segments) {
    currentPath += `/${segment}`;

    let label: string | null = null;
    if (NAV_SEGMENTS.has(segment)) {
      label = translate("nav", segment);
    } else if (SETTINGS_SEGMENTS.has(segment)) {
      label = translate("settings", segment);
    }

    crumbs.push({
      label: label ?? segment.charAt(0).toUpperCase() + segment.slice(1),
      href: currentPath,
    });
  }

  return crumbs;
}
