import { getLocale, getTranslations } from "next-intl/server";

import { DetectionShell } from "@/components/detection/detection-shell";
import type { FilterDrawerOptions } from "@/components/detection/filter-drawer";
import type { FilterMultiSelectOption } from "@/components/detection/filter-multi-select";
import { EVENT_KIND_FRIENDLY_NAMES } from "@/components/events/event-display-helpers";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import {
  computePeriodRange,
  DEFAULT_PERIOD_KEY,
  type Event,
  type EventListFilterInput,
  type Filter,
  type FlowKind,
  type PaginationState,
  PERIOD_KEYS,
  type PivotFilterParams,
  parsePaginationSearchParams,
  parsePivotSearchParams,
  searchEventsAtAnchor,
  TAG_FIELDS,
  type TagField,
  TEXT_FIELDS,
  type TextField,
  totalPagesFrom,
} from "@/lib/detection";
import { COUNTRY_CODES } from "@/lib/detection/countries";
import { FLOW_KINDS } from "@/lib/detection/direction";
import {
  INITIAL_THREAT_KINDS,
  LEARNING_METHOD_VALUES,
  THREAT_CATEGORY_KEY_BY_VALUE,
  THREAT_CATEGORY_VALUES,
  THREAT_LEVEL_KEY_BY_VALUE,
  THREAT_LEVEL_VALUES,
} from "@/lib/detection/filter-options";
import type { LearningMethod, PageInfo } from "@/lib/detection/types";

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
  const locale = await getLocale();
  const rawParams = await searchParams;
  const pivotParams = parsePivotSearchParams(rawParams);
  let initialPagination: PaginationState =
    parsePaginationSearchParams(rawParams);
  // The client shell builds chip label strings from `labels.chipLabels`
  // — including the aggregate-count formatter that closes over the
  // active locale — so the server page only needs the plain strings.
  const summarizeLabels = {
    sensor: t("filters.chips.sensor"),
    sensorAggregate: t.raw("filters.chips.sensorAggregate") as string,
  };

  const defaultRange = computePeriodRange(DEFAULT_PERIOD_KEY);
  const initialInput: EventListFilterInput = {
    start: defaultRange.start,
    end: defaultRange.end,
  };
  if (pivotParams.source) initialInput.source = pivotParams.source;
  if (pivotParams.destination) {
    initialInput.destination = pivotParams.destination;
  }
  for (const field of TAG_FIELDS) {
    const values = pivotParams[field];
    if (values && values.length > 0) initialInput[field] = values;
  }
  const initialFilter: Filter = { mode: "structured", input: initialInput };

  // Pivot-only params carry through as chip state but aren't part of
  // the EventListFilterInput yet — they land in the Network/IP phase.
  const initialPivotOnly: PivotFilterParams = {
    kind: pivotParams.kind,
    origPort: pivotParams.origPort,
    respPort: pivotParams.respPort,
    proto: pivotParams.proto,
    window: pivotParams.window,
  };

  let initialTotal: string | null = null;
  let initialError: string | null = null;
  let initialEvents: Event[] = [];
  let initialEventKeys: string[] = [];
  let initialPageInfo: PageInfo | null = null;
  try {
    // `searchEventsAtAnchor` handles the cold-SSR two-step for a
    // `tail` deep link: the first call discovers `totalCount`, then
    // the helper's drift-correction loop re-queries with
    // `last: totalCount % pageSize` so a reload of
    // `?last=1&page=15&pageSize=100` lands on the labeled last page's
    // actual rows rather than the straddling `last: pageSize` window.
    // The same loop absorbs real-time total drift across consecutive
    // queries for free.
    const connection = await searchEventsAtAnchor(
      session,
      initialFilter,
      initialPagination.anchor,
      initialPagination.pageSize,
    );
    if (initialPagination.anchor.kind === "tail") {
      // Synchronise the page number with the real last page once the
      // total is known. A URL like `?last=1` without `?page=` parses
      // to `page: 1`; pair that with the tail anchor and the range
      // indicator would label the final slice as page 1. The derived
      // total-page count recovers the right label.
      const lastPage = totalPagesFrom(
        connection.totalCount,
        initialPagination.pageSize,
      );
      if (lastPage !== null && lastPage !== initialPagination.page) {
        initialPagination = { ...initialPagination, page: lastPage };
      }
    }
    initialTotal = connection.totalCount;
    initialEvents = connection.nodes;
    // Parallel to `nodes`: each `edges[i].cursor` is the stable
    // server identity for `nodes[i]`. The client uses it as the
    // row's React key so duplicate content can't collide.
    initialEventKeys = connection.edges.map((edge) => edge.cursor);
    initialPageInfo = connection.pageInfo;
  } catch {
    initialError = t("filters.resultsError");
  }

  const periodOptions = Object.fromEntries(
    PERIOD_KEYS.map((key) => [key, t(`filters.periodOptions.${key}`)]),
  ) as Record<(typeof PERIOD_KEYS)[number], string>;

  const directionOptions = Object.fromEntries(
    FLOW_KINDS.map((kind) => [kind, t(`filters.directionOptions.${kind}`)]),
  ) as Record<FlowKind, string>;
  const directionChipValues = Object.fromEntries(
    FLOW_KINDS.map((kind) => [kind, t(`filters.directionChipValues.${kind}`)]),
  ) as Record<FlowKind, string>;

  const options = buildFilterOptions(locale, {
    level: (key: string) => t(`filters.levelOptions.${key}`),
    category: (key: string) => t(`filters.categoryOptions.${key}`),
    learningMethod: (key: string) => t(`filters.learningMethodOptions.${key}`),
    countrySentinel: (code: "XX" | "ZZ") => ({
      label: t(`filters.countrySentinels.${code}.label`),
      searchAliases: t(`filters.countrySentinels.${code}.searchAliases`),
    }),
  });

  // Free-form fields: single-string text inputs (source, destination)
  // and tag inputs (keywords, hostnames, user*). Only plain strings
  // cross the server→client boundary here; the client shell uses
  // `useTranslations` to build the per-tag remove labels (which take a
  // dynamic `tag` arg) so no function prop is serialized.
  const textFieldLabels = Object.fromEntries(
    TEXT_FIELDS.map((field) => [
      field,
      {
        label: t(`filters.attributes.${field}.label`),
        placeholder: t(`filters.attributes.${field}.placeholder`),
      },
    ]),
  ) as Record<TextField, { label: string; placeholder: string }>;

  const tagFieldLabels = Object.fromEntries(
    TAG_FIELDS.map((field) => [
      field,
      {
        label: t(`filters.attributes.${field}.label`),
        placeholder: t(`filters.attributes.${field}.placeholder`),
      },
    ]),
  ) as Record<TagField, { label: string; placeholder: string }>;

  return (
    <DetectionShell
      title={t("title")}
      initialFilter={initialFilter}
      initialPeriod={DEFAULT_PERIOD_KEY}
      initialResult={{
        totalCount: initialTotal,
        error: initialError,
        events: initialEvents,
        eventKeys: initialEventKeys,
        pageInfo: initialPageInfo,
      }}
      initialPagination={initialPagination}
      options={options}
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
        directionChips: {
          label: t("filters.directionChipLabel"),
          values: directionChipValues,
        },
        endpointChips: {
          source: t("filters.endpoint.chipSource"),
          destination: t("filters.endpoint.chipDestination"),
          aggregate: t.raw("filters.endpoint.chipAggregate") as string,
        },
        confidenceChipLabel: t("filters.confidenceChipLabel"),
        chipLabels: {
          source: t("filters.chips.source"),
          destination: t("filters.chips.destination"),
          kind: t("filters.chips.kind"),
          origPort: t("filters.chips.origPort"),
          respPort: t("filters.chips.respPort"),
          proto: t("filters.chips.proto"),
          window: t("filters.chips.window"),
          windowLastDay: t("filters.chips.windowLastDay"),
          windowLastWeek: t("filters.chips.windowLastWeek"),
          keywords: t("filters.chips.keywords"),
          hostnames: t("filters.chips.hostnames"),
          userIds: t("filters.chips.userIds"),
          userNames: t("filters.chips.userNames"),
          userDepartments: t("filters.chips.userDepartments"),
        },
        drawer: {
          title: t("filters.drawerTitle"),
          description: t("filters.drawerDescription"),
          periodLabel: t("filters.periodLabel"),
          periodOptions,
          timeRangeLabel: t("filters.timeRangeLabel"),
          startLabel: t("filters.startLabel"),
          endLabel: t("filters.endLabel"),
          directionLabel: t("filters.directionLabel"),
          directionOptions,
          confidenceLabel: t("filters.confidenceLabel"),
          confidenceMinLabel: t("filters.confidenceMinLabel"),
          confidenceMaxLabel: t("filters.confidenceMaxLabel"),
          attributesLegend: t("filters.attributesLegend"),
          attributes: {
            source: textFieldLabels.source,
            destination: textFieldLabels.destination,
            keywords: tagFieldLabels.keywords,
            hostnames: tagFieldLabels.hostnames,
            userIds: tagFieldLabels.userIds,
            userNames: tagFieldLabels.userNames,
            userDepartments: tagFieldLabels.userDepartments,
          },
          apply: t("filters.apply"),
          saveThisFilter: t("filters.saveThisFilter"),
          saveThisFilterComingSoon: t("filters.saveThisFilterComingSoon"),
          invalidRange: t("filters.invalidRange"),
          close: t("filters.close"),
          endpointLabel: t("filters.endpoint.label"),
          endpointAdvanced: t("filters.endpoint.advanced"),
          endpointEmpty: t("filters.endpoint.empty"),
          endpointCount: t.raw("filters.endpoint.count") as string,
          endpointPanel: {
            title: t("filters.endpoint.panelTitle"),
            description: t("filters.endpoint.panelDescription"),
            close: t("filters.endpoint.close"),
            savedSectionTitle: t("filters.endpoint.savedSectionTitle"),
            savedEmpty: t("filters.endpoint.savedEmpty"),
            savedHelp: t("filters.endpoint.savedHelp"),
            customSectionTitle: t("filters.endpoint.customSectionTitle"),
            customEmpty: t("filters.endpoint.customEmpty"),
            inputLabel: t("filters.endpoint.inputLabel"),
            inputPlaceholder: t("filters.endpoint.inputPlaceholder"),
            addEntry: t("filters.endpoint.addEntry"),
            invalidInput: t("filters.endpoint.invalidInput"),
            invalidInputExamples: t("filters.endpoint.invalidInputExamples"),
            countBadge: t.raw("filters.endpoint.countBadge") as string,
            directionLabel: t("filters.endpoint.directionLabel"),
            directionBoth: t("filters.endpoint.directionBoth"),
            directionSource: t("filters.endpoint.directionSource"),
            directionDestination: t("filters.endpoint.directionDestination"),
            batchSetDirection: t("filters.endpoint.batchSetDirection"),
            selectAll: t("filters.endpoint.selectAll"),
            removeEntry: t("filters.endpoint.removeEntry"),
            done: t("filters.endpoint.done"),
          },
          customerLabel: t("filters.customerLabel"),
          customerComingSoon: t("filters.customerComingSoon"),
          customerComingSoonHint: t("filters.customerComingSoonHint"),
          sensor: {
            label: t("filters.sensor.label"),
            placeholder: t("filters.sensor.placeholder"),
            searchPlaceholder: t("filters.sensor.searchPlaceholder"),
            selectAll: t("filters.sensor.selectAll"),
            clearAll: t("filters.sensor.clearAll"),
            empty: t("filters.sensor.empty"),
            noMatches: t("filters.sensor.noMatches"),
            selectedSummary: t.raw("filters.sensor.selectedSummary") as string,
            removeSelection: t.raw("filters.sensor.removeSelection") as string,
            comingSoonLabel: t("filters.sensor.comingSoonLabel"),
            comingSoonHint: t("filters.sensor.comingSoonHint"),
            loadingLabel: t("filters.sensor.loadingLabel"),
            loadingHint: t("filters.sensor.loadingHint"),
            errorLabel: t("filters.sensor.errorLabel"),
            errorHint: t("filters.sensor.errorHint"),
            retry: t("filters.sensor.retry"),
          },
          categoricalSectionLabel: t("filters.categoricalSectionLabel"),
          fields: {
            levels: t("filters.fields.levels"),
            countries: t("filters.fields.countries"),
            learningMethods: t("filters.fields.learningMethods"),
            categories: t("filters.fields.categories"),
            kinds: t("filters.fields.kinds"),
          },
        },
        summarize: summarizeLabels,
        pagination: {
          pageSizeLabel: t("pagination.pageSizeLabel"),
          firstPage: t("pagination.firstPage"),
          previousPage: t("pagination.previousPage"),
          nextPage: t("pagination.nextPage"),
          lastPage: t("pagination.lastPage"),
          goToPageLabel: t("pagination.goToPageLabel"),
          goToPagePlaceholder: t("pagination.goToPagePlaceholder"),
          goToPageSubmit: t("pagination.goToPageSubmit"),
        },
      }}
      initialPivotOnly={initialPivotOnly}
    />
  );
}

interface OptionLabelFns {
  level: (key: string) => string;
  category: (key: string) => string;
  learningMethod: (key: string) => string;
  countrySentinel: (code: "XX" | "ZZ") => {
    label: string;
    searchAliases: string;
  };
}

const COUNTRY_SENTINEL_CODES = ["XX", "ZZ"] as const;
type CountrySentinelCode = (typeof COUNTRY_SENTINEL_CODES)[number];

function isCountrySentinel(code: string): code is CountrySentinelCode {
  return (COUNTRY_SENTINEL_CODES as readonly string[]).includes(code);
}

function buildFilterOptions(
  locale: string,
  labels: OptionLabelFns,
): FilterDrawerOptions {
  const countryNames = buildCountryNameResolver(locale);

  const levels: FilterMultiSelectOption<number>[] = THREAT_LEVEL_VALUES.map(
    (value) => ({
      value,
      label: labels.level(THREAT_LEVEL_KEY_BY_VALUE[value]),
    }),
  );

  const categories: FilterMultiSelectOption<number>[] =
    THREAT_CATEGORY_VALUES.map((value) => ({
      value,
      label: labels.category(THREAT_CATEGORY_KEY_BY_VALUE[value]),
      searchText: THREAT_CATEGORY_KEY_BY_VALUE[value],
    }));

  const learningMethods: FilterMultiSelectOption<LearningMethod>[] =
    LEARNING_METHOD_VALUES.map((value) => ({
      value,
      label: labels.learningMethod(value),
      searchText: value,
    }));

  const countries: FilterMultiSelectOption<string>[] = COUNTRY_CODES.map(
    (code) => {
      // REview sentinels (`XX` = location unknown, `ZZ` = location
      // database unavailable) are not valid ISO-3166 regions, so
      // `Intl.DisplayNames` rejects them. Surface an explicit
      // localized label + search aliases instead of the bare code so
      // the drawer rows are meaningful and can be discovered by
      // searching `unknown` / `unavailable` (or the KR equivalents).
      if (isCountrySentinel(code)) {
        const sentinel = labels.countrySentinel(code);
        return {
          value: code,
          label: `${sentinel.label} (${code})`,
          searchText: `${code} ${sentinel.searchAliases}`,
        };
      }
      const name = countryNames(code);
      return {
        value: code,
        label: name ? `${name} (${code})` : code,
        searchText: code,
      };
    },
  );

  // REview matches `EventListFilterInput.kinds` against the canonical
  // `__typename` tokens (`HttpThreat`, `PortScan`, …), so submit
  // those verbatim and surface the human-readable name only as the
  // drawer label. `searchText` keeps the raw token matchable too, so
  // searching `HttpThreat` or `http` both land on the same row.
  const kinds: FilterMultiSelectOption<string>[] = INITIAL_THREAT_KINDS.map(
    (kind) => ({
      value: kind,
      label: EVENT_KIND_FRIENDLY_NAMES[kind] ?? kind,
      searchText: kind,
    }),
  );

  return { levels, countries, learningMethods, categories, kinds };
}

function buildCountryNameResolver(
  locale: string,
): (code: string) => string | undefined {
  try {
    const display = new Intl.DisplayNames([locale], { type: "region" });
    return (code) => {
      // `Intl.DisplayNames` rejects the REview sentinels `XX` / `ZZ`.
      // Let the caller fall back to the bare code for those.
      try {
        return display.of(code);
      } catch {
        return undefined;
      }
    };
  } catch {
    return () => undefined;
  }
}
