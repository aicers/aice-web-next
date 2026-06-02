import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";

interface PageProps {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Legacy redirect for the detection-event investigation view.
 *
 * The view moved from `/events/<token>` into the 탐지-owned
 * `/detection/events/<token>` namespace (#678) so URL, concept, and
 * menu align. The locator token wraps a *stable* REview event id
 * (review-web#841), so `/events/<token>` links were durable: bookmarks,
 * shared/support links, and stale browser tabs would otherwise 404.
 *
 * This server-side redirect preserves the query string (`returnTo`,
 * `customers`, `aimerForce`, …) and fires before any dashboard content
 * renders, so it never reintroduces the wrong-sidebar highlight the
 * move fixed. `permanentRedirect` (308) tells crawlers and clients the
 * move fixed.
 *
 * The redirect is *temporary* (307, `redirect`) on purpose: the
 * `/events` namespace is reserved for the future Giganto source-event
 * browsing surface, so we avoid baking a permanently client-cached rule
 * onto `/events/<…>` that could later misroute a real source-event
 * page. This shim only forwards the single `[token]` detail path and
 * will be revisited when that surface lands.
 */
export default async function LegacyEventInvestigationRedirect({
  params,
  searchParams,
}: PageProps) {
  const { locale, token } = await params;
  const resolvedSearch = await searchParams;

  const localePrefix = locale === routing.defaultLocale ? "" : `/${locale}`;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedSearch)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  const search = query.toString();

  redirect(
    `${localePrefix}/detection/events/${encodeURIComponent(token)}${
      search ? `?${search}` : ""
    }`,
  );
}
