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
import { startTransition, useCallback, useMemo, useRef, useState } from "react";
import { runEventQuery } from "@/app/[locale]/(dashboard)/detection/actions";
import {
  type FetchSensorsResult,
  fetchSensors,
} from "@/app/[locale]/(dashboard)/detection/sensor-actions";
import {
  ResultList,
  type ResultListLabels,
  type ResultListState,
} from "@/components/detection/result-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type ChipRemoveTarget,
  removeActiveChip,
} from "@/lib/detection/active-filters";
import { buildAppliedFilter } from "@/lib/detection/apply-filter";
import {
  buildDirectionChips,
  type DirectionChip,
  type DirectionChipLabels,
  readDirectionsFromInput,
} from "@/lib/detection/direction";
import {
  buildEndpointChips,
  type EndpointChipLabels,
  type EndpointEntry,
} from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import { buildDetectionFilterBar } from "@/lib/detection/filter-bar";
import {
  type ActiveFilterChip,
  buildMultiSelectChips,
} from "@/lib/detection/filter-chips";
import {
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  type DetectionFilterDraft,
  isoToLocalInput,
} from "@/lib/detection/filter-draft";
import {
  type FilterChip,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/filter-summary";
import type { PeriodKey } from "@/lib/detection/period";
import type {
  Event as DetectionEvent,
  FlowKind,
  LearningMethod,
} from "@/lib/detection/types";
import {
  buildDetectionSearchParams,
  buildPivotChips,
  mergePivotParams,
  type PivotChip,
  type PivotChipLabels,
  type PivotFilterParams,
  type PivotKey,
  pivotParamsFromFilterInput,
  TAG_FIELDS,
  type TagField,
  TEXT_FIELDS,
} from "@/lib/detection/url-filters";
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
  summarize: SummarizeFilterLabels;
}

export interface DetectionShellInitialResult {
  totalCount: string | null;
  error: string | null;
  events: DetectionEvent[];
}

interface DetectionShellProps {
  title: string;
  labels: DetectionShellLabels;
  options: FilterDrawerOptions;
  initialFilter: Filter;
  initialPeriod: PeriodKey | null;
  initialResult: DetectionShellInitialResult;
  /** Pivot-only params from the URL (kind, ports, proto, window) — rendered as chips but not editable in the drawer yet. */
  initialPivotOnly?: PivotFilterParams;
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

export function DetectionShell({
  title,
  labels,
  options,
  initialFilter,
  initialPeriod,
  initialResult,
  initialPivotOnly = {},
}: DetectionShellProps) {
  const t = useTranslations("detection.filters");
  const tResults = useTranslations("detection.results");
  const locale = useLocale();
  const pathname = usePathname();
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
  // `pivotOnly` carries chip-only fields (kind/ports/proto/window) that
  // arrive from the Investigation handoff URL and have no drawer
  // editor yet. They live in component state so chip × removal can
  // also drop them from the bar.
  const [pivotOnly, setPivotOnly] =
    useState<PivotFilterParams>(initialPivotOnly);
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
  const [resultError, setResultError] = useState<string | null>(
    initialResult.error,
  );
  const [loading, setLoading] = useState(false);
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(
    initialResult.error === null && initialResult.totalCount !== null
      ? Date.now()
      : null,
  );
  // Monotonic id for the in-flight Apply; a late response whose id
  // no longer matches is dropped so the results region can't drift
  // away from the committed filter when the operator applies twice
  // in quick succession.
  const latestRequestIdRef = useRef(0);

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

  const openDrawer = useCallback(
    (opts?: { openEndpointPanel?: boolean }) => {
      setDraft(
        (current) =>
          current ??
          filterToDraft(committedFilter, committedPeriod, committedEndpoints),
      );
      setOpenEndpointPanelOnDrawerOpen(opts?.openEndpointPanel ?? false);
      setFocusField(null);
      setDrawerOpen(true);
      // Lazy-load the sensor inventory the first time the drawer
      // opens, and retry on a prior transient failure so a single
      // hiccup doesn't freeze Sensor into the "Coming soon" fallback
      // for the rest of the tab session. Only `loading` / `loaded`
      // short-circuit — `idle` means never fetched, `error` means the
      // last attempt failed and the user just asked again.
      if (sensorCache.status === "loading" || sensorCache.status === "loaded") {
        return;
      }
      triggerSensorFetch();
    },
    [
      committedFilter,
      committedPeriod,
      committedEndpoints,
      sensorCache.status,
      triggerSensorFetch,
    ],
  );

  // Re-run a committed filter without going through the drawer's
  // Apply path. Used by both chip × removal and the result list's
  // Refresh button — neither has a draft to normalize, so they
  // bypass `buildAppliedFilter`. Mirrors the same monotonic
  // request-id late-response guard that `handleApply` uses.
  const runQueryFor = useCallback(
    (filter: Filter) => {
      setLoading(true);
      setResultError(null);
      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      startTransition(async () => {
        try {
          const result = await runEventQuery(filter);
          if (latestRequestIdRef.current !== requestId) return;
          if (result.ok) {
            setTotalCount(result.totalCount);
            setEvents(result.events);
            setResultError(null);
            setLastUpdatedMs(Date.now());
          } else {
            setTotalCount(null);
            setEvents([]);
            setResultError(labels.resultsError);
          }
        } catch {
          if (latestRequestIdRef.current !== requestId) return;
          setTotalCount(null);
          setEvents([]);
          setResultError(labels.resultsError);
        } finally {
          if (latestRequestIdRef.current === requestId) {
            setLoading(false);
          }
        }
      });
    },
    [labels.resultsError],
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
        const qs = buildDetectionSearchParams(merged).toString();
        const url = qs ? `${pathname}?${qs}` : pathname;
        window.history.replaceState(window.history.state, "", url);
      }

      runQueryFor(next);
    },
    [committedFilter, pivotOnly, options, pathname, runQueryFor, sensorCache],
  );

  // Pure helper: drop a single pivot-only field. Pivot-only chips
  // come from the URL (kind/origPort/respPort/proto/window) and are
  // not represented in `EventListFilterInput`, so removal touches
  // `pivotOnly` state alone — the active filter doesn't change.
  const handleRemovePivotOnlyChip = useCallback(
    (field: PivotKey) => {
      const next: PivotFilterParams = { ...pivotOnly };
      if (field === "kind") next.kind = undefined;
      else if (field === "origPort") next.origPort = undefined;
      else if (field === "respPort") next.respPort = undefined;
      else if (field === "proto") next.proto = undefined;
      else if (field === "window") next.window = undefined;
      else return;
      setPivotOnly(next);
      if (committedFilter.mode === "structured") {
        const merged = mergePivotParams(
          next,
          pivotParamsFromFilterInput(committedFilter.input),
        );
        const qs = buildDetectionSearchParams(merged).toString();
        const url = qs ? `${pathname}?${qs}` : pathname;
        window.history.replaceState(window.history.state, "", url);
      }
    },
    [committedFilter, pathname, pivotOnly],
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
        const qs = buildDetectionSearchParams(merged).toString();
        const url = qs ? `${pathname}?${qs}` : pathname;
        window.history.replaceState(window.history.state, "", url);
      }
      runQueryFor(next.filter);
    },
    [committedEndpoints, committedFilter, pivotOnly, pathname, runQueryFor],
  );

  const handleRefresh = useCallback(() => {
    runQueryFor(committedFilter);
  }, [committedFilter, runQueryFor]);

  const openDrawerFocused = useCallback(
    (field: PivotKey) => {
      // Only drawer-editable fields have an input to focus. Pivot-only
      // fields (kind/origPort/respPort/proto/window) produce scalar
      // chips that never aggregate, so in practice this branch is only
      // reached for tag/text fields — the guard keeps us honest if a
      // future aggregate path widens the chip set.
      setDraft(
        (current) =>
          current ??
          filterToDraft(committedFilter, committedPeriod, committedEndpoints),
      );
      setFocusField(isDrawerFocusField(field) ? field : null);
      setFocusToken((t) => t + 1);
      setDrawerOpen(true);
    },
    [committedFilter, committedPeriod, committedEndpoints],
  );

  // Compose the function-valued labels the chip builder needs on this
  // side of the server/client boundary. The server page passes only
  // plain strings; the translator closes over the active locale here so
  // aggregate chip counts format with the right language.
  const chipLabels = useMemo<PivotChipLabels>(
    () => ({
      ...labels.chipLabels,
      countAggregate: (label, count) =>
        t("chips.countAggregate", { label, count }),
    }),
    [labels.chipLabels, t],
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

  // Pivot-style chips from drawer free-form fields (+ URL-only pivots).
  const pivotChips = useMemo<PivotChip[]>(
    () =>
      buildPivotChips(
        mergePivotParams(
          pivotOnly,
          pivotParamsFromFilterInput(extractStructuredInput(committedFilter)),
        ),
        chipLabels,
      ),
    [committedFilter, pivotOnly, chipLabels],
  );

  const { summary: activeChipText, chips: baseChips } = buildDetectionFilterBar(
    {
      filter: committedFilter,
      period: committedPeriod,
      pivotChips,
      labels: {
        confidenceChipLabel: labels.confidenceChipLabel,
        activeChipsEmpty: labels.activeChipsEmpty,
        periodOptions: labels.drawer.periodOptions,
        formatRange: ({ start, end }) => t("activeRange", { start, end }),
      },
    },
  );
  const directionChips: DirectionChip[] = buildDirectionChips(
    structuredDirections(committedFilter),
    labels.directionChips,
  );
  const endpointChips = buildEndpointChips(
    committedEndpoints,
    labels.endpointChips,
  );
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

  const sensorChips: FilterChip[] =
    committedFilter.mode === "structured"
      ? summarizeFilter(committedFilter.input, sensorOptions, labels.summarize)
      : [];
  const multiSelectChips = useMemo(
    () =>
      buildActiveMultiSelectChips(
        committedFilter,
        options,
        drawerLabels,
        multiSelectLabels,
      ),
    [committedFilter, options, drawerLabels, multiSelectLabels],
  );
  const hasChips =
    baseChips.length > 0 ||
    directionChips.length > 0 ||
    endpointChips.length > 0 ||
    sensorChips.length > 0 ||
    multiSelectChips.length > 0;

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
        totalCount,
        range: resultRange,
        lastUpdatedMs,
      };
    }
    if (resultError) {
      return {
        status: "error",
        events: [],
        totalCount: null,
        range: resultRange,
        lastUpdatedMs,
      };
    }
    return {
      status: "ready",
      events,
      totalCount,
      range: resultRange,
      lastUpdatedMs,
    };
  }, [events, lastUpdatedMs, loading, resultError, resultRange, totalCount]);

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
            <span className="text-muted-foreground text-xs">
              {activeChipText}
            </span>
            {hasChips ? (
              <ul className="flex flex-wrap items-center gap-1.5">
                {baseChips.map((chip) => {
                  const isPivotOnly = isPivotOnlyField(chip.field);
                  const removeTarget = chip.field
                    ? pivotChipRemoveTarget(
                        chip.field,
                        chip.value,
                        !!chip.aggregate,
                      )
                    : chip.id === "confidence"
                      ? ({ kind: "confidence" } as const)
                      : null;
                  return (
                    <li key={chip.id}>
                      <RemovableChip
                        prefix={
                          chip.aggregate && chip.field ? null : chip.label
                        }
                        value={chip.value}
                        onActivate={
                          chip.aggregate && chip.field && !isPivotOnly
                            ? () => openDrawerFocused(chip.field as PivotKey)
                            : undefined
                        }
                        onRemove={
                          isPivotOnly && chip.field
                            ? () =>
                                handleRemovePivotOnlyChip(
                                  chip.field as PivotKey,
                                )
                            : removeTarget
                              ? () => handleRemoveChip(removeTarget)
                              : undefined
                        }
                        removeLabel={removeChip(chip.value)}
                      />
                    </li>
                  );
                })}
                {directionChips.map((chip) => (
                  <li key={chip.id}>
                    <RemovableChip
                      prefix={chip.label}
                      value={chip.value}
                      onRemove={() =>
                        handleRemoveChip({
                          kind: "directionValue",
                          value: chip.id.replace("direction:", "") as FlowKind,
                        })
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
                      onActivate={
                        chip.aggregate
                          ? () => openDrawer({ openEndpointPanel: true })
                          : undefined
                      }
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
                {sensorChips.map((chip) => (
                  <li key={chip.id}>
                    <RemovableChip
                      prefix={chip.label}
                      value={chip.value}
                      onRemove={() =>
                        chip.id === "sensor:aggregate"
                          ? handleRemoveChip({
                              kind: "arrayAggregate",
                              field: "sensors",
                            })
                          : handleRemoveChip({
                              kind: "arrayValue",
                              field: "sensors",
                              value: chip.id.replace(/^sensor:/, ""),
                            })
                      }
                      removeLabel={removeChip(chip.value)}
                    />
                  </li>
                ))}
                {multiSelectChips.map((chip) => {
                  const target = multiSelectChipRemoveTarget(chip);
                  return (
                    <li key={chip.key}>
                      <RemovableChip
                        prefix={chip.label}
                        value={chip.value}
                        onRemove={
                          target ? () => handleRemoveChip(target) : undefined
                        }
                        removeLabel={removeChip(chip.value)}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>

        {/* Results region (hero) */}
        <section
          aria-label={labels.resultsRegion}
          aria-live="polite"
          className="flex min-h-[60vh] flex-1 flex-col"
        >
          <ResultList
            state={resultListState}
            labels={resultListLabels}
            locale={locale}
            onRefresh={handleRefresh}
            onOpenFilters={() => openDrawer()}
          />
        </section>

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
    </div>
  );
}

function filterToDraft(
  filter: Filter,
  period: PeriodKey | null,
  endpoints: EndpointEntry[],
): DetectionFilterDraft {
  const startIso = structuredStart(filter);
  const endIso = structuredEnd(filter);
  const confidence = structuredConfidence(filter);
  const sensorIds =
    filter.mode === "structured" ? (filter.input.sensors ?? []) : [];
  const input = filter.mode === "structured" ? filter.input : {};
  const fromArray = (values: string[] | null | undefined): string[] =>
    values && values.length > 0 ? [...values] : [];
  return {
    period,
    startLocal: isoToLocalInput(startIso),
    endLocal: isoToLocalInput(endIso),
    startIso,
    endIso,
    directions: readDirectionsFromInput(structuredDirections(filter)),
    endpoints,
    confidenceMin: confidence?.min ?? CONFIDENCE_DEFAULT_MIN,
    confidenceMax: confidence?.max ?? CONFIDENCE_DEFAULT_MAX,
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

const FOCUSABLE_FIELDS = new Set<string>([...TEXT_FIELDS, ...TAG_FIELDS]);

function isDrawerFocusField(field: PivotKey): field is DrawerFocusField {
  return FOCUSABLE_FIELDS.has(field);
}

function extractStructuredInput(filter: Filter) {
  if (filter.mode !== "structured") return {};
  return filter.input;
}

function structuredStart(filter: Filter): string | null {
  if (filter.mode !== "structured") return null;
  return filter.input.start ?? null;
}

function structuredEnd(filter: Filter): string | null {
  if (filter.mode !== "structured") return null;
  return filter.input.end ?? null;
}

function structuredDirections(filter: Filter): FlowKind[] | null | undefined {
  if (filter.mode !== "structured") return undefined;
  return filter.input.directions;
}

function structuredConfidence(
  filter: Filter,
): { min: number; max: number } | null {
  if (filter.mode !== "structured") return null;
  const min = filter.input.confidenceMin;
  const max = filter.input.confidenceMax;
  if (min == null && max == null) return null;
  return {
    min: min ?? CONFIDENCE_DEFAULT_MIN,
    max: max ?? CONFIDENCE_DEFAULT_MAX,
  };
}

function buildActiveMultiSelectChips(
  filter: Filter,
  options: FilterDrawerOptions,
  labels: FilterDrawerLabels,
  multiSelectLabels: FilterMultiSelectLabels,
): ActiveFilterChip[] {
  if (filter.mode !== "structured") return [];
  const input = filter.input;
  const aggregateCount = (n: number) => multiSelectLabels.summarySome(n);

  const chips: ActiveFilterChip[] = [];
  chips.push(
    ...buildMultiSelectChips({
      fieldKey: "levels",
      fieldLabel: labels.fields.levels,
      options: options.levels,
      selected: input.levels ?? [],
      aggregateValue: aggregateCount,
    }),
  );
  chips.push(
    ...buildMultiSelectChips({
      fieldKey: "countries",
      fieldLabel: labels.fields.countries,
      options: options.countries,
      selected: input.countries ?? [],
      aggregateValue: aggregateCount,
    }),
  );
  chips.push(
    ...buildMultiSelectChips({
      fieldKey: "learningMethods",
      fieldLabel: labels.fields.learningMethods,
      options: options.learningMethods,
      selected: input.learningMethods ?? [],
      aggregateValue: aggregateCount,
    }),
  );
  chips.push(
    ...buildMultiSelectChips<number>({
      fieldKey: "categories",
      fieldLabel: labels.fields.categories,
      options: options.categories,
      selected: (input.categories ?? []).filter(
        (v): v is number => typeof v === "number",
      ),
      aggregateValue: aggregateCount,
    }),
  );
  chips.push(
    ...buildMultiSelectChips({
      fieldKey: "kinds",
      fieldLabel: labels.fields.kinds,
      options: options.kinds,
      selected: input.kinds ?? [],
      aggregateValue: aggregateCount,
      // Seed-list field — see the `openList` note in filter-chips.ts.
      openList: true,
    }),
  );
  return chips;
}

/**
 * URL-only pivot fields. These show up as chips but have no slot in
 * `EventListFilterInput`, so chip × removal updates `pivotOnly` state
 * rather than the active filter.
 */
const PIVOT_ONLY_FIELDS = new Set<PivotKey>([
  "kind",
  "origPort",
  "respPort",
  "proto",
  "window",
]);

function isPivotOnlyField(field: PivotKey | undefined): boolean {
  return field !== undefined && PIVOT_ONLY_FIELDS.has(field);
}

function pivotChipRemoveTarget(
  field: PivotKey,
  value: string,
  aggregate: boolean,
): ChipRemoveTarget | null {
  if (PIVOT_ONLY_FIELDS.has(field)) return null;
  if (field === "source" || field === "destination") {
    return { kind: "scalarField", field };
  }
  // Tag fields: keywords / hostnames / userIds / userNames / userDepartments.
  if (
    field === "keywords" ||
    field === "hostnames" ||
    field === "userIds" ||
    field === "userNames" ||
    field === "userDepartments"
  ) {
    if (aggregate) return { kind: "arrayAggregate", field };
    return { kind: "arrayValue", field, value };
  }
  return null;
}

function multiSelectChipRemoveTarget(
  chip: ActiveFilterChip,
): ChipRemoveTarget | null {
  const field = chip.fieldKey;
  if (
    field !== "levels" &&
    field !== "countries" &&
    field !== "learningMethods" &&
    field !== "categories" &&
    field !== "kinds"
  ) {
    return null;
  }
  if (chip.aggregate) {
    return { kind: "categoricalAggregate", field };
  }
  // The chip key encodes the underlying value — `levels:5`,
  // `countries:US`, `kinds:HttpThreat`, etc. Parse it back so the
  // removal target matches the typed `selected` array.
  const valueText = chip.key.startsWith(`${field}:`)
    ? chip.key.slice(field.length + 1)
    : chip.value;
  if (field === "levels" || field === "categories") {
    const n = Number.parseInt(valueText, 10);
    if (!Number.isFinite(n)) return null;
    return { kind: "categoricalValue", field, value: n };
  }
  if (field === "learningMethods") {
    if (valueText !== "UNSUPERVISED" && valueText !== "SEMI_SUPERVISED") {
      return null;
    }
    return { kind: "categoricalValue", field, value: valueText };
  }
  return { kind: "categoricalValue", field, value: valueText };
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
  const interactive = !!onActivate;
  const Wrapper = interactive ? "button" : "span";
  const wrapperProps = interactive
    ? {
        type: "button" as const,
        onClick: onActivate,
        className:
          "focus-visible:ring-ring/50 rounded-full focus-visible:ring-2 focus-visible:outline-none",
      }
    : {};
  return (
    <span className="inline-flex items-center gap-1">
      <Wrapper {...wrapperProps}>
        <Badge
          variant="secondary"
          className={cn(
            "font-normal",
            interactive && "cursor-pointer",
            onRemove && "pr-1",
          )}
        >
          {prefix ? (
            <span className="text-muted-foreground mr-1 text-xs">{prefix}</span>
          ) : null}
          <span className="text-foreground text-xs font-medium">{value}</span>
          {onRemove ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              aria-label={removeLabel}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 ml-1 inline-flex size-3.5 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          ) : null}
        </Badge>
      </Wrapper>
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
