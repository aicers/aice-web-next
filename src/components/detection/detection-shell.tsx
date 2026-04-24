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
  PaginationControls,
  type PaginationControlsLabels,
} from "@/components/detection/pagination-controls";
import {
  ResultList,
  type ResultListLabels,
  type ResultListState,
} from "@/components/detection/result-list";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  formatEndpointSummary,
  levelBadgeVariant,
} from "@/components/events/event-display-helpers";
import { Badge } from "@/components/ui/badge";
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
import { buildAppliedFilter } from "@/lib/detection/apply-filter";
import type { DirectionChipLabels } from "@/lib/detection/direction";
import { readDirectionsFromInput } from "@/lib/detection/direction";
import {
  buildEndpointChips,
  type EndpointChipLabels,
  type EndpointEntry,
} from "@/lib/detection/endpoint-filter";
import { formatEventTime } from "@/lib/detection/event-time";
import type { Filter } from "@/lib/detection/filter";
import {
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  type DetectionFilterDraft,
  isoToLocalInput,
} from "@/lib/detection/filter-draft";
import {
  type FilterChip,
  type FilterChipFocus,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/filter-summary";
import {
  clearPaginationParams,
  committedPageForAnchor,
  INITIAL_PAGINATION_STATE,
  type PageAnchor,
  type PageSize,
  type PaginationState,
  pageAtNewSize,
  paginationToSearchEntries,
  totalPagesFrom,
} from "@/lib/detection/pagination";
import type { PeriodKey } from "@/lib/detection/period";
import type {
  Event as DetectionEvent,
  LearningMethod,
  PageInfo,
} from "@/lib/detection/types";
import {
  buildDetectionSearchParams,
  mergePivotParams,
  type PivotChipLabels,
  type PivotFilterParams,
  pivotParamsFromFilterInput,
  type TagField,
} from "@/lib/detection/url-filters";
import {
  encodeEventLocator,
  isEventAddressable,
} from "@/lib/events/event-locator";
import { cn } from "@/lib/utils";
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

export interface DetectionShellLabels {
  recommendedFilter: string;
  savedFilters: string;
  railPlaceholder: string;
  filtersOpen: string;
  activeChipsEmpty: string;
  resultsRegion: string;
  resultsLoading: string;
  resultsError: string;
  analyticsToggle: string;
  analyticsShow: string;
  analyticsHide: string;
  analyticsPlaceholder: string;
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
  };
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
}

interface DetectionShellProps {
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
 * lands. `ResultList` keeps painting the previous rows while
 * `loading` is true as long as it still has events, so deferring
 * either reset until the response lands leaves a window during
 * the round-trip where:
 *
 * - the chip bar and URL already describe the newly committed
 *   filter, but
 * - the Quick peek inspector (and its **Open investigation**
 *   button) is still pinned to a row the committed filter no
 *   longer describes, and
 * - `EventRow` / `MorePopover` state from the stale slice can be
 *   reconciled onto the replacement slice because `queryEpoch`
 *   hasn't advanced yet.
 *
 * Extracted so the dispatch-time contract can be unit-tested
 * without standing up a full DOM render of the shell.
 */
export function applyCommitDispatchReset(setters: {
  setQueryEpoch: (fn: (n: number) => number) => void;
  setQuickPeekEvent: (event: null) => void;
}): void {
  setters.setQueryEpoch((epoch) => epoch + 1);
  setters.setQuickPeekEvent(null);
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
      downloadComingSoon: tResults("downloadComingSoon"),
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
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openEndpointPanelOnDrawerOpen, setOpenEndpointPanelOnDrawerOpen] =
    useState(false);

  const [committedFilter, setCommittedFilter] = useState<Filter>(initialFilter);
  const [committedPeriod, setCommittedPeriod] = useState<PeriodKey | null>(
    initialPeriod,
  );
  const [committedEndpoints, setCommittedEndpoints] = useState<EndpointEntry[]>(
    [],
  );
  // `pivotOnly` carries URL-only fields (kind/ports/proto/window) that
  // arrive from the Investigation handoff. They are preserved through
  // URL round-trips so pivot logic (Phase Detection-12) can pick them
  // up, but they are not represented in `EventListFilterInput` and do
  // not participate in the active filter chip bar yet — rendering them
  // as chips would violate the "× is a self-contained commit that
  // re-runs the query" contract while the underlying query still
  // ignores them.
  const pivotOnly = initialPivotOnly;
  const [draft, setDraft] = useState<DetectionFilterDraft | null>(null);
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
  // on epoch `0`; the first client-side commit advances to `1`.
  const [queryEpoch, setQueryEpoch] = useState(0);
  const [resultError, setResultError] = useState<string | null>(
    initialResult.error,
  );
  const [loading, setLoading] = useState(false);
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(
    initialResult.error === null && initialResult.totalCount !== null
      ? Date.now()
      : null,
  );
  // Tracks whether any query has been dispatched (by the server-
  // rendered initial load or a subsequent Apply / Refresh / chip
  // removal). A freshly-mounted `+` tab with no successful query —
  // e.g. the server action returned an error before the page mounted
  // — renders the dedicated pre-query empty state instead of the
  // generic zero-results panel.
  const [hasQueried, setHasQueried] = useState(
    initialResult.error === null && initialResult.totalCount !== null,
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
    null,
  );
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
  }, [
    committedFilter,
    committedPeriod,
    committedEndpoints,
    sensorCache,
    triggerSensorFetch,
  ]);

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
        applyCommitDispatchReset({ setQueryEpoch, setQuickPeekEvent });
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
            } else {
              totalCountRef.current = null;
              setTotalCount(null);
              setEvents([]);
              setEventKeys([]);
              setPageInfo(null);
              setResultError(labels.resultsError);
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
    [labels.resultsError],
  );

  // Wrapper used by the Apply / chip / Refresh paths — they all
  // reset pagination back to page 1 (head) on transition.
  const runQueryFor = useCallback(
    (filter: Filter) => {
      // Cancel any in-flight Go-to-page walk — its cursors were
      // derived from the superseded filter.
      latestWalkIdRef.current += 1;
      setWalking(null);
      void dispatchQuery(filter, {
        anchor: { kind: "head" },
        pageSize: pagination.pageSize,
        page: 1,
        navigating: false,
      });
    },
    [dispatchQuery, pagination.pageSize],
  );

  const handleApply = useCallback(
    (applied: DetectionFilterDraft) => {
      if (!applied.startIso || !applied.endIso) return;
      // Only the `ready` state (sensor-list query present + loaded)
      // permits a `sensors` value in the committed filter; every
      // other state strips it to preserve the fallback contract.
      const endpointLive =
        sensorCache.status === "loaded" && sensorCache.endpointAvailable;
      const next = buildAppliedFilter(
        committedFilter,
        applied,
        endpointLive,
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

      // Mirror the free-form filter fields into the URL so a refresh
      // restores them. Only the drawer's free-form inputs (source,
      // destination, and the tag fields) ride in the URL today — the
      // time range has no URL-persisted form, so a refresh falls back
      // to the default period. The pivot-only params
      // (kind/ports/proto/window) stay as-is — they carry no drawer
      // state yet.
      //
      // Use `history.replaceState` rather than `router.replace` so the
      // URL update doesn't trigger a soft navigation. A soft navigation
      // would re-run this route's server page and `searchEvents()`
      // alongside the explicit `runEventQuery(next)` below — two
      // queries per Apply for the same filter, with the navigation
      // result discarded because the shell keeps its own client state.
      // `replaceState` keeps URL persistence (refresh restores the
      // active tab) without paying for a duplicate REview round-trip.
      if (next.mode === "structured") {
        const merged = mergePivotParams(
          pivotOnly,
          pivotParamsFromFilterInput(next.input),
        );
        const search = buildDetectionSearchParams(merged);
        // Apply resets the cursor to the start of the new filter
        // space — stale pagination keys would point at cursors from
        // the old filter's connection.
        clearPaginationParams(search);
        // Pagination itself is persisted below when the fresh query
        // resolves; the initial URL can stay short (default page
        // size, head anchor, no page param).
        if (pagination.pageSize !== INITIAL_PAGINATION_STATE.pageSize) {
          search.set("pageSize", String(pagination.pageSize));
        }
        const qs = search.toString();
        const url = qs ? `${pathname}?${qs}` : pathname;
        window.history.replaceState(window.history.state, "", url);
      }

      runQueryFor(next);
    },
    [
      committedFilter,
      pagination.pageSize,
      pivotOnly,
      options,
      pathname,
      runQueryFor,
      sensorCache,
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
      // Persist the removal in the URL the same way Apply does.
      if (next.filter.mode === "structured") {
        const merged = mergePivotParams(
          pivotOnly,
          pivotParamsFromFilterInput(next.filter.input),
        );
        const search = buildDetectionSearchParams(merged);
        clearPaginationParams(search);
        if (pagination.pageSize !== INITIAL_PAGINATION_STATE.pageSize) {
          search.set("pageSize", String(pagination.pageSize));
        }
        const qs = search.toString();
        const url = qs ? `${pathname}?${qs}` : pathname;
        window.history.replaceState(window.history.state, "", url);
      }
      runQueryFor(next.filter);
    },
    [
      committedEndpoints,
      committedFilter,
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
      if (committedFilter.mode !== "structured") return;
      const merged = mergePivotParams(
        pivotOnly,
        pivotParamsFromFilterInput(committedFilter.input),
      );
      const search = buildDetectionSearchParams(merged);
      clearPaginationParams(search);
      for (const [k, v] of paginationToSearchEntries(next)) {
        search.set(k, v);
      }
      const qs = search.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.replaceState(window.history.state, "", url);
    },
    [committedFilter, pathname, pivotOnly],
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
  }, [committedFilter, dispatchQuery, pagination, persistPaginationToUrl]);

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
    },
    [
      committedFilter,
      committedPeriod,
      committedEndpoints,
      sensorCache,
      triggerSensorFetch,
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

  // Shared chip summariser: one `Filter → FilterChip[]` call the bar
  // reuses everywhere. The pivot-only chips above are concatenated
  // on render because they live outside `EventListFilterInput`.
  const summarizeLabels = useMemo<SummarizeFilterLabels>(
    () => ({
      sensor: labels.drawer.sensor.label,
      sensorAggregate: labels.summarize.sensorAggregate,
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
        categoricalOptions: {
          levels: options.levels,
          countries: options.countries,
          learningMethods: options.learningMethods,
          categories: options.categories,
          kinds: options.kinds,
        },
      }),
    [committedFilter, committedPeriod, options, sensorOptions, summarizeLabels],
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

  const handleRowOpen = useCallback((event: DetectionEvent) => {
    setQuickPeekEvent(event);
  }, []);

  const handleRowInvestigate = useCallback(
    (event: DetectionEvent) => {
      // Build a locator token and jump into the Investigation view.
      // Carry the current pathname + search as `returnTo` so a
      // non-default-locale operator who lands on `/events/<token>`
      // can return to their filtered Detection tab. `useRouter`
      // from `next-intl/navigation` is locale-aware — it prefixes
      // the target path so Korean / English operators land on the
      // right segment.
      const token = encodeEventLocator(event);
      if (!token) return;
      const search =
        typeof window !== "undefined" ? window.location.search : "";
      const returnTo = `${pathname}${search}`;
      const href = `/events/${encodeURIComponent(token)}?returnTo=${encodeURIComponent(returnTo)}`;
      router.push(href);
    },
    [pathname, router],
  );

  return (
    <div className="flex gap-4">
      <aside
        aria-label={labels.savedFilters}
        className="flex w-14 shrink-0 flex-col gap-6 border-r border-[var(--sidebar-border)] pr-2 desktop:w-60 desktop:pr-4"
      >
        <RailSection
          icon={<Star className="size-4" />}
          title={labels.recommendedFilter}
          placeholder={labels.railPlaceholder}
        />
        <RailSection
          icon={<Bookmark className="size-4" />}
          title={labels.savedFilters}
          placeholder={labels.railPlaceholder}
        />
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
              className="hidden w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--sidebar-border)] desktop:flex"
            >
              <QuickPeekInspectorBody
                event={quickPeekEvent}
                locale={locale}
                labels={resultListLabels}
                onClose={() => setQuickPeekEvent(null)}
                onInvestigate={() => handleRowInvestigate(quickPeekEvent)}
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
          {analyticsOpen ? (
            <div
              id="detection-analytics-panel"
              className="text-muted-foreground border-t border-[var(--sidebar-border)] px-3 py-4 text-sm"
            >
              {labels.analyticsPlaceholder}
            </div>
          ) : null}
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
          focusField={focusField}
          focusToken={focusToken}
        />
      ) : null}

      <QuickPeekInspectorOverlay
        event={isDesktop ? null : quickPeekEvent}
        locale={locale}
        labels={resultListLabels}
        onClose={() => setQuickPeekEvent(null)}
        onInvestigate={() => {
          if (quickPeekEvent) handleRowInvestigate(quickPeekEvent);
        }}
      />
    </div>
  );
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
 * Narrow-viewport Quick peek inspector: an overlay sheet. Phase
 * Detection-18 owns the full contents; for v1 we render the compact
 * summary the list row already shows plus the "Open investigation"
 * jump. At ≥ desktop widths the shell renders the same body
 * ({@link QuickPeekInspectorBody}) inline as a right-hand pane,
 * matching the layout contract in issue #280.
 */
function QuickPeekInspectorOverlay({
  event,
  locale,
  labels,
  onClose,
  onInvestigate,
}: {
  event: DetectionEvent | null;
  locale: string;
  labels: ResultListLabels;
  onClose: () => void;
  onInvestigate: () => void;
}) {
  const open = event !== null;
  const kindLabel = event
    ? (EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename)
    : "";
  const timeLabel = event
    ? formatEventTime(event.time, locale, labels.unknownTime)
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
        closeLabel={labels.quickPeekClose}
      >
        <SheetHeader>
          <SheetTitle>{kindLabel}</SheetTitle>
          <SheetDescription>{timeLabel}</SheetDescription>
        </SheetHeader>
        {event ? (
          <QuickPeekInspectorContent
            event={event}
            labels={labels}
            onInvestigate={onInvestigate}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Inline inspector body used by the desktop+ right-hand pane. The
 * pane header mirrors the overlay's `SheetHeader` (kind + time) and
 * carries an explicit Close affordance because there's no backdrop
 * click to dismiss the inline pane.
 */
function QuickPeekInspectorBody({
  event,
  locale,
  labels,
  onClose,
  onInvestigate,
}: {
  event: DetectionEvent;
  locale: string;
  labels: ResultListLabels;
  onClose: () => void;
  onInvestigate: () => void;
}) {
  const kindLabel =
    EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  const timeLabel = formatEventTime(event.time, locale, labels.unknownTime);
  return (
    <>
      <header className="flex items-start gap-2 border-b border-[var(--sidebar-border)] px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-foreground truncate text-sm font-semibold">
            {kindLabel}
          </span>
          <span className="text-muted-foreground text-xs">{timeLabel}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={labels.quickPeekClose}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-7 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>
      <QuickPeekInspectorContent
        event={event}
        labels={labels}
        onInvestigate={onInvestigate}
      />
    </>
  );
}

function QuickPeekInspectorContent({
  event,
  labels,
  onInvestigate,
}: {
  event: DetectionEvent;
  labels: ResultListLabels;
  onInvestigate: () => void;
}) {
  const addressable = isEventAddressable(event);
  const endpointSummary = formatEndpointSummary(event);
  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pb-4 pt-3">
      <div className="flex items-center gap-2">
        <Badge variant={levelBadgeVariant(event.level)} className="uppercase">
          {labels.levelLabels[event.level] ?? event.level}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {labels.confidenceLabel} {event.confidence.toFixed(2)}
        </span>
      </div>
      {endpointSummary ? (
        <p className="text-foreground font-mono text-xs break-all">
          {endpointSummary}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {event.sensor || labels.noSensor}
      </p>
      <Button
        type="button"
        size="sm"
        onClick={onInvestigate}
        disabled={!addressable}
        className="mt-2 self-start"
      >
        {labels.rowInvestigateLabel}
      </Button>
    </div>
  );
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
