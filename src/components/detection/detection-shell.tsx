"use client";

import {
  Bookmark,
  ChevronRight,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition, useCallback, useMemo, useRef, useState } from "react";
import type {
  RunEventQueryOk,
  RunEventQueryResult,
} from "@/app/[locale]/(dashboard)/detection/actions";
import { runEventQuery } from "@/app/[locale]/(dashboard)/detection/actions";
import {
  type FetchSensorsResult,
  fetchSensors,
} from "@/app/[locale]/(dashboard)/detection/sensor-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  usePathname as useLocalePathname,
  useRouter as useLocaleRouter,
} from "@/i18n/navigation";
import { buildAppliedFilter } from "@/lib/detection/apply-filter";
import {
  type DirectionChipLabels,
  normalizeDirections,
  readDirectionsFromInput,
} from "@/lib/detection/direction";
import {
  type EndpointChipLabels,
  type EndpointEntry,
  endpointsToEndpointInputs,
} from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import type { ActiveFilterChip } from "@/lib/detection/filter-chips";
import {
  CONFIDENCE_DEFAULT_MAX,
  CONFIDENCE_DEFAULT_MIN,
  type DetectionFilterDraft,
  isoToLocalInput,
} from "@/lib/detection/filter-draft";
import {
  type FilterChipSpec,
  type SummarizeFilterLabels,
  summarizeFilter,
} from "@/lib/detection/filter-summary";
import type { PeriodKey } from "@/lib/detection/period";
import { urlParamsForCommitted } from "@/lib/detection/pivot-handoff";
import type { Event, FlowKind, LearningMethod } from "@/lib/detection/types";
import {
  buildDetectionSearchParams,
  type PivotChipLabels,
  type PivotFilterParams,
  type PivotKey,
  TAG_FIELDS,
  type TagField,
  TEXT_FIELDS,
} from "@/lib/detection/url-filters";
import { encodeEventLocator } from "@/lib/events/event-locator";
import { buildInvestigationReturnTo } from "@/lib/events/return-to";
import { cn } from "@/lib/utils";
import { EventList, type EventListLabels } from "./event-list";
import {
  type DrawerFocusField,
  FilterDrawer,
  type FilterDrawerLabels,
  type FilterDrawerOptions,
  type TagFieldLabel,
} from "./filter-drawer";
import type { FilterMultiSelectLabels } from "./filter-multi-select";
import {
  QuickPeekInspector,
  type QuickPeekInspectorLabels,
} from "./quick-peek-inspector";
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
  resultsError: string;
  analyticsToggle: string;
  analyticsShow: string;
  analyticsHide: string;
  analyticsPlaceholder: string;
  /** `Remove {label}` — accessible name for the per-chip × button. */
  removeChip: string;
  /** Prefix for the time-range chip body (e.g. `Period`). */
  periodChipLabel: string;
  directionChips: DirectionChipLabels;
  endpointChips: EndpointChipLabels;
  confidenceChipLabel: string;
  chipLabels: ChipLabelStrings;
  drawer: DrawerLabelStrings;
  /**
   * Minimal sensor-only label subset supplied by the server page.
   * The shell composes the full {@link SummarizeFilterLabels} locally
   * from the surrounding fields (direction / endpoint / pivot /
   * drawer period options / etc.) so the server→client payload
   * stays flat and serializable.
   */
  summarize: { sensor: string; sensorAggregate: string };
  list: EventListLabels;
  quickPeek: QuickPeekInspectorLabels;
}

export interface DetectionShellInitialResult {
  totalCount: string | null;
  error: string | null;
  events: Event[];
  /** Parallel-indexed Relay cursors for stable per-row keys. */
  cursors: (string | null)[];
  fetchedAt: string | null;
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
  // `pathname` from `next/navigation` carries the locale prefix —
  // that's what `window.history.replaceState` needs when it rewrites
  // the URL to match the committed filter, so the locale doesn't get
  // silently dropped.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Locale-aware navigation for jumping into the Investigation page:
  // `useLocaleRouter().push()` re-adds the current locale prefix, and
  // `useLocalePathname()` returns the locale-stripped path suitable
  // for the `returnTo` query param (the Investigation back-link is
  // rendered via the same locale-aware `<Link>`).
  const router = useLocaleRouter();
  const localePathname = useLocalePathname();
  // Tracks the desktop breakpoint defined in `globals.css`
  // (`--breakpoint-desktop: 1280px`). The Quick peek inspector is
  // rendered as an inline right-side pane at or above this width
  // (the list shrinks to make room); below it, the inspector falls
  // back to the Sheet overlay so the list keeps its full width.
  const isDesktop = useMediaQuery("(min-width: 1280px)");
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
  // Pivot-only params (kind/ports/proto/window) come from the URL and are
  // held as state so the `×` on those chips can clear them. They travel
  // with the committed filter via `mergePivotParams` below.
  const [committedPivotOnly, setCommittedPivotOnly] =
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
  const [events, setEvents] = useState<Event[]>(initialResult.events);
  const [cursors, setCursors] = useState<(string | null)[]>(
    initialResult.cursors,
  );
  const [fetchedAt, setFetchedAt] = useState<string | null>(
    initialResult.fetchedAt,
  );
  const [resultError, setResultError] = useState<string | null>(
    initialResult.error,
  );
  // Tracks whether a query has ever been dispatched for this tab.
  // Seeded from the server's initial fetch state: if the page
  // successfully pre-fetched (fetchedAt is set) or failed trying
  // (error is set), a query has run; otherwise — e.g. future
  // Phase Detection-10 `+` tab that mounts without auto-execute —
  // the list renders its pre-query guidance state.
  const [hasQueried, setHasQueried] = useState<boolean>(
    initialResult.fetchedAt !== null || initialResult.error !== null,
  );
  const [loading, setLoading] = useState(false);
  const [quickPeekEvent, setQuickPeekEvent] = useState<Event | null>(null);
  const quickPeekOpen = quickPeekEvent !== null;
  const quickPeekInline = isDesktop && quickPeekOpen;
  // Monotonic id for the in-flight query; a late response whose id
  // no longer matches is dropped so the results region can't drift
  // away from the committed filter when the operator applies twice
  // in quick succession or a chip removal lands while a refresh is
  // still resolving.
  const latestRequestIdRef = useRef(0);

  // Kicks off a sensor-list fetch and threads the result into the
  // session cache.
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

  const applyResult = useCallback(
    (requestId: number, result: RunEventQueryOk) => {
      if (latestRequestIdRef.current !== requestId) return;
      setTotalCount(result.totalCount);
      setEvents(result.events);
      setCursors(result.cursors);
      setFetchedAt(result.fetchedAt);
      setResultError(null);
    },
    [],
  );

  const applyError = useCallback(
    (requestId: number) => {
      if (latestRequestIdRef.current !== requestId) return;
      setTotalCount(null);
      setEvents([]);
      setCursors([]);
      setResultError(labels.resultsError);
    },
    [labels.resultsError],
  );

  /**
   * Dispatch a new query for `next` and update the results region.
   *
   * `period` is threaded through explicitly rather than read from
   * `committedPeriod` state: chip-removal paths clear the period
   * synchronously via `setCommittedPeriod(null)` but the committed
   * state doesn't update until the next render, so a stale period
   * would otherwise leak into the URL rewrite. Callers pass the
   * period they're about to commit.
   *
   * The URL rewrite goes through {@link urlParamsForCommitted} so
   * `kinds` (single-valued) and the period ride along as `kind=` /
   * `window=`. Without that, a `Refresh` click after landing on
   * `/detection?kind=HttpThreat&window=7d` would rewrite the URL
   * back to a bare `/detection`, breaking reload / share / the
   * Investigation `returnTo` round-trip.
   */
  const dispatchQuery = useCallback(
    (next: Filter, pivotOnly: PivotFilterParams, period: PeriodKey | null) => {
      setLoading(true);
      setResultError(null);
      setHasQueried(true);

      if (next.mode === "structured") {
        const merged = urlParamsForCommitted(next.input, period, pivotOnly);
        const qs = buildDetectionSearchParams(merged).toString();
        const url = qs ? `${pathname}?${qs}` : pathname;
        window.history.replaceState(window.history.state, "", url);
      }

      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      startTransition(async () => {
        let result: RunEventQueryResult;
        try {
          result = await runEventQuery(next);
        } catch {
          applyError(requestId);
          if (latestRequestIdRef.current === requestId) setLoading(false);
          return;
        }
        if (latestRequestIdRef.current !== requestId) return;
        if (result.ok) {
          applyResult(requestId, result);
        } else {
          applyError(requestId);
        }
        if (latestRequestIdRef.current === requestId) setLoading(false);
      });
    },
    [applyError, applyResult, pathname],
  );

  // Shared open path for every drawer entry point (Filters button,
  // endpoint chip body, field-focused chip body). Keeping the entry-
  // point side effects — sensor bootstrap and endpoint-panel reset —
  // in one place stops them from drifting across paths: otherwise a
  // stale `openEndpointPanelOnDrawerOpen` from a prior Network/IP
  // chip leaks into the next `Period`/`Direction` chip open, and
  // chip-body activation can skip the sensor fetch so Sensor stays
  // pinned to its disabled loading state on a fresh load.
  const openDrawerInternal = useCallback(
    (opts: {
      focusField: DrawerFocusField | null;
      openEndpointPanel: boolean;
      incrementFocusToken: boolean;
    }) => {
      setDraft(
        (current) =>
          current ??
          filterToDraft(committedFilter, committedPeriod, committedEndpoints),
      );
      setOpenEndpointPanelOnDrawerOpen(opts.openEndpointPanel);
      setFocusField(opts.focusField);
      if (opts.incrementFocusToken) setFocusToken((t) => t + 1);
      setDrawerOpen(true);
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

  const openDrawer = useCallback(
    (opts?: { openEndpointPanel?: boolean }) => {
      openDrawerInternal({
        focusField: null,
        openEndpointPanel: opts?.openEndpointPanel ?? false,
        incrementFocusToken: false,
      });
    },
    [openDrawerInternal],
  );

  const handleApply = useCallback(
    (applied: DetectionFilterDraft) => {
      // A fully-cleared time range (both ISO fields null) is a valid
      // committed state — the operator removed the Period chip and is
      // now editing other fields. Reject only asymmetric pairs, which
      // the drawer also guards against; they shouldn't reach us.
      if (Boolean(applied.startIso) !== Boolean(applied.endIso)) return;
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
      setDraft(applied);
      setDrawerOpen(false);
      dispatchQuery(next, committedPivotOnly, applied.period);
    },
    [committedFilter, committedPivotOnly, dispatchQuery, options, sensorCache],
  );

  const openDrawerFocused = useCallback(
    (field: DrawerFocusField | PivotKey) => {
      openDrawerInternal({
        focusField: isDrawerFocusField(field) ? field : null,
        openEndpointPanel: false,
        incrementFocusToken: true,
      });
    },
    [openDrawerInternal],
  );

  const handleRefresh = useCallback(() => {
    dispatchQuery(committedFilter, committedPivotOnly, committedPeriod);
  }, [committedFilter, committedPeriod, committedPivotOnly, dispatchQuery]);

  const handleSelect = useCallback((event: Event) => {
    setQuickPeekEvent(event);
  }, []);

  const handleQuickPeekOpenChange = useCallback((open: boolean) => {
    if (!open) setQuickPeekEvent(null);
  }, []);

  // The row affordance jumps to the full Investigation view. Events
  // without addressing can't be resolved by the locator decoder — the
  // encode helper returns null there and we silently no-op so the
  // operator doesn't land on an "Invalid event link" page.
  //
  // `returnTo` is built from the current locale-stripped pathname
  // plus the active URL search params so the Investigation back-link
  // round-trips to the same filtered tab the operator came from,
  // rather than a bare `/detection` that drops their filter state
  // (and on non-default locales drops the locale too). The back-link
  // on Investigation renders through the locale-aware `<Link>`, so
  // the path we stash here must be locale-free.
  const handleOpenInvestigation = useCallback(
    (event: Event) => {
      const token = encodeEventLocator(event);
      if (!token) return;
      const returnTo = buildInvestigationReturnTo(
        localePathname,
        searchParams?.toString() ?? "",
      );
      router.push(`/events/${token}?returnTo=${encodeURIComponent(returnTo)}`);
    },
    [router, localePathname, searchParams],
  );

  // ─────────── Chip removal handlers ───────────

  const applyFilterChange = useCallback(
    (nextFilter: Filter, nextPivotOnly?: PivotFilterParams) => {
      const pivotOnly = nextPivotOnly ?? committedPivotOnly;
      setCommittedFilter(nextFilter);
      // Removing the period/range chip also clears the period
      // selection so the drawer doesn't lie about the current state.
      // Compute the next period locally so `dispatchQuery` sees the
      // cleared value — the `setCommittedPeriod` above hasn't flushed
      // yet and the `committedPeriod` closure would carry the stale
      // value into the URL rewrite.
      const periodCleared =
        nextFilter.mode === "structured" &&
        (!nextFilter.input.start || !nextFilter.input.end);
      if (periodCleared) {
        setCommittedPeriod(null);
      }
      if (nextPivotOnly) {
        setCommittedPivotOnly(nextPivotOnly);
      }
      // Invalidate the drawer draft so the next open rebuilds from
      // the newly committed filter.
      setDraft(null);
      dispatchQuery(
        nextFilter,
        pivotOnly,
        periodCleared ? null : committedPeriod,
      );
    },
    [committedPeriod, committedPivotOnly, dispatchQuery],
  );

  const removeStructuredField = useCallback(
    (
      updater: (
        input: import("@/lib/detection").EventListFilterInput,
      ) => import("@/lib/detection").EventListFilterInput,
    ) => {
      if (committedFilter.mode !== "structured") return;
      const nextInput = updater(committedFilter.input);
      applyFilterChange({ mode: "structured", input: nextInput });
    },
    [applyFilterChange, committedFilter],
  );

  const removePivotOnlyField = useCallback(
    (field: "kind" | "origPort" | "respPort" | "proto" | "window") => {
      const next = { ...committedPivotOnly };
      delete next[field];
      setCommittedPivotOnly(next);
      dispatchQuery(committedFilter, next, committedPeriod);
    },
    [committedFilter, committedPeriod, committedPivotOnly, dispatchQuery],
  );

  const removePivotChip = useCallback(
    (chip: { field: PivotKey; aggregate: boolean; value: string }) => {
      const field = chip.field;
      // Pivot-only fields live in committedPivotOnly, not in the filter.
      if (
        field === "kind" ||
        field === "origPort" ||
        field === "respPort" ||
        field === "proto" ||
        field === "window"
      ) {
        removePivotOnlyField(field);
        return;
      }
      if (field === "source" || field === "destination") {
        removeStructuredField((input) => {
          const { [field]: _removed, ...rest } = input;
          return rest;
        });
        return;
      }
      // Tag fields: aggregate chip clears the whole array;
      // individual chip removes the single value.
      const tagField = field as TagField;
      removeStructuredField((input) => {
        const current = input[tagField];
        if (!Array.isArray(current) || current.length === 0) return input;
        if (chip.aggregate) {
          const { [tagField]: _removed, ...rest } = input;
          return rest;
        }
        const filtered = current.filter((v) => v !== chip.value);
        if (filtered.length === 0) {
          const { [tagField]: _removed, ...rest } = input;
          return rest;
        }
        return { ...input, [tagField]: filtered };
      });
    },
    [removePivotOnlyField, removeStructuredField],
  );

  const removeConfidenceChip = useCallback(() => {
    removeStructuredField((input) => {
      const { confidenceMin: _a, confidenceMax: _b, ...rest } = input;
      return rest;
    });
  }, [removeStructuredField]);

  // Removing the Period chip clears the active time window: `start` /
  // `end` come off the filter input, `applyFilterChange()` observes
  // `periodCleared` and drops `committedPeriod` to null. The list then
  // runs without a time constraint until the operator reopens the
  // drawer and picks a period / range.
  const removePeriodChip = useCallback(() => {
    removeStructuredField((input) => {
      const { start: _s, end: _e, ...rest } = input;
      return rest;
    });
  }, [removeStructuredField]);

  const removeDirectionChip = useCallback(
    (kind: FlowKind) => {
      removeStructuredField((input) => {
        const current = input.directions;
        if (!current || current.length === 0) return input;
        const next = normalizeDirections(current.filter((k) => k !== kind));
        if (next.length === 0) {
          const { directions: _removed, ...rest } = input;
          return rest;
        }
        return { ...input, directions: next };
      });
    },
    [removeStructuredField],
  );

  const removeEndpointChip = useCallback(
    (entryId: string | null) => {
      // Aggregate chip (entryId === null) clears every endpoint; an
      // individual chip removes one entry.
      const nextEntries =
        entryId === null
          ? []
          : committedEndpoints.filter((e) => e.id !== entryId);
      setCommittedEndpoints(nextEntries);
      // Rebuild `input.endpoints` from the new selection so the
      // committed filter reflects the chip removal. Without this,
      // single-entry removal would leave the prior `endpoints` array
      // on `input` and the re-dispatched query would still be
      // constrained by the removed rule.
      const nextEndpoints = endpointsToEndpointInputs(nextEntries);
      removeStructuredField((input) => {
        if (nextEndpoints.length === 0) {
          const { endpoints: _removed, ...rest } = input;
          return rest;
        }
        return { ...input, endpoints: nextEndpoints };
      });
    },
    [committedEndpoints, removeStructuredField],
  );

  const removeSensorChip = useCallback(
    (sensorId: string | null) => {
      removeStructuredField((input) => {
        if (sensorId === null) {
          const { sensors: _removed, ...rest } = input;
          return rest;
        }
        const current = input.sensors ?? [];
        const filtered = current.filter((id) => id !== sensorId);
        if (filtered.length === 0) {
          const { sensors: _removed, ...rest } = input;
          return rest;
        }
        return { ...input, sensors: filtered };
      });
    },
    [removeStructuredField],
  );

  type MultiSelectFieldKey =
    | "levels"
    | "countries"
    | "learningMethods"
    | "categories"
    | "kinds";

  const removeMultiSelectChip = useCallback(
    (chip: ActiveFilterChip) => {
      const fieldKey = chip.fieldKey as MultiSelectFieldKey;
      removeStructuredField((input) => {
        if (chip.aggregate) {
          const next = { ...input };
          delete next[fieldKey];
          return next;
        }
        // Individual chip: chip.value is a label, but the `key` carries
        // the raw value as `${fieldKey}:${value}`.
        const raw = chip.key.slice(fieldKey.length + 1);
        if (fieldKey === "levels" || fieldKey === "categories") {
          const current = (input[fieldKey] ?? []) as number[];
          const parsed = Number.parseInt(raw, 10);
          const filtered = current.filter((v) => v !== parsed);
          const next = { ...input };
          if (filtered.length === 0) delete next[fieldKey];
          else next[fieldKey] = filtered;
          return next;
        }
        if (fieldKey === "learningMethods") {
          const current = (input.learningMethods ?? []) as LearningMethod[];
          const filtered = current.filter((v) => v !== raw);
          const next = { ...input };
          if (filtered.length === 0) delete next.learningMethods;
          else next.learningMethods = filtered;
          return next;
        }
        // countries / kinds: string[]
        const current = (input[fieldKey] ?? []) as string[];
        const filtered = current.filter((v) => v !== raw);
        const next = { ...input };
        if (filtered.length === 0) delete next[fieldKey];
        else next[fieldKey] = filtered;
        return next;
      });
    },
    [removeStructuredField],
  );

  // ─────────── Compose labels for builders ───────────

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

  const sensorOptions: readonly SensorOption[] =
    sensorCache.status === "loaded" ? sensorCache.options : [];
  const sensorState = sensorStateForCache(sensorCache);

  // Single entry point: `summarizeFilter` turns the abstract `Filter`
  // into the full set of chip specs the bar renders, plus the
  // `timeSummary` / `hasTimeChip` pair used to drive the period
  // affordance. Before this helper, the shell assembled the bar
  // through five parallel builders — direction / endpoint / pivot /
  // confidence / sensor / multi-select — which meant the aggregation
  // rule lived in five files at once. Keeping the orchestration in
  // `filter-summary.ts` makes the rule reusable everywhere chips
  // appear, as the Phase Detection-9 spec requires.
  const summarizeLabels = useMemo<SummarizeFilterLabels>(
    () => ({
      activeEmpty: labels.activeChipsEmpty,
      periodLabel: labels.periodChipLabel,
      periodOptions: labels.drawer.periodOptions,
      formatRange: ({ start, end }) => t("activeRange", { start, end }),
      confidenceLabel: labels.confidenceChipLabel,
      directionChips: labels.directionChips,
      endpointChips: labels.endpointChips,
      sensor: labels.summarize.sensor,
      sensorAggregate: labels.summarize.sensorAggregate,
      pivot: chipLabels,
      multiSelectFields: labels.drawer.fields,
      multiSelectLabels,
    }),
    [
      chipLabels,
      labels.activeChipsEmpty,
      labels.confidenceChipLabel,
      labels.directionChips,
      labels.drawer.fields,
      labels.drawer.periodOptions,
      labels.endpointChips,
      labels.periodChipLabel,
      labels.summarize.sensor,
      labels.summarize.sensorAggregate,
      multiSelectLabels,
      t,
    ],
  );

  const summary = useMemo(
    () =>
      summarizeFilter(
        {
          filter: committedFilter,
          period: committedPeriod,
          endpoints: committedEndpoints,
          pivotOnly: committedPivotOnly,
          sensorOptions,
          drawerOptions: options,
        },
        summarizeLabels,
      ),
    [
      committedEndpoints,
      committedFilter,
      committedPeriod,
      committedPivotOnly,
      options,
      sensorOptions,
      summarizeLabels,
    ],
  );
  const { chips: chipSpecs, timeSummary, hasTimeChip } = summary;
  const hasChips = chipSpecs.length > 0;

  const makeRemoveLabel = useCallback(
    (chipValue: string): string =>
      labels.removeChip.replace("{label}", chipValue),
    [labels.removeChip],
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

      <section className="flex min-w-0 flex-1 gap-4">
        <h1 className="sr-only">{title}</h1>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
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
                !hasChips && !hasTimeChip
                  ? "text-muted-foreground text-xs"
                  : "py-1",
              )}
            >
              {/* The empty placeholder only stands in when the bar has
                  no chips at all — including the period chip. Showing
                  it whenever the time chip is cleared would print "No
                  filter applied." next to the surviving chips after a
                  Period removal, contradicting the active filter. */}
              {!hasTimeChip && !hasChips ? (
                <span className="text-muted-foreground text-xs">
                  {timeSummary}
                </span>
              ) : null}
              {hasTimeChip || hasChips ? (
                <ul className="flex flex-wrap items-center gap-1.5">
                  {hasTimeChip ? (
                    <li key="period">
                      <Badge
                        variant="secondary"
                        className="flex items-center gap-1 font-normal"
                      >
                        <ChipBody
                          label={labels.periodChipLabel}
                          value={timeSummary}
                          onActivate={() => openDrawerFocused("timeRange")}
                        />
                        <ChipRemoveButton
                          label={makeRemoveLabel(timeSummary)}
                          onClick={removePeriodChip}
                        />
                      </Badge>
                    </li>
                  ) : null}
                  {chipSpecs.map((chip) => (
                    <li key={chip.id} className="flex items-center">
                      <Badge
                        variant="secondary"
                        className="flex items-center gap-1 font-normal"
                      >
                        {renderChipBody(chip, openDrawer, openDrawerFocused)}
                        {renderChipRemove(
                          chip,
                          makeRemoveLabel,
                          removeConfidenceChip,
                          removePivotChip,
                          removeDirectionChip,
                          removeEndpointChip,
                          removeSensorChip,
                          removeMultiSelectChip,
                        )}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          {/* Result list — the hero of the page. */}
          <EventList
            events={resultError ? [] : events}
            cursors={resultError ? [] : cursors}
            totalCount={totalCount}
            loading={loading}
            error={resultError}
            fetchedAt={fetchedAt}
            hasQueried={hasQueried}
            labels={labels.list}
            onRefresh={handleRefresh}
            onSelect={handleSelect}
            onOpenInvestigation={handleOpenInvestigation}
          />

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
        </div>

        {quickPeekInline ? (
          <QuickPeekInspector
            event={quickPeekEvent}
            open
            inline
            onOpenChange={handleQuickPeekOpenChange}
            onOpenInvestigation={handleOpenInvestigation}
            labels={labels.quickPeek}
          />
        ) : null}
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

      {/* Narrow-viewport Quick peek: overlay Sheet. */}
      <QuickPeekInspector
        event={quickPeekEvent}
        open={quickPeekOpen && !isDesktop}
        onOpenChange={handleQuickPeekOpenChange}
        onOpenInvestigation={handleOpenInvestigation}
        labels={labels.quickPeek}
      />
    </div>
  );
}

/**
 * Chip body: the label+value block that sits to the left of the `×`
 * button. When {@link onActivate} is supplied the block becomes a
 * button that reopens the filter drawer focused on the chip's field;
 * otherwise it renders as static spans. Every chip in the active
 * filter bar should pass an `onActivate` — the contract is that the
 * body is editable and only the `×` removes — but the optional form
 * keeps the helper safe for chips whose owning field doesn't have a
 * drawer control yet (e.g. pivot-only fields coming from the URL).
 */
function ChipBody({
  label,
  value,
  onActivate,
}: {
  label?: string;
  value: string;
  onActivate?: () => void;
}) {
  const content = (
    <>
      {label ? (
        <span className="text-muted-foreground text-xs">{label}</span>
      ) : null}
      <span className="text-foreground text-xs font-medium">{value}</span>
    </>
  );
  if (!onActivate) {
    return <span className="inline-flex items-center gap-1">{content}</span>;
  }
  return (
    <button
      type="button"
      onClick={onActivate}
      className="focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded focus-visible:ring-2 focus-visible:outline-none"
    >
      {content}
    </button>
  );
}

function ChipRemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground h-5 px-1"
    >
      <X className="size-3" aria-hidden="true" />
    </Button>
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

const FOCUSABLE_FIELDS = new Set<string>([
  ...TEXT_FIELDS,
  ...TAG_FIELDS,
  "timeRange",
  "directions",
  "confidence",
  "sensors",
  "levels",
  "countries",
  "learningMethods",
  "categories",
  "kinds",
]);

function isDrawerFocusField(field: string): field is DrawerFocusField {
  return FOCUSABLE_FIELDS.has(field);
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

/**
 * Render the label+value portion of a chip, dispatched by the
 * discriminated `kind` from `summarizeFilter`. Pivot aggregate chips
 * omit the label prefix because the aggregate value already
 * embeds it (e.g. `Keywords: 7`). All other chips show `label · value`.
 */
function renderChipBody(
  chip: FilterChipSpec,
  openDrawer: (opts?: { openEndpointPanel?: boolean }) => void,
  openDrawerFocused: (field: DrawerFocusField | PivotKey) => void,
): React.ReactNode {
  switch (chip.kind) {
    case "pivot": {
      const focusKey = isDrawerFocusField(chip.field)
        ? (chip.field as DrawerFocusField)
        : null;
      const onActivate = focusKey
        ? () => openDrawerFocused(focusKey)
        : () => openDrawerFocused(chip.field);
      // Aggregate pivot chips fold the label into the value
      // (e.g. `Keywords: 7`), so the ChipBody only renders the
      // value — duplicating the prefix would read as `Keywords
      // Keywords: 7`.
      if (chip.aggregate) {
        return <ChipBody value={chip.value} onActivate={onActivate} />;
      }
      return (
        <ChipBody
          label={chip.label}
          value={chip.value}
          onActivate={onActivate}
        />
      );
    }
    case "confidence":
      return (
        <ChipBody
          label={chip.label}
          value={chip.value}
          onActivate={() => openDrawerFocused("confidence")}
        />
      );
    case "direction":
      return (
        <ChipBody
          label={chip.label}
          value={chip.value}
          onActivate={() => openDrawerFocused("directions")}
        />
      );
    case "endpoint":
      return (
        <ChipBody
          value={chip.value}
          onActivate={() => openDrawer({ openEndpointPanel: true })}
        />
      );
    case "sensor":
      return (
        <ChipBody
          label={chip.label}
          value={chip.value}
          onActivate={() => openDrawerFocused("sensors")}
        />
      );
    case "multiSelect":
      return (
        <ChipBody
          label={chip.label}
          value={chip.value}
          onActivate={() =>
            openDrawerFocused(chip.fieldKey as DrawerFocusField)
          }
        />
      );
    // The `period` branch is rendered separately at the top of the
    // chip list; it never reaches here because `summarizeFilter`
    // surfaces the period via `timeSummary` / `hasTimeChip` rather
    // than emitting a `period` chip spec.
    case "period":
      return (
        <ChipBody
          label={chip.label}
          value={chip.value}
          onActivate={() => openDrawerFocused("timeRange")}
        />
      );
  }
}

/**
 * Render the × affordance for a chip. The period chip is rendered
 * inline above the chip list with its own `ChipRemoveButton` (the
 * `period` branch of the discriminated union is kept here only for
 * exhaustiveness and is never exercised — `summarizeFilter` surfaces
 * the time window via `timeSummary` / `hasTimeChip`, not as a chip
 * spec pushed into `chips`).
 */
function renderChipRemove(
  chip: FilterChipSpec,
  makeRemoveLabel: (chipValue: string) => string,
  removeConfidenceChip: () => void,
  removePivotChip: (pivot: {
    field: PivotKey;
    aggregate: boolean;
    value: string;
  }) => void,
  removeDirectionChip: (flow: FlowKind) => void,
  removeEndpointChip: (entryId: string | null) => void,
  removeSensorChip: (sensorId: string | null) => void,
  removeMultiSelectChip: (chip: ActiveFilterChip) => void,
): React.ReactNode {
  switch (chip.kind) {
    case "period":
      return null;
    case "confidence":
      return (
        <ChipRemoveButton
          label={makeRemoveLabel(chip.value)}
          onClick={removeConfidenceChip}
        />
      );
    case "pivot":
      return (
        <ChipRemoveButton
          label={makeRemoveLabel(chip.value)}
          onClick={() =>
            removePivotChip({
              field: chip.field,
              aggregate: chip.aggregate,
              value: chip.value,
            })
          }
        />
      );
    case "direction":
      return (
        <ChipRemoveButton
          label={makeRemoveLabel(chip.value)}
          onClick={() => removeDirectionChip(chip.flow)}
        />
      );
    case "endpoint":
      return (
        <ChipRemoveButton
          label={makeRemoveLabel(chip.value)}
          onClick={() => removeEndpointChip(chip.entryId)}
        />
      );
    case "sensor":
      return (
        <ChipRemoveButton
          label={makeRemoveLabel(chip.value)}
          onClick={() => removeSensorChip(chip.sensorId)}
        />
      );
    case "multiSelect":
      return (
        <ChipRemoveButton
          label={makeRemoveLabel(chip.value)}
          onClick={() => removeMultiSelectChip(chip.chip)}
        />
      );
  }
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
