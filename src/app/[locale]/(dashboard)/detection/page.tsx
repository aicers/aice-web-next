import { getLocale, getTranslations } from "next-intl/server";

import { DetectionTabsShell } from "@/components/detection/detection-tabs-shell";
import type { FilterDrawerOptions } from "@/components/detection/filter-drawer";
import type { FilterMultiSelectOption } from "@/components/detection/filter-multi-select";
import { EVENT_KIND_FRIENDLY_NAMES } from "@/components/events/event-display-helpers";
import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { getCurrentSession, requirePermission } from "@/lib/auth/session";
import {
  classifyEventQueryError,
  computePeriodRange,
  DEFAULT_PERIOD_KEY,
  type EncodedTabFilter,
  type EndpointEntry,
  type Event,
  type EventListFilterInput,
  FILTER_URL_PARAM,
  type Filter,
  type FlowKind,
  type PaginationState,
  PERIOD_KEYS,
  type PeriodKey,
  type PivotFilterParams,
  parseFilterFromUrlParam,
  parsePaginationSearchParams,
  parsePivotSearchParams,
  pivotExtrasFromPivotParams,
  pivotWindowToPeriodKey,
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
  THREAT_LEVEL_VALUES,
} from "@/lib/detection/filter-options";
import { QUICK_PEEK_EVENT_PARAM } from "@/lib/detection/quick-peek-url";
import { RECOMMENDED_PRESETS } from "@/lib/detection/recommended-filters";
import { createTabId, type TabId } from "@/lib/detection/tabs";
import type {
  LearningMethod,
  PageInfo,
  ThreatLevel,
} from "@/lib/detection/types";
import { decodeEventLocator } from "@/lib/events/event-locator";

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
  const scope = await getEffectiveCustomerScope(session);
  const rawParams = await searchParams;
  let initialPagination: PaginationState =
    parsePaginationSearchParams(rawParams);
  // The client shell builds chip label strings from `labels.chipLabels`
  // — including the aggregate-count formatter that closes over the
  // active locale — so the server page only needs the plain strings.
  const summarizeLabels = {
    sensor: t("filters.chips.sensor"),
    sensorAggregate: t.raw("filters.chips.sensorAggregate") as string,
    customerAggregate: t.raw("filters.chips.customerAggregate") as string,
  };

  // Phase Detection-10 persistence contract: prefer the encoded `?f=`
  // blob (carries the full Filter — every `EventListFilterInput` field
  // plus `mode: "query"` once the search-language phase lands) and
  // fall back to the legacy pivot params (`source=`, `kind=`,
  // `window=`, …) only when `?f=` is absent. The fallback exists so
  // outbound Investigation handoff links of the shape
  // `/detection?source=X&window=1d&kind=HttpThreat` keep bootstrapping
  // the destination tab; on the next state mutation the URL writer
  // flips over to `?f=` and clears the legacy fields.
  const encodedFilter: EncodedTabFilter | null =
    typeof rawParams[FILTER_URL_PARAM] === "string"
      ? parseFilterFromUrlParam(rawParams[FILTER_URL_PARAM] as string)
      : null;
  let initialFilter: Filter;
  let pivotPeriod: PeriodKey | null;
  let initialPivotOnly: PivotFilterParams;
  let initialEndpoints: EndpointEntry[];
  if (encodedFilter) {
    initialFilter = encodedFilter.filter;
    pivotPeriod = encodedFilter.period;
    initialPivotOnly = { ...encodedFilter.pivotExtras };
    initialEndpoints = encodedFilter.endpoints;
  } else {
    const pivotParams = parsePivotSearchParams(rawParams);
    // Pivot links (Quick peek, Related Events, Overview Top Pivots)
    // encode an optional `window=` and `kind=` alongside
    // source/destination so the destination page actually narrows to
    // the requested slice rather than landing on the default 1h /
    // unfiltered view. Translate them into the drawer's vocabulary —
    // `window=1d/7d` picks the matching period key and the resulting
    // start/end, `kind=` seeds the Kinds multi-select with a single
    // entry — so the committed query honors the pivot contract on the
    // first render.
    pivotPeriod =
      pivotWindowToPeriodKey(pivotParams.window) ?? DEFAULT_PERIOD_KEY;
    const periodRange = computePeriodRange(pivotPeriod);
    const initialInput: EventListFilterInput = {
      start: periodRange.start,
      end: periodRange.end,
    };
    if (pivotParams.source) initialInput.source = pivotParams.source;
    if (pivotParams.destination) {
      initialInput.destination = pivotParams.destination;
    }
    if (pivotParams.kind) {
      initialInput.kinds = [pivotParams.kind];
    }
    for (const field of TAG_FIELDS) {
      const values = pivotParams[field];
      if (values && values.length > 0) initialInput[field] = values;
    }
    // Reviewer Round 5: pivot URLs and Investigation back-links carry
    // the operator's active customer narrowing as `customers=1,2`.
    // Thread it into the committed filter so the very first SSR
    // dispatch honours the narrowing — and so a crafted out-of-scope
    // ID flows into the BFF intersection check rather than being
    // silently dropped before it reaches the gate.
    if (pivotParams.customers && pivotParams.customers.length > 0) {
      initialInput.customers = pivotParams.customers;
    }
    initialFilter = { mode: "structured", input: initialInput };
    // Port / proto are not yet part of `EventListFilterInput`; they
    // ride in the URL so Phase Network/IP can pick them up without
    // losing the pivot target. They land in `initialPivotOnly` and
    // round-trip into the encoded `?f=` blob on the next state
    // mutation.
    initialPivotOnly = { ...pivotExtrasFromPivotParams(pivotParams) };
    initialEndpoints = [];
  }

  let initialTotal: string | null = null;
  let initialError: string | null = null;
  let initialEvents: Event[] = [];
  let initialEventKeys: string[] = [];
  let initialPageInfo: PageInfo | null = null;
  // #278: populated when the SSR bootstrap query fails with the typed
  // `forbidden-sensor-scope` classification (review-web 0.33.0's
  // `eventList` rejection on an out-of-scope `sensors` argument
  // reached via a tampered URL, stale saved filter, or mid-session
  // scope change on a cold load). Threaded into the bootstrap tab's
  // initial result so the shell can render the "selection no longer
  // accessible" banner with the same name-aware copy and one-click
  // drop-and-reapply recovery the client-side Apply path offers.
  let initialForbiddenSensorIds: readonly string[] | null = null;
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
  } catch (err) {
    // #405 I: review's typed denials surface as the explicit
    // forbidden-scope panel rather than the generic banner — the
    // security guardrails forbid conflating "denied" with "no
    // data".
    //
    // #278: cold loads from a bookmarked / saved / tampered URL run
    // through this SSR path, *not* `runEventQuery`, so the typed
    // classification has to happen here too. Reuse the shared
    // `classifyEventQueryError` helper so a `Forbidden` against a
    // filter carrying out-of-scope `sensors` lands the operator on
    // the same "selection no longer accessible" banner and
    // drop-and-reapply recovery the client-side Apply path offers.
    //
    // Reviewer Round 2 P1: `ReviewUnknownGraphQLError` deliberately
    // propagates past the classifier — review answered with a code
    // we don't classify, and masking that as the generic results
    // banner would hide a real bug from operators. The route's
    // error boundary surfaces it. Plain `Error`s (transport drops,
    // BFF bugs) keep rendering the generic banner so the rest of
    // the shell stays usable.
    const classified = classifyEventQueryError(err, initialFilter);
    switch (classified.code) {
      case "forbidden-sensor-scope":
        initialError = t("filters.resultsForbiddenSensor.title");
        initialForbiddenSensorIds = classified.unavailableSensorIds ?? [];
        break;
      case "forbidden-customer-scope":
      case "forbidden":
        initialError = t("filters.resultsForbiddenScope");
        break;
      default:
        initialError = t("filters.resultsError");
        break;
    }
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

  // Anchor the bootstrap tab to the URL-supplied `?tab=<id>` token
  // when present so a reload / bookmark reuses the same tab id. The
  // client-side wrapper checks this id against sessionStorage to
  // decide whether to promote a stored payload onto the bootstrap
  // tab (matching id → the reload case, restore UX state) or keep
  // the bootstrap fresh (mismatched id → link share, ignore prior
  // session). Raw `tab` values from the URL are accepted as-is
  // modulo a character-class filter so a malicious caller can't
  // inject fragment-breaking tokens.
  const rawTab = rawParams.tab;
  const tabId: TabId =
    typeof rawTab === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawTab)
      ? rawTab
      : createTabId();

  // Reviewer Round 9: capture the Quick peek `?event=<locator>` token
  // server-side and seed it as `pendingQuickPeekToken` on the
  // bootstrap tab. The multi-tab wrapper's mount-time URL effect
  // re-emits this token when `quickPeekEvent` is null, so a shared
  // link whose first slice errors keeps the URL token intact while
  // the operator's Retry / Refresh runs — without this seed, the
  // wrapper's first replaceState would clobber the token before the
  // recovered slice could match it. Strict-validate the token via
  // `decodeEventLocator` so a tampered or malformed `?event=` value
  // is treated as no token rather than round-tripped indefinitely.
  const rawEventToken = rawParams[QUICK_PEEK_EVENT_PARAM];
  const initialQuickPeekToken: string | null =
    typeof rawEventToken === "string" && decodeEventLocator(rawEventToken)
      ? rawEventToken
      : null;

  const shellLabels = {
    exportConfirm: {
      title: t("results.exportConfirm.title"),
      descriptionTemplate: t.raw("results.exportConfirm.description") as string,
      continueLabel: t("results.exportConfirm.continue"),
      cancelLabel: t("results.exportConfirm.cancel"),
      narrowFilterLabel: t("results.exportConfirm.narrowFilter"),
    },
    exportErrorMessage: t("results.downloadErrorDescription"),
    exportForbiddenScopeMessage: t("results.downloadForbiddenScopeDescription"),
    exportLimitExceededTemplate: t.raw(
      "results.downloadLimitExceededDescription",
    ) as string,
    exportColumnHeaders: {
      level: t("results.csvHeaders.level"),
      time: t("results.csvHeaders.time"),
      kind: t("results.csvHeaders.kind"),
      attackKind: t("results.csvHeaders.attackKind"),
      category: t("results.csvHeaders.category"),
      confidence: t("results.csvHeaders.confidence"),
      triage: t("results.csvHeaders.triage"),
      source: t("results.csvHeaders.source"),
      destination: t("results.csvHeaders.destination"),
      sensor: t("results.csvHeaders.sensor"),
      userName: t("results.csvHeaders.userName"),
      hostname: t("results.csvHeaders.hostname"),
    },
    // Issue #428: the saved + recommended filter sections are now
    // surfaced as an on-demand dropdown next to the Filters button
    // rather than an always-visible left rail. The label set
    // collapses what used to be three separate label blocks
    // (`savedRail.*`, `savedFiltersRail`, `recommendedFilters.*`)
    // into a single `presetsDropdown` payload the dropdown consumes.
    // Preset names still live under `detection.recommendedFilters.*`
    // so the static client-side list keeps a single source of truth.
    presetsDropdown: {
      trigger: t("presets.trigger"),
      recommendedHeading: t("presets.recommendedHeading"),
      recommendedEmpty: t("presets.recommendedEmpty"),
      recommendedPresetNames: Object.fromEntries(
        RECOMMENDED_PRESETS.map((preset) => [
          preset.id,
          t(`recommendedFilters.${preset.nameKey}`),
        ]),
      ) as Record<string, string>,
      savedHeading: t("presets.savedHeading"),
      savedLoading: t("presets.savedLoading"),
      savedLoadError: t("presets.savedError"),
      savedEmpty: t("presets.savedEmpty"),
      savedRowMenuLabelTemplate: t.raw("presets.savedRowMenuLabel") as string,
      openInNewTabTemplate: t.raw("presets.openInNewTab") as string,
      loadInNewTab: t("presets.loadInNewTab"),
      loadInCurrentTab: t("presets.loadInCurrentTab"),
      rename: t("presets.rename"),
      delete: t("presets.delete"),
      saveCurrentFilter: t("presets.saveCurrentFilter"),
      deleteConfirm: {
        title: t("presets.deleteConfirm.title"),
        descriptionTemplate: t.raw(
          "presets.deleteConfirm.description",
        ) as string,
        cancel: t("presets.deleteConfirm.cancel"),
        confirm: t("presets.deleteConfirm.confirm"),
        error: t("presets.deleteConfirm.error"),
      },
      renameDialog: {
        title: t("presets.renameDialog.title"),
        description: t("presets.renameDialog.description"),
        nameLabel: t("presets.renameDialog.nameLabel"),
        namePlaceholder: t("presets.renameDialog.namePlaceholder"),
        cancel: t("presets.renameDialog.cancel"),
        submit: t("presets.renameDialog.submit"),
        submitting: t("presets.renameDialog.submitting"),
        errors: {
          empty: t("presets.renameDialog.errors.empty"),
          duplicate: t("presets.renameDialog.errors.duplicate"),
          tooLong: t("presets.renameDialog.errors.tooLong"),
          server: t("presets.renameDialog.errors.server"),
          unauthenticated: t("presets.renameDialog.errors.unauthenticated"),
        },
      },
    },
    saveFilterDialog: {
      title: t("saveFilterDialog.title"),
      description: t("saveFilterDialog.description"),
      nameLabel: t("saveFilterDialog.nameLabel"),
      namePlaceholder: t("saveFilterDialog.namePlaceholder"),
      cancel: t("saveFilterDialog.cancel"),
      submit: t("saveFilterDialog.submit"),
      submitting: t("saveFilterDialog.submitting"),
      errors: {
        empty: t("saveFilterDialog.errors.empty"),
        duplicate: t("saveFilterDialog.errors.duplicate"),
        tooLong: t("saveFilterDialog.errors.tooLong"),
        server: t("saveFilterDialog.errors.server"),
        unauthenticated: t("saveFilterDialog.errors.unauthenticated"),
      },
    },
    filtersOpen: t("filters.open"),
    activeChipsEmpty: t("filters.activeChipsEmpty"),
    resultsRegion: t("filters.resultsRegion"),
    resultsLoading: t("filters.resultsLoading"),
    resultsError: t("filters.resultsError"),
    resultsForbiddenScope: t("filters.resultsForbiddenScope"),
    resultsForbiddenSensor: {
      title: t("filters.resultsForbiddenSensor.title"),
      descriptionNamed: t.raw(
        "filters.resultsForbiddenSensor.descriptionNamed",
      ) as string,
      descriptionUnresolved: t.raw(
        "filters.resultsForbiddenSensor.descriptionUnresolved",
      ) as string,
      descriptionMixed: t.raw(
        "filters.resultsForbiddenSensor.descriptionMixed",
      ) as string,
      recoveryAction: t("filters.resultsForbiddenSensor.recoveryAction"),
      recoveryConfirmation: t(
        "filters.resultsForbiddenSensor.recoveryConfirmation",
      ),
    },
    analyticsToggle: t("analytics.toggle"),
    analyticsShow: t("analytics.show"),
    analyticsHide: t("analytics.hide"),
    analytics: {
      dimensionLabel: t("analytics.dimensionLabel"),
      dimensionOptions: {
        srcIp: t("analytics.dimensionOptions.srcIp"),
        dstIp: t("analytics.dimensionOptions.dstIp"),
        country: t("analytics.dimensionOptions.country"),
        category: t("analytics.dimensionOptions.category"),
        level: t("analytics.dimensionOptions.level"),
        kind: t("analytics.dimensionOptions.kind"),
      },
      topNLabel: t("analytics.topNLabel"),
      topNChartTitleTemplate: t.raw(
        "analytics.topNChartTitleTemplate",
      ) as string,
      timeSeriesTitle: t("analytics.timeSeriesTitle"),
      countSuffixTemplate: t.raw("analytics.countSuffixTemplate") as string,
      bucketLabelTemplate: t.raw("analytics.bucketLabelTemplate") as string,
      periodSecondsTemplate: t.raw("analytics.periodSecondsTemplate") as string,
      periodMinutesTemplate: t.raw("analytics.periodMinutesTemplate") as string,
      periodHoursTemplate: t.raw("analytics.periodHoursTemplate") as string,
      periodDaysTemplate: t.raw("analytics.periodDaysTemplate") as string,
      periodWeeksTemplate: t.raw("analytics.periodWeeksTemplate") as string,
      loadingTitle: t("analytics.loadingTitle"),
      loadingDescription: t("analytics.loadingDescription"),
      errorTitle: t("analytics.errorTitle"),
      errorDescription: t("analytics.errorDescription"),
      errorRetry: t("analytics.errorRetry"),
      forbiddenTitle: t("analytics.forbiddenTitle"),
      forbiddenDescription: t("analytics.forbiddenDescription"),
      forbiddenScopeTitle: t("analytics.forbiddenScopeTitle"),
      forbiddenScopeDescription: t("analytics.forbiddenScopeDescription"),
      emptyTitle: t("analytics.emptyTitle"),
      emptyDescription: t("analytics.emptyDescription"),
      levelLabels: {
        VERY_LOW: t("filters.levelOptions.VERY_LOW"),
        LOW: t("filters.levelOptions.LOW"),
        MEDIUM: t("filters.levelOptions.MEDIUM"),
        HIGH: t("filters.levelOptions.HIGH"),
        VERY_HIGH: t("filters.levelOptions.VERY_HIGH"),
      },
      categoryLabels: {
        RECONNAISSANCE: t("filters.categoryOptions.RECONNAISSANCE"),
        INITIAL_ACCESS: t("filters.categoryOptions.INITIAL_ACCESS"),
        EXECUTION: t("filters.categoryOptions.EXECUTION"),
        CREDENTIAL_ACCESS: t("filters.categoryOptions.CREDENTIAL_ACCESS"),
        DISCOVERY: t("filters.categoryOptions.DISCOVERY"),
        LATERAL_MOVEMENT: t("filters.categoryOptions.LATERAL_MOVEMENT"),
        COMMAND_AND_CONTROL: t("filters.categoryOptions.COMMAND_AND_CONTROL"),
        EXFILTRATION: t("filters.categoryOptions.EXFILTRATION"),
        IMPACT: t("filters.categoryOptions.IMPACT"),
        COLLECTION: t("filters.categoryOptions.COLLECTION"),
        DEFENSE_EVASION: t("filters.categoryOptions.DEFENSE_EVASION"),
        PERSISTENCE: t("filters.categoryOptions.PERSISTENCE"),
        PRIVILEGE_ESCALATION: t("filters.categoryOptions.PRIVILEGE_ESCALATION"),
        RESOURCE_DEVELOPMENT: t("filters.categoryOptions.RESOURCE_DEVELOPMENT"),
      },
      countryUnknown: t("results.countryUnknown"),
      countryUnavailable: t("results.countryUnavailable"),
      pivotActivateTemplate: t.raw("analytics.pivotActivateTemplate") as string,
    },
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
      customers: t("filters.chips.customers"),
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
      saveThisFilterDisabled: t("filters.saveThisFilterDisabled"),
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
      customer: {
        label: t("filters.customer.label"),
        placeholder: t("filters.customer.placeholder"),
        searchPlaceholder: t("filters.customer.searchPlaceholder"),
        selectAll: t("filters.customer.selectAll"),
        clearAll: t("filters.customer.clearAll"),
        emptyScope: t("filters.customer.emptyScope"),
        noMatches: t("filters.customer.noMatches"),
        selectedSummary: t.raw("filters.customer.selectedSummary") as string,
        removeSelection: t.raw("filters.customer.removeSelection") as string,
        loadingLabel: t("filters.customer.loadingLabel"),
        loadingHint: t("filters.customer.loadingHint"),
        errorLabel: t("filters.customer.errorLabel"),
        errorHint: t("filters.customer.errorHint"),
        retry: t("filters.customer.retry"),
        refresh: t("filters.customer.refresh"),
      },
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
        refresh: t("filters.sensor.refresh"),
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
    quickPeek: {
      close: t("quickPeek.close"),
      summaryHeading: t("quickPeek.summaryHeading"),
      endpointsHeading: t("quickPeek.endpointsHeading"),
      detectionMetaHeading: t("quickPeek.detectionMetaHeading"),
      protocolHeading: t("quickPeek.protocolHeading"),
      actionsHeading: t("quickPeek.actionsHeading"),
      sourceLabel: t("quickPeek.sourceLabel"),
      destinationLabel: t("quickPeek.destinationLabel"),
      sensorLabel: t("quickPeek.sensorLabel"),
      attackKindLabel: t("quickPeek.attackKindLabel"),
      learningMethodLabel: t("quickPeek.learningMethodLabel"),
      learningMethodValues: {
        UNSUPERVISED: t("quickPeek.learningMethodUnsupervised"),
        SEMI_SUPERVISED: t("quickPeek.learningMethodSemiSupervised"),
      },
      confidenceLabel: t("quickPeek.confidenceLabel"),
      categoryLabels: {
        RECONNAISSANCE: t("filters.categoryOptions.RECONNAISSANCE"),
        INITIAL_ACCESS: t("filters.categoryOptions.INITIAL_ACCESS"),
        EXECUTION: t("filters.categoryOptions.EXECUTION"),
        CREDENTIAL_ACCESS: t("filters.categoryOptions.CREDENTIAL_ACCESS"),
        DISCOVERY: t("filters.categoryOptions.DISCOVERY"),
        LATERAL_MOVEMENT: t("filters.categoryOptions.LATERAL_MOVEMENT"),
        COMMAND_AND_CONTROL: t("filters.categoryOptions.COMMAND_AND_CONTROL"),
        EXFILTRATION: t("filters.categoryOptions.EXFILTRATION"),
        IMPACT: t("filters.categoryOptions.IMPACT"),
        COLLECTION: t("filters.categoryOptions.COLLECTION"),
        DEFENSE_EVASION: t("filters.categoryOptions.DEFENSE_EVASION"),
        PERSISTENCE: t("filters.categoryOptions.PERSISTENCE"),
        PRIVILEGE_ESCALATION: t("filters.categoryOptions.PRIVILEGE_ESCALATION"),
        RESOURCE_DEVELOPMENT: t("filters.categoryOptions.RESOURCE_DEVELOPMENT"),
      },
      levelLabels: {
        VERY_LOW: t("filters.levelOptions.VERY_LOW"),
        LOW: t("filters.levelOptions.LOW"),
        MEDIUM: t("filters.levelOptions.MEDIUM"),
        HIGH: t("filters.levelOptions.HIGH"),
        VERY_HIGH: t("filters.levelOptions.VERY_HIGH"),
      },
      protocolFields: {
        dnsQuery: t("quickPeek.protocolFields.dnsQuery"),
        dnsQueryType: t("quickPeek.protocolFields.dnsQueryType"),
        dnsResponseCode: t("quickPeek.protocolFields.dnsResponseCode"),
        httpMethod: t("quickPeek.protocolFields.httpMethod"),
        httpHost: t("quickPeek.protocolFields.httpHost"),
        httpUri: t("quickPeek.protocolFields.httpUri"),
        httpStatusCode: t("quickPeek.protocolFields.httpStatusCode"),
        tlsServerName: t("quickPeek.protocolFields.tlsServerName"),
        tlsVersion: t("quickPeek.protocolFields.tlsVersion"),
        tlsJa3: t("quickPeek.protocolFields.tlsJa3"),
        startTime: t("quickPeek.protocolFields.startTime"),
        endTime: t("quickPeek.protocolFields.endTime"),
        userList: t("quickPeek.protocolFields.userList"),
        isInternal: t("quickPeek.protocolFields.isInternal"),
        networkService: t("quickPeek.protocolFields.networkService"),
      },
      booleanTrue: t("quickPeek.booleanTrue"),
      booleanFalse: t("quickPeek.booleanFalse"),
      openInvestigation: t("quickPeek.openInvestigation"),
      openInvestigationTooltip: t("quickPeek.openInvestigationTooltip"),
      pivotSource: t("quickPeek.pivotSource"),
      pivotDestination: t("quickPeek.pivotDestination"),
      pivotKind: t("quickPeek.pivotKind"),
      copy: t("quickPeek.copy"),
      copied: t("quickPeek.copied"),
      countryUnknown: t("results.countryUnknown"),
      countryUnavailable: t("results.countryUnavailable"),
      portSeparator: t("quickPeek.portSeparator"),
      unknownTime: t("results.unknownTime"),
      noSensor: t("results.noSensor"),
    },
  };

  return (
    <>
      <CustomerScopeCallout scope={scope} className="mb-4" />
      <DetectionTabsShell
        title={t("title")}
        options={options}
        initialCustomerScope={{
          // Reviewer Round 1 #3 + Round 3 #1: thread the SSR-resolved
          // scope through to the wrapper as a chip-name display
          // fallback only — the shared customer cache itself starts
          // `idle` and is populated on the first drawer open. The
          // fallback lets a bookmarked / saved-filter / pivot URL
          // paint customer **names** on the very first render rather
          // than raw IDs while the first-open fetch is still pending.
          kind: scope.kind,
          customers: scope.customers.map((c) => ({ id: c.id, name: c.name })),
        }}
        initialTab={{
          id: tabId,
          filter: initialFilter,
          period: pivotPeriod,
          pivotOnly: initialPivotOnly,
          endpoints: initialEndpoints,
          pagination: initialPagination,
          result: {
            totalCount: initialTotal,
            error: initialError,
            events: initialEvents,
            eventKeys: initialEventKeys,
            pageInfo: initialPageInfo,
            // #278: seed the bootstrap tab's sensor-scope affordance
            // when the SSR query failed with the new
            // `forbidden-sensor-scope` classification. `null` (the
            // common case) means the shell skips the banner entirely.
            forbiddenSensorIds: initialForbiddenSensorIds,
          },
          quickPeekToken: initialQuickPeekToken,
        }}
        labels={{
          shell: shellLabels,
          tabs: {
            tablist: t("tabs.tablist"),
            newTab: t("tabs.newTab"),
            newTabAtCap: t("tabs.newTabAtCap"),
            closeTab: t("tabs.closeTab"),
            renameTab: t("tabs.renameTab"),
            resetName: t("tabs.resetName"),
          },
          tabFallbackName: t("tabs.fallbackName"),
          pivot: {
            // Pass ICU templates as plain strings so the server→client
            // boundary stays serialization-safe; the client wrapper does
            // a single `.replace("{value}", …)` / `.replace("{max}", …)`
            // before showing the toast.
            alreadyFilteredTemplate: t.raw("pivot.alreadyFiltered") as string,
            tabCapReachedTemplate: t.raw("pivot.tabCapReached") as string,
            dismissToast: t("pivot.dismissToast"),
          },
        }}
      />
    </>
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

  const levels: FilterMultiSelectOption<ThreatLevel>[] =
    THREAT_LEVEL_VALUES.map((value) => ({
      value,
      label: labels.level(value),
    }));

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
