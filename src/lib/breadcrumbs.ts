/** Segments that map to translation keys in "nav" namespace. */
export const NAV_SEGMENTS = new Set([
  "home",
  "dashboard",
  "event",
  "events",
  "detection",
  "triage",
  "report",
  "nodes",
  "audit-logs",
  "settings",
]);

/**
 * Parent segments whose dynamic child (an opaque token / id) renders a
 * static `nav` fallback label instead of the raw URL segment. The map
 * value is the `nav` translation key for that fallback.
 *
 * Only the plural detail routes appear here: `events/[token]` and
 * `nodes/[id]`. The singular `event` segment is deliberately absent —
 * `/event` is the static Event-browsing route, not a detail route, so
 * mapping it would risk mislabelling a future `/event/<child>` path as
 * "Event detail".
 */
const DYNAMIC_CHILD_FALLBACKS: Record<string, string> = {
  events: "eventDetail",
  nodes: "nodeDetail",
};

/** Segments that map to translation keys in "settings" namespace. */
export const SETTINGS_SEGMENTS = new Set([
  "accounts",
  "roles",
  "profile",
  "customers",
  "policies",
  "account-status",
]);

/**
 * Map URL segments to i18n keys when they differ.
 * Segments not listed here use the segment itself as the key.
 */
const SETTINGS_KEY_MAP: Record<string, string> = {
  "account-status": "accountStatus",
};

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
 * @param overrideLastLabel - When the last segment is a dynamic detail child
 *   (its parent is in {@link DYNAMIC_CHILD_FALLBACKS}), use this meaningful
 *   label — derived client-side from the page's already-fetched data — in
 *   place of the static fallback. When absent, the dynamic child shows the
 *   static fallback (`eventDetail` / `nodeDetail`) rather than the raw,
 *   opaque token/id.
 */
export function parseBreadcrumbs(
  pathname: string,
  translate: (ns: "nav" | "settings", key: string) => string | null,
  overrideLastLabel?: string | null,
): BreadcrumbSegment[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: BreadcrumbSegment[] = [];

  let currentPath = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    currentPath += `/${segment}`;

    let label: string | null = null;
    if (NAV_SEGMENTS.has(segment)) {
      label = translate("nav", segment);
    } else if (SETTINGS_SEGMENTS.has(segment)) {
      label = translate("settings", SETTINGS_KEY_MAP[segment] ?? segment);
    } else {
      // A segment unknown to the nav/settings maps may still be a
      // dynamic detail child (an opaque token/id). Such a child takes
      // the meaningful override when available, else the parent's
      // static fallback label — never the raw segment.
      const fallbackKey = DYNAMIC_CHILD_FALLBACKS[segments[i - 1]];
      if (fallbackKey) {
        const isLast = i === segments.length - 1;
        label =
          isLast && overrideLastLabel
            ? overrideLastLabel
            : translate("nav", fallbackKey);
      }
    }

    crumbs.push({
      label: label ?? segment.charAt(0).toUpperCase() + segment.slice(1),
      href: currentPath,
    });
  }

  return crumbs;
}
