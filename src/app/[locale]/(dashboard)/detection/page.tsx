import { getTranslations } from "next-intl/server";

import { DetectionShell } from "@/components/detection/detection-shell";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import {
  buildPivotChips,
  computePeriodRange,
  DEFAULT_PERIOD_KEY,
  type Filter,
  PERIOD_KEYS,
  parsePivotSearchParams,
  searchEvents,
} from "@/lib/detection";

interface DetectionPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DetectionPage({
  searchParams,
}: DetectionPageProps) {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "detection:read");

  const t = await getTranslations("detection");
  const rawParams = await searchParams;
  const pivotParams = parsePivotSearchParams(rawParams);
  const initialChips = buildPivotChips(pivotParams, {
    source: t("filters.chips.source"),
    destination: t("filters.chips.destination"),
    kind: t("filters.chips.kind"),
    origPort: t("filters.chips.origPort"),
    respPort: t("filters.chips.respPort"),
    proto: t("filters.chips.proto"),
    window: t("filters.chips.window"),
    windowLastDay: t("filters.chips.windowLastDay"),
    windowLastWeek: t("filters.chips.windowLastWeek"),
  });

  const defaultRange = computePeriodRange(DEFAULT_PERIOD_KEY);
  const initialFilter: Filter = {
    mode: "structured",
    input: { start: defaultRange.start, end: defaultRange.end },
  };

  let initialTotal: string | null = null;
  let initialError: string | null = null;
  try {
    const connection = await searchEvents(session, initialFilter, { first: 1 });
    initialTotal = connection.totalCount;
  } catch {
    initialError = t("filters.resultsError");
  }

  const periodOptions = Object.fromEntries(
    PERIOD_KEYS.map((key) => [key, t(`filters.periodOptions.${key}`)]),
  ) as Record<(typeof PERIOD_KEYS)[number], string>;

  return (
    <DetectionShell
      title={t("title")}
      initialFilter={initialFilter}
      initialPeriod={DEFAULT_PERIOD_KEY}
      initialResult={{ totalCount: initialTotal, error: initialError }}
      labels={{
        recommendedFilter: t("savedRail.recommended"),
        savedFilters: t("savedRail.saved"),
        railPlaceholder: t("savedRail.placeholder"),
        filtersOpen: t("filters.open"),
        activeChipsEmpty: t("filters.activeChipsEmpty"),
        resultsRegion: t("filters.resultsRegion"),
        resultsLoading: t("filters.resultsLoading"),
        resultsError: t("filters.resultsError"),
        analyticsToggle: t("analytics.toggle"),
        analyticsShow: t("analytics.show"),
        analyticsHide: t("analytics.hide"),
        analyticsPlaceholder: t("analytics.placeholder"),
        drawer: {
          title: t("filters.drawerTitle"),
          description: t("filters.drawerDescription"),
          periodLabel: t("filters.periodLabel"),
          periodOptions,
          timeRangeLabel: t("filters.timeRangeLabel"),
          startLabel: t("filters.startLabel"),
          endLabel: t("filters.endLabel"),
          apply: t("filters.apply"),
          saveThisFilter: t("filters.saveThisFilter"),
          saveThisFilterComingSoon: t("filters.saveThisFilterComingSoon"),
          invalidRange: t("filters.invalidRange"),
          close: t("filters.close"),
        },
      }}
      initialChips={initialChips}
    />
  );
}
