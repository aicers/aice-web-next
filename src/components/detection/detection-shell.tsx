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
import type { PeriodKey } from "@/lib/detection/period";
import type {
  Event as DetectionEvent,
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
  // Tracks whether any query has been dispatched (by the server-
  // rendered initial load or a subsequent Apply / Refresh / chip
  // removal). A freshly-mounted `+` tab with no successful query —
  // e.g. the server action returned an error before the page mounted
  // — renders the dedicated pre-query empty state instead of the
  // generic zero-results panel.
  const [hasQueried, setHasQueried] = useState(
    initialResult.error === null && initialResult.totalCount !== null,
  );
  // Quick peek inspector (Phase Detection-18 owns the content; this
  // shell wires the open/close contract and the jump into full
  // Investigation). At wide widths (≥ `desktop`) the inspector docks
  // inline as a right-hand pane; at narrower widths the same state
  // drives an overlay drawer.
  const [quickPeekEvent, setQuickPeekEvent] = useState<DetectionEvent | null>(
    null,
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
      setHasQueried(true);
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
      setDrawerOpen(true);
      // Endpoint aggregate: also expand the Network/IP advanced panel
      // so the operator lands in the same UI as the sidebar "Advanced"
      // affordance.
      if (focus === "endpoints") setOpenEndpointPanelOnDrawerOpen(true);
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

  // URL-only pivot chips: kind / origPort / respPort / proto / window
  // live in `pivotOnly` state and are not represented in the
  // `EventListFilterInput`, so they don't flow through
  // `summarizeFilter`. Per-field filter chips (source, destination,
  // tag fields, direction, confidence, sensor, categoricals, period)
  // are produced by the shared summariser below.
  const pivotOnlyChips = useMemo<PivotChip[]>(
    () => buildPivotChips(pivotOnly, chipLabels),
    [pivotOnly, chipLabels],
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
  const hasChips =
    summarizedChips.length > 0 ||
    pivotOnlyChips.length > 0 ||
    endpointChips.length > 0;

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
    if (!hasQueried) {
      return {
        status: "empty-prequery",
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
  }, [
    events,
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
                {pivotOnlyChips.map((chip) => (
                  <li key={chip.id}>
                    <RemovableChip
                      prefix={chip.aggregate ? null : chip.label}
                      value={chip.value}
                      onRemove={() =>
                        handleRemovePivotOnlyChip(chip.field as PivotKey)
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
                      onActivate={() => openDrawer({ openEndpointPanel: true })}
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
            onRowOpen={handleRowOpen}
            onRowInvestigate={handleRowInvestigate}
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

      <QuickPeekInspector
        event={quickPeekEvent}
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
 * Quick peek inspector shell. Phase Detection-18 owns the full
 * contents; for v1 we render the compact summary the list row
 * already shows plus the "Open investigation" jump. The inspector
 * opens as an overlay drawer (`Sheet` from `radix-ui`) at every
 * viewport — the inline-dock split at ≥ desktop widths is a
 * polish follow-up tracked against Phase Detection-18.
 */
function QuickPeekInspector({
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
  const addressable = event ? isEventAddressable(event) : false;
  const endpointSummary = event ? formatEndpointSummary(event) : null;
  const kindLabel = event
    ? (EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename)
    : "";
  let timeLabel = "";
  if (event) {
    const d = new Date(event.time);
    timeLabel = Number.isNaN(d.getTime())
      ? labels.unknownTime
      : new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(d);
  }
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
        closeLabel={labels.errorRetry}
      >
        <SheetHeader>
          <SheetTitle>{kindLabel}</SheetTitle>
          <SheetDescription>{timeLabel}</SheetDescription>
        </SheetHeader>
        {event ? (
          <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
            <div className="flex items-center gap-2">
              <Badge
                variant={levelBadgeVariant(event.level)}
                className="uppercase"
              >
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
        ) : null}
      </SheetContent>
    </Sheet>
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
