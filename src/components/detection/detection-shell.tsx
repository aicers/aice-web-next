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
import { runEventQuery } from "@/app/[locale]/(dashboard)/detection/actions";
import {
  type FetchSensorsResult,
  fetchSensors,
} from "@/app/[locale]/(dashboard)/detection/sensor-actions";
import {
  type DetectionTabData,
  type DetectionTabLabels,
  DetectionTabs,
  detectionTabDomId,
  detectionTabPanelDomId,
} from "@/components/detection/detection-tabs";
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
  type EndpointChip,
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
import { buildAllTabsSearchParams } from "@/lib/detection/filter-url";
import type { PeriodKey } from "@/lib/detection/period";
import { computePeriodRange, DEFAULT_PERIOD_KEY } from "@/lib/detection/period";
import {
  type AutoTabNameLabels,
  buildAutoTabName,
} from "@/lib/detection/tab-name";
import {
  ACTIVE_TAB_PARAM,
  coerceTabForLivePage,
  createBlankTab,
  createDefaultTab,
  parseTabsFromSession,
  rehydrateTabs,
  resolveTabPeriod,
  serializeTabsForSession,
  TAB_CAP,
  TABS_SESSION_KEY,
  type TabSnapshot,
} from "@/lib/detection/tabs";
import type {
  Event as DetectionEvent,
  LearningMethod,
} from "@/lib/detection/types";
import type {
  PivotChipLabels,
  PivotFilterParams,
  TagField,
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

type ChipLabelStrings = Omit<PivotChipLabels, "countAggregate">;

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
  summarize: {
    sensor: string;
    sensorAggregate: string;
  };
  /**
   * Multi-tab (Phase Detection-10) UI labels.
   *
   * Only the plain-string slice of {@link DetectionTabLabels} crosses
   * the server→client boundary here; the two formatter callbacks
   * (`addTabCapTooltip`, `closeTab`) are built inside the shell with
   * `useTranslations` so server components never have to serialize
   * functions into client-component props.
   */
  tabs: Omit<DetectionTabLabels, "addTabCapTooltip" | "closeTab"> & {
    autoEmptyTab: string;
    autoMoreSuffix: string;
  };
}

export interface DetectionShellInitialResult {
  totalCount: string | null;
  error: string | null;
  events: DetectionEvent[];
  eventKeys: string[];
}

interface DetectionShellProps {
  title: string;
  labels: DetectionShellLabels;
  options: FilterDrawerOptions;
  initialFilter: Filter;
  initialPeriod: PeriodKey | null;
  initialResult: DetectionShellInitialResult;
  initialPivotOnly?: PivotFilterParams;
  initialEndpoints?: readonly EndpointEntry[];
  /**
   * Full tab strip reconstructed from the URL. The active tab
   * shares its filter/period/endpoints with `initialFilter` /
   * `initialPeriod` / `initialEndpoints`, and carries the SSR
   * `initialResult`; the others start blank and will run on
   * demand when the operator switches to them.
   */
  initialTabs?: TabSnapshot[];
  initialActiveIndex?: number;
}

export type SensorCache =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "loaded";
      endpointAvailable: boolean;
      options: readonly SensorOption[];
    }
  | { status: "error" };

export function sensorStateForCache(
  cache: SensorCache,
): SensorMultiSelectState {
  if (cache.status === "loaded") {
    return cache.endpointAvailable ? "ready" : "unavailable";
  }
  if (cache.status === "error") return "error";
  return "loading";
}

export function shouldTriggerSensorFetch(cache: SensorCache): boolean {
  return cache.status !== "loading" && cache.status !== "loaded";
}

export function shouldOpenEndpointPanelForFocus(
  focus: FilterChipFocus,
): boolean {
  return focus === "endpoints";
}

export const ENDPOINT_CHIP_FOCUS: FilterChipFocus = "endpoints";

/**
 * See the in-shell usage comment. Extracted so the dispatch-time
 * contract (bump queryEpoch + clear quickPeek synchronously with the
 * commit, not after the async response lands) can be unit-tested
 * without standing up a full DOM render.
 */
export function applyCommitDispatchReset(setters: {
  setQueryEpoch: (fn: (n: number) => number) => void;
  setQuickPeekEvent: (event: null) => void;
}): void {
  setters.setQueryEpoch((epoch) => epoch + 1);
  setters.setQuickPeekEvent(null);
}

/**
 * Per-tab runtime state. Combines the persisted {@link TabSnapshot}
 * with the result-pane and drawer-draft state that lives only while
 * the page is mounted. When the tab cap is hit or a tab is closed
 * the runtime state is dropped along with the snapshot.
 */
interface TabRuntime {
  snapshot: TabSnapshot;
  draft: DetectionFilterDraft | null;
  events: DetectionEvent[];
  eventKeys: string[];
  totalCount: string | null;
  resultError: string | null;
  lastUpdatedMs: number | null;
  hasQueried: boolean;
  loading: boolean;
  queryEpoch: number;
  quickPeekEvent: DetectionEvent | null;
}

function createBlankRuntime(snapshot: TabSnapshot): TabRuntime {
  return {
    snapshot,
    draft: null,
    events: [],
    eventKeys: [],
    totalCount: null,
    resultError: null,
    lastUpdatedMs: null,
    hasQueried: false,
    loading: false,
    queryEpoch: 0,
    quickPeekEvent: null,
  };
}

export function DetectionShell({
  title,
  labels,
  options,
  initialFilter,
  initialPeriod,
  initialResult,
  initialPivotOnly = {},
  initialEndpoints,
  initialTabs,
  initialActiveIndex = 0,
}: DetectionShellProps) {
  const t = useTranslations("detection.filters");
  const tResults = useTranslations("detection.results");
  const tTabs = useTranslations("detection.tabs");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

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

  // Global (not-per-tab) UI state.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openEndpointPanelOnDrawerOpen, setOpenEndpointPanelOnDrawerOpen] =
    useState(false);
  const [sensorCache, setSensorCache] = useState<SensorCache>({
    status: "idle",
  });
  const [focusField, setFocusField] = useState<DrawerFocusField | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  // Seed tabs from the URL-derived working set (active tab plus any
  // extras that rode along in the `tabs=<json>` param). The client
  // side then rehydrates from sessionStorage in a one-shot effect
  // below — doing the rehydrate in an effect (not in `useState`'s
  // initializer) keeps the server/client markup identical on the
  // first paint so there's no hydration mismatch when a stored tab
  // set differs from the URL.
  const [tabs, setTabs] = useState<TabRuntime[]>(() => {
    const seed: TabSnapshot[] =
      initialTabs && initialTabs.length > 0
        ? initialTabs
        : [
            {
              id: "tab-initial",
              filter: initialFilter,
              period: initialPeriod,
              endpoints: initialEndpoints ? [...initialEndpoints] : [],
              pivotOnly: initialPivotOnly,
              name: null,
              autoRun: true,
              analyticsOpen: false,
            },
          ];
    const activeSeed = seed[initialActiveIndex] ?? seed[0];
    return seed.map((snapshot) => {
      const runtime = createBlankRuntime(snapshot);
      if (snapshot === activeSeed) {
        runtime.events = initialResult.events;
        runtime.eventKeys = initialResult.eventKeys;
        runtime.totalCount = initialResult.totalCount;
        runtime.resultError = initialResult.error;
        runtime.lastUpdatedMs =
          initialResult.error === null && initialResult.totalCount !== null
            ? Date.now()
            : null;
        runtime.hasQueried =
          initialResult.error === null && initialResult.totalCount !== null;
      }
      return runtime;
    });
  });
  const [activeIndex, setActiveIndex] = useState(() => {
    const seedLength =
      initialTabs && initialTabs.length > 0 ? initialTabs.length : 1;
    if (initialActiveIndex < 0 || initialActiveIndex >= seedLength) return 0;
    return initialActiveIndex;
  });

  // Mutates a specific tab by id. Uses functional updates so in-flight
  // async responses can land without racing against tab-set changes
  // (add/close) that may have shifted indices.
  const updateTabById = useCallback(
    (id: string, patch: Partial<TabRuntime>) => {
      setTabs((prev) =>
        prev.map((r) => (r.snapshot.id === id ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const updateSnapshotById = useCallback(
    (id: string, patch: Partial<TabSnapshot>) => {
      setTabs((prev) =>
        prev.map((r) =>
          r.snapshot.id === id
            ? { ...r, snapshot: { ...r.snapshot, ...patch } }
            : r,
        ),
      );
    },
    [],
  );

  // Per-tab async request tracking so a late response from one tab
  // cannot clobber another tab that was switched to in the meantime.
  const requestCounterRef = useRef(0);
  const latestRequestIdByTabRef = useRef<Map<string, number>>(new Map());

  // One-shot rehydration from sessionStorage. Merges stored tabs on
  // top of the URL-driven initial tab set so a page reload restores
  // the working set without losing the SSR-fetched result for the
  // active tab. The writer effect below skips the first mount; if
  // it ran there it would serialize the URL-only state with the
  // pre-setTabs closure and clobber the stored payload before this
  // read could load it.
  const hydratedRef = useRef(false);
  const tabsSerializedRef = useRef<string>("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot rehydration — the URL-driven SSR snapshot is only authoritative on first mount, so subsequent changes to `initialFilter`/`initialPeriod`/`initialPivotOnly`/`initialResult`/`initialTabs` must NOT re-trigger this effect.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(TABS_SESSION_KEY);
    const storedRaw = parseTabsFromSession(raw);
    // Forward-compat: the session decoder round-trips `mode: "query"`
    // tabs, but the live page cannot render them — downgrade here
    // for the same reason the server page boundary does. See
    // {@link coerceTabForLivePage}.
    const stored = storedRaw
      ? {
          ...storedRaw,
          tabs: storedRaw.tabs.map((tab) =>
            coerceTabForLivePage(tab, DEFAULT_PERIOD_KEY),
          ),
        }
      : null;
    if (!stored) return;
    const urlActive = readActiveTabFromUrl();
    // Capture the URL-derived tab set from the current `tabs`
    // state (seeded by `useState` above from `initialTabs` /
    // `initialResult`). These snapshots are authoritative for
    // the shareable slice; the session provides the rest plus
    // per-tab UI state.
    const urlTabs: TabSnapshot[] = tabs.map((r) => r.snapshot);
    const rebased = rehydrateTabs({
      urlTabs,
      urlActiveIndex: urlActive,
      session: stored,
    });
    // Map each rebased snapshot back to a runtime. The active tab
    // keeps the SSR-fetched result; the others start blank and
    // will run on demand when the operator switches to them and
    // hits Apply (or implicitly if their `autoRun` flag is set).
    setTabs(() =>
      rebased.tabs.map((snapshot, index) => {
        if (index === rebased.activeIndex) {
          const runtime = createBlankRuntime(snapshot);
          runtime.events = initialResult.events;
          runtime.eventKeys = initialResult.eventKeys;
          runtime.totalCount = initialResult.totalCount;
          runtime.resultError = initialResult.error;
          runtime.lastUpdatedMs =
            initialResult.error === null && initialResult.totalCount !== null
              ? Date.now()
              : null;
          runtime.hasQueried =
            initialResult.error === null && initialResult.totalCount !== null;
          return runtime;
        }
        return createBlankRuntime(snapshot);
      }),
    );
    setActiveIndex(rebased.activeIndex);
  }, []);

  // Mirror the tabs array to sessionStorage on every change. Skips
  // the initial mount: if we wrote the 1-tab SSR snapshot there, we
  // would clobber a stored multi-tab payload before the rehydration
  // effect above has had a chance to read it (mount-time effects
  // fire with the pre-setTabs closure, so the writer can't see the
  // rebased state yet). After the first render cycle the writer is
  // the single source of truth for sessionStorage.
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (initialMountRef.current) {
      initialMountRef.current = false;
      return;
    }
    const snapshot = {
      tabs: tabs.map((r) => r.snapshot),
      activeIndex,
    };
    const serialized = serializeTabsForSession(snapshot);
    if (serialized === tabsSerializedRef.current) return;
    tabsSerializedRef.current = serialized;
    try {
      window.sessionStorage.setItem(TABS_SESSION_KEY, serialized);
    } catch {
      // Quota errors / Safari private mode fall-through silently — a
      // missing session store just means the next reload starts from
      // URL alone, which is a valid degradation.
    }
  }, [tabs, activeIndex]);

  const activeTab = tabs[activeIndex] ?? tabs[0];
  const activeSnapshot = activeTab.snapshot;
  const committedFilter = activeSnapshot.filter;

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
    setTabs((prev) => {
      const next = [...prev];
      const current = next[activeIndex];
      if (!current) return prev;
      if (current.draft) return prev;
      // Seed the drawer from a rolled-forward copy of the committed
      // filter so a relative-period tab (`Last 1 hour`, …) shows a
      // window ending at "now" instead of the frozen original. The
      // rolled values live only in the draft; the committed snapshot
      // is left untouched so the result header keeps describing the
      // window the cached rows were actually queried against. The
      // snapshot only rolls when a query runs (Apply / Refresh /
      // committed chip removal).
      const rolled = resolveTabPeriod(current.snapshot);
      const nextDraft = filterToDraft(
        rolled.filter,
        rolled.period,
        rolled.endpoints,
      );
      next[activeIndex] = { ...current, draft: nextDraft };
      return next;
    });
    setOpenEndpointPanelOnDrawerOpen(false);
    setFocusField(null);
    setDrawerOpen(true);
    if (shouldTriggerSensorFetch(sensorCache)) triggerSensorFetch();
  }, [activeIndex, sensorCache, triggerSensorFetch]);

  // Run a committed filter for a specific tab, updating runtime state
  // by id so async responses cannot clobber a different tab that was
  // switched to in the meantime.
  const runQueryForTab = useCallback(
    (tabId: string, filter: Filter) => {
      const requestId = requestCounterRef.current + 1;
      requestCounterRef.current = requestId;
      latestRequestIdByTabRef.current.set(tabId, requestId);
      updateTabById(tabId, {
        loading: true,
        resultError: null,
        hasQueried: true,
        quickPeekEvent: null,
      });
      setTabs((prev) =>
        prev.map((r) =>
          r.snapshot.id === tabId ? { ...r, queryEpoch: r.queryEpoch + 1 } : r,
        ),
      );
      startTransition(async () => {
        try {
          const result = await runEventQuery(filter);
          if (latestRequestIdByTabRef.current.get(tabId) !== requestId) return;
          if (result.ok) {
            updateTabById(tabId, {
              totalCount: result.totalCount,
              events: result.events,
              eventKeys: result.eventKeys,
              resultError: null,
              lastUpdatedMs: Date.now(),
              loading: false,
            });
          } else {
            updateTabById(tabId, {
              totalCount: null,
              events: [],
              eventKeys: [],
              resultError: labels.resultsError,
              loading: false,
            });
          }
        } catch {
          if (latestRequestIdByTabRef.current.get(tabId) !== requestId) return;
          updateTabById(tabId, {
            totalCount: null,
            events: [],
            eventKeys: [],
            resultError: labels.resultsError,
            loading: false,
          });
        }
      });
    },
    [labels.resultsError, updateTabById],
  );

  // Write the full tab strip + `?tab=N` index to the browser URL
  // without triggering a soft navigation. The active tab's full
  // filter surface — period, explicit range, directions, confidence,
  // categoricals, sensors, endpoints — always rides in the top-level
  // params so pivot hand-off links keep working. When the working
  // set fits inside the URL-length budget, every tab's filter also
  // rides along in a compact `tabs=<json>` param so a shared link
  // reproduces the author's whole strip instead of just the active
  // one.
  const syncUrlForTabs = useCallback(
    (nextTabs: TabRuntime[], nextActive: number) => {
      if (typeof window === "undefined") return;
      const snapshots = nextTabs.map((r) => r.snapshot);
      const { search } = buildAllTabsSearchParams({
        tabs: snapshots,
        activeIndex: nextActive,
        pathname,
      });
      const qs = search.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.replaceState(window.history.state, "", url);
    },
    [pathname],
  );

  const handleApply = useCallback(
    (applied: DetectionFilterDraft) => {
      // One-sided ranges are rejected by the drawer's validation.
      // Both-null is allowed — it's the "no time filter" Apply used
      // when the operator cleared the default period chip before
      // first running the query on a pending `+` tab.
      if (Boolean(applied.startIso) !== Boolean(applied.endIso)) return;
      const current = tabs[activeIndex];
      if (!current) return;
      const endpointLive =
        sensorCache.status === "loaded" && sensorCache.endpointAvailable;
      const next = buildAppliedFilter(
        current.snapshot.filter,
        applied,
        endpointLive,
        options,
      );
      const nextSnapshot: TabSnapshot = {
        ...current.snapshot,
        filter: next,
        period: applied.period,
        endpoints: applied.endpoints,
        autoRun: true,
      };
      // Discard the submitted draft after Apply. `openDrawer` /
      // `openDrawerFocused` only re-roll a relative period (`Last 1
      // hour`, …) forward to "now" when the cached draft is null; if
      // we kept `draft: applied` here, reopening the drawer twenty
      // minutes after Apply would reuse the frozen absolute
      // `startIso` / `endIso` captured on submit, and a subsequent
      // re-Apply of the same tab would quietly requery the original
      // window. Clearing the draft matches the pattern used by
      // Refresh and chip removal (see `handleRefresh`, `handleRemoveChip`).
      const nextTabs = tabs.map((r, i) =>
        i === activeIndex ? { ...r, snapshot: nextSnapshot, draft: null } : r,
      );
      setTabs(nextTabs);
      setDrawerOpen(false);
      syncUrlForTabs(nextTabs, activeIndex);
      runQueryForTab(nextSnapshot.id, next);
    },
    [activeIndex, tabs, options, runQueryForTab, sensorCache, syncUrlForTabs],
  );

  const handleRemoveChip = useCallback(
    (target: ChipRemoveTarget) => {
      const current = tabs[activeIndex];
      if (!current) return;
      const next = removeActiveChip(
        current.snapshot.filter,
        current.snapshot.endpoints,
        target,
      );
      // Pending `+` tabs must go through the drawer's Apply path
      // before running their first query (issue #281 "the user must
      // Apply"). Chip removal on a pending tab mutates the filter but
      // keeps the tab pending — the user still has to Apply to execute
      // it. Already-run tabs behave as before: flip to `autoRun: true`
      // and fire the query.
      const wasPending = !current.snapshot.autoRun;
      const baseSnapshot: TabSnapshot = {
        ...current.snapshot,
        filter: next.filter,
        endpoints: next.endpoints,
        period: target.kind === "period" ? null : current.snapshot.period,
        autoRun: !wasPending,
      };
      // Re-roll the committed filter's window against "now" before
      // running. Otherwise a `Last 1 hour` tab refreshed twenty
      // minutes after first Apply would still query the original hour
      // and the freshness chip would lie. For pending tabs we skip
      // this: the tab is not being executed here.
      const nextSnapshot = wasPending
        ? baseSnapshot
        : resolveTabPeriod(baseSnapshot);
      const nextTabs = tabs.map((r, i) =>
        i === activeIndex ? { ...r, snapshot: nextSnapshot, draft: null } : r,
      );
      setTabs(nextTabs);
      syncUrlForTabs(nextTabs, activeIndex);
      if (wasPending) return;
      runQueryForTab(nextSnapshot.id, nextSnapshot.filter);
    },
    [activeIndex, runQueryForTab, syncUrlForTabs, tabs],
  );

  const handleRefresh = useCallback(() => {
    const current = tabs[activeIndex];
    if (!current) return;
    // Guard: a pending tab should never reach this code path — the
    // Refresh button is disabled in that state (see `ResultList`'s
    // `canRefresh` prop). Defend against programmatic invocations
    // anyway so the Apply-only rule cannot be bypassed.
    if (!current.snapshot.autoRun) return;
    const rolled = resolveTabPeriod(current.snapshot);
    if (rolled !== current.snapshot) {
      // Clearing the cached drawer draft when the snapshot rolls is
      // what keeps the drawer honest on reopen: `handleApply` seeds
      // `draft` from the just-applied filter, and `openDrawer` only
      // bails when a draft already exists. Without this clear, a
      // rolled-forward tab would reopen the drawer with the frozen
      // absolute start / end captured on first Apply, even though
      // the committed filter (and the chip bar) show the rolled
      // window. See PR #330 reviewer round 5.
      const nextTabs = tabs.map((r, i) =>
        i === activeIndex ? { ...r, snapshot: rolled, draft: null } : r,
      );
      setTabs(nextTabs);
    }
    runQueryForTab(rolled.id, rolled.filter);
  }, [activeIndex, runQueryForTab, tabs]);

  const openDrawerFocused = useCallback(
    (focus: FilterChipFocus) => {
      setTabs((prev) => {
        const next = [...prev];
        const current = next[activeIndex];
        if (!current) return prev;
        if (current.draft) return prev;
        // See `openDrawer` — roll relative periods forward into the
        // draft only. The committed snapshot is not touched here so
        // the result header keeps describing the cached rows' query
        // window until a real rerun (Apply / Refresh) lands.
        const rolled = resolveTabPeriod(current.snapshot);
        const nextDraft = filterToDraft(
          rolled.filter,
          rolled.period,
          rolled.endpoints,
        );
        next[activeIndex] = { ...current, draft: nextDraft };
        return next;
      });
      setFocusField(focus);
      setFocusToken((tk) => tk + 1);
      setOpenEndpointPanelOnDrawerOpen(shouldOpenEndpointPanelForFocus(focus));
      setDrawerOpen(true);
      if (shouldTriggerSensorFetch(sensorCache)) triggerSensorFetch();
    },
    [activeIndex, sensorCache, triggerSensorFetch],
  );

  // Clear any unapplied draft on the tab being left so reopening the
  // drawer after returning re-seeds from the committed filter — not a
  // stale draft that diverges from the chip bar. The issue requires
  // every context switch to re-synchronize the drawer and chip bar to
  // the destination tab's committed filter; without this clear,
  // `openDrawer` / `openDrawerFocused` short-circuit on the cached
  // draft and show the abandoned edit instead. Applies to every path
  // that switches away from the active tab (plain select, `+`, and
  // any future pivot / saved-filter activation).
  const clearLeavingDraft = useCallback(
    (source: TabRuntime[]) => {
      const leaving = source[activeIndex];
      if (!leaving?.draft) return source;
      return source.map((r, i) =>
        i === activeIndex ? { ...r, draft: null } : r,
      );
    },
    [activeIndex],
  );

  // Tab bar callbacks.
  const handleTabSelect = useCallback(
    (index: number) => {
      if (index === activeIndex) return;
      const nextTabs = clearLeavingDraft(tabs);
      if (nextTabs !== tabs) setTabs(nextTabs);
      setActiveIndex(index);
      // Close any open drawer on tab switch — drafts live per-tab, so
      // the drawer's open/closed state is only coherent relative to
      // the active tab.
      setDrawerOpen(false);
      syncUrlForTabs(nextTabs, index);
    },
    [activeIndex, clearLeavingDraft, syncUrlForTabs, tabs],
  );

  const handleTabAdd = useCallback(() => {
    if (tabs.length >= TAB_CAP) return;
    const defaultRange = computePeriodRange(DEFAULT_PERIOD_KEY);
    const blank = createBlankTab({
      filter: {
        mode: "structured",
        input: { start: defaultRange.start, end: defaultRange.end },
      },
      period: DEFAULT_PERIOD_KEY,
    });
    const runtime = createBlankRuntime(blank);
    // `+` is a context switch just like `handleTabSelect`: the active
    // tab changes to the new blank one. Drop any unapplied draft on
    // the tab being left so returning to it (via tab click) reopens
    // the drawer from the committed filter, not the abandoned edit.
    const cleared = clearLeavingDraft(tabs);
    const nextIndex = cleared.length;
    const nextTabs = [...cleared, runtime];
    setTabs(nextTabs);
    setActiveIndex(nextIndex);
    setDrawerOpen(false);
    // The new blank tab becomes active. Write the full strip to the
    // URL now — not on the next Apply — so a reload before the
    // operator runs a query re-hydrates the fresh tab (with
    // `autoRun: false` / `pending=1`) rather than the stale filter
    // the previous active tab left in the URL.
    syncUrlForTabs(nextTabs, nextIndex);
  }, [clearLeavingDraft, syncUrlForTabs, tabs]);

  const handleTabClose = useCallback(
    (index: number) => {
      const priorLength = tabs.length;
      const priorActive = activeIndex;
      let nextRuntimes: TabRuntime[] = [];
      if (priorLength === 0) {
        nextRuntimes = tabs;
      } else if (priorLength === 1) {
        // Closing the last tab auto-creates a fresh default tab so
        // the page never renders tab-less. Use `createDefaultTab`, not
        // `createBlankTab`: the issue distinguishes a default tab
        // (auto-executes `Last 1 hour` on page entry) from a pending
        // `+` tab (stays pending until Apply). Closing the last tab
        // should drop the operator into the former.
        const defaultRange = computePeriodRange(DEFAULT_PERIOD_KEY);
        const fresh = createDefaultTab({
          filter: {
            mode: "structured",
            input: { start: defaultRange.start, end: defaultRange.end },
          },
          period: DEFAULT_PERIOD_KEY,
        });
        nextRuntimes = [createBlankRuntime(fresh)];
      } else {
        nextRuntimes = tabs.filter((_, i) => i !== index);
      }
      setTabs(nextRuntimes);
      let nextActive = priorActive;
      if (priorLength <= 1) {
        nextActive = 0;
      } else if (index < priorActive) {
        nextActive = priorActive - 1;
      } else if (index === priorActive) {
        nextActive = Math.min(priorActive, priorLength - 2);
      }
      setActiveIndex(nextActive);
      setDrawerOpen(false);
      // If the close changed which tab is active, refresh the URL so
      // it describes the now-active tab — otherwise the closed tab's
      // filter would stay in the URL and could resurrect into the
      // neighbour on reload.
      syncUrlForTabs(nextRuntimes, nextActive);
    },
    [activeIndex, syncUrlForTabs, tabs],
  );

  const handleTabRename = useCallback(
    (index: number, nextName: string | null) => {
      const target = tabs[index];
      if (!target) return;
      updateSnapshotById(target.snapshot.id, { name: nextName });
    },
    [tabs, updateSnapshotById],
  );

  // If the active tab just became the one we need to auto-run
  // (switching to a tab whose snapshot was loaded from sessionStorage
  // with autoRun and no cached result yet), kick off the query.
  useEffect(() => {
    const current = tabs[activeIndex];
    if (!current) return;
    if (
      current.snapshot.autoRun &&
      !current.hasQueried &&
      !current.loading &&
      !current.resultError
    ) {
      // Auto-run only gets triggered by switching to a session-
      // restored tab that has never run. The initial tab's SSR path
      // already populated `hasQueried`. Roll the relative period
      // forward first so `Last 1 hour` (etc.) always queries the hour
      // ending "now", not the window captured on the tab's last Apply.
      const rolled = resolveTabPeriod(current.snapshot);
      if (rolled !== current.snapshot) {
        // Also drop any stale drawer draft cached on the runtime —
        // without this, `openDrawer`'s existing-draft short-circuit
        // would reopen the drawer with the pre-roll start / end the
        // operator last Applied, even though the committed filter
        // and chips show the rolled window. See PR #330 reviewer
        // round 5.
        setTabs((prev) =>
          prev.map((r) =>
            r.snapshot.id === current.snapshot.id
              ? {
                  ...r,
                  snapshot: {
                    ...r.snapshot,
                    filter: rolled.filter,
                    period: rolled.period,
                  },
                  draft: null,
                }
              : r,
          ),
        );
      }
      runQueryForTab(rolled.id, rolled.filter);
    }
    // The body's own guard (`!hasQueried && !loading && !resultError`)
    // prevents re-entering once the query has been kicked off, so
    // depending on the full `tabs` array is safe — subsequent result-
    // state updates land with `hasQueried` true and short-circuit.
  }, [activeIndex, tabs, runQueryForTab]);

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
  const sensorState = sensorStateForCache(sensorCache);

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

  // Per-tab chip summariser. Each tab carries its own chip list; the
  // active bar reads from the current tab, and the tab bar uses each
  // tab's chips to auto-generate its title.
  const perTabChips = useMemo<FilterChip[][]>(
    () =>
      tabs.map((r) =>
        summarizeFilter(r.snapshot.filter, summarizeLabels, {
          period: r.snapshot.period,
          sensorOptions,
          categoricalOptions: {
            levels: options.levels,
            countries: options.countries,
            learningMethods: options.learningMethods,
            categories: options.categories,
            kinds: options.kinds,
          },
        }),
      ),
    [tabs, options, sensorOptions, summarizeLabels],
  );
  const summarizedChips = perTabChips[activeIndex] ?? [];

  // Per-tab endpoint chips. Kept separate from `perTabChips` because
  // the active filter bar renders them in a distinct strip, but they
  // still participate in the auto-generated tab title so two tabs
  // differentiated only by endpoint rows don't collapse to the same
  // auto name.
  const perTabEndpointChips = useMemo<EndpointChip[][]>(
    () =>
      tabs.map((r) =>
        buildEndpointChips(r.snapshot.endpoints, labels.endpointChips),
      ),
    [tabs, labels.endpointChips],
  );
  const endpointChips = perTabEndpointChips[activeIndex] ?? [];
  const hasChips = summarizedChips.length > 0 || endpointChips.length > 0;

  const autoNameLabels = useMemo<AutoTabNameLabels>(
    () => ({
      emptyTab: labels.tabs.autoEmptyTab,
      separator: " · ",
      moreSuffix: (count: number) =>
        tTabs("autoMoreSuffix", { count }) as string,
    }),
    [labels.tabs.autoEmptyTab, tTabs],
  );

  // Formatter callbacks can't ride the server→client props bridge,
  // so the shell rebuilds the full DetectionTabLabels locally from
  // the plain-string slice it received plus `tTabs`.
  const tabBarLabels = useMemo<DetectionTabLabels>(
    () => ({
      ...labels.tabs,
      addTabCapTooltip: (cap: number) =>
        tTabs("addTabCapTooltip", { cap }) as string,
      closeTab: (name: string) => tTabs("closeTab", { name }) as string,
    }),
    [labels.tabs, tTabs],
  );

  const tabData = useMemo<DetectionTabData[]>(
    () =>
      tabs.map((r, index) => ({
        snapshot: r.snapshot,
        autoTitle: buildAutoTabName(
          perTabChips[index] ?? [],
          autoNameLabels,
          perTabEndpointChips[index] ?? [],
        ),
      })),
    [tabs, perTabChips, perTabEndpointChips, autoNameLabels],
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
    if (activeTab.loading) {
      return {
        status: "loading",
        events: activeTab.events,
        eventKeys: activeTab.eventKeys,
        totalCount: activeTab.totalCount,
        range: resultRange,
        lastUpdatedMs: activeTab.lastUpdatedMs,
      };
    }
    if (activeTab.resultError) {
      return {
        status: "error",
        events: [],
        eventKeys: [],
        totalCount: null,
        range: resultRange,
        lastUpdatedMs: activeTab.lastUpdatedMs,
      };
    }
    if (!activeTab.hasQueried) {
      return {
        status: "empty-prequery",
        events: [],
        eventKeys: [],
        totalCount: null,
        range: resultRange,
        lastUpdatedMs: activeTab.lastUpdatedMs,
      };
    }
    return {
      status: "ready",
      events: activeTab.events,
      eventKeys: activeTab.eventKeys,
      totalCount: activeTab.totalCount,
      range: resultRange,
      lastUpdatedMs: activeTab.lastUpdatedMs,
    };
  }, [activeTab, resultRange]);

  const setActiveDraft = useCallback(
    (nextDraft: DetectionFilterDraft | null) => {
      const id = activeTab?.snapshot.id;
      if (!id) return;
      updateTabById(id, { draft: nextDraft });
    },
    [activeTab, updateTabById],
  );

  const handleRowOpen = useCallback(
    (event: DetectionEvent) => {
      const id = activeTab?.snapshot.id;
      if (!id) return;
      updateTabById(id, { quickPeekEvent: event });
    },
    [activeTab, updateTabById],
  );

  const handleRowInvestigate = useCallback(
    (event: DetectionEvent) => {
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

  const closeQuickPeek = useCallback(() => {
    const id = activeTab?.snapshot.id;
    if (!id) return;
    updateTabById(id, { quickPeekEvent: null });
  }, [activeTab, updateTabById]);

  const setActiveAnalyticsOpen = useCallback(
    (nextOpen: boolean) => {
      const id = activeTab?.snapshot.id;
      if (!id) return;
      // `analyticsOpen` lives on the snapshot (not runtime) so the
      // state is mirrored into sessionStorage by the writer effect —
      // reloading the page restores whichever tabs had the analytics
      // strip expanded. Kept off the URL per the shareable/non-
      // shareable split documented in lib/detection/tabs.ts.
      updateSnapshotById(id, { analyticsOpen: nextOpen });
    },
    [activeTab, updateSnapshotById],
  );

  const isDesktop = useIsDesktopViewport();
  const quickPeekEvent = activeTab.quickPeekEvent;
  const analyticsOpen = activeTab.snapshot.analyticsOpen;

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

        <DetectionTabs
          tabs={tabData}
          activeIndex={activeIndex}
          cap={TAB_CAP}
          labels={tabBarLabels}
          onSelect={handleTabSelect}
          onClose={handleTabClose}
          onAdd={handleTabAdd}
          onRename={handleTabRename}
        />

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

        <div
          role="tabpanel"
          id={detectionTabPanelDomId(activeTab.snapshot.id)}
          aria-labelledby={detectionTabDomId(activeTab.snapshot.id)}
          className="flex min-h-[60vh] flex-1 gap-4"
        >
          <section
            aria-label={labels.resultsRegion}
            aria-live="polite"
            className="flex min-w-0 flex-1 flex-col"
          >
            <ResultList
              state={resultListState}
              labels={resultListLabels}
              locale={locale}
              queryEpoch={activeTab.queryEpoch}
              canRefresh={activeTab.snapshot.autoRun}
              onRefresh={handleRefresh}
              onOpenFilters={() => openDrawer()}
              onRowOpen={handleRowOpen}
              onRowInvestigate={handleRowInvestigate}
            />
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
                onClose={closeQuickPeek}
                onInvestigate={() => handleRowInvestigate(quickPeekEvent)}
              />
            </aside>
          ) : null}
        </div>
        {tabs.map((tab) =>
          tab.snapshot.id === activeTab.snapshot.id ? null : (
            <div
              key={tab.snapshot.id}
              role="tabpanel"
              id={detectionTabPanelDomId(tab.snapshot.id)}
              aria-labelledby={detectionTabDomId(tab.snapshot.id)}
              hidden
            />
          ),
        )}

        <div className="rounded-lg border border-[var(--sidebar-border)]">
          <button
            type="button"
            onClick={() => setActiveAnalyticsOpen(!analyticsOpen)}
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

      {activeTab.draft ? (
        <FilterDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          draft={activeTab.draft}
          onDraftChange={setActiveDraft}
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
        onClose={closeQuickPeek}
        onInvestigate={() => {
          if (quickPeekEvent) handleRowInvestigate(quickPeekEvent);
        }}
      />
    </div>
  );
}

/** Read the active-tab index from the browser's current URL, or
 * null when unset. Guarded so server-side callers don't blow up. */
function readActiveTabFromUrl(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get(ACTIVE_TAB_PARAM);
  if (!raw) return null;
  // Mirror `readActiveTabIndex`'s strict parse so a hand-edited
  // `?tab=1.5` / `?tab=1junk` does not silently activate tab 1 here.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

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
