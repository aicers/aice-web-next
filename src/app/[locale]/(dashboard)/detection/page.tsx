import { getLocale, getTranslations } from "next-intl/server";

import { DetectionShell } from "@/components/detection/detection-shell";
import type { FilterDrawerOptions } from "@/components/detection/filter-drawer";
import type { FilterMultiSelectOption } from "@/components/detection/filter-multi-select";
import { EVENT_KIND_FRIENDLY_NAMES } from "@/components/events/event-display-helpers";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import {
  type Filter,
  type FlowKind,
  PERIOD_KEYS,
  parsePivotSearchParams,
  searchEvents,
  TAG_FIELDS,
  type TagField,
  TEXT_FIELDS,
  type TextField,
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
import { applyPivotHandoff } from "@/lib/detection/pivot-handoff";
import type { LearningMethod, ThreatCategory } from "@/lib/detection/types";

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
  // The client shell builds chip label strings from `labels.chipLabels`
  // — including the aggregate-count formatter that closes over the
  // active locale — so the server page only needs the plain strings.
  const summarizeLabels = {
    sensor: t("filters.chips.sensor"),
    sensorAggregate: t.raw("filters.chips.sensorAggregate") as string,
  };

  // Pivot URL params fold into the structured filter so the result
  // set actually narrows — `kind` becomes `input.kinds`, `window`
  // overrides `start`/`end` + the period selection. Ports and proto
  // stay pivot-only (no first-class filter input yet) and land as
  // chip-only state in the shell.
  const {
    initialFilter: initialInput,
    initialPeriod,
    residualPivotOnly: initialPivotOnly,
  } = applyPivotHandoff(pivotParams);
  const initialFilter: Filter = { mode: "structured", input: initialInput };

  let initialTotal: string | null = null;
  let initialError: string | null = null;
  let initialEvents: Array<import("@/lib/detection").Event> = [];
  let initialCursors: (string | null)[] = [];
  let initialFetchedAt: string | null = null;
  try {
    const connection = await searchEvents(session, initialFilter, {
      first: 50,
    });
    initialTotal = connection.totalCount;
    initialEvents = connection.edges.map((edge) => edge.node);
    initialCursors = connection.edges.map((edge) => edge.cursor ?? null);
    initialFetchedAt = new Date().toISOString();
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

  // The hero row and the filter drawer both label `ThreatCategory`
  // values; they must share the same localized strings so that a
  // `ko` user does not see `Initial Access` in the row but the KR
  // translation in the drawer for the same category. The map is
  // built once here and threaded into `list.categoryLabels`.
  const categoryLabels = Object.fromEntries(
    THREAT_CATEGORY_VALUES.map((value) => {
      const key = THREAT_CATEGORY_KEY_BY_VALUE[value];
      return [key, t(`filters.categoryOptions.${key}`)];
    }),
  ) as Record<ThreatCategory, string>;

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
      initialPeriod={initialPeriod}
      initialResult={{
        totalCount: initialTotal,
        error: initialError,
        events: initialEvents,
        cursors: initialCursors,
        fetchedAt: initialFetchedAt,
      }}
      options={options}
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
        removeChip: t.raw("filters.removeChip") as string,
        periodChipLabel: t("filters.periodChipLabel"),
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
        list: {
          region: t("results.region"),
          loading: t("results.loading"),
          headerCount: t("results.headerCount"),
          headerCountKnown: t.raw("results.headerCountKnown") as string,
          headerCountRange: t.raw("results.headerCountRange") as string,
          downloadCsv: t("results.downloadCsv"),
          downloadCsvComingSoon: t("results.downloadCsvComingSoon"),
          refresh: t("results.refresh"),
          updatedRelative: t.raw("results.updatedRelative") as string,
          updatedJustNow: t("results.updatedJustNow"),
          updatedNever: t("results.updatedNever"),
          emptyTitle: t("results.emptyTitle"),
          emptyBody: t("results.emptyBody"),
          preQueryTitle: t("results.preQueryTitle"),
          preQueryBody: t("results.preQueryBody"),
          openInvestigation: t("results.openInvestigation"),
          confidence: t.raw("results.confidence") as string,
          triageSummary: t.raw("results.triageSummary") as string,
          unknownEndpoint: t("results.unknownEndpoint"),
          attackKindLabel: t.raw("results.attackKindLabel") as string,
          moreCount: t.raw("results.moreCount") as string,
          moreAddressesTitle: t("results.moreAddressesTitle"),
          moreAddressesCount: t.raw("results.moreAddressesCount") as string,
          morePortsTitle: t("results.morePortsTitle"),
          morePortsCount: t.raw("results.morePortsCount") as string,
          rowTrigger: t.raw("results.rowTrigger") as string,
          pivotKind: t.raw("results.pivotKind") as string,
          pivotSourceIp: t.raw("results.pivotSourceIp") as string,
          pivotDestinationIp: t.raw("results.pivotDestinationIp") as string,
          categoryLabels,
        },
        quickPeek: {
          title: t("quickPeek.title"),
          description: t("quickPeek.description"),
          placeholder: t("quickPeek.placeholder"),
          openInvestigation: t("quickPeek.openInvestigation"),
          close: t("quickPeek.close"),
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
