import { getLocale, getTranslations } from "next-intl/server";

import { type EventResult, EventSearch } from "@/components/event/event-search";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import {
  parseFilterFromSearchParams,
  parsePaginationSearchParams,
  recordFamily,
} from "@/lib/event";
import {
  listEventSensors,
  searchConnRawEvents,
  searchSysmonRawEvents,
} from "@/lib/event/server-actions";

interface EventPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/event` — the Giganto source-event browsing surface (E0 Conn
 * vertical slice).
 *
 * Server-side gated on `event:read`: a caller without the permission is
 * redirected to `/` by {@link requirePermission}. The nav item itself
 * stays visible to everyone (page-gate only, matching Detection).
 *
 * The filter and pagination live in the URL so a search is shareable
 * and survives reload; this server component reads them, fetches the
 * sensor list and (when a sensor is chosen) the Conn page, then hands
 * the data to the client orchestrator.
 */
export default async function EventPage({ searchParams }: EventPageProps) {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "event:read");

  const t = await getTranslations("event");
  const locale = await getLocale();
  const rawParams = await searchParams;

  const filter = parseFilterFromSearchParams(rawParams);
  const { pageSize, anchor } = parsePaginationSearchParams(rawParams);

  // The sensor list is fetched independently of the result so the
  // filter form still renders (with a notice) when Giganto is briefly
  // unreachable.
  let sensors: string[] | null;
  try {
    sensors = await listEventSensors(session);
  } catch {
    sensors = null;
  }

  // Dispatch by record family: the Conn vertical slice keeps its bespoke
  // typed query, while the 14 Sysmon types share the generic dispatch.
  let result: EventResult;
  try {
    if (recordFamily(filter.recordType) === "network") {
      const connection = await searchConnRawEvents(
        session,
        filter,
        anchor,
        pageSize,
      );
      result =
        connection === null
          ? { status: "prequery" }
          : {
              status: "ready",
              family: "network",
              edges: connection.edges,
              pageInfo: connection.pageInfo,
            };
    } else {
      const connection = await searchSysmonRawEvents(
        session,
        filter.recordType,
        filter,
        anchor,
        pageSize,
      );
      result =
        connection === null
          ? { status: "prequery" }
          : {
              status: "ready",
              family: "sysmon",
              edges: connection.edges,
              pageInfo: connection.pageInfo,
            };
    }
  } catch {
    result = { status: "error" };
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <EventSearch
        committedFilter={filter}
        sensors={sensors}
        pageSize={pageSize}
        result={result}
        locale={locale}
      />
    </div>
  );
}
