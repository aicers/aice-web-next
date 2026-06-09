import { getLocale, getTranslations } from "next-intl/server";

import {
  EventSearch,
  type RawEventResult,
} from "@/components/event/event-search";
import { EventViewTabs } from "@/components/event/event-view-tabs";
import {
  type StatisticsResultState,
  StatisticsView,
} from "@/components/event/statistics-view";
import type { AuthSession } from "@/lib/auth/jwt";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import {
  parseFilterFromSearchParams,
  parsePaginationSearchParams,
  parseStatisticsFilterFromSearchParams,
  parseViewModeFromSearchParams,
} from "@/lib/event";
import {
  fetchStatistics,
  listEventSensors,
  searchRawEvents,
} from "@/lib/event/server-actions";

interface EventPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type RawParams = Record<string, string | string[] | undefined>;

/**
 * `/event` — the Giganto source-event browsing surface.
 *
 * Server-side gated on `event:read`: a caller without the permission is
 * redirected to `/` by {@link requirePermission}. The nav item itself
 * stays visible to everyone (page-gate only, matching Detection).
 *
 * A `view` toggle switches between the **Events** record table and the
 * **Statistics** aggregation chart. Both views keep their filter and the
 * active view in the URL so a search is shareable and survives reload;
 * this server component reads them, fetches the sensor list and the
 * selected view's data, then hands it to the matching client
 * orchestrator. The Events view fetches one page of the selected record
 * type (any of the 20 network types).
 */
export default async function EventPage({ searchParams }: EventPageProps) {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "event:read");

  const t = await getTranslations("event");
  const locale = await getLocale();
  const rawParams = await searchParams;

  const view = parseViewModeFromSearchParams(rawParams);

  // The sensor list is fetched independently of the result so the
  // filter form still renders (with a notice) when Giganto is briefly
  // unreachable. Both views share this single-fetch sensor source.
  let sensors: string[] | null;
  try {
    sensors = await listEventSensors(session);
  } catch {
    sensors = null;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <EventViewTabs active={view} />
      {view === "statistics" ? (
        <StatisticsViewSection
          rawParams={rawParams}
          sensors={sensors}
          locale={locale}
          session={session}
        />
      ) : (
        <EventsViewSection
          rawParams={rawParams}
          sensors={sensors}
          locale={locale}
          session={session}
        />
      )}
    </div>
  );
}

async function EventsViewSection({
  rawParams,
  sensors,
  locale,
  session,
}: {
  rawParams: RawParams;
  sensors: string[] | null;
  locale: string;
  session: AuthSession;
}) {
  const filter = parseFilterFromSearchParams(rawParams);
  const { pageSize, anchor } = parsePaginationSearchParams(rawParams);

  let result: RawEventResult;
  try {
    const connection = await searchRawEvents(session, filter, anchor, pageSize);
    result =
      connection === null
        ? { status: "prequery" }
        : {
            status: "ready",
            edges: connection.edges,
            pageInfo: connection.pageInfo,
          };
  } catch {
    result = { status: "error" };
  }

  return (
    <EventSearch
      committedFilter={filter}
      sensors={sensors}
      pageSize={pageSize}
      result={result}
      locale={locale}
    />
  );
}

async function StatisticsViewSection({
  rawParams,
  sensors,
  locale,
  session,
}: {
  rawParams: RawParams;
  sensors: string[] | null;
  locale: string;
  session: AuthSession;
}) {
  const filter = parseStatisticsFilterFromSearchParams(rawParams);

  let result: StatisticsResultState;
  try {
    const events = await fetchStatistics(session, filter);
    result =
      events === null ? { status: "prequery" } : { status: "ready", events };
  } catch {
    result = { status: "error" };
  }

  return (
    <StatisticsView
      committedFilter={filter}
      sensors={sensors}
      result={result}
      locale={locale}
    />
  );
}
