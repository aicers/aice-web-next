/**
 * Decide whether a sidebar/mobile nav item is active for the current
 * pathname using a *segment-aware* match rather than a loose prefix.
 *
 * A plain `pathname.startsWith(href)` lights up the wrong menu when one
 * item's href is a string prefix of another route: e.g. the 이벤트 menu's
 * `/event` would have matched the `/events/<token>` path the
 * detection-event detail page once lived at (#678). Matching on
 * path-segment boundaries instead means `/event` only matches `/event`
 * or `/event/...`, never `/events/...`, while `/detection` still
 * matches its nested `/detection/events/<token>` investigation view.
 *
 * @param pathname locale-stripped pathname (as returned by next-intl's
 *   `usePathname`), e.g. `/detection/events/abc`.
 * @param href the nav item's href, e.g. `/detection`.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
