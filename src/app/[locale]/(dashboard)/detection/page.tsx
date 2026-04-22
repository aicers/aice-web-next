import { getTranslations } from "next-intl/server";

import { DetectionShell } from "@/components/detection/detection-shell";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import {
  computePeriodRange,
  DEFAULT_PERIOD_KEY,
  type Event,
  type EventListFilterInput,
  type Filter,
  PERIOD_KEYS,
  type PeriodKey,
  type PivotFilterParams,
  parsePivotSearchParams,
  searchEvents,
} from "@/lib/detection";
import { DEFAULT_RESULT_PAGE_SIZE } from "./constants";

interface DetectionPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Map a pivot `window` param to the nearest quick-select period key.
// `7d` has no exact period equivalent; `1w` is the closest (and
// matches the ms window exactly).
const PIVOT_WINDOW_TO_PERIOD: Record<
  NonNullable<PivotFilterParams["window"]>,
  PeriodKey
> = {
  "1d": "1d",
  "7d": "1w",
};

export default async function DetectionPage({
  searchParams,
}: DetectionPageProps) {
  const session = await getCurrentSession();
  if (!session) return null;

  await requirePermission(session, "detection:read");

  const t = await getTranslations("detection");

  // Pivot handoff from Investigation → Detection (Phase Detection-12
  // is still deferred; this preserves the `source` / `destination` /
  // `kind` / `window` URL contract that Overview + Related tabs emit
  // via `buildDetectionPivotUrl`). We translate the pivot params
  // directly into the abstract `Filter` so the chip bar — computed
  // from `summarizeFilter` — surfaces them like any other committed
  // filter. `origPort` / `respPort` / `proto` have no representation
  // in `EventListFilterInput` v1 and are silently dropped; when the
  // filter surface gains them, this mapping is the place to hang
  // them off.
  const rawParams = await searchParams;
  const pivot = parsePivotSearchParams(rawParams);
  const initialPeriod: PeriodKey = pivot.window
    ? PIVOT_WINDOW_TO_PERIOD[pivot.window]
    : DEFAULT_PERIOD_KEY;
  const initialRange = computePeriodRange(initialPeriod);
  const pivotFilterInput: EventListFilterInput = {
    start: initialRange.start,
    end: initialRange.end,
  };
  if (pivot.source) pivotFilterInput.source = pivot.source;
  if (pivot.destination) pivotFilterInput.destination = pivot.destination;
  if (pivot.kind) pivotFilterInput.kinds = [pivot.kind];
  const initialFilter: Filter = {
    mode: "structured",
    input: pivotFilterInput,
  };

  let initialTotal: string | null = null;
  let initialError: string | null = null;
  let initialEvents: Event[] = [];
  let initialCursors: (string | null)[] = [];
  let initialFetchedAt: string | null = null;
  try {
    const connection = await searchEvents(session, initialFilter, {
      first: DEFAULT_RESULT_PAGE_SIZE,
    });
    initialTotal = connection.totalCount;
    // Carry `edges` through when available so each row's opaque
    // cursor reaches the list as a stable React key. Fall back to
    // `nodes` only if the server ever omits edges.
    const edgeNodes = connection.edges?.map((edge) => edge.node) ?? [];
    initialCursors = connection.edges?.map((edge) => edge.cursor ?? null) ?? [];
    initialEvents =
      edgeNodes.length === connection.nodes.length
        ? edgeNodes
        : connection.nodes;
    initialFetchedAt = new Date().toISOString();
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
      initialPeriod={initialPeriod}
      initialResult={{
        totalCount: initialTotal,
        error: initialError,
        events: initialEvents,
        cursors: initialCursors,
        fetchedAt: initialFetchedAt,
      }}
      labels={{
        recommendedFilter: t("savedRail.recommended"),
        savedFilters: t("savedRail.saved"),
        railPlaceholder: t("savedRail.placeholder"),
        filtersOpen: t("filters.open"),
        activeChipsEmpty: t("filters.activeChipsEmpty"),
        resultsError: t("filters.resultsError"),
        analyticsToggle: t("analytics.toggle"),
        analyticsShow: t("analytics.show"),
        analyticsHide: t("analytics.hide"),
        analyticsPlaceholder: t("analytics.placeholder"),
        list: {
          region: t("filters.resultsRegion"),
          loading: t("filters.resultsLoading"),
          headerCount: t("results.headerCount"),
          headerCountKnown: t.raw("results.headerCountKnown"),
          headerCountRange: t.raw("results.headerCountRange"),
          downloadCsv: t("results.downloadCsv"),
          downloadCsvComingSoon: t("results.downloadCsvComingSoon"),
          refresh: t("results.refresh"),
          updatedRelative: t.raw("results.updatedRelative"),
          updatedJustNow: t("results.updatedJustNow"),
          updatedNever: t("results.updatedNever"),
          emptyTitle: t("results.emptyTitle"),
          emptyBody: t("results.emptyBody"),
          openInvestigation: t("results.openInvestigation"),
          confidence: t.raw("results.confidence"),
          triageSummary: t.raw("results.triageSummary"),
          unknownEndpoint: t("results.unknownEndpoint"),
          attackKindLabel: t.raw("results.attackKindLabel"),
          moreCount: t.raw("results.moreCount"),
          rowTrigger: t.raw("results.rowTrigger"),
          moreAddressesTitle: t("quickPeek.moreAddresses"),
          moreAddressesCount: t.raw("quickPeek.moreAddressesCount"),
          morePortsTitle: t("quickPeek.morePorts"),
          morePortsCount: t.raw("quickPeek.morePortsCount"),
        },
        chipBar: {
          period: t("filters.chips.period"),
          range: t("filters.chips.range"),
          source: t("filters.chips.source"),
          destination: t("filters.chips.destination"),
          confidenceMin: t("filters.chips.confidenceMin"),
          confidenceMax: t("filters.chips.confidenceMax"),
          customers: t("filters.chips.customers"),
          endpoints: t("filters.chips.endpoints"),
          directions: t("filters.chips.directions"),
          keywords: t("filters.chips.keywords"),
          networkTags: t("filters.chips.networkTags"),
          sensors: t("filters.chips.sensors"),
          os: t("filters.chips.os"),
          devices: t("filters.chips.devices"),
          hostnames: t("filters.chips.hostnames"),
          userIds: t("filters.chips.userIds"),
          userNames: t("filters.chips.userNames"),
          userDepartments: t("filters.chips.userDepartments"),
          countries: t("filters.chips.countries"),
          categories: t("filters.chips.categories"),
          levels: t("filters.chips.levels"),
          kinds: t("filters.chips.kinds"),
          learningMethods: t("filters.chips.learningMethods"),
          triagePolicies: t("filters.chips.triagePolicies"),
          remove: t.raw("filters.chips.remove"),
          aggregateOne: t.raw("filters.chips.aggregateOne"),
          aggregateOther: t.raw("filters.chips.aggregateOther"),
          aggregateCount: t.raw("quickPeek.aggregateCount"),
          valuePopoverHint: t("filters.chips.valuePopoverHint"),
          valuePopoverRemove: t("filters.chips.valuePopoverRemove"),
          empty: t("filters.activeChipsEmpty"),
          region: t("filters.activeChipsLabel"),
          levelHigh: t("filters.chips.levelHigh"),
          levelMedium: t("filters.chips.levelMedium"),
          levelLow: t("filters.chips.levelLow"),
          rangeFormat: t.raw("filters.activeRange"),
          periodOptions,
        },
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
        quickPeek: {
          title: t("quickPeek.title"),
          description: t("quickPeek.description"),
          placeholder: t("quickPeek.placeholder"),
          openInvestigation: t("quickPeek.openInvestigation"),
          close: t("quickPeek.close"),
        },
      }}
    />
  );
}
