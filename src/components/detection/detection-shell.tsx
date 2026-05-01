"use client";

import {
  Bookmark,
  ChevronRight,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type RunEventQueryResult,
  runEventQuery,
} from "@/app/[locale]/(dashboard)/detection/actions";
import {
  type FetchSensorsResult,
  fetchSensors,
} from "@/app/[locale]/(dashboard)/detection/sensor-actions";
import {
  CsvExportConfirmDialog,
  type CsvExportConfirmLabels,
} from "@/components/detection/csv-export-dialog";
import {
  DetectionAnalytics,
  type DetectionAnalyticsLabels,
} from "@/components/detection/detection-analytics";
import { isMorePopoverOpen } from "@/components/detection/more-popover";
import {
  PaginationControls,
  type PaginationControlsLabels,
} from "@/components/detection/pagination-controls";
import {
  QuickPeekInspector,
  type QuickPeekInspectorLabels,
} from "@/components/detection/quick-peek-inspector";
import {
  RecommendedFiltersRail,
  type RecommendedFiltersRailLabels,
} from "@/components/detection/recommended-filters-rail";
import {
  ResultList,
  type ResultListLabels,
  type ResultListState,
} from "@/components/detection/result-list";
import {
  SaveFilterDialog,
  type SaveFilterDialogLabels,
} from "@/components/detection/save-filter-dialog";
import {
  SavedFiltersRail,
  type SavedFiltersRailLabels,
} from "@/components/detection/saved-filters-rail";
import {
  type CsvExportPayload,
  useCsvExport,
} from "@/components/detection/use-csv-export";
import { useCsvExportTotalCountGetter } from "@/components/detection/use-render-synced-ref";
import type { UseSavedFiltersResult } from "@/components/detection/use-saved-filters";
import { EVENT_KIND_FRIENDLY_NAMES } from "@/components/events/event-display-helpers";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useRouter } from "@/i18n/navigation";
import {
  type ChipRemoveTarget,
  removeActiveChip,
} from "@/lib/detection/active-filters";
import {
  type AnalyticsDimension,
  type AnalyticsTopN,
  DEFAULT_ANALYTICS_DIMENSION,
  DEFAULT_ANALYTICS_TOP_N,
} from "@/lib/detection/analytics";
import { buildAppliedFilter } from "@/lib/detection/apply-filter";
import type { DirectionChipLabels } from "@/lib/detection/direction";
import { readDirectionsFromInput } from "@/lib/detection/direction";
import {
  buildEndpointChips,
  type EndpointChipLabels,
  type EndpointEntry,
  endpointEntriesFromEndpointInputs,
} from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import { parsePositiveCustomerId } from "@/lib/detection/filter-customer-scope";
import {
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  type DetectionFilterDraft,
  isoToLocalInput,
} from "@/lib/detection/filter-draft";
import { analyticsFilterIdentity } from "@/lib/detection/filter-identity";
import {
  type FilterChip,
  type FilterChipFocus,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/filter-summary";
import {
  buildSearchParamsForFilter,
  type EncodedTabFilter,
  type PivotExtras,
} from "@/lib/detection/filter-url";
import {
  committedPageForAnchor,
  INITIAL_PAGINATION_STATE,
  type PageAnchor,
  type PageSize,
  type PaginationState,
  pageAtNewSize,
  paginationToSearchEntries,
  totalPagesFrom,
} from "@/lib/detection/pagination";
import {
  DEFAULT_PERIOD_KEY,
  matchesPeriodKey,
  type PeriodKey,
} from "@/lib/detection/period";
import type { PivotPatch } from "@/lib/detection/pivot";
import {
  applyQuickPeekToken,
  readQuickPeekToken,
} from "@/lib/detection/quick-peek-url";
import type { RecommendedPreset } from "@/lib/detection/recommended-filters";
import {
  autoTabName as autoTabNameFromChips,
  preserveActiveTabParam,
} from "@/lib/detection/tabs";
import type {
  Event as DetectionEvent,
  LearningMethod,
  PageInfo,
} from "@/lib/detection/types";
import type {
  PivotChipLabels,
  PivotFilterParams,
  TagField,
} from "@/lib/detection/url-filters";
import { encodeEventLocator } from "@/lib/events/event-locator";
import { cn } from "@/lib/utils";
import type {
  CustomerMultiSelectState,
  CustomerOption,
} from "./customer-multi-select";
import {
  type DrawerFocusField,
  FilterDrawer,
  type FilterDrawerLabels,
  type FilterDrawerOptions,
  type TagFieldLabel,
} from "./filter-drawer";
import type { FilterMultiSelectLabels } from "./filter-multi-select";
import type {
  SensorMultiSelectState,
  SensorOption,
} from "./sensor-multi-select";

/**
 * Serializable subset of {@link PivotChipLabels} — the server page passes
 * this shape, and the client shell injects `countAggregate` (a function
 * that takes a dynamic count) on render. Function props can't cross the
 * server→client boundary, so the bound translator stays on the client.
 */
type ChipLabelStrings = Omit<PivotChipLabels, "countAggregate">;

/**
 * Serializable subset of {@link FilterDrawerLabels["attributes"]} — the
 * server page passes plain strings for each tag field, and the client
 * shell constructs the per-field `removeLabel` formatter using the
 * locale's translator.
 */
type AttributesLabelStrings = Omit<
  FilterDrawerLabels["attributes"],
  "keywords" | "hostnames" | "userIds" | "userNames" | "userDepartments"
> & {
  keywords: Omit<TagFieldLabel, "removeLabel">;
  hostnames: Omit<TagFieldLabel, "removeLabel">;
  userIds: Omit<TagFieldLabel, "removeLabel">;
  userNames: Omit<TagFieldLabel, "removeLabel">;
  userDepartments: Omit<TagFieldLabel, "removeLabel">;
};

/**
 * Serializable subset of {@link FilterDrawerLabels} — the server page
 * passes plain strings for each tag field, and the client shell
 * constructs the per-field `removeLabel` formatter using the locale's
 * translator.
 */
type DrawerLabelStrings = Omit<FilterDrawerLabels, "attributes"> & {
  attributes: AttributesLabelStrings;
};

/**
 * Serializable subset of {@link QuickPeekInspectorLabels}. Function-
 * valued formatters (`triageSummary`, `moreCountSuffix`) are built
 * on the client side using the locale translator — the server page
 * only passes plain strings.
 */
export type QuickPeekLabelStrings = Omit<
  QuickPeekInspectorLabels,
  "triageSummary" | "moreCountSuffix"
>;

/**
 * Serializable subset of {@link DetectionAnalyticsLabels}. The
 * server page passes ICU templates as plain strings; this shell
 * binds them into the function-valued formatters
 * (`countSuffix`, `bucketLabel`, `pivotActivate`, period values)
 * using the active locale's translator before the analytics
 * component is rendered.
 */
export interface AnalyticsLabelStrings {
  dimensionLabel: string;
  dimensionOptions: DetectionAnalyticsLabels["dimensionOptions"];
  topNLabel: string;
  topNChartTitleTemplate: string;
  timeSeriesTitle: string;
  countSuffixTemplate: string;
  bucketLabelTemplate: string;
  periodSecondsTemplate: string;
  periodMinutesTemplate: string;
  periodHoursTemplate: string;
  periodDaysTemplate: string;
  periodWeeksTemplate: string;
  loadingTitle: string;
  loadingDescription: string;
  errorTitle: string;
  errorDescription: string;
  errorRetry: string;
  forbiddenTitle: string;
  forbiddenDescription: string;
  /**
   * Headline + body for the analytics strip's
   * `forbidden-customer-scope` branch (Reviewer Round 6 #1) — the
   * inbound filter references a customer the caller cannot access, or
   * the caller's scope is empty. Distinct from
   * {@link forbiddenTitle}/{@link forbiddenDescription} (caller lacks
   * `detection:read`) so the panel can show the actionable customer-
   * scope copy instead of the generic Detection-access denial.
   */
  forbiddenScopeTitle: string;
  forbiddenScopeDescription: string;
  emptyTitle: string;
  emptyDescription: string;
  levelLabels: DetectionAnalyticsLabels["levelLabels"];
  categoryLabels: DetectionAnalyticsLabels["categoryLabels"];
  countryUnknown: string;
  countryUnavailable: string;
  pivotActivateTemplate: string;
}

/**
 * Serializable subset of {@link SavedFiltersRailLabels} — the server
 * page passes plain strings. The function-valued `menuLabel`
 * formatter (it carries a dynamic `{name}` arg) is bound on the
 * client side using the active locale's translator before being
 * threaded into the rail.
 */
export interface SavedFiltersRailLabelStrings {
  title: string;
  emptyHint: string;
  loadingHint: string;
  loadErrorHint: string;
  /** ICU template carrying `{name}` for the per-row menu trigger. */
  menuLabelTemplate: string;
  loadInNewTab: string;
  loadInCurrentTab: string;
  rename: string;
  delete: string;
  deleteConfirm: {
    title: string;
    /** ICU template carrying `{name}` for the body copy. */
    descriptionTemplate: string;
    cancel: string;
    confirm: string;
    error: string;
  };
  renameDialog: SaveFilterDialogLabels;
}

export interface DetectionShellLabels {
  /**
   * CSV export affordance labels — confirmation dialog copy, the
   * column headers the downloaded file will carry, and the generic
   * error message surfaced when the stream fails. The server action
   * echoes the headers back in the CSV so the file matches the
   * operator's locale regardless of where the stream is rendered.
   */
  exportConfirm: Omit<CsvExportConfirmLabels, "descriptionTemplate"> & {
    descriptionTemplate: string;
  };
  exportErrorMessage: string;
  /**
   * Surfaced when the export's 403 body carries
   * `code: "forbidden-customer-scope"` — the inbound filter references a
   * customer outside the caller's effective scope (Reviewer Round 6 #1).
   * Distinct from {@link exportErrorMessage} so the operator gets an
   * actionable hint ("remove the unavailable customers") rather than the
   * generic transient-error copy.
   */
  exportForbiddenScopeMessage: string;
  /**
   * Template used when the server rejects the export because the
   * estimated row count exceeds the hard per-export ceiling. Carries
   * `{count}` and `{limit}` placeholders so the error message can
   * quote the figures from the 413 response body.
   */
  exportLimitExceededTemplate: string;
  exportColumnHeaders: Record<string, string>;
  recommendedFilter: string;
  savedFilters: string;
  railPlaceholder: string;
  /**
   * Localized display name for each {@link RecommendedPreset}, keyed
   * by `preset.id`. Built on the server page from
   * `detection.recommendedFilters.<nameKey>` so the rail can render
   * names without hauling `useTranslations` into a presentation
   * component.
   */
  recommendedPresetNames: Record<string, string>;
  /** Sub-line shown below the Recommended Filter heading when the preset list is empty. */
  recommendedEmptyHint: string;
  /**
   * Serializable subset of {@link SavedFiltersRailLabels} — the
   * server page passes plain strings (the menu a11y label is an ICU
   * template carrying `{name}`); the shell binds the function-valued
   * `menuLabel` formatter using the active locale's translator before
   * the rail is rendered. Includes templates / strings for the
   * embedded rename and delete confirmation dialogs.
   */
  savedFiltersRail: SavedFiltersRailLabelStrings;
  /**
   * Labels for the "Save this filter" dialog opened from the filter
   * drawer footer. Plain strings — the dialog handles its own
   * inline error rendering.
   */
  saveFilterDialog: SaveFilterDialogLabels;
  filtersOpen: string;
  activeChipsEmpty: string;
  resultsRegion: string;
  resultsLoading: string;
  resultsError: string;
  /**
   * Surfaced when {@link runEventQuery} returns
   * `code: "forbidden-customer-scope"` — the inbound filter references a
   * customer outside the caller's effective scope, or the caller's
   * scope is empty (Reviewer Round 6 #1). Distinct from
   * {@link resultsError} so the operator gets an actionable hint
   * ("remove the unavailable customers") rather than the generic
   * transient-error copy.
   */
  resultsForbiddenScope: string;
  analyticsToggle: string;
  analyticsShow: string;
  analyticsHide: string;
  /**
   * Serializable subset of {@link DetectionAnalyticsLabels} — the
   * server page passes plain strings; the client shell builds the
   * function-valued formatters (count suffix, period descriptors,
   * pivot a11y label) using the locale translator.
   */
  analytics: AnalyticsLabelStrings;
  directionChips: DirectionChipLabels;
  endpointChips: EndpointChipLabels;
  confidenceChipLabel: string;
  chipLabels: ChipLabelStrings;
  drawer: DrawerLabelStrings;
  pagination: PaginationLabelStrings;
  /**
   * Serializable subset of {@link SummarizeFilterLabels} — the server
   * page only passes plain strings; the client shell builds the full
   * labels (including the function-valued `formatRange` and
   * `categoricalAggregate` formatters) using the locale translator.
   */
  summarize: {
    sensor: string;
    sensorAggregate: string;
    /**
     * `{count}` substituted; #384 customer aggregate template, e.g.
     * `"{count} selected"`. The shell concatenates with the customer
     * label to produce the chip value `Customer: 4 selected`.
     */
    customerAggregate: string;
  };
  quickPeek: QuickPeekLabelStrings;
}

/**
 * Serializable subset of {@link PaginationControlsLabels} — the
 * server page passes plain strings for the button names; the shell
 * builds the function-valued formatters (range indicator,
 * page-of-total, walking progress) using the locale translator.
 */
export interface PaginationLabelStrings {
  pageSizeLabel: string;
  firstPage: string;
  previousPage: string;
  nextPage: string;
  lastPage: string;
  goToPageLabel: string;
  goToPagePlaceholder: string;
  goToPageSubmit: string;
}

export interface DetectionShellInitialResult {
  totalCount: string | null;
  error: string | null;
  events: DetectionEvent[];
  /**
   * Parallel to `events`: `eventKeys[i]` is the stable cursor for
   * `events[i]`. Threaded through from the server so the result
   * list can key rows on server identity instead of a lossy
   * composite of content fields (which aliases when two events
   * share the same time / endpoint tuple within one page).
   */
  eventKeys: string[];
  /**
   * `EventConnection.pageInfo` for the initial slice. `null` only
   * when the server query errored before the shell mounted — the
   * paginator then renders without nav affordances until the next
   * Apply / Refresh repopulates it.
   */
  pageInfo: PageInfo | null;
  /**
   * Reviewer Round 1 (item 3): freshness timestamp carried over from
   * a prior tab activation so the result header keeps showing
   * "Updated 5 minutes ago" instead of "Updated just now" the moment
   * the operator switches back. `undefined` means "compute from the
   * initial bootstrap" (`Date.now()` when the SSR'd query succeeded,
   * else `null`); the multi-tab wrapper passes the cached value when
   * remounting an inactive tab, the page leaves it undefined.
   */
  lastUpdatedMs?: number | null;
  /**
   * Reviewer Round 1 (item 3): per-tab "has any committed query
   * dispatched yet" flag carried over from a prior tab activation
   * so a remount keeps the pre-query empty state visible (and
   * doesn't get confused with a fresh-load pre-query state). The
   * page leaves it undefined and the shell derives the bootstrap
   * value from `error` / `totalCount`.
   */
  hasQueried?: boolean;
  /**
   * Reviewer Round 1 (item 3): per-tab monotonic queryEpoch carried
   * across tab activations so per-row state cannot accidentally
   * carry from a prior committed query into the next one. The
   * wrapper threads the cached value back on remount; an SSR
   * bootstrap leaves it undefined and the shell starts from `0`.
   */
  queryEpoch?: number;
  /**
   * Reviewer Round 4 (item 1): per-tab "is a committed query
   * currently in flight" flag carried across tab activations. When
   * the operator clicks Apply / Refresh / a paginator step in tab
   * A and switches to tab B before the request resolves, the
   * wrapper unmounts tab A's shell — its async response then
   * lands in a dead React tree and the tab's cache never receives
   * the fresh rows. Threading `loading: true` back into the
   * remount triggers {@link shouldResumeQueryOnMount}: the new
   * shell re-issues the same query against the snapshot's
   * pagination so the in-flight Apply is not silently dropped.
   * SSR bootstrap leaves it undefined; the shell defaults to false.
   */
  loading?: boolean;
}

/**
 * Subset of the shell's reactive state that the multi-tab wrapper
 * (`DetectionTabsShell`) needs to snapshot into the active tab's
 * {@link TabSnapshot} slot on tab switch and session serialization.
 * Emitted via {@link DetectionShellProps.onStateChange} whenever any
 * included field changes.
 *
 * Fields outside the tab's contract — drawer-open flag, sensor cache,
 * focus target, in-flight request ids — stay local to the shell and
 * are not part of the snapshot. They reset on the remount a tab
 * switch triggers, which matches the UX intent (closing the drawer
 * on switch, re-fetching sensors lazily on first drawer open after
 * switch).
 */
export interface DetectionShellStateSnapshot {
  filter: Filter;
  period: PeriodKey | null;
  endpoints: EndpointEntry[];
  pivotOnly: PivotFilterParams;
  pagination: PaginationState;
  draft: DetectionFilterDraft | null;
  analyticsOpen: boolean;
  /**
   * Reviewer Round 1 (P2 per-tab state): selector value the
   * analytics strip currently shows. Carries a default for fresh
   * tabs but the shell's `setAnalyticsDimension` flips it to the
   * operator's choice; the multi-tab wrapper mirrors it into the
   * tab snapshot so a switch / reload restores the same selection.
   */
  analyticsDimension: AnalyticsDimension;
  /** See {@link analyticsDimension} — same per-tab restore contract. */
  analyticsTopN: AnalyticsTopN;
  quickPeekEvent: DetectionEvent | null;
  /**
   * Reviewer Round 9: pending Quick peek URL token the shell has
   * decoded but not yet resolved against a successful slice. Mirrors
   * the same field on `TabSnapshot` so the multi-tab wrapper can
   * round-trip the URL token across its mount-time URL rewrite when
   * the bootstrap query errored. Always null when
   * {@link quickPeekEvent} is non-null. Cleared as soon as the shell
   * either resolves the token (matched event → quick peek opened) or
   * proves it stale (no match against a successful slice → URL
   * stripped).
   */
  pendingQuickPeekToken: string | null;
  result: {
    events: DetectionEvent[];
    eventKeys: string[];
    totalCount: string | null;
    pageInfo: PageInfo | null;
    resultError: string | null;
    lastUpdatedMs: number | null;
    hasQueried: boolean;
    queryEpoch: number;
    loading: boolean;
    walking: { current: number; target: number } | null;
  };
}

export interface DetectionShellProps {
  title: string;
  labels: DetectionShellLabels;
  options: FilterDrawerOptions;
  initialFilter: Filter;
  initialPeriod: PeriodKey | null;
  initialResult: DetectionShellInitialResult;
  /** URL-only pivot params (kind, ports, proto, window). Preserved through URL round-trips for Phase Detection-12 pivot logic; not rendered as active-filter chips yet because they do not participate in the committed `EventListFilterInput`. */
  initialPivotOnly?: PivotFilterParams;
  /**
   * Page size + cursor anchor parsed from the URL. A fresh
   * `/detection` load passes {@link INITIAL_PAGINATION_STATE}; a
   * deep-linked URL restores the persisted slice so a refresh keeps
   * the operator on the page they were viewing.
   */
  initialPagination?: PaginationState;
  /**
   * Rich endpoint entries (text + direction) the operator entered in
   * the Network/IP advanced panel. The committed filter input also
   * carries them as `EndpointInput[]` for REview, but the panel and
   * the endpoint chip bar work off this richer parallel list — there
   * is no reverse path from `EndpointInput[]` back to the typed
   * entries, so the multi-tab wrapper threads them through this prop
   * to restore the rich representation on tab activation.
   */
  initialEndpoints?: EndpointEntry[];
  /**
   * Drawer draft carried from a prior tab-mount. When the multi-tab
   * wrapper rehydrates an inactive tab, the draft the operator last
   * had open in that tab's drawer is restored so reopening the
   * drawer picks up exactly where it left off. `null` — the default
   * — matches the fresh-load behaviour where the drawer seeds its
   * draft on first open.
   */
  initialDraft?: DetectionFilterDraft | null;
  /**
   * Initial expansion of the analytics strip. Part of the per-tab
   * snapshot so a rehydrated tab remembers whether the operator had
   * the strip open.
   */
  initialAnalyticsOpen?: boolean;
  /**
   * Initial dimension shown in the analytics strip. Reviewer Round 1
   * (P2): per-tab — the wrapper rebuilds the shell on tab switch, so
   * the selector value rides on a snapshot field rather than on
   * `DetectionAnalytics`'s local React state.
   */
  initialAnalyticsDimension?: AnalyticsDimension;
  /** Initial Top N count shown in the analytics strip. See {@link initialAnalyticsDimension}. */
  initialAnalyticsTopN?: AnalyticsTopN;
  /**
   * Initial Quick peek event carried from a prior tab-mount. Pinned
   * to the rehydrated event reference rather than re-resolved from
   * the URL, because the URL-based restore path only describes the
   * active tab's selection and the multi-tab wrapper rehydrates
   * inactive tabs on remount.
   */
  initialQuickPeekEvent?: DetectionEvent | null;
  /**
   * Reviewer Round 9: pending Quick peek URL token captured by the
   * SSR bootstrap so the multi-tab wrapper can re-emit `?event=` on
   * its mount-time URL rewrite while the shell's first slice is in
   * an errored-without-proof state. The shell seeds local state
   * from this prop so its later restore-vs-strip reconciliation can
   * use the captured token even after the URL itself has been
   * rewritten by other tab mutations.
   */
  initialPendingQuickPeekToken?: string | null;
  /**
   * Fired on every tab-relevant state transition so the multi-tab
   * wrapper can mirror the active tab's live state into its
   * `TabSnapshot[]` (for session persistence and for the save-on-
   * switch contract). Functions that would normally drive tab-
   * local effects — focus management, drawer open state — are NOT
   * included in the snapshot; see {@link DetectionShellStateSnapshot}
   * for the contract.
   */
  onStateChange?: (snapshot: DetectionShellStateSnapshot) => void;
  /**
   * Pivot (drill-down) activation hook (Phase Detection-12).
   * Forwarded straight to {@link ResultList}; the multi-tab wrapper
   * supplies a handler that decides whether to create / focus /
   * toast based on the patch and the rest of the tab list. When
   * undefined, pivot affordances are hidden (single-tab / standalone
   * shell paths).
   */
  onPivot?: (patch: PivotPatch) => void;
  /**
   * Personal saved-filters state owned by the multi-tab wrapper
   * (Phase Detection-15). Threaded down so the rail stays consistent
   * across tabs and a save in one tab refreshes every tab's rail.
   * `undefined` keeps the rail in its placeholder shape — used by the
   * standalone shell tests that do not exercise the saved-filters
   * rail.
   */
  savedFilters?: UseSavedFiltersResult;
  /**
   * Activation hook for "Load in new tab" / per-row default click on
   * a saved filter. The wrapper creates a new tab pre-seeded with the
   * supplied filter and auto-runs the query so the new tab lands
   * populated rather than on the pre-query empty state — matching the
   * pivot tab-create contract.
   */
  onLoadSavedFilterInNewTab?: (filter: Filter) => void;
  /**
   * System-provided recommended presets to render in the slim left
   * rail (Phase Detection-16). Read-only in v1: each row activates a
   * one-click broad view in a new tab. The shell stays render-only
   * over the list; the wrapper builds the concrete {@link Filter}
   * from the preset and threads it through the same "load in new tab"
   * path Saved Filters use. `undefined` keeps the rail in the
   * placeholder shape used by the standalone shell tests.
   */
  recommendedPresets?: readonly RecommendedPreset[];
  /**
   * Activation hook for the Recommended Filter rail. Same contract
   * as {@link onLoadSavedFilterInNewTab}: the wrapper creates a new
   * tab pre-seeded with the preset's filter and auto-runs the
   * query so the tab lands populated.
   */
  onLoadRecommendedFilterInNewTab?: (preset: RecommendedPreset) => void;
  /**
   * Customer inventory cache, lifted to the multi-tab wrapper so it
   * survives the keyed remount this shell undergoes on every tab
   * switch (Reviewer Round 1 #1: with the cache here in shell-local
   * state, opening the drawer in one tab and then switching tabs
   * dropped the cache and forced another fetch — breaking the
   * page-session-shared contract from #384). Pass-through props that
   * keep the rendering code identical to a self-owned cache.
   */
  customerCache: CustomerCache;
  /**
   * Manual `↻` refresh callback the wrapper supplies. The drawer's
   * Customer header `↻` icon and the error-state Retry button both
   * call this; the wrapper performs the actual `fetchCustomersForFilter()`
   * round-trip and replaces the cache.
   */
  onCustomerRefresh: () => void;
  /**
   * Lookup options used for chip-name rendering when {@link customerCache}
   * isn't yet `loaded` (e.g. during a manual refresh). The wrapper
   * seeds these from the SSR `getEffectiveCustomerScope(session)` call
   * so chips render with customer **names**, not raw IDs, on the
   * first paint of a bookmarked / saved-filter / pivot URL — the
   * disagreement Reviewer Round 1 #3 flagged when chip rendering
   * relied solely on the lazy-loaded cache.
   */
  initialCustomerOptions?: readonly CustomerOption[];
}

/**
 * Session-cached sensor inventory. The drawer resolves this on
 * first open and reuses it for subsequent opens in the same tab,
 * so toggling the drawer repeatedly does not re-hit the REview
 * endpoint. The `status` discriminator distinguishes "not fetched
 * yet" from "fetched but endpoint absent" so the UI can tell a
 * real empty inventory from a transitional build.
 */
export type SensorCache =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "loaded";
      endpointAvailable: boolean;
      options: readonly SensorOption[];
    }
  | { status: "error" };

/**
 * Translate the session sensor cache into the visual state the
 * Sensor control should render. The mapping is intentionally
 * distinct for each non-ready source so that the UI does not
 * conflate "endpoint genuinely absent" with "endpoint live but
 * request in flight" or "endpoint live but the last attempt
 * failed" — the reviewer concern that motivated this helper.
 */
export function sensorStateForCache(
  cache: SensorCache,
): SensorMultiSelectState {
  if (cache.status === "loaded") {
    return cache.endpointAvailable ? "ready" : "unavailable";
  }
  if (cache.status === "error") return "error";
  return "loading";
}

/**
 * True when an open-drawer path should kick off a sensor fetch. An
 * in-flight request or a loaded cache is reused as-is; `idle` (never
 * fetched) and `error` (last attempt failed) both re-request so the
 * Sensor control doesn't sit in its disabled placeholder forever.
 * Shared by both the Filters button path and the chip-body path so
 * the two cannot drift.
 */
export function shouldTriggerSensorFetch(cache: SensorCache): boolean {
  return cache.status !== "loading" && cache.status !== "loaded";
}

/**
 * Session-cached customer inventory (#384). Mirrors {@link SensorCache}
 * one-for-one — the drawer fetches `getEffectiveCustomerScope(session)`
 * (via `fetchCustomersForFilter`) on first open and reuses the result
 * for subsequent opens in the same tab session. The cache is keyed on
 * the page mount: away-and-back / hard refresh discards it.
 */
export type CustomerCache =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "loaded";
      kind: "admin" | "assigned" | "empty";
      options: readonly CustomerOption[];
    }
  | { status: "error" };

/**
 * Translate {@link CustomerCache} into the visual state the
 * Customer control should render. `loaded` (regardless of `kind`)
 * maps to `ready` — the empty-scope case is folded into the ready
 * state with `options.length === 0` so the control can render its
 * disabled "No customer access" affordance distinctly from the
 * loading and error states.
 */
export function customerStateForCache(
  cache: CustomerCache,
): CustomerMultiSelectState {
  if (cache.status === "loaded") return "ready";
  if (cache.status === "error") return "error";
  return "loading";
}

/**
 * True when an open-drawer path should kick off a customer fetch.
 * Same contract as {@link shouldTriggerSensorFetch} so both drawer
 * fields share their lazy-load policy.
 */
export function shouldTriggerCustomerFetch(cache: CustomerCache): boolean {
  return cache.status !== "loading" && cache.status !== "loaded";
}

/**
 * Whether the drawer's apply / save boundary may emit
 * `input.customers` for the current cache state. True only when the
 * cache is `loaded` AND the loaded option list is non-empty —
 * mirrors the sensor `endpointLive` gate so the issue/manual
 * contract holds: the filter submits no `customers` value while the
 * first drawer-open fetch is in flight (`loading`), after a manual
 * refresh transitioned the control into `error`, or on an empty-
 * scope (`loaded` + zero options, the "No customer access"
 * affordance) session — even when a bookmark / saved filter / pivot
 * URL hydrated the draft with prior IDs. Reviewer Round 8.
 */
export function customerSelectionLiveForCache(cache: CustomerCache): boolean {
  return cache.status === "loaded" && cache.options.length > 0;
}

/**
 * Whether opening the drawer on a given chip-body focus should also
 * expand the Network/IP advanced panel. Only the endpoints aggregate
 * wants it; every other focus (period, source, direction, …) must
 * explicitly clear the flag so a prior endpoint activation doesn't
 * leak into an unrelated field on the next chip click.
 */
export function shouldOpenEndpointPanelForFocus(
  focus: FilterChipFocus,
): boolean {
  return focus === "endpoints";
}

/**
 * Chip-body focus target for every Network/IP endpoint chip (both
 * the per-entry and aggregate forms). Exported so the shell and
 * tests agree on a single key — endpoint chips must route through
 * the same `openDrawerFocused` path as every other chip so the
 * drawer scrolls the Network/IP section into view. Previously the
 * endpoint chip was an exception that skipped focus entirely,
 * which the reviewer flagged in Round 7.
 */
export const ENDPOINT_CHIP_FOCUS: FilterChipFocus = "endpoints";

/**
 * State updates that must fire synchronously at the moment a
 * committed query transition is dispatched — Apply / chip × /
 * Refresh — regardless of whether the async response later
 * resolves, rejects, or is dropped as stale.
 *
 * The contract (Reviewer Round 12): bump `queryEpoch` and close
 * Quick peek at dispatch time, not after the replacement slice
 * lands. For Refresh (same-filter re-fetch) `ResultList` keeps
 * painting the previous rows while `loading` is true as long as it
 * still has events — so deferring either reset until the response
 * lands leaves a window during the round-trip where:
 *
 * - the Quick peek inspector (and its **Open investigation**
 *   button) is still pinned to a row the fresh slice may no
 *   longer return, and
 * - `EventRow` / `MorePopover` state from the stale slice can be
 *   reconciled onto the replacement slice because `queryEpoch`
 *   hasn't advanced yet.
 *
 * For Apply and chip × the retained-slice window does not exist:
 * `runQueryFor` clears events / pagination synchronously before
 * calling this helper so the tab's durable state never observes
 * "new filter + old rows/cursor" (see Reviewer Round 3 on the
 * multi-tab wrapper).
 *
 * Reviewer Round 3 added `clearQuickPeekUrl`: closing the in-
 * memory peek alone leaves the tab URL carrying a stale
 * `?event=<token>` entry, so a reload after Refresh would
 * resurrect the selection. The URL sink is injected rather than
 * called inline so the helper stays DOM-free and testable.
 *
 * Reviewer Round 7 tightened the URL contract: the sink now
 * receives `hadPeek` so callers can preserve the URL token when
 * there is no open peek being dismissed. The specific scenario
 * that prompted the change is "reload with `?event=` → transient
 * backend error → click Refresh": the URL token is pending a
 * successful retry, and unconditionally stripping it on dispatch
 * would lose the selection URL state before the retry's slice
 * could match it.
 *
 * Extracted so the dispatch-time contract can be unit-tested
 * without standing up a full DOM render of the shell.
 */
export function applyCommitDispatchReset(setters: {
  setQueryEpoch: (fn: (n: number) => number) => void;
  setQuickPeekEvent: (
    fn: (prev: DetectionEvent | null) => DetectionEvent | null,
  ) => void;
  clearQuickPeekUrl?: (args: { hadPeek: boolean }) => void;
}): void {
  setters.setQueryEpoch((epoch) => epoch + 1);
  setters.setQuickPeekEvent((prev) => {
    setters.clearQuickPeekUrl?.({ hadPeek: prev !== null });
    return null;
  });
}

/**
 * State updates that must fire synchronously when a filter-
 * transitioning dispatch (Apply / chip ×) begins — before the async
 * REview round-trip resolves. Reviewer Round 3: without these, a
 * tab-switch taken mid-flight parks a transient snapshot
 * `{ filter: NEW, pagination: OLD_CURSOR, events: OLD_ROWS,
 * loading: true }` into the multi-tab wrapper. Two visible failures
 * follow:
 *
 * - The wrapper's loading-stripping remount path renders OLD rows
 *   as a ready cached result for the NEW filter, violating the
 *   "each tab is a filter + result pair" contract from #281.
 * - The wrapper's URL effect rewrites the address from the
 *   snapshot and reintroduces stale `after=` / `before=` / `last=`
 *   params on top of the newly committed filter.
 *
 * Resetting at dispatch time makes the transition atomic from the
 * tab model's perspective: the tab's durable state flows
 * `{ filter: NEW, pagination: HEAD, events: [], loading: true }`
 * → `{ ..., events: FRESH, loading: false }` — never through a
 * "new filter + old rows/cursor" midpoint.
 *
 * Refresh deliberately does NOT route through this helper: it
 * re-runs the *current* filter at the *current* page, so clearing
 * rows would flash a skeleton and break the "update in place"
 * contract.
 */
export function applyTransitionReset(
  setters: {
    setPagination: (next: PaginationState) => void;
    setEvents: (next: DetectionEvent[]) => void;
    setEventKeys: (next: string[]) => void;
    setTotalCount: (next: string | null) => void;
    setPageInfo: (next: PageInfo | null) => void;
    setLastUpdatedMs: (next: number | null) => void;
    setTotalCountRef: (next: string | null) => void;
  },
  args: { pageSize: PageSize },
): void {
  setters.setPagination({
    pageSize: args.pageSize,
    anchor: { kind: "head" },
    page: 1,
  });
  setters.setEvents([]);
  setters.setEventKeys([]);
  setters.setTotalCount(null);
  setters.setPageInfo(null);
  setters.setLastUpdatedMs(null);
  setters.setTotalCountRef(null);
}

/**
 * Reviewer Round 5: invalidate any in-flight committed-query dispatch
 * (paginator step / Apply / Refresh) and any in-flight Go-to-page
 * walk by advancing the monotonic ids that gate their late-arrival
 * checks. Used by the shell's unmount cleanup so an Apply / Refresh
 * / paginator click that the operator started in tab A — and then
 * abandoned by switching to tab B before the response landed —
 * cannot run global URL side effects under the next tab's id.
 *
 * Without the bump the resolved request still passes the request-id
 * check inside `dispatchQuery` and runs:
 *
 * - {@link reconcileQuickPeekAgainstSlice}, which can strip the
 *   currently-active tab's `?event=` token; and
 * - the `navigateTo` / `handleRefresh` continuations, which call
 *   `persistPaginationToUrl` to rewrite the URL from the unmounted
 *   shell's filter / pagination while `preserveActiveTabParam`
 *   copies the **current** `?tab=`. The address bar then ends up
 *   with B's tab id paired with A's filter / page, and reload or
 *   share reproduces the wrong active tab state.
 *
 * Bumping both ids on unmount short-circuits the in-flight callback
 * so abandoned requests cannot touch global URL state; the resumed
 * shell on switch-back owns the replacement query and URL via
 * {@link shouldResumeQueryOnMount}.
 *
 * Extracted as a pure helper so the unmount contract can be unit-
 * tested without standing up the shell's full client runtime.
 */
export function invalidateInFlightOnUnmount(refs: {
  latestRequestIdRef: { current: number };
  latestWalkIdRef: { current: number };
}): void {
  refs.latestRequestIdRef.current += 1;
  refs.latestWalkIdRef.current += 1;
}

/**
 * Reviewer Round 4 (item 1): true when a freshly-mounted shell's
 * snapshot indicates the prior shell instance had a committed query
 * in flight.
 *
 * The multi-tab wrapper mirrors `result.loading: true` into the
 * outgoing tab's slot when the operator switches away mid-Apply
 * (or mid-Refresh / mid-pagination). Without resuming, the original
 * request resolves into the unmounted shell — the tab cache never
 * receives the fresh rows, and switching back yields the post-
 * `applyTransitionReset` empty result for the new filter rather
 * than the query result.
 *
 * Resume semantics: re-issue the same query at the snapshot's
 * pagination with `navigating: true`. `applyTransitionReset` has
 * already pinned pagination to HEAD + page=1 for the Apply / chip
 * × path, so the resumed call lands at head; for Refresh /
 * paginator clicks the snapshot retains the user's current page,
 * which is the right anchor to re-fetch.
 *
 * Extracted as a pure helper so the resume contract can be unit-
 * tested without standing up the shell's full client runtime.
 */
export function shouldResumeQueryOnMount(
  loading: boolean | undefined,
): boolean {
  return loading === true;
}

/**
 * Re-derive the period key from a saved filter's start / end pair.
 * Saved filter payloads only persist the structured `EventListFilterInput`
 * (per the issue's data model), so the rich `period` field in the
 * tab snapshot is not stored — we recompute it on load so the period
 * chip lights up when the saved range exactly matches one of the
 * preset windows. Query-mode filters return `null` (no period chip
 * to highlight). The {@link matchesPeriodKey} helper keeps the
 * comparison exact, so a user-edited range that happens to fall in
 * a preset's neighbourhood does not spuriously re-stamp the chip.
 */
export function derivePeriodForFilter(filter: Filter): PeriodKey | null {
  if (filter.mode !== "structured") return null;
  const { start, end } = filter.input;
  if (typeof start !== "string" || typeof end !== "string") return null;
  return matchesPeriodKey({ start, end });
}

export function DetectionShell({
  title,
  labels,
  options,
  initialFilter,
  initialPeriod,
  initialResult,
  initialPivotOnly = {},
  initialPagination = INITIAL_PAGINATION_STATE,
  initialEndpoints = [],
  initialDraft = null,
  initialAnalyticsOpen = false,
  initialAnalyticsDimension = DEFAULT_ANALYTICS_DIMENSION,
  initialAnalyticsTopN = DEFAULT_ANALYTICS_TOP_N,
  initialQuickPeekEvent = null,
  initialPendingQuickPeekToken = null,
  onStateChange,
  onPivot,
  savedFilters,
  onLoadSavedFilterInNewTab,
  recommendedPresets,
  onLoadRecommendedFilterInNewTab,
  customerCache,
  onCustomerRefresh,
  initialCustomerOptions,
}: DetectionShellProps) {
  const t = useTranslations("detection.filters");
  const tResults = useTranslations("detection.results");
  const tPagination = useTranslations("detection.pagination");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  // Build the function-valued labels for the chip remove button and the
  // result list on this side of the server/client boundary. Function
  // props can't cross that boundary, so the bound translator stays on
  // the client and closes over the active locale.
  const removeChip = useCallback(
    (label: string) => t("removeChip", { label }),
    [t],
  );
  const resultListLabels = useMemo<ResultListLabels>(
    () => ({
      countWithRange: ({ range, total }) =>
        tResults("countWithRange", { range, total }),
      totalOnly: ({ total }) => tResults("totalOnly", { total }),
      download: tResults("download"),
      downloadRunning: tResults("downloadRunning"),
      downloadErrorTitle: tResults("downloadErrorTitle"),
      downloadErrorDismiss: tResults("downloadErrorDismiss"),
      refresh: tResults("refresh"),
      updatedJustNow: tResults("updatedJustNow"),
      updatedSecondsAgo: (s: number) => tResults("updatedSecondsAgo", { s }),
      updatedMinutesAgo: (m: number) => tResults("updatedMinutesAgo", { m }),
      updatedHoursAgo: (h: number) => tResults("updatedHoursAgo", { h }),
      loadingTitle: tResults("loadingTitle"),
      loadingDescription: tResults("loadingDescription"),
      errorTitle: tResults("errorTitle"),
      errorDescription: tResults("errorDescription"),
      errorRetry: tResults("errorRetry"),
      emptyResultsTitle: tResults("emptyResultsTitle"),
      emptyResultsDescription: tResults("emptyResultsDescription"),
      emptyFilterTitle: tResults("emptyFilterTitle"),
      emptyFilterDescription: tResults("emptyFilterDescription"),
      emptyFilterAction: tResults("emptyFilterAction"),
      rowOpenLabel: tResults("rowOpenLabel"),
      rowInvestigateLabel: tResults("rowInvestigateLabel"),
      quickPeekClose: tResults("quickPeekClose"),
      unknownTime: tResults("unknownTime"),
      noSensor: tResults("noSensor"),
      confidenceLabel: t("confidenceChipLabel"),
      triageSummary: ({ count, max }) =>
        tResults("triageSummary", { count, max }),
      endpointSeparator: tResults("endpointSeparator"),
      moreCountSuffix: (count: number) =>
        tResults("moreCountSuffix", { count }),
      countryUnknown: tResults("countryUnknown"),
      countryUnavailable: tResults("countryUnavailable"),
      levelLabels: {
        LOW: t("levelOptions.LOW"),
        MEDIUM: t("levelOptions.MEDIUM"),
        HIGH: t("levelOptions.HIGH"),
      },
      categoryLabels: {
        RECONNAISSANCE: t("categoryOptions.RECONNAISSANCE"),
        INITIAL_ACCESS: t("categoryOptions.INITIAL_ACCESS"),
        EXECUTION: t("categoryOptions.EXECUTION"),
        CREDENTIAL_ACCESS: t("categoryOptions.CREDENTIAL_ACCESS"),
        DISCOVERY: t("categoryOptions.DISCOVERY"),
        LATERAL_MOVEMENT: t("categoryOptions.LATERAL_MOVEMENT"),
        COMMAND_AND_CONTROL: t("categoryOptions.COMMAND_AND_CONTROL"),
        EXFILTRATION: t("categoryOptions.EXFILTRATION"),
        IMPACT: t("categoryOptions.IMPACT"),
        COLLECTION: t("categoryOptions.COLLECTION"),
        DEFENSE_EVASION: t("categoryOptions.DEFENSE_EVASION"),
        PERSISTENCE: t("categoryOptions.PERSISTENCE"),
        PRIVILEGE_ESCALATION: t("categoryOptions.PRIVILEGE_ESCALATION"),
        RESOURCE_DEVELOPMENT: t("categoryOptions.RESOURCE_DEVELOPMENT"),
      },
      attackKindLabel: tResults("attackKindLabel"),
      pivotActivate: ({ label, value }: { label: string; value: string }) =>
        tResults("pivotActivate", { label, value }),
      pivotColumnLabels: {
        origAddr: tResults("pivotColumnLabels.origAddr"),
        respAddr: tResults("pivotColumnLabels.respAddr"),
        origCountry: tResults("pivotColumnLabels.origCountry"),
        respCountry: tResults("pivotColumnLabels.respCountry"),
        level: tResults("pivotColumnLabels.level"),
        category: tResults("pivotColumnLabels.category"),
        kind: tResults("pivotColumnLabels.kind"),
        userName: tResults("pivotColumnLabels.userName"),
        hostname: tResults("pivotColumnLabels.hostname"),
      },
      userNameLabel: tResults("userNameLabel"),
      hostnameLabel: tResults("hostnameLabel"),
    }),
    [t, tResults],
  );
  const multiSelectLabels = useMemo<FilterMultiSelectLabels>(
    () => ({
      allToggle: t("multiSelect.all"),
      searchPlaceholder: t("multiSelect.searchPlaceholder"),
      noOptionsMatch: t("multiSelect.noOptionsMatch"),
      summaryNone: t("multiSelect.summaryNone"),
      summaryAll: t("multiSelect.summaryAll"),
      summarySome: (count: number) => t("multiSelect.summarySome", { count }),
      expand: t("multiSelect.expand"),
      collapse: t("multiSelect.collapse"),
    }),
    [t],
  );
  // Build the Quick peek inspector labels on the client side. The
  // server page supplies plain strings (including the per-subtype
  // `protocolFields` table); function-valued formatters —
  // `triageSummary` and `moreCountSuffix` — close over the active
  // locale so they can't cross the server→client boundary and are
  // assembled here instead.
  const quickPeekLabels = useMemo<QuickPeekInspectorLabels>(
    () => ({
      ...labels.quickPeek,
      triageSummary: ({ count, max }) =>
        tResults("triageSummary", { count, max }),
      moreCountSuffix: (count: number) =>
        tResults("moreCountSuffix", { count }),
    }),
    [labels.quickPeek, tResults],
  );
  // Bind the analytics strip's plain-string templates into their
  // function-valued shapes here on the client. The server page only
  // supplies ICU strings + the categorical (level / category) label
  // tables; the formatter closures below close over the locale's
  // translator and so cannot cross the server→client boundary.
  const analyticsLabels = useMemo<DetectionAnalyticsLabels>(() => {
    const a = labels.analytics;
    return {
      dimensionLabel: a.dimensionLabel,
      dimensionOptions: a.dimensionOptions,
      topNLabel: a.topNLabel,
      topNChartTitleTemplate: a.topNChartTitleTemplate,
      timeSeriesTitle: a.timeSeriesTitle,
      countSuffix: (count: number) =>
        a.countSuffixTemplate.replace("{count}", count.toLocaleString(locale)),
      bucketLabel: (period: string) =>
        a.bucketLabelTemplate.replace("{period}", period),
      periodValues: {
        seconds: (n) => a.periodSecondsTemplate.replace("{n}", String(n)),
        minutes: (n) => a.periodMinutesTemplate.replace("{n}", String(n)),
        hours: (n) => a.periodHoursTemplate.replace("{n}", String(n)),
        days: (n) => a.periodDaysTemplate.replace("{n}", String(n)),
        weeks: (n) => a.periodWeeksTemplate.replace("{n}", String(n)),
      },
      loadingTitle: a.loadingTitle,
      loadingDescription: a.loadingDescription,
      errorTitle: a.errorTitle,
      errorDescription: a.errorDescription,
      errorRetry: a.errorRetry,
      forbiddenTitle: a.forbiddenTitle,
      forbiddenDescription: a.forbiddenDescription,
      forbiddenScopeTitle: a.forbiddenScopeTitle,
      forbiddenScopeDescription: a.forbiddenScopeDescription,
      emptyTitle: a.emptyTitle,
      emptyDescription: a.emptyDescription,
      levelLabels: a.levelLabels,
      categoryLabels: a.categoryLabels,
      countryUnknown: a.countryUnknown,
      countryUnavailable: a.countryUnavailable,
      pivotActivate: ({ label, value }) =>
        a.pivotActivateTemplate
          .replace("{label}", label)
          .replace("{value}", value),
    };
  }, [labels.analytics, locale]);
  const [analyticsOpen, setAnalyticsOpen] = useState(initialAnalyticsOpen);
  const [analyticsDimension, setAnalyticsDimension] =
    useState<AnalyticsDimension>(initialAnalyticsDimension);
  const [analyticsTopN, setAnalyticsTopN] =
    useState<AnalyticsTopN>(initialAnalyticsTopN);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openEndpointPanelOnDrawerOpen, setOpenEndpointPanelOnDrawerOpen] =
    useState(false);

  const [committedFilter, setCommittedFilter] = useState<Filter>(initialFilter);
  const [committedPeriod, setCommittedPeriod] = useState<PeriodKey | null>(
    initialPeriod,
  );
  const [committedEndpoints, setCommittedEndpoints] =
    useState<EndpointEntry[]>(initialEndpoints);
  // `pivotOnly` carries URL-only fields that aren't yet represented
  // in the drawer — today that's `origPort` / `respPort` / `proto`,
  // which arrive from the Investigation handoff and ride through the
  // encoded `?f=` blob so the pivot shape survives a reload until
  // Phase Network/IP wires them into the drawer. `kind` / `window`
  // are no longer parked here — they live in the committed filter
  // (`input.kinds`) and `committedPeriod` and round-trip through the
  // {@link Filter} payload directly, so a drawer edit clears any
  // stale token on the next Apply / chip removal.
  const pivotOnly = initialPivotOnly;
  // Reviewer Round 2 (P2 freshness): the analytics strip must use a
  // dedicated identity that pins the literal `start` / `end` pair —
  // re-applying the same relative period chip ("Last 1 hour") from
  // the drawer recomputes new ISO bounds, replaces the result-list
  // filter, and the open strip must refetch against the new window.
  // The multi-tab pivot identity collapses period-equivalent windows
  // together and is too lossy for that contract. See
  // {@link analyticsFilterIdentity}.
  const analyticsFilterIdentityValue = useMemo(
    () => analyticsFilterIdentity(committedFilter),
    [committedFilter],
  );
  // Active customer narrowing on the committed filter, threaded onto
  // the Quick peek pivots and the Investigation handoff URL (#384) so
  // a click-through preserves the customer scope rather than landing
  // on the unfiltered set. `Filter.input.customers` is `string[]` (the
  // wire format `EventListFilterInput` exposes); pivots and the events
  // route both speak the same encoding so no conversion is needed.
  const committedCustomers = useMemo<readonly string[] | undefined>(() => {
    if (committedFilter.mode !== "structured") return undefined;
    const list = committedFilter.input.customers;
    if (!list || list.length === 0) return undefined;
    return list;
  }, [committedFilter]);
  const [draft, setDraft] = useState<DetectionFilterDraft | null>(initialDraft);
  const [sensorCache, setSensorCache] = useState<SensorCache>({
    status: "idle",
  });
  // Target field for the drawer to focus after opening. `focusToken`
  // increments on each openDrawerFocused call so repeated clicks on
  // the same aggregate chip re-trigger the drawer's focus effect.
  const [focusField, setFocusField] = useState<DrawerFocusField | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  const [totalCount, setTotalCount] = useState<string | null>(
    initialResult.totalCount,
  );
  const [events, setEvents] = useState<DetectionEvent[]>(initialResult.events);
  // Parallel array of per-edge REview cursors (see
  // `DetectionShellInitialResult.eventKeys`). Kept in lockstep with
  // `events`: every `setEvents(x)` call is paired with a matching
  // `setEventKeys(y)`. The cursor is used as the React row key only
  // within a single committed slice — REview's schema documents
  // `EventEdge.cursor` as "a cursor for use in pagination", not as a
  // stable per-event identity across queries, so cross-commit row
  // reuse is prevented by `queryEpoch` below rather than by the
  // cursor value itself.
  const [eventKeys, setEventKeys] = useState<string[]>(initialResult.eventKeys);
  // Monotonic per-commit counter. Bumped on every committed query
  // transition — Apply, chip removal, Refresh, and the error / zero-
  // results branches — and composed into the React row key so
  // `EventRow` / `MorePopover` state cannot be carried across
  // unrelated committed queries even if REview happens to reuse a
  // positional cursor value in the new slice. The initial slice sits
  // on epoch `0`; the first client-side commit advances to `1`. The
  // multi-tab wrapper threads the cached counter back on remount so
  // a tab switched-back-to does not silently rewind the epoch.
  const [queryEpoch, setQueryEpoch] = useState(initialResult.queryEpoch ?? 0);
  const [resultError, setResultError] = useState<string | null>(
    initialResult.error,
  );
  // Reviewer Round 4 (item 1): seed `loading` from the snapshot so a
  // tab remounted mid-Apply (or mid-Refresh / mid-pagination) keeps
  // showing the loading skeleton until the resume effect below
  // re-issues the request. SSR bootstrap leaves `initialResult.loading`
  // undefined and the shell starts at idle.
  const [loading, setLoading] = useState(initialResult.loading ?? false);
  // Reviewer Round 1 (item 3): honour the wrapper-supplied cached
  // freshness timestamp on a tab remount. Without it, switching back
  // to a tab that had been queried earlier would compute
  // `Date.now()` here and the result header would read "Updated just
  // now" even though no refresh fired — making cached results look
  // newer than they are. Bootstrap-only loads (where the wrapper
  // omits the cache) fall back to the SSR-completed timestamp.
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(() => {
    if (initialResult.lastUpdatedMs !== undefined) {
      return initialResult.lastUpdatedMs;
    }
    return initialResult.error === null && initialResult.totalCount !== null
      ? Date.now()
      : null;
  });
  // Tracks whether any query has been dispatched (by the server-
  // rendered initial load or a subsequent Apply / Refresh / chip
  // removal). A freshly-mounted `+` tab with no successful query —
  // e.g. the server action returned an error before the page mounted
  // — renders the dedicated pre-query empty state instead of the
  // generic zero-results panel. The multi-tab wrapper threads the
  // cached value back on remount so a switched-back-to tab keeps its
  // post-query result panel rather than reverting to the pre-query
  // empty state.
  const [hasQueried, setHasQueried] = useState(
    initialResult.hasQueried ??
      (initialResult.error === null && initialResult.totalCount !== null),
  );
  const [pagination, setPagination] =
    useState<PaginationState>(initialPagination);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(
    initialResult.pageInfo,
  );
  // Subtle progress hint for multi-step Go-to-page walks. `null`
  // means no walk is in flight; otherwise the paginator renders a
  // "Walking… 3 of 9" label under the Go-to-page input.
  const [walking, setWalking] = useState<{
    current: number;
    target: number;
  } | null>(null);
  // Monotonic id for the active Go-to-page walk. A second Go submission
  // supersedes the first — any late REview response whose walk id
  // no longer matches is dropped so cursor drift during a multi-step
  // walk can't leak into the committed page.
  const latestWalkIdRef = useRef(0);
  // Quick peek inspector (Phase Detection-18 owns the content; this
  // shell wires the open/close contract and the jump into full
  // Investigation). At wide widths (≥ `desktop`) the inspector docks
  // inline as a right-hand pane; at narrower widths the same state
  // drives an overlay drawer.
  //
  // The selection is cleared whenever a committed query transition
  // replaces the result set (Apply, chip removal, Refresh, error,
  // zero-results). REview does not expose a stable per-event identity
  // in v1 — `EventEdge.cursor` is a pagination cursor, and the
  // `encodeEventLocator` tuple is documented as best-effort — so a
  // "keep inspector open and revalidate against the new slice"
  // strategy can silently retarget the inspector at a different
  // event when a positional cursor is reused across filters. Closing
  // on every commit is the defensive alternative.
  const [quickPeekEvent, setQuickPeekEvent] = useState<DetectionEvent | null>(
    initialQuickPeekEvent,
  );
  // Reviewer Round 9: pending Quick peek URL token captured from the
  // SSR bootstrap (or a prior tab activation) so the multi-tab
  // wrapper can re-emit `?event=` from the snapshot while the shell
  // has not yet been able to resolve the token against a successful
  // slice. Cleared as soon as the shell either restores the peek
  // (match found) or proves the token stale (URL stripped). The
  // wrapper's `buildUrlSearchForTab` falls through to this token
  // when `quickPeekEvent` is null, so its mount-time URL rewrite
  // does not clobber the URL token before Retry / Refresh can
  // reconcile it.
  const [pendingQuickPeekToken, setPendingQuickPeekToken] = useState<
    string | null
  >(initialPendingQuickPeekToken);
  // Ref mirror of `quickPeekEvent` so the async `runQueryFor` success
  // path can read the latest state without becoming a dependency.
  // Reviewer Round 7: used to gate the post-Refresh URL reconcile so
  // a pending `?event=` token from the mount-error path can be
  // matched against the retry's slice.
  const quickPeekEventRef = useRef<DetectionEvent | null>(null);
  useEffect(() => {
    quickPeekEventRef.current = quickPeekEvent;
  }, [quickPeekEvent]);
  const isDesktop = useIsDesktopViewport();
  // Monotonic id for the in-flight Apply; a late response whose id
  // no longer matches is dropped so the results region can't drift
  // away from the committed filter when the operator applies twice
  // in quick succession.
  const latestRequestIdRef = useRef(0);
  // Mirror of the most-recent `totalCount` state so `dispatchQuery`
  // can thread it into `runEventQuery` (for partial-final-page tail
  // requests) without re-binding the callback every time the total
  // refreshes — a reactive dependency would churn every downstream
  // useCallback and can mid-flight re-create the Go-to-page walker.
  const totalCountRef = useRef<string | null>(initialResult.totalCount);

  // Kicks off a sensor-list fetch and threads the result into the
  // session cache. Extracted so both the initial lazy-load (on the
  // first drawer open) and an explicit Retry click from the error
  // state can share the same side-effect shape. Kept outside the
  // cache updater so React Strict Mode's double-invocation of state
  // updaters cannot trigger duplicate network requests.
  const triggerSensorFetch = useCallback(() => {
    setSensorCache({ status: "loading" });
    void fetchSensors().then(
      (result: FetchSensorsResult) => {
        if (result.ok) {
          setSensorCache({
            status: "loaded",
            endpointAvailable: result.endpointAvailable,
            options: result.sensors.map((s) => ({
              id: s.id,
              name: s.name,
            })),
          });
        } else {
          setSensorCache({ status: "error" });
        }
      },
      () => setSensorCache({ status: "error" }),
    );
  }, []);

  // Customer fetch is owned by the multi-tab wrapper (Reviewer
  // Round 1 #1: lifted out of shell-local state so the cache survives
  // the keyed remount on tab switch). The wrapper supplies
  // `onCustomerRefresh` for the manual `↻` and the chip-body /
  // Filters-button drawer-open paths just call it on an idle/error
  // cache through `triggerCustomerFetch` below.
  const triggerCustomerFetch = onCustomerRefresh;

  const openDrawer = useCallback(() => {
    setDraft(
      (current) =>
        current ??
        filterToDraft(committedFilter, committedPeriod, committedEndpoints),
    );
    // The Filters button opens the drawer with no focus target;
    // chip-body activation routes through `openDrawerFocused`, which
    // is the only path that ever sets the endpoint panel flag.
    setOpenEndpointPanelOnDrawerOpen(false);
    setFocusField(null);
    setDrawerOpen(true);
    // Lazy-load the sensor inventory the first time the drawer
    // opens, and retry on a prior transient failure so a single
    // hiccup doesn't freeze Sensor into the "Coming soon" fallback
    // for the rest of the tab session.
    if (shouldTriggerSensorFetch(sensorCache)) triggerSensorFetch();
    // Customer inventory follows the same lazy-on-first-open
    // contract (#384). The two fetches fire together on the same
    // drawer-open trigger so both fields settle at the same visible
    // cadence.
    if (shouldTriggerCustomerFetch(customerCache)) triggerCustomerFetch();
  }, [
    committedFilter,
    committedPeriod,
    committedEndpoints,
    sensorCache,
    triggerSensorFetch,
    customerCache,
    triggerCustomerFetch,
  ]);

  // Mirror the Quick peek selection into the URL so a refresh
  // restores the active peek. `history.replaceState` matches the
  // Apply / chip-remove path above — the selection is not a
  // separate history entry, so Back does not rewind the peek.
  //
  // Defined ahead of the committed-query helpers (`dispatchQuery`,
  // `runQueryFor`, `handleApply`, `handleRemoveChip`) so those paths
  // can hand the URL sink into `applyCommitDispatchReset` —
  // Reviewer Round 3 flagged that closing the in-memory peek alone
  // leaves the tab URL carrying a stale `?event=<token>` entry, so
  // Refresh plus reload would resurrect the selection.
  const writeQuickPeekToUrl = useCallback((token: string | null) => {
    if (typeof window === "undefined") return;
    const nextSearch = applyQuickPeekToken(window.location.search, token);
    const url = `${window.location.pathname}${nextSearch}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    // Reviewer Round 9: any explicit URL write supersedes the
    // pending-token placeholder. Stripping the URL clears pending so
    // the wrapper's `buildUrlSearchForTab` does not re-emit a
    // just-removed token; setting a new token clears pending so the
    // wrapper falls back to encoding the new `quickPeekEvent`'s
    // locator (which the open-peek path always sets in the same
    // gesture).
    setPendingQuickPeekToken(null);
  }, []);

  // Match-or-strip leg of the mount-restore contract, run against a
  // freshly resolved committed-query slice. Reviewer Round 7: the
  // mount-only restore effect preserves a pending `?event=` token
  // when the initial fetch errors; this helper picks up the
  // deferred decision the first time a later successful slice can
  // actually prove the token stale or restore the peek.
  //
  // Reviewer Round 8 widened the scope: the helper also closes any
  // in-memory peek whose locator no longer matches the fresh slice.
  // That covers the "peek reopened during the retained-slice loading
  // window" race — the result list also drops row handlers during
  // `status === "loading"` to prevent that re-open, but this
  // defense-in-depth pass means the stale-inspector contract holds
  // even if another path manages to set the peek between dispatch
  // and the fetch landing.
  const reconcileQuickPeekAgainstSlice = useCallback(
    (nextEvents: readonly DetectionEvent[]) => {
      if (typeof window === "undefined") return;
      const current = quickPeekEventRef.current;
      const currentToken = current ? encodeEventLocator(current) : null;
      const stored = readQuickPeekToken(
        new URLSearchParams(window.location.search),
      );
      // Prefer the in-memory peek's own locator when present — covers
      // the race where a row click during the retained-slice loading
      // window reopened the peek after dispatch. Fall back to the URL
      // token for the mount-error restore path, where no in-memory
      // peek exists yet.
      const probeToken = currentToken ?? stored?.token ?? null;
      if (!probeToken) {
        // No URL token and no addressable in-memory peek. A non-
        // addressable in-memory peek (rare: a schema-limited row was
        // selected mid-flight) has no stable identity to re-match
        // against the fresh slice, so close it rather than risk
        // showing an inspector describing a row the new filter does
        // not return.
        if (current) setQuickPeekEvent(null);
        // Reviewer Round 9: a successful slice with no probe token is
        // also the canonical "this tab has no pending peek" state, so
        // clear any stale pending placeholder.
        setPendingQuickPeekToken(null);
        return;
      }
      const match = nextEvents.find(
        (evt) => encodeEventLocator(evt) === probeToken,
      );
      const action = reconcileQuickPeekUrlAction({
        tokenPresent: stored !== null,
        matchFound: match !== undefined,
      });
      if (match) {
        // `restore` for the mount-error path (no in-memory peek yet);
        // otherwise pin to the fresh-slice reference so downstream
        // renders use the latest event identity.
        if (action === "restore" && !current) setQuickPeekEvent(match);
        else if (current && current !== match) setQuickPeekEvent(match);
        // Reviewer Round 9: the pending placeholder is now resolved
        // to a concrete event — clear it so the wrapper encodes the
        // event's locator on the next URL write rather than the raw
        // pending token.
        setPendingQuickPeekToken(null);
        return;
      }
      // Token present but the fresh slice does not contain it: strip
      // the URL token and close any stale in-memory peek.
      if (action === "strip") writeQuickPeekToUrl(null);
      if (current) setQuickPeekEvent(null);
      // Reviewer Round 9: even when `action !== "strip"` (no URL
      // token but an in-memory peek that lost its row), pending can
      // now be cleared because either branch above decided the
      // peek's fate against a successful slice.
      setPendingQuickPeekToken(null);
    },
    [writeQuickPeekToUrl],
  );

  /**
   * Re-run a committed filter at a specific page / anchor. Used by
   * chip × removal, the result list's Refresh, the paginator's
   * First/Prev/Next/Last, and each step of a Go-to-page walk. Bumps
   * a monotonic request id so a late response from a superseded
   * dispatch is dropped — without that guard, a quick Next → Prev
   * could land the Prev rows on top of the Next slice.
   *
   * When a query-transition side effect fires (Apply, chip removal,
   * Refresh) the paginator state is reset to page 1 before dispatch
   * so the URL and the request agree: `head` + `page=1`.
   */
  const dispatchQuery = useCallback(
    (
      filter: Filter,
      args: {
        anchor: PageAnchor;
        pageSize: PageSize;
        page: number;
        /**
         * `true` for navigation within the current filter (paginator
         * clicks, Go-to-page walk steps). `false` for committed
         * transitions (Apply, chip removal, Refresh) — those bump
         * queryEpoch and close Quick peek per
         * {@link applyCommitDispatchReset}.
         */
        navigating: boolean;
      },
    ): Promise<RunEventQueryResult | null> => {
      setLoading(true);
      setResultError(null);
      setHasQueried(true);
      if (!args.navigating) {
        // See `applyCommitDispatchReset` for the dispatch-time contract.
        // Reviewer Round 7: only clear the URL token when we are
        // actually dismissing an open peek. Otherwise — e.g. Refresh
        // after an errored initial load, where the URL still carries a
        // pending-restore token but `quickPeekEvent` is null — we leave
        // the URL alone so a successful retry can still restore the
        // peek. The post-fetch reconcile below performs the "prove
        // stale with a successful slice" leg of the same contract.
        applyCommitDispatchReset({
          setQueryEpoch,
          setQuickPeekEvent,
          clearQuickPeekUrl: ({ hadPeek }) => {
            if (hadPeek) writeQuickPeekToUrl(null);
          },
        });
      }
      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      return new Promise<RunEventQueryResult | null>((resolve) => {
        startTransition(async () => {
          try {
            const result = await runEventQuery(filter, {
              pageSize: args.pageSize,
              anchor: args.anchor,
              // Pass the most-recently-known total so a `tail` anchor
              // requests the partial-final-page remainder instead of
              // the straddling `last: pageSize` window. For head /
              // after / before this is ignored by
              // `searchArgsForAnchor`. Read through a ref so the
              // dispatcher's identity doesn't churn on every total
              // update.
              totalCount: totalCountRef.current,
            });
            if (latestRequestIdRef.current !== requestId) {
              resolve(null);
              return;
            }
            if (result.ok) {
              totalCountRef.current = result.totalCount;
              setTotalCount(result.totalCount);
              setEvents(result.events);
              setEventKeys(result.eventKeys);
              setPageInfo(result.pageInfo);
              // For `tail` anchors, the server action's drift-
              // correction loop may have re-queried against a total
              // that crossed a page boundary (e.g. 1,453 → 1,553 at
              // 100/page moves the last page from 15 to 16). Re-derive
              // the label from the response's own `totalCount` so the
              // page counter matches the actual rows. Other anchors
              // keep the caller's chosen page.
              setPagination({
                pageSize: args.pageSize,
                anchor: args.anchor,
                page: committedPageForAnchor(
                  args.anchor,
                  args.pageSize,
                  result.totalCount,
                  args.page,
                ),
              });
              setResultError(null);
              setLastUpdatedMs(Date.now());
              // Reviewer Round 7: if the mount-error path left a
              // pending `?event=` token in the URL (no in-memory peek
              // to dismiss, token preserved through dispatch), this is
              // the first successful slice that can actually prove the
              // token stale or restore the selection. Re-run the same
              // match-or-strip logic the mount effect applies on first
              // load, against the fresh slice we just committed.
              //
              // Reviewer Round 8: the prior `=== null` guard let a peek
              // reopened during the retained-slice loading window
              // survive even when the fresh slice no longer contained
              // its row. Always reconciling — and letting the helper
              // itself close a stale in-memory peek — closes that
              // window. Paired with the result-list's handler gate on
              // `status === "ready"`, the stale-inspector contract from
              // #290 now has both a prevention and a detection leg.
              reconcileQuickPeekAgainstSlice(result.events);
            } else {
              totalCountRef.current = null;
              setTotalCount(null);
              setEvents([]);
              setEventKeys([]);
              setPageInfo(null);
              // Reviewer Round 6 #1: surface the typed
              // `forbidden-customer-scope` rejection with actionable
              // copy ("remove the unavailable customers") instead of
              // collapsing it back into the generic transient-error
              // banner. Other failure codes (`forbidden`,
              // `unauthenticated`, `server-error`) keep the generic
              // copy — those are not actionable from the result region.
              setResultError(
                result.code === "forbidden-customer-scope"
                  ? labels.resultsForbiddenScope
                  : labels.resultsError,
              );
            }
            resolve(result);
          } catch {
            if (latestRequestIdRef.current !== requestId) {
              resolve(null);
              return;
            }
            totalCountRef.current = null;
            setTotalCount(null);
            setEvents([]);
            setEventKeys([]);
            setPageInfo(null);
            setResultError(labels.resultsError);
            resolve(null);
          } finally {
            if (latestRequestIdRef.current === requestId) {
              setLoading(false);
            }
          }
        });
      });
    },
    [
      labels.resultsError,
      labels.resultsForbiddenScope,
      writeQuickPeekToUrl,
      reconcileQuickPeekAgainstSlice,
    ],
  );

  // Wrapper used by the Apply and chip × paths — both commit a new
  // filter and reset pagination back to page 1 (head) on transition.
  // Refresh does NOT route through here: it re-runs the *current*
  // filter at the *current* page, so it must not clear the cached
  // result (same-filter re-fetch) and calls `dispatchQuery` directly.
  const runQueryFor = useCallback(
    (filter: Filter) => {
      // Cancel any in-flight Go-to-page walk — its cursors were
      // derived from the superseded filter.
      latestWalkIdRef.current += 1;
      setWalking(null);
      // Reviewer Round 3: apply the atomic-transition reset so the
      // multi-tab wrapper's snapshot never observes "new filter + old
      // cached rows/cursor" during the async REview round-trip. See
      // {@link applyTransitionReset} for the full contract.
      applyTransitionReset(
        {
          setPagination,
          setEvents,
          setEventKeys,
          setTotalCount,
          setPageInfo,
          setLastUpdatedMs,
          setTotalCountRef: (v) => {
            totalCountRef.current = v;
          },
        },
        { pageSize: pagination.pageSize },
      );
      void dispatchQuery(filter, {
        anchor: { kind: "head" },
        pageSize: pagination.pageSize,
        page: 1,
        navigating: false,
      });
    },
    [dispatchQuery, pagination.pageSize],
  );

  // Reviewer Round 4 (item 1): resume an in-flight committed query
  // when a tab the operator switched away from mid-Apply (or mid-
  // Refresh / mid-pagination) is remounted. The wrapper threads the
  // snapshot's `loading: true` flag back through `initialResult.loading`;
  // if present, re-issue the same query at the snapshot's pagination
  // so the original Apply is not silently dropped. Re-dispatch lands
  // through `dispatchQuery` with `navigating: true` because the
  // dispatch-time reset (epoch bump, peek clear) was already applied
  // by the original commit.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — the snapshot's `loading` flag is read once on first render; subsequent state changes flow through normal dispatch paths.
  useEffect(() => {
    if (!shouldResumeQueryOnMount(initialResult.loading)) return;
    void dispatchQuery(initialFilter, {
      anchor: initialPagination.anchor,
      pageSize: initialPagination.pageSize,
      page: initialPagination.page,
      navigating: true,
    });
  }, []);

  // Reviewer Round 5: invalidate any in-flight dispatch / walk on
  // unmount. The multi-tab wrapper unmounts the shell on tab switch;
  // without the bump, an Apply / Refresh / paginator request started
  // in tab A still passes the request-id check after tab B has taken
  // over and runs global URL side effects under B's `?tab=`. See
  // {@link invalidateInFlightOnUnmount} for the full contract.
  useEffect(() => {
    return () => {
      invalidateInFlightOnUnmount({
        latestRequestIdRef,
        latestWalkIdRef,
      });
    };
  }, []);

  const handleApply = useCallback(
    (applied: DetectionFilterDraft) => {
      if (!applied.startIso || !applied.endIso) return;
      // Only the `ready` state (sensor-list query present + loaded)
      // permits a `sensors` value in the committed filter; every
      // other state strips it to preserve the fallback contract.
      const endpointLive =
        sensorCache.status === "loaded" && sensorCache.endpointAvailable;
      // Reviewer Round 8: same fallback contract for customers — the
      // draft can be hydrated from a bookmark / saved filter / pivot
      // URL, so without this gate Apply (and Save) would re-emit
      // `customers: [...]` in exactly the states the issue forbids:
      // first drawer-open fetch in flight (`loading`), manual refresh
      // landed on `error`, or `No customer access` (`loaded` with
      // empty options).
      const customerLive = customerSelectionLiveForCache(customerCache);
      const next = buildAppliedFilter(
        committedFilter,
        applied,
        endpointLive,
        customerLive,
        options,
      );
      setCommittedFilter(next);
      setCommittedPeriod(applied.period);
      setCommittedEndpoints(applied.endpoints);
      // Sync the cached draft with the canonical values we just
      // committed. `applied` is the drawer's already-normalized draft
      // (trimmed strings, normalized tag arrays), so reopening the
      // drawer shows the same text that the filter is actually using
      // rather than the original whitespace-padded input.
      setDraft(applied);
      setDrawerOpen(false);

      // Mirror the committed filter into the URL so a refresh restores
      // it. Reviewer Round 1 (item 1): the encoded `?f=` blob carries
      // the entire {@link Filter} — every `EventListFilterInput` field
      // (levels, countries, learning methods, categories, directions,
      // confidence bounds, sensors, endpoints) plus the future
      // `mode: "query"` branch. The legacy pivot encoder only covered a
      // subset and silently dropped those fields; reload would lose
      // them.
      //
      // Use `history.replaceState` rather than `router.replace` so the
      // URL update doesn't trigger a soft navigation. A soft navigation
      // would re-run this route's server page and `searchEvents()`
      // alongside the explicit `runEventQuery(next)` below — two
      // queries per Apply for the same filter, with the navigation
      // result discarded because the shell keeps its own client state.
      // `replaceState` keeps URL persistence (refresh restores the
      // active tab) without paying for a duplicate REview round-trip.
      const search = buildEncodedFilterSearch({
        filter: next,
        period: applied.period,
        endpoints: applied.endpoints,
        pivotExtras: extrasFromPivotOnly(pivotOnly),
      });
      // Apply resets the cursor to the start of the new filter
      // space — stale pagination keys would point at cursors from
      // the old filter's connection. Pagination itself is persisted
      // below when the fresh query resolves; the initial URL can stay
      // short (default page size, head anchor, no page param).
      if (pagination.pageSize !== INITIAL_PAGINATION_STATE.pageSize) {
        search.set("pageSize", String(pagination.pageSize));
      }
      preserveActiveTabParam(search);
      const qs = search.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.replaceState(window.history.state, "", url);

      runQueryFor(next);
    },
    [
      committedFilter,
      customerCache,
      pagination.pageSize,
      pivotOnly,
      options,
      pathname,
      runQueryFor,
      sensorCache,
    ],
  );

  /**
   * Replace the active tab's committed filter with a saved-filter
   * payload and re-run the query. Mirrors the {@link handleApply}
   * URL / cache-reset contract so loading a saved filter is
   * indistinguishable from re-applying it from the drawer — the
   * draft is dropped so the next drawer open rebuilds from the
   * loaded filter, the period chip is re-derived via
   * {@link matchesPeriodKey}, and rich endpoint entries are
   * rehydrated from `filter.input.endpoints` so the chip bar /
   * drawer stay in sync. Without rehydration the next drawer Apply
   * would rebuild `input.endpoints` from an empty draft and silently
   * clear the saved Network/IP rules.
   */
  const loadFilterIntoCurrentTab = useCallback(
    (filter: Filter) => {
      const period = derivePeriodForFilter(filter);
      const endpoints =
        filter.mode === "structured"
          ? endpointEntriesFromEndpointInputs(filter.input.endpoints)
          : [];
      setCommittedFilter(filter);
      setCommittedPeriod(period);
      setCommittedEndpoints(endpoints);
      setDraft(null);
      setDrawerOpen(false);

      const search = buildEncodedFilterSearch({
        filter,
        period,
        endpoints,
        pivotExtras: extrasFromPivotOnly(pivotOnly),
      });
      if (pagination.pageSize !== INITIAL_PAGINATION_STATE.pageSize) {
        search.set("pageSize", String(pagination.pageSize));
      }
      preserveActiveTabParam(search);
      const qs = search.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.replaceState(window.history.state, "", url);

      runQueryFor(filter);
    },
    [pagination.pageSize, pathname, pivotOnly, runQueryFor],
  );

  // Save dialog state — opened from the drawer's "Save this filter"
  // button. The dialog opens with the draft normalized into a
  // {@link Filter} so the saved payload exactly matches what an
  // immediate Apply would commit, and a chip-based default name so
  // the operator can confirm without typing.
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveDialogFilter, setSaveDialogFilter] = useState<Filter | null>(null);
  const [saveDialogDefaultName, setSaveDialogDefaultName] = useState("");

  const handleSaveSubmit = useCallback(
    async (name: string) => {
      if (!savedFilters || !saveDialogFilter) {
        return { ok: false as const, code: "server-error" as const };
      }
      const result = await savedFilters.save(name, saveDialogFilter);
      if (result.ok) {
        return { ok: true as const };
      }
      return { ok: false as const, code: result.code };
    },
    [saveDialogFilter, savedFilters],
  );

  // Bind the rail's function-valued labels (the per-row menu a11y
  // formatter takes a dynamic `name` arg) using the active locale's
  // translator on this side of the server→client boundary.
  const railLabels = useMemo<SavedFiltersRailLabels>(() => {
    const railStrings = labels.savedFiltersRail;
    return {
      title: railStrings.title,
      emptyHint: railStrings.emptyHint,
      loadingHint: railStrings.loadingHint,
      loadErrorHint: railStrings.loadErrorHint,
      menuLabel: (name: string) =>
        railStrings.menuLabelTemplate.replace("{name}", name),
      loadInNewTab: railStrings.loadInNewTab,
      loadInCurrentTab: railStrings.loadInCurrentTab,
      rename: railStrings.rename,
      delete: railStrings.delete,
      deleteConfirm: railStrings.deleteConfirm,
      renameDialog: railStrings.renameDialog,
    };
  }, [labels.savedFiltersRail]);

  const recommendedRailLabels = useMemo<RecommendedFiltersRailLabels>(
    () => ({
      title: labels.recommendedFilter,
      emptyHint: labels.recommendedEmptyHint,
      presetName: (preset) =>
        labels.recommendedPresetNames[preset.id] ?? preset.id,
    }),
    [
      labels.recommendedFilter,
      labels.recommendedEmptyHint,
      labels.recommendedPresetNames,
    ],
  );

  const handleRemoveChip = useCallback(
    (target: ChipRemoveTarget) => {
      const next = removeActiveChip(
        committedFilter,
        committedEndpoints,
        target,
      );
      setCommittedFilter(next.filter);
      setCommittedEndpoints(next.endpoints);
      // A chip removal that drops `start`/`end` would clear the
      // committed period state too — the shell never reaches that
      // path today (the period chip removal target is `period`),
      // so the period stays in sync with the filter's start/end.
      if (target.kind === "period") {
        setCommittedPeriod(null);
      }
      // Drop the cached drawer draft — it was built from the
      // pre-removal filter and would clobber the change if the
      // operator opens the drawer next.
      setDraft(null);
      // Persist the removal in the URL the same way Apply does. The
      // period chip removes `committedPeriod` → we pass `null` so the
      // encoded blob drops the period alongside the filter itself;
      // every other target leaves the period untouched so the
      // current committed period still rides through.
      const nextPeriod = target.kind === "period" ? null : committedPeriod;
      const search = buildEncodedFilterSearch({
        filter: next.filter,
        period: nextPeriod,
        endpoints: next.endpoints,
        pivotExtras: extrasFromPivotOnly(pivotOnly),
      });
      if (pagination.pageSize !== INITIAL_PAGINATION_STATE.pageSize) {
        search.set("pageSize", String(pagination.pageSize));
      }
      preserveActiveTabParam(search);
      const qs = search.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.replaceState(window.history.state, "", url);
      runQueryFor(next.filter);
    },
    [
      committedEndpoints,
      committedFilter,
      committedPeriod,
      pagination.pageSize,
      pivotOnly,
      pathname,
      runQueryFor,
    ],
  );

  /**
   * Write the current pagination state into the URL alongside the
   * existing filter / pivot params. Called after every successful
   * paginator navigation so a refresh or share-this-URL lands on
   * the same page.
   */
  const persistPaginationToUrl = useCallback(
    (next: PaginationState) => {
      const search = buildEncodedFilterSearch({
        filter: committedFilter,
        period: committedPeriod,
        endpoints: committedEndpoints,
        pivotExtras: extrasFromPivotOnly(pivotOnly),
      });
      for (const [k, v] of paginationToSearchEntries(next)) {
        search.set(k, v);
      }
      preserveActiveTabParam(search);
      const qs = search.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.replaceState(window.history.state, "", url);
    },
    [committedEndpoints, committedFilter, committedPeriod, pathname, pivotOnly],
  );

  /**
   * Fire a paginator navigation (First / Prev / Next / Last /
   * single-step Go-to-page) at the current committed filter. On
   * success, writes the resulting pagination state into the URL so
   * a refresh restores the same page.
   */
  const navigateTo = useCallback(
    async (next: PaginationState): Promise<RunEventQueryResult | null> => {
      // Navigation within the current filter — Apply contract does
      // not apply. `dispatchQuery` with `navigating: true` keeps
      // Quick peek open and does not bump queryEpoch (positional
      // cursors change, but the committed filter is unchanged, so
      // row-state leakage is not a risk).
      const result = await dispatchQuery(committedFilter, {
        anchor: next.anchor,
        pageSize: next.pageSize,
        page: next.page,
        navigating: true,
      });
      if (result?.ok) {
        // For `tail` navigations, re-derive the page label from the
        // response's own `totalCount` so a URL reload lands on the
        // same rows under the same page number even when the total
        // drifted during the request.
        persistPaginationToUrl({
          ...next,
          page: committedPageForAnchor(
            next.anchor,
            next.pageSize,
            result.totalCount,
            next.page,
          ),
        });
      }
      return result;
    },
    [committedFilter, dispatchQuery, persistPaginationToUrl],
  );

  const handleRefresh = useCallback(() => {
    // Refresh re-runs the current slice rather than the Apply/chip
    // contract's "reset to page 1". An operator sitting on page N
    // who asks to refresh expects the same window with fresh data,
    // not a silent teleport to page 1. `navigating: false` still
    // bumps the queryEpoch so per-row state (MorePopover, focus) is
    // cleared, matching the dispatch-time contract for committed
    // transitions.
    //
    // Short-circuit when the tab has not yet run its first query: a
    // `+`-created tab seeded with the default filter must reach its
    // first result through Apply, not through Refresh (#281). The
    // header button is already disabled for `empty-prequery`, so this
    // mostly guards programmatic callers. Reviewer Round 8 (item 1):
    // a bootstrap tab whose initial auto-query failed is *not*
    // `!hasQueried` — `bootstrapTabToSnapshot` marks it `hasQueried`
    // so the in-panel Retry button (which calls back through this
    // handler) can re-issue the query against the same filter /
    // anchor instead of being a no-op.
    if (!hasQueried) return;
    latestWalkIdRef.current += 1;
    setWalking(null);
    void dispatchQuery(committedFilter, {
      anchor: pagination.anchor,
      pageSize: pagination.pageSize,
      page: pagination.page,
      navigating: false,
    }).then((result) => {
      if (result?.ok) {
        // A Refresh parked on a `tail` anchor can see the total shift
        // between the previous query and this one. Persist the page
        // number derived from the fresh total so the URL counts from
        // the same rows the paginator is about to render.
        persistPaginationToUrl({
          ...pagination,
          page: committedPageForAnchor(
            pagination.anchor,
            pagination.pageSize,
            result.totalCount,
            pagination.page,
          ),
        });
      }
    });
  }, [
    committedFilter,
    dispatchQuery,
    hasQueried,
    pagination,
    persistPaginationToUrl,
  ]);

  /**
   * Walk the connection forward to `target` at `pageSize`, one
   * request at a time. Shared by the Go-to-page input and the
   * page-size selector — both need a sequential cursor walk to
   * reach an arbitrary page without random-access support.
   *
   * `canResumeFromCurrent` lets Go-to-page reuse the current
   * pagination when its target lies strictly ahead (saves steps
   * for forward jumps). The page-size selector always walks from
   * head because cursors are page-size scoped — reusing a cursor
   * captured at `50/page` under a `100/page` request would drift
   * the window off by up to one old-page worth of rows.
   */
  const runWalkTo = useCallback(
    async (
      walkId: number,
      target: number,
      pageSize: PageSize,
      canResumeFromCurrent: boolean,
    ): Promise<void> => {
      let currentPage: number;
      let anchorForCurrentPage: PageAnchor;
      let currentPageInfo: PageInfo | null;
      if (canResumeFromCurrent && pagination.page < target && pageInfo) {
        currentPage = pagination.page;
        anchorForCurrentPage = pagination.anchor;
        currentPageInfo = pageInfo;
      } else {
        currentPage = 1;
        anchorForCurrentPage = { kind: "head" };
        currentPageInfo = null;
      }

      if (currentPageInfo === null) {
        setWalking({ current: currentPage, target });
        const seed = await dispatchQuery(committedFilter, {
          anchor: anchorForCurrentPage,
          pageSize,
          page: currentPage,
          navigating: true,
        });
        if (latestWalkIdRef.current !== walkId) return;
        if (!seed?.ok) {
          setWalking(null);
          return;
        }
        currentPageInfo = seed.pageInfo;
      }

      while (currentPage < target) {
        if (latestWalkIdRef.current !== walkId) return;
        if (!currentPageInfo?.hasNextPage || !currentPageInfo.endCursor) {
          // REview ran out of pages before totalCount said we
          // should — commit whatever state we last reached and
          // stop walking.
          break;
        }
        const stepAnchor: PageAnchor = {
          kind: "after",
          cursor: currentPageInfo.endCursor,
        };
        setWalking({ current: currentPage + 1, target });
        const step = await dispatchQuery(committedFilter, {
          anchor: stepAnchor,
          pageSize,
          page: currentPage + 1,
          navigating: true,
        });
        if (latestWalkIdRef.current !== walkId) return;
        if (!step?.ok) {
          setWalking(null);
          return;
        }
        anchorForCurrentPage = stepAnchor;
        currentPage += 1;
        currentPageInfo = step.pageInfo;
      }

      if (latestWalkIdRef.current !== walkId) return;
      setWalking(null);
      persistPaginationToUrl({
        pageSize,
        page: currentPage,
        anchor: anchorForCurrentPage,
      });
    },
    [
      committedFilter,
      dispatchQuery,
      pageInfo,
      pagination,
      persistPaginationToUrl,
    ],
  );

  const handlePageSizeChange = useCallback(
    (size: PageSize) => {
      // Keep the operator near the first row of the current window
      // rather than snapping to page 1: at page 3 of `50/page`
      // (rows 101-150), switching to `100/page` lands on page 2
      // (rows 101-200); at page 2 of `100/page`, switching to
      // `25/page` lands on page 5. If the new target is page 1, use
      // a head shortcut; otherwise walk from head at the new size
      // (cursors don't port across page sizes). We intentionally do
      // *not* collapse a target that happens to equal the current
      // `totalPages` into a tail anchor: tail navigations re-derive
      // the last page from the response's fresh `totalCount`, which
      // would land on a different page than the explicit target
      // derived from the prior window's first row when new events
      // have arrived between queries.
      if (size === pagination.pageSize) return;
      const walkId = latestWalkIdRef.current + 1;
      latestWalkIdRef.current = walkId;
      setWalking(null);
      const targetPage = pageAtNewSize(
        pagination.page,
        pagination.pageSize,
        size,
      );
      if (targetPage <= 1) {
        void navigateTo({
          pageSize: size,
          page: 1,
          anchor: { kind: "head" },
        });
        return;
      }
      void runWalkTo(walkId, targetPage, size, false);
    },
    [navigateTo, pagination, runWalkTo],
  );

  const handleFirstPage = useCallback(() => {
    latestWalkIdRef.current += 1;
    setWalking(null);
    void navigateTo({
      pageSize: pagination.pageSize,
      page: 1,
      anchor: { kind: "head" },
    });
  }, [navigateTo, pagination.pageSize]);

  const handleLastPage = useCallback(() => {
    latestWalkIdRef.current += 1;
    setWalking(null);
    // Derive the "last" page number from the current total so the
    // range indicator reads right; if the total can't be parsed
    // (REview returned no total), fall back to page 1 + tail anchor
    // — REview still returns the last slice, the page counter just
    // can't display an accurate number.
    const lastPage = totalPagesFrom(totalCount, pagination.pageSize) ?? 1;
    void navigateTo({
      pageSize: pagination.pageSize,
      page: lastPage,
      anchor: { kind: "tail" },
    });
  }, [navigateTo, pagination.pageSize, totalCount]);

  const handleNextPage = useCallback(() => {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    latestWalkIdRef.current += 1;
    setWalking(null);
    void navigateTo({
      pageSize: pagination.pageSize,
      page: pagination.page + 1,
      anchor: { kind: "after", cursor: pageInfo.endCursor },
    });
  }, [navigateTo, pageInfo, pagination]);

  const handlePreviousPage = useCallback(() => {
    if (!pageInfo?.hasPreviousPage || !pageInfo.startCursor) return;
    latestWalkIdRef.current += 1;
    setWalking(null);
    void navigateTo({
      pageSize: pagination.pageSize,
      page: Math.max(1, pagination.page - 1),
      anchor: { kind: "before", cursor: pageInfo.startCursor },
    });
  }, [navigateTo, pageInfo, pagination]);

  /**
   * Jump the connection to page N. Relay cursors are opaque offsets
   * into the result order, so there is no O(1) jump when the target
   * lies strictly inside the window — `Go to page 50` from page 1 is
   * 49 forward requests. This handler:
   *
   *   - No-ops when the target matches the current page. The walker
   *     would otherwise drop down the "restart from head" branch and
   *     re-walk (or re-fetch) the same slice the operator is already
   *     looking at.
   *   - Short-circuits to First / Last when the target is 1 or
   *     ≥ totalPages, saving the entire walk in the two most common
   *     cases (power users typing a small number, or clicking Last
   *     from the middle).
   *   - Otherwise delegates to {@link runWalkTo}, which handles the
   *     cursor walk, progress hint, and supersession guard shared
   *     with the page-size selector.
   *   - Caps the target at the derived total page count so a typo
   *     like "go to page 99999" lands on the last page instead of
   *     walking forever.
   */
  const handleGoToPage = useCallback(
    (target: number) => {
      if (!Number.isFinite(target) || target < 1) return;
      if (loading) return;

      // Derive totalPages from the currently-known totalCount.
      // (Unknown → no cap, so the walker stops naturally when
      // `hasNextPage` / `hasPreviousPage` goes false.)
      const totalPages = totalPagesFrom(totalCount, pagination.pageSize);
      const capped =
        totalPages !== null ? Math.min(target, totalPages) : target;

      // Already on the target page — nothing to do. Without this
      // guard the handler would fall into the walker's "restart from
      // head" branch and re-walk the same number of pages we're
      // already parked on.
      if (capped === pagination.page) return;

      const walkId = latestWalkIdRef.current + 1;
      latestWalkIdRef.current = walkId;
      setWalking(null);

      // Short-circuits for the cheap cases.
      if (capped <= 1) {
        void navigateTo({
          pageSize: pagination.pageSize,
          page: 1,
          anchor: { kind: "head" },
        });
        return;
      }
      if (totalPages !== null && capped >= totalPages) {
        void navigateTo({
          pageSize: pagination.pageSize,
          page: totalPages,
          anchor: { kind: "tail" },
        });
        return;
      }

      void runWalkTo(walkId, capped, pagination.pageSize, true);
    },
    [loading, navigateTo, pagination, runWalkTo, totalCount],
  );

  // CSV export controller — owns the download round-trip, the
  // large-export confirmation dialog, and the error banner. The
  // payload is built lazily from `committedFilter` and the locale
  // translator so the export always reflects the latest committed
  // state at click time, not the state that was live when the
  // button was first rendered.
  // Latest committed total-count is threaded through
  // `useCsvExportTotalCountGetter`, which owns the render-synced
  // ref + stable lazy getter together so the regression test can
  // import the exact helper the shell wires into `useCsvExport`.
  // See the helper's module-level comment for why an effect-based
  // sync would open a stale-count window for Download CSV.
  const getKnownTotalCount = useCsvExportTotalCountGetter(totalCount);
  const csvExport = useCsvExport({
    errorMessage: labels.exportErrorMessage,
    // Reviewer Round 6 #1: surface the export route's
    // `code: "forbidden-customer-scope"` 403 with actionable copy
    // ("remove the unavailable customers") instead of the generic
    // export-error banner.
    forbiddenScopeMessage: labels.exportForbiddenScopeMessage,
    formatLimitExceededMessage: useCallback(
      ({ totalCount, limit }: { totalCount: string; limit: number }) =>
        labels.exportLimitExceededTemplate
          .replace("{count}", totalCount)
          .replace("{limit}", String(limit)),
      [labels.exportLimitExceededTemplate],
    ),
    // Reviewer Round 10: feed the currently-rendered total count
    // into the hook so known-large / known-over-cap exports are
    // gated on the client before the save picker opens.
    getKnownTotalCount,
    buildPayload: useCallback<() => CsvExportPayload>(() => {
      const headers = {
        level: tResults("csvHeaders.level"),
        time: tResults("csvHeaders.time"),
        kind: tResults("csvHeaders.kind"),
        attackKind: tResults("csvHeaders.attackKind"),
        category: tResults("csvHeaders.category"),
        confidence: tResults("csvHeaders.confidence"),
        triage: tResults("csvHeaders.triage"),
        source: tResults("csvHeaders.source"),
        destination: tResults("csvHeaders.destination"),
        sensor: tResults("csvHeaders.sensor"),
        userName: tResults("csvHeaders.userName"),
        hostname: tResults("csvHeaders.hostname"),
      } as const;
      return {
        filter: committedFilter,
        periodKey: committedPeriod,
        headers,
        formatRowOptions: {
          levelLabels: resultListLabels.levelLabels,
          categoryLabels: resultListLabels.categoryLabels,
          countryUnknown: resultListLabels.countryUnknown,
          countryUnavailable: resultListLabels.countryUnavailable,
          // Raw ICU template so the server can substitute
          // `{count}` / `{max}` into the triage cell without a
          // next-intl message formatter — matches the string the
          // result row renders via `ResultListLabels.triageSummary`.
          triageSummaryTemplate: tResults.raw("triageSummary") as string,
          // Same raw-template trick for the plural-endpoint "+N
          // more" summary so subtypes that only populate the
          // plural addressing fields (e.g. ExternalDdos,
          // MultiHostPortScan) render the locale's suffix instead
          // of an English fallback. Matches
          // `ResultListLabels.moreCountSuffix` in KR.
          moreCountSuffixTemplate: tResults.raw("moreCountSuffix") as string,
        },
      };
    }, [committedFilter, committedPeriod, resultListLabels, tResults]),
  });

  const handleDownloadCsv = useCallback(() => {
    void csvExport.start();
  }, [csvExport]);
  const handleConfirmLargeExport = useCallback(() => {
    void csvExport.confirmAndContinue();
  }, [csvExport]);
  const handleNarrowFilterFromExport = useCallback(() => {
    csvExport.cancelConfirmation();
    openDrawer();
  }, [csvExport, openDrawer]);

  const openDrawerFocused = useCallback(
    (focus: FilterChipFocus) => {
      // Ensure the drawer has a draft to edit, then scroll-focus the
      // matching section. `DrawerFocusField` is a superset that covers
      // every `FilterChipFocus` value, so the cast is safe — the
      // drawer itself no-ops on targets whose anchor isn't mounted.
      setDraft(
        (current) =>
          current ??
          filterToDraft(committedFilter, committedPeriod, committedEndpoints),
      );
      setFocusField(focus);
      setFocusToken((t) => t + 1);
      // Endpoint aggregate: also expand the Network/IP advanced panel
      // so the operator lands in the same UI as the sidebar "Advanced"
      // affordance. For every other focus target, clear the flag so a
      // prior endpoint activation doesn't leak into an unrelated field
      // (e.g. Period / Source) on the next chip click.
      setOpenEndpointPanelOnDrawerOpen(shouldOpenEndpointPanelForFocus(focus));
      setDrawerOpen(true);
      // Kick off the lazy sensor fetch on the chip-body path too, so
      // `SensorMultiSelect` doesn't sit in its disabled "Loading
      // sensors…" placeholder forever when the operator opens the
      // drawer via a chip without ever having clicked Filters.
      if (shouldTriggerSensorFetch(sensorCache)) triggerSensorFetch();
      // Customer fetch follows the same chip-body wiring (#384).
      if (shouldTriggerCustomerFetch(customerCache)) triggerCustomerFetch();
    },
    [
      committedFilter,
      committedPeriod,
      committedEndpoints,
      sensorCache,
      triggerSensorFetch,
      customerCache,
      triggerCustomerFetch,
    ],
  );

  const paginationLabels = useMemo<PaginationControlsLabels>(
    () => ({
      pageSizeLabel: labels.pagination.pageSizeLabel,
      rangeIndicator: ({ start, end, total }) =>
        tPagination("rangeIndicator", { start, end, total }),
      totalOnly: ({ total }) => tPagination("totalOnly", { total }),
      pageOfTotal: ({ page, total }) =>
        tPagination("pageOfTotal", { page, total }),
      firstPage: labels.pagination.firstPage,
      previousPage: labels.pagination.previousPage,
      nextPage: labels.pagination.nextPage,
      lastPage: labels.pagination.lastPage,
      goToPageLabel: labels.pagination.goToPageLabel,
      goToPagePlaceholder: labels.pagination.goToPagePlaceholder,
      goToPageSubmit: labels.pagination.goToPageSubmit,
      walkingProgress: ({ current, target }) =>
        tPagination("walkingProgress", { current, target }),
    }),
    [labels.pagination, tPagination],
  );

  const drawerLabels = useMemo<FilterDrawerLabels>(() => {
    const withRemoveLabel = (
      field: TagField,
      strings: Omit<TagFieldLabel, "removeLabel">,
    ): TagFieldLabel => ({
      ...strings,
      removeLabel: (tag: string) =>
        t(
          `attributes.${field}.remove` as Parameters<typeof t>[0],
          { tag } as Parameters<typeof t>[1],
        ),
    });
    const attributes: FilterDrawerLabels["attributes"] = {
      source: labels.drawer.attributes.source,
      destination: labels.drawer.attributes.destination,
      keywords: withRemoveLabel("keywords", labels.drawer.attributes.keywords),
      hostnames: withRemoveLabel(
        "hostnames",
        labels.drawer.attributes.hostnames,
      ),
      userIds: withRemoveLabel("userIds", labels.drawer.attributes.userIds),
      userNames: withRemoveLabel(
        "userNames",
        labels.drawer.attributes.userNames,
      ),
      userDepartments: withRemoveLabel(
        "userDepartments",
        labels.drawer.attributes.userDepartments,
      ),
    };
    return { ...labels.drawer, attributes };
  }, [labels.drawer, t]);

  const sensorOptions: readonly SensorOption[] =
    sensorCache.status === "loaded" ? sensorCache.options : [];
  // See `sensorStateForCache` for the intent behind each branch:
  //   - `idle`/`loading` → "Loading sensors…" while the first
  //     fetch resolves; this must NOT reuse "Coming soon" copy
  //     because the endpoint may well be live.
  //   - `error` → retryable error state with an inline Retry
  //     button, so a transient hiccup doesn't require closing and
  //     reopening the drawer.
  //   - `loaded && !endpointAvailable` → "Coming soon" placeholder,
  //     the only case where the vendored schema actually lacks the
  //     sensor-list query.
  //   - `loaded && endpointAvailable` → functional multi-select.
  // `buildAppliedFilter` still gates `sensors` submission on the
  // `ready` state, so no intermediate state leaks IDs into the
  // committed filter.
  const sensorState = sensorStateForCache(sensorCache);

  // Customer cache → drawer state + chip-summary options. Mirrors
  // the sensor wiring above; the empty-scope edge case
  // (`kind: 'empty'`) is folded into a `loaded` cache with
  // `options.length === 0` so the drawer renders the dedicated
  // "No customer access" affordance.
  const customerOptions: readonly CustomerOption[] =
    customerCache.status === "loaded" ? customerCache.options : [];
  const customerState = customerStateForCache(customerCache);
  // Lookup options for chip-name rendering. Reviewer Round 1 #3:
  // a bookmarked `?f=` URL (or saved filter / pivot) that already
  // carries `customers: [<id>, ...]` paints chips in the active
  // chip bar before the customer cache transitions out of `idle`.
  // Falling back to `initialCustomerOptions` (seeded server-side
  // from `getEffectiveCustomerScope(session)`) means those chips
  // render the customer **name** on the first paint, not the raw
  // numeric id `summarizeFilter` defaults to when the option list
  // is empty. Once the wrapper's manual-refresh resolves, the live
  // `loaded` cache wins so a fresh post-refresh assignment shows
  // up immediately.
  const customerSummaryOptions = useMemo<
    readonly { value: string; label: string }[]
  >(() => {
    const source =
      customerCache.status === "loaded"
        ? customerCache.options
        : (initialCustomerOptions ?? []);
    return source.map((c) => ({ value: String(c.id), label: c.name }));
  }, [customerCache, initialCustomerOptions]);

  // Shared chip summariser: one `Filter → FilterChip[]` call the bar
  // reuses everywhere. The pivot-only chips above are concatenated
  // on render because they live outside `EventListFilterInput`.
  const summarizeLabels = useMemo<SummarizeFilterLabels>(
    () => ({
      sensor: labels.drawer.sensor.label,
      sensorAggregate: labels.summarize.sensorAggregate,
      customers: labels.drawer.customer.label,
      // #384: customer aggregate chip reads `Customer: 4 selected`,
      // matching the issue's prescribed wording.
      customerAggregate: (count: number) =>
        `${labels.drawer.customer.label}: ${labels.summarize.customerAggregate.replace("{count}", String(count))}`,
      period: t("chips.period"),
      periodOptions: labels.drawer.periodOptions,
      formatRange: ({ start, end }) => t("activeRange", { start, end }),
      direction: labels.directionChips.label,
      directionValues: labels.directionChips.values,
      confidence: labels.confidenceChipLabel,
      source: labels.chipLabels.source,
      destination: labels.chipLabels.destination,
      keywords: labels.chipLabels.keywords,
      hostnames: labels.chipLabels.hostnames,
      userIds: labels.chipLabels.userIds,
      userNames: labels.chipLabels.userNames,
      userDepartments: labels.chipLabels.userDepartments,
      levels: labels.drawer.fields.levels,
      countries: labels.drawer.fields.countries,
      learningMethods: labels.drawer.fields.learningMethods,
      categories: labels.drawer.fields.categories,
      kinds: labels.drawer.fields.kinds,
      categoricalAggregate: ({ label, count }) =>
        t("chips.countAggregate", { label, count }),
    }),
    [labels, t],
  );
  const summarizedChips = useMemo<FilterChip[]>(
    () =>
      summarizeFilter(committedFilter, summarizeLabels, {
        period: committedPeriod,
        sensorOptions,
        customerOptions: customerSummaryOptions,
        categoricalOptions: {
          levels: options.levels,
          countries: options.countries,
          learningMethods: options.learningMethods,
          categories: options.categories,
          kinds: options.kinds,
        },
      }),
    [
      committedFilter,
      committedPeriod,
      options,
      sensorOptions,
      customerSummaryOptions,
      summarizeLabels,
    ],
  );
  // Endpoints still flow through their richer drawer-side entries; the
  // unified summariser covers the committed `EventListFilterInput`, but
  // endpoint entries live parallel to it and carry the raw text the
  // user typed.
  const endpointChips = buildEndpointChips(
    committedEndpoints,
    labels.endpointChips,
  );
  const hasChips = summarizedChips.length > 0 || endpointChips.length > 0;

  // Save dialog opens with the draft normalized to a Filter so the
  // saved payload exactly matches what an immediate Apply would
  // commit. Defined here because the chip summariser + sensor
  // options are declared just above; placing the callback any
  // earlier would reference variables before their declaration.
  const handleSaveRequest = useCallback(
    (applied: DetectionFilterDraft) => {
      const endpointLive =
        sensorCache.status === "loaded" && sensorCache.endpointAvailable;
      // Reviewer Round 8: see {@link handleApply}. The Save path also
      // routes the draft through `buildAppliedFilter`, so a saved
      // filter created while the customer cache is `loading`,
      // `error`, or `No customer access` (`loaded` + empty options)
      // would otherwise persist a stale `customers` array — even
      // though the drawer disabled the control. Apply the same gate
      // so the saved payload omits `customers` in those states.
      const customerLive = customerSelectionLiveForCache(customerCache);
      const next = buildAppliedFilter(
        committedFilter,
        applied,
        endpointLive,
        customerLive,
        options,
      );
      const chips = summarizeFilter(next, summarizeLabels, {
        period: applied.period,
        sensorOptions,
        customerOptions: customerSummaryOptions,
        categoricalOptions: {
          levels: options.levels,
          countries: options.countries,
          learningMethods: options.learningMethods,
          categories: options.categories,
          kinds: options.kinds,
        },
      });
      const defaultName = autoTabNameFromChips(
        chips.map((c) => c.value),
        labels.drawer.periodOptions[DEFAULT_PERIOD_KEY],
      );
      setSaveDialogFilter(next);
      setSaveDialogDefaultName(defaultName);
      setSaveDialogOpen(true);
    },
    [
      committedFilter,
      customerCache,
      labels.drawer.periodOptions,
      options,
      sensorCache,
      sensorOptions,
      customerSummaryOptions,
      summarizeLabels,
    ],
  );

  const resultRange = useMemo<{ start: string; end: string } | null>(() => {
    if (committedFilter.mode !== "structured") return null;
    const { start, end } = committedFilter.input;
    if (!start || !end) return null;
    return {
      start: isoToLocalInput(start),
      end: isoToLocalInput(end),
    };
  }, [committedFilter]);

  const resultListState: ResultListState = useMemo(() => {
    if (loading) {
      return {
        status: "loading",
        events,
        eventKeys,
        totalCount,
        range: resultRange,
        lastUpdatedMs,
      };
    }
    if (resultError) {
      return {
        status: "error",
        events: [],
        eventKeys: [],
        totalCount: null,
        range: resultRange,
        lastUpdatedMs,
      };
    }
    if (!hasQueried) {
      return {
        status: "empty-prequery",
        events: [],
        eventKeys: [],
        totalCount: null,
        range: resultRange,
        lastUpdatedMs,
      };
    }
    return {
      status: "ready",
      events,
      eventKeys,
      totalCount,
      range: resultRange,
      lastUpdatedMs,
    };
  }, [
    events,
    eventKeys,
    hasQueried,
    lastUpdatedMs,
    loading,
    resultError,
    resultRange,
    totalCount,
  ]);

  /**
   * Build the `/events/<token>?returnTo=...` href for an event so
   * the Quick peek "Open full investigation" action can render as a
   * real anchor tag — middle-click and Cmd+click open a new browser
   * tab rather than routing programmatically. Returns `null` when
   * the event lacks an encodable locator (schema-limited subtypes);
   * callers hide the affordance in that case.
   */
  const buildInvestigateHref = useCallback(
    (event: DetectionEvent): string | null => {
      const token = encodeEventLocator(event);
      if (!token) return null;
      const search =
        typeof window !== "undefined" ? window.location.search : "";
      // Drop the peek-selection param from `returnTo` — if the
      // operator comes back, Quick peek restores on mount from the
      // tab's own URL state rather than from a stale `returnTo`.
      const cleanSearch = applyQuickPeekToken(search, null);
      const returnTo = `${pathname}${cleanSearch}`;
      // Forward the active customer narrowing (#384) as a separate
      // query param so the Investigation page can thread it onto its
      // outbound pivot URLs (Overview "same source" / Related). Kept
      // out of `returnTo` to avoid forcing the events route to decode
      // the encoded `?f=` filter blob.
      const params = new URLSearchParams();
      params.set("returnTo", returnTo);
      if (committedCustomers && committedCustomers.length > 0) {
        params.set("customers", committedCustomers.join(","));
      }
      return `/events/${encodeURIComponent(token)}?${params.toString()}`;
    },
    [pathname, committedCustomers],
  );

  const openQuickPeekFor = useCallback(
    (event: DetectionEvent) => {
      setQuickPeekEvent(event);
      const token = encodeEventLocator(event);
      writeQuickPeekToUrl(token);
    },
    [writeQuickPeekToUrl],
  );

  const closeQuickPeek = useCallback(() => {
    setQuickPeekEvent(null);
    writeQuickPeekToUrl(null);
  }, [writeQuickPeekToUrl]);

  const handleRowOpen = useCallback(
    (event: DetectionEvent) => {
      openQuickPeekFor(event);
    },
    [openQuickPeekFor],
  );

  const handleRowInvestigate = useCallback(
    (event: DetectionEvent) => {
      // Programmatic route kept for the row chevron. The Quick peek
      // inspector itself renders the "Open full investigation"
      // action as a real `<a>` (see {@link buildInvestigateHref}),
      // so middle-click / Cmd+click work there; the row-level
      // chevron lands directly on the investigation view via client
      // navigation.
      const href = buildInvestigateHref(event);
      if (!href) return;
      router.push(href);
    },
    [buildInvestigateHref, router],
  );

  // Restore the Quick peek selection from the URL on mount. When
  // the stored token's locator matches an event in the current
  // slice (by re-encoding every event and comparing tokens), we
  // pin the peek to that event. When the slice does not contain
  // the event — e.g. the operator shared a link whose filter no
  // longer matches, or pagination shifted — strip the stale token
  // from the URL and keep the peek closed rather than opening on
  // an arbitrary row (issue #290's "close the peek silently").
  //
  // The strip is gated on a confirmed-successful initial slice. A
  // transient backend failure on first load surfaces as an empty
  // `events` array alongside a non-null `initialResult.error`; in
  // that case the slice never proved the token stale, so the URL
  // is left intact and a later successful reload (or Refresh, if
  // the commit path itself preserves the token) can still restore
  // the peek.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only — subsequent URL writes go through `writeQuickPeekToUrl` directly so re-running on every `events` change would fight the operator's own open/close actions.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Skip the URL restore when the multi-tab wrapper has already
    // handed us a resolved peek event for this tab. The URL-encoded
    // peek applies only to the active tab's filter; a dormant tab
    // rehydrated from sessionStorage carries its peek via
    // `initialQuickPeekEvent` instead, and re-reading the URL here
    // would conflate the two and clobber the per-tab selection.
    if (initialQuickPeekEvent) return;
    const stored = readQuickPeekToken(
      new URLSearchParams(window.location.search),
    );
    if (!stored) {
      // Reviewer Round 9: pending mirrors the URL token, so an absent
      // URL token always implies an absent pending placeholder.
      setPendingQuickPeekToken(null);
      return;
    }
    const match = events.find(
      (evt) => encodeEventLocator(evt) === stored.token,
    );
    if (match) {
      setQuickPeekEvent(match);
      // Reviewer Round 9: a resolved peek supersedes pending — the
      // wrapper's URL writer encodes the peek's locator from now on.
      setPendingQuickPeekToken(null);
      return;
    }
    if (
      shouldStripStaleQuickPeekToken({
        tokenPresent: true,
        matchFound: false,
        initialErrored: initialResult.error !== null,
      })
    ) {
      // `writeQuickPeekToUrl(null)` already clears pending — see the
      // setter for the rationale.
      writeQuickPeekToUrl(null);
      return;
    }
    // Reviewer Round 9: errored-without-proof path. The URL token is
    // intentionally preserved (the empty errored slice cannot prove
    // the token stale); seed pending from the URL so the multi-tab
    // wrapper's `buildUrlSearchForTab` can re-emit `?event=` on its
    // mount-time URL rewrite. Without this seeding, the wrapper's
    // first replaceState would clobber the URL token before
    // `reconcileQuickPeekAgainstSlice` could decide restore vs.
    // strip on a later successful Retry / Refresh.
    setPendingQuickPeekToken(stored.token);
  }, []);

  // Escape dismisses the desktop inline Quick peek pane. The narrow
  // overlay Sheet uses Radix Dialog, which already handles Escape
  // internally — so only attach the listener on the desktop branch
  // to avoid double-close with the Sheet's built-in handler. We
  // also skip the close when a `MorePopover` is open so a single
  // Escape unwinds only the topmost layer (the popover) rather than
  // collapsing the inspector too; a subsequent Escape — with no
  // popover open — closes the inspector.
  useEffect(() => {
    if (!isDesktop || !quickPeekEvent) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        !shouldCloseQuickPeekOnEscape({
          isDesktop: true,
          quickPeekOpen: true,
          morePopoverOpen: isMorePopoverOpen(),
        })
      ) {
        return;
      }
      closeQuickPeek();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isDesktop, quickPeekEvent, closeQuickPeek]);

  // Emit the current tab-relevant state to the multi-tab wrapper on
  // every transition so the wrapper can mirror the active tab's live
  // state into its `TabSnapshot[]`. The wrapper uses this to:
  //   - Persist to sessionStorage so a reload restores the exact tab
  //     set the operator had open.
  //   - Snapshot before a tab switch, so the outgoing tab keeps its
  //     cached result and drawer draft when the operator switches
  //     back later.
  // The effect fires after commit, so `shellSnapshotRef.current` in
  // the wrapper lags live state by one render — which is the right
  // contract for the wrapper's snapshot-on-switch path: the user has
  // to take a rendered state before clicking a different tab.
  useEffect(() => {
    if (!onStateChange) return;
    onStateChange({
      filter: committedFilter,
      period: committedPeriod,
      endpoints: committedEndpoints,
      pivotOnly,
      pagination,
      draft,
      analyticsOpen,
      analyticsDimension,
      analyticsTopN,
      quickPeekEvent,
      pendingQuickPeekToken,
      result: {
        events,
        eventKeys,
        totalCount,
        pageInfo,
        resultError,
        lastUpdatedMs,
        hasQueried,
        queryEpoch,
        loading,
        walking,
      },
    });
  }, [
    onStateChange,
    committedFilter,
    committedPeriod,
    committedEndpoints,
    pivotOnly,
    pagination,
    draft,
    analyticsOpen,
    analyticsDimension,
    analyticsTopN,
    quickPeekEvent,
    pendingQuickPeekToken,
    events,
    eventKeys,
    totalCount,
    pageInfo,
    resultError,
    lastUpdatedMs,
    hasQueried,
    queryEpoch,
    loading,
    walking,
  ]);

  return (
    <div className="flex gap-4">
      <aside
        aria-label={labels.savedFilters}
        className="flex w-14 shrink-0 flex-col gap-6 border-r border-[var(--sidebar-border)] pr-2 desktop:w-60 desktop:pr-4"
      >
        {recommendedPresets && onLoadRecommendedFilterInNewTab ? (
          <RecommendedFiltersRail
            presets={recommendedPresets}
            labels={recommendedRailLabels}
            onActivate={onLoadRecommendedFilterInNewTab}
          />
        ) : (
          <RailSection
            icon={<Star className="size-4" />}
            title={labels.recommendedFilter}
            placeholder={labels.railPlaceholder}
          />
        )}
        {savedFilters ? (
          <SavedFiltersRail
            state={savedFilters}
            labels={railLabels}
            onLoadInCurrentTab={(filter) =>
              loadFilterIntoCurrentTab(filter.filter)
            }
            onLoadInNewTab={(filter) =>
              onLoadSavedFilterInNewTab?.(filter.filter)
            }
          />
        ) : (
          <RailSection
            icon={<Bookmark className="size-4" />}
            title={labels.savedFilters}
            placeholder={labels.railPlaceholder}
          />
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <h1 className="sr-only">{title}</h1>

        {/* Top bar: Filters affordance + active filter chip bar. */}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={labels.filtersOpen}
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            onClick={() => openDrawer()}
          >
            <SlidersHorizontal className="size-4" />
            {labels.filtersOpen}
          </Button>
          <div
            role="toolbar"
            aria-label={labels.filtersOpen}
            className={cn(
              "flex min-h-8 flex-1 flex-wrap items-center gap-2 rounded-md border border-dashed border-[var(--sidebar-border)] px-3",
              !hasChips ? "text-muted-foreground text-xs" : "py-1",
            )}
          >
            {!hasChips ? (
              <span className="text-muted-foreground text-xs">
                {labels.activeChipsEmpty}
              </span>
            ) : (
              <ul className="flex flex-wrap items-center gap-1.5">
                {summarizedChips.map((chip) => (
                  <li key={chip.id}>
                    <RemovableChip
                      prefix={chip.aggregate ? null : chip.label}
                      value={chip.value}
                      onActivate={
                        chip.focus
                          ? () =>
                              openDrawerFocused(chip.focus as FilterChipFocus)
                          : undefined
                      }
                      onRemove={
                        chip.remove
                          ? () =>
                              handleRemoveChip(chip.remove as ChipRemoveTarget)
                          : undefined
                      }
                      removeLabel={removeChip(chip.value)}
                    />
                  </li>
                ))}
                {endpointChips.map((chip) => (
                  <li key={chip.id}>
                    <RemovableChip
                      prefix={null}
                      value={chip.label}
                      onActivate={() => openDrawerFocused(ENDPOINT_CHIP_FOCUS)}
                      onRemove={() =>
                        chip.aggregate
                          ? handleRemoveChip({ kind: "endpointAll" })
                          : handleRemoveChip({
                              kind: "endpointEntry",
                              entryId: chip.id,
                            })
                      }
                      removeLabel={removeChip(chip.label)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/*
         * Results region (hero) + inline Quick peek inspector (desktop+).
         *
         * Layout contract (issue #280): at ≥ desktop widths, when Quick
         * peek is open the list shrinks proportionally to the right
         * and the inspector docks as an inline pane beside it. At
         * narrower widths the inspector falls back to an overlay drawer
         * (rendered below) and the list keeps its full width. Both
         * branches reuse `QuickPeekInspectorBody` so the summary +
         * "Open investigation" contract is defined once.
         */}
        <div className="flex min-h-[60vh] flex-1 gap-4">
          <section
            aria-label={labels.resultsRegion}
            aria-live="polite"
            className="flex min-w-0 flex-1 flex-col"
          >
            <ResultList
              state={resultListState}
              labels={resultListLabels}
              locale={locale}
              queryEpoch={queryEpoch}
              onRefresh={handleRefresh}
              onOpenFilters={() => openDrawer()}
              onRowOpen={handleRowOpen}
              onRowInvestigate={handleRowInvestigate}
              onPivot={onPivot}
              onDownload={handleDownloadCsv}
              downloadRunning={csvExport.status.kind === "running"}
              downloadError={
                csvExport.status.kind === "error"
                  ? csvExport.status.message
                  : null
              }
              onDismissDownloadError={csvExport.dismissError}
            />
            {hasQueried && !resultError ? (
              <PaginationControls
                labels={paginationLabels}
                locale={locale}
                totalCount={totalCount}
                pageSize={pagination.pageSize}
                page={pagination.page}
                hasPreviousPage={pageInfo?.hasPreviousPage ?? false}
                hasNextPage={pageInfo?.hasNextPage ?? false}
                disabled={loading}
                walking={walking}
                onPageSizeChange={handlePageSizeChange}
                onFirst={handleFirstPage}
                onPrevious={handlePreviousPage}
                onNext={handleNextPage}
                onLast={handleLastPage}
                onGoToPage={handleGoToPage}
              />
            ) : null}
          </section>
          {isDesktop && quickPeekEvent ? (
            <aside
              aria-label={resultListLabels.rowOpenLabel}
              className="hidden w-96 shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--sidebar-border)] desktop:flex"
            >
              {/*
               * Remount the inspector whenever the selected event
               * identity changes so descendant components with local
               * UI state (notably `MorePopover`'s open flag) reset
               * instead of leaking across row switches. Mirrors the
               * `queryEpoch`-composed remount the result list uses
               * for the same reason.
               */}
              <QuickPeekInspector
                key={quickPeekResetKey(quickPeekEvent)}
                event={quickPeekEvent}
                labels={quickPeekLabels}
                locale={locale}
                investigateHref={buildInvestigateHref(quickPeekEvent)}
                onClose={closeQuickPeek}
                customers={committedCustomers}
              />
            </aside>
          ) : null}
        </div>

        {/* Collapsible analytics strip (collapsed by default) */}
        <div className="rounded-lg border border-[var(--sidebar-border)]">
          <button
            type="button"
            onClick={() => setAnalyticsOpen((open) => !open)}
            aria-expanded={analyticsOpen}
            aria-controls="detection-analytics-panel"
            className="text-foreground flex w-full items-center gap-2 px-3 py-2 text-sm font-medium"
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform",
                analyticsOpen && "rotate-90",
              )}
              aria-hidden="true"
            />
            <span>{labels.analyticsToggle}</span>
            <span className="sr-only">
              {analyticsOpen ? labels.analyticsHide : labels.analyticsShow}
            </span>
          </button>
          <div id="detection-analytics-panel">
            <DetectionAnalytics
              open={analyticsOpen}
              filter={committedFilter}
              filterIdentity={analyticsFilterIdentityValue}
              labels={analyticsLabels}
              dimension={analyticsDimension}
              topN={analyticsTopN}
              onDimensionChange={setAnalyticsDimension}
              onTopNChange={setAnalyticsTopN}
              onPivot={onPivot}
            />
          </div>
        </div>
      </section>

      {draft ? (
        <FilterDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          draft={draft}
          onDraftChange={setDraft}
          onApply={handleApply}
          options={options}
          labels={drawerLabels}
          multiSelectLabels={multiSelectLabels}
          openEndpointPanelOnOpen={openEndpointPanelOnDrawerOpen}
          sensorOptions={sensorOptions}
          sensorState={sensorState}
          onSensorRetry={triggerSensorFetch}
          customerOptions={customerOptions}
          customerState={customerState}
          onCustomerRefresh={triggerCustomerFetch}
          focusField={focusField}
          focusToken={focusToken}
          onSaveRequest={savedFilters ? handleSaveRequest : undefined}
        />
      ) : null}

      {savedFilters ? (
        <SaveFilterDialog
          open={saveDialogOpen && saveDialogFilter !== null}
          onOpenChange={(open) => {
            setSaveDialogOpen(open);
            if (!open) setSaveDialogFilter(null);
          }}
          defaultName={saveDialogDefaultName}
          labels={labels.saveFilterDialog}
          onSubmit={handleSaveSubmit}
        />
      ) : null}

      <QuickPeekInspectorOverlay
        event={isDesktop ? null : quickPeekEvent}
        locale={locale}
        labels={quickPeekLabels}
        buildInvestigateHref={buildInvestigateHref}
        onClose={closeQuickPeek}
        customers={committedCustomers}
      />

      <CsvExportConfirmDialog
        open={csvExport.status.kind === "confirm-required"}
        totalCount={
          csvExport.status.kind === "confirm-required"
            ? csvExport.status.confirmation.totalCount
            : null
        }
        estimatedBytes={
          csvExport.status.kind === "confirm-required"
            ? csvExport.status.confirmation.estimatedBytes
            : null
        }
        labels={labels.exportConfirm}
        onContinue={handleConfirmLargeExport}
        onCancel={csvExport.cancelConfirmation}
        onNarrow={handleNarrowFilterFromExport}
      />
    </div>
  );
}

/**
 * Stable identity string for a Quick peek selection, used as the
 * inspector's React `key` so changing rows remounts the subtree.
 * `encodeEventLocator` is preferred (it is the same token persisted
 * to the URL and so collides at the same rate as the locator), but
 * it returns null for events missing addressing data; in that case
 * we fall back to the composite tuple the locator itself is built
 * from. The row list already uses a similar epoch-plus-cursor key
 * to reset `MorePopover` state across committed queries.
 */
export function quickPeekResetKey(event: DetectionEvent): string {
  const token = encodeEventLocator(event);
  if (token) return `t:${token}`;
  return `e:${event.__typename}|${event.time}|${event.sensor}`;
}

/**
 * Decides whether the mount-only URL restore should strip a stale
 * `?event=` token after it fails to match any event in the current
 * slice. The strip is the issue's documented "close the peek
 * silently" behavior, but it is only safe after a successful slice
 * load has proved the token does not map into the active query. A
 * transient backend error on first load surfaces as an empty
 * `events` array alongside a non-null `initialError`; in that case
 * the slice never proved the token stale, so the URL is left alone
 * and a later successful reload can still restore the peek.
 */
export function shouldStripStaleQuickPeekToken(args: {
  tokenPresent: boolean;
  matchFound: boolean;
  initialErrored: boolean;
}): boolean {
  if (!args.tokenPresent) return false;
  if (args.matchFound) return false;
  if (args.initialErrored) return false;
  return true;
}

/**
 * Decision for the post-fetch Quick peek URL reconcile used by
 * `runQueryFor`. Reviewer Round 7: a Refresh after a transient
 * initial-load error must re-evaluate a pending `?event=` token
 * against the replacement slice — restoring the peek on match,
 * stripping the token on a confirmed miss, no-op when the URL
 * carries no token. The mount-only restore effect can't help here
 * because it is gated on `[]` and only runs once.
 *
 * Extracted as a pure helper so the branch logic stays unit-
 * testable without standing up the client component.
 */
export type ReconcileQuickPeekUrlAction = "noop" | "restore" | "strip";

export function reconcileQuickPeekUrlAction(args: {
  tokenPresent: boolean;
  matchFound: boolean;
}): ReconcileQuickPeekUrlAction {
  if (!args.tokenPresent) return "noop";
  if (args.matchFound) return "restore";
  return "strip";
}

/**
 * Predicate for the desktop inline inspector's Escape handler.
 *
 * Reviewer Round 13: pressing Escape with a `+N more` popover open
 * used to close the popover and the inspector together, because
 * both surfaces installed document-level Escape listeners on the
 * same key event. The shell's handler now skips the close when any
 * `MorePopover` is open — a single Escape unwinds only the topmost
 * layer (the popover); a subsequent Escape (with no popover open)
 * dismisses the inspector. Extracted as a pure helper so the branch
 * logic stays unit-testable without standing up the client
 * component.
 */
export function shouldCloseQuickPeekOnEscape(args: {
  isDesktop: boolean;
  quickPeekOpen: boolean;
  morePopoverOpen: boolean;
}): boolean {
  if (!args.isDesktop) return false;
  if (!args.quickPeekOpen) return false;
  if (args.morePopoverOpen) return false;
  return true;
}

/**
 * Subscribes to the desktop media query (`≥ --breakpoint-desktop`).
 * Starts as `false` so the server render matches the narrow branch —
 * the desktop branch flips on post-mount once `matchMedia` reports
 * the real viewport width. Prevents hydration mismatch without the
 * flash-of-incorrect-layout a purely CSS-based toggle would need.
 */
function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(min-width: 1280px)");
    const sync = () => setIsDesktop(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}

/**
 * Narrow-viewport Quick peek inspector: an overlay Sheet that wraps
 * {@link QuickPeekInspector}. At ≥ desktop widths the shell renders
 * the same component inline as a right-hand pane; see #280 for the
 * width-responsive layout contract. The overlay supplies its own
 * close button via `SheetContent`, so the inline Close affordance
 * inside the inspector is suppressed with `showClose={false}`.
 */
function QuickPeekInspectorOverlay({
  event,
  locale,
  labels,
  buildInvestigateHref,
  onClose,
  customers,
}: {
  event: DetectionEvent | null;
  locale: string;
  labels: QuickPeekInspectorLabels;
  buildInvestigateHref: (event: DetectionEvent) => string | null;
  onClose: () => void;
  customers?: readonly string[];
}) {
  const open = event !== null;
  const kindLabel = event
    ? (EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename)
    : "";
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="sm:max-w-md"
        closeLabel={labels.close}
        onEscapeKeyDown={(event) => {
          // A `MorePopover` inside the overlay installs its own
          // Escape-to-close handler. Without this guard Radix would
          // also treat the same Escape as a Sheet-close signal,
          // collapsing both layers together. Preventing default here
          // lets the popover close first; a subsequent Escape — with
          // no popover open — dismisses the Sheet.
          if (isMorePopoverOpen()) event.preventDefault();
        }}
      >
        {/*
         * The Sheet primitive requires an accessible title and
         * description for screen readers. `QuickPeekInspector`
         * renders its own visible header (kind + time) — hide the
         * Sheet-level ones visually but keep them in the a11y tree.
         */}
        <SheetHeader className="sr-only">
          <SheetTitle>{kindLabel}</SheetTitle>
          <SheetDescription>{labels.summaryHeading}</SheetDescription>
        </SheetHeader>
        {event ? (
          <QuickPeekInspector
            key={quickPeekResetKey(event)}
            event={event}
            labels={labels}
            locale={locale}
            investigateHref={buildInvestigateHref(event)}
            onClose={onClose}
            showClose={false}
            customers={customers}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Build a `URLSearchParams` carrying only the encoded `?f=` filter
 * blob. Pagination, tab id, and quick-peek params are layered on top
 * by the caller. Reviewer Round 1 (item 1): centralised so every
 * state-mutation URL writer (Apply, chip removal, pagination) round-
 * trips the full {@link Filter} rather than the legacy pivot subset.
 */
function buildEncodedFilterSearch(args: EncodedTabFilter): URLSearchParams {
  return buildSearchParamsForFilter(args);
}

/**
 * Narrow `PivotFilterParams` (the broader URL shape used by the
 * Investigation handoff inbound parser) to the `PivotExtras` subset
 * the encoded blob carries. Drawer-owned fields (kind, window,
 * source, …) are dropped because they round-trip through the
 * {@link Filter} payload itself.
 */
function extrasFromPivotOnly(pivot: PivotFilterParams): PivotExtras {
  const out: PivotExtras = {};
  if (pivot.origPort !== undefined) out.origPort = pivot.origPort;
  if (pivot.respPort !== undefined) out.respPort = pivot.respPort;
  if (pivot.proto !== undefined) out.proto = pivot.proto;
  return out;
}

function filterToDraft(
  filter: Filter,
  period: PeriodKey | null,
  endpoints: EndpointEntry[],
): DetectionFilterDraft {
  const input = filter.mode === "structured" ? filter.input : {};
  const startIso = input.start ?? null;
  const endIso = input.end ?? null;
  const confidenceMin = input.confidenceMin ?? CONFIDENCE_DEFAULT_MIN;
  const confidenceMax = input.confidenceMax ?? CONFIDENCE_DEFAULT_MAX;
  const sensorIds = input.sensors ?? [];
  const fromArray = (values: string[] | null | undefined): string[] =>
    values && values.length > 0 ? [...values] : [];
  return {
    period,
    startLocal: isoToLocalInput(startIso),
    endLocal: isoToLocalInput(endIso),
    startIso,
    endIso,
    directions: readDirectionsFromInput(input.directions),
    endpoints,
    confidenceMin,
    confidenceMax,
    sensorIds: [...sensorIds],
    // Customers travel as `string[]` on the wire; the drawer draft
    // uses `number[]` for natural comparison/membership. Drop any
    // string that does not parse cleanly into a positive integer —
    // a malformed entry can only reach the draft via a saved-filter
    // load or a crafted `?f=` blob, and the BFF intersection check
    // would reject it on the next dispatch anyway. Keeping the draft
    // numeric-only here keeps the chip / UI paths free of `NaN`.
    customerIds: customerIdsFromInput(input.customers),
    levels: (input.levels ?? []) as readonly number[],
    countries: (input.countries ?? []) as readonly string[],
    learningMethods: (input.learningMethods ?? []) as readonly LearningMethod[],
    categories: (input.categories ?? []).filter(
      (v): v is number => typeof v === "number",
    ) as readonly number[],
    kinds: (input.kinds ?? []) as readonly string[],
    source: input.source ?? "",
    destination: input.destination ?? "",
    keywords: fromArray(input.keywords),
    hostnames: fromArray(input.hostnames),
    userIds: fromArray(input.userIds),
    userNames: fromArray(input.userNames),
    userDepartments: fromArray(input.userDepartments),
  };
}

function customerIdsFromInput(
  values: readonly string[] | null | undefined,
): number[] {
  if (!values || values.length === 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of values) {
    const parsed = parsePositiveCustomerId(raw);
    if (parsed === null || seen.has(parsed)) continue;
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

function RemovableChip({
  prefix,
  value,
  onActivate,
  onRemove,
  removeLabel,
}: {
  prefix: string | null;
  value: string;
  onActivate?: () => void;
  onRemove?: () => void;
  removeLabel: string;
}) {
  // The activator and remove controls must be siblings, not nested —
  // a <button> inside another <button> is invalid HTML and triggers a
  // React hydration mismatch. Render the Badge as a plain span and
  // place each button beside it inside the outer wrapper.
  const activateLabel = prefix ? `${prefix}: ${value}` : value;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full",
        (onActivate || onRemove) &&
          "bg-secondary text-secondary-foreground gap-1 px-2 py-0.5",
      )}
    >
      {onActivate ? (
        <button
          type="button"
          onClick={onActivate}
          aria-label={activateLabel}
          className="focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          {prefix ? (
            <span className="text-muted-foreground text-xs" aria-hidden="true">
              {prefix}
            </span>
          ) : null}
          <span
            className="text-foreground text-xs font-medium"
            aria-hidden="true"
          >
            {value}
          </span>
        </button>
      ) : (
        <>
          {prefix ? (
            <span className="text-muted-foreground text-xs">{prefix}</span>
          ) : null}
          <span className="text-foreground text-xs font-medium">{value}</span>
        </>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-3.5 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

function RailSection({
  icon,
  title,
  placeholder,
}: {
  icon: React.ReactNode;
  title: string;
  placeholder: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="text-muted-foreground flex items-center justify-center desktop:justify-start desktop:gap-2">
        <span aria-hidden="true">{icon}</span>
        <span className="sr-only text-xs font-medium uppercase tracking-wider desktop:not-sr-only desktop:inline">
          {title}
        </span>
      </div>
      <p className="text-muted-foreground sr-only text-xs desktop:not-sr-only desktop:block">
        {placeholder}
      </p>
    </section>
  );
}
