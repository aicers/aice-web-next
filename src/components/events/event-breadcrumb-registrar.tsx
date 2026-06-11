"use client";

import { useLocale } from "next-intl";

import { EVENT_KIND_FRIENDLY_NAMES } from "@/components/events/event-display-helpers";
import { useRegisterBreadcrumbLabel } from "@/components/providers/breadcrumb-label-provider";
import { useTimezone } from "@/components/providers/timezone-provider";
import { formatDateTimeCompact } from "@/lib/format-date";

interface EventBreadcrumbRegistrarProps {
  /** ISO timestamp of the event (`event.time`). */
  time: string;
  /** GraphQL `__typename` of the curated event subtype. */
  typename: string;
}

/**
 * Publishes the meaningful breadcrumb label for an event detail page —
 * `{compact time} · {event kind}` — derived from the page's already
 * fetched data. The compact time honours the user's timezone
 * (`useTimezone`) and the active app locale (`useLocale`); the event
 * kind reuses the same English-only `EVENT_KIND_FRIENDLY_NAMES` mapping
 * the investigation header renders. Renders nothing.
 */
export function EventBreadcrumbRegistrar({
  time,
  typename,
}: EventBreadcrumbRegistrarProps) {
  const timezone = useTimezone();
  const locale = useLocale();

  const compactTime = formatDateTimeCompact(time, timezone, locale);
  const friendlyKind = EVENT_KIND_FRIENDLY_NAMES[typename] ?? typename;
  const label = `${compactTime} · ${friendlyKind}`;

  useRegisterBreadcrumbLabel(label);

  return null;
}
