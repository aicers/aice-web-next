"use client";

import { EVENT_KIND_FRIENDLY_NAMES } from "@/components/events/event-display-helpers";
import { useRegisterBreadcrumbLabel } from "@/components/providers/breadcrumb-label-provider";
import { useTimestampFormatter } from "@/components/timestamp";

interface EventBreadcrumbRegistrarProps {
  /** ISO timestamp of the event (`event.time`). */
  time: string;
  /** GraphQL `__typename` of the curated event subtype. */
  typename: string;
}

/**
 * Publishes the meaningful breadcrumb label for an event detail page —
 * `{compact time} · {event kind}` — derived from the page's already
 * fetched data. The compact time honours the user's timezone and the
 * active app locale via `useTimestampFormatter().formatCompact`; the
 * event kind reuses the same English-only `EVENT_KIND_FRIENDLY_NAMES` mapping
 * the investigation header renders. Renders nothing.
 */
export function EventBreadcrumbRegistrar({
  time,
  typename,
}: EventBreadcrumbRegistrarProps) {
  const { formatCompact } = useTimestampFormatter();

  const compactTime = formatCompact(time);
  const friendlyKind = EVENT_KIND_FRIENDLY_NAMES[typename] ?? typename;
  // Pre-mount `formatCompact` is null; the label registers once the
  // timezone resolves, matching the registrar's post-mount apply.
  const label =
    compactTime === null ? null : `${compactTime} · ${friendlyKind}`;

  useRegisterBreadcrumbLabel(label);

  return null;
}
