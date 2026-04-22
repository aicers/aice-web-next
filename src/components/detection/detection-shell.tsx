"use client";

import { Bookmark, ChevronRight, SlidersHorizontal, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { startTransition, useCallback, useMemo, useRef, useState } from "react";
import { runEventQuery } from "@/app/[locale]/(dashboard)/detection/actions";
import {
  type FetchSensorsResult,
  fetchSensors,
} from "@/app/[locale]/(dashboard)/detection/sensor-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { FlowKind, LearningMethod } from "@/lib/detection/types";
import type { PivotChip } from "@/lib/detection/url-filters";
import { cn } from "@/lib/utils";
import {
  FilterDrawer,
  type FilterDrawerLabels,
  type FilterDrawerOptions,
} from "./filter-drawer";
import type { FilterMultiSelectLabels } from "./filter-multi-select";
import type {
  SensorMultiSelectState,
  SensorOption,
} from "./sensor-multi-select";

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
  drawer: FilterDrawerLabels;
  summarize: SummarizeFilterLabels;
}

export interface DetectionShellInitialResult {
  totalCount: string | null;
  error: string | null;
}

interface DetectionShellProps {
  title: string;
  labels: DetectionShellLabels;
  options: FilterDrawerOptions;
  initialFilter: Filter;
  initialPeriod: PeriodKey | null;
  initialResult: DetectionShellInitialResult;
  initialChips?: PivotChip[];
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
  initialChips = [],
}: DetectionShellProps) {
  const t = useTranslations("detection.filters");
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
  const [draft, setDraft] = useState<DetectionFilterDraft | null>(null);
  const [sensorCache, setSensorCache] = useState<SensorCache>({
    status: "idle",
  });

  const [totalCount, setTotalCount] = useState<string | null>(
    initialResult.totalCount,
  );
  const [resultError, setResultError] = useState<string | null>(
    initialResult.error,
  );
  const [loading, setLoading] = useState(false);
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
      setDrawerOpen(false);
      setLoading(true);
      setResultError(null);
      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      startTransition(async () => {
        try {
          const result = await runEventQuery(next);
          if (latestRequestIdRef.current !== requestId) return;
          if (result.ok) {
            setTotalCount(result.totalCount);
            setResultError(null);
          } else {
            setTotalCount(null);
            setResultError(labels.resultsError);
          }
        } catch {
          // A rejected invocation (transport error, serialization
          // failure, unexpected throw before the typed union is
          // returned) would otherwise leave `loading` true forever.
          if (latestRequestIdRef.current !== requestId) return;
          setTotalCount(null);
          setResultError(labels.resultsError);
        } finally {
          if (latestRequestIdRef.current === requestId) {
            setLoading(false);
          }
        }
      });
    },
    [committedFilter, labels.resultsError, options, sensorCache],
  );

  const { summary: activeChipText, chips: baseChips } = buildDetectionFilterBar(
    {
      filter: committedFilter,
      period: committedPeriod,
      pivotChips: initialChips,
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
        labels.drawer,
        multiSelectLabels,
      ),
    [committedFilter, options, labels.drawer, multiSelectLabels],
  );
  const hasChips =
    baseChips.length > 0 ||
    directionChips.length > 0 ||
    endpointChips.length > 0 ||
    sensorChips.length > 0 ||
    multiSelectChips.length > 0;

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
                {baseChips.map((chip) => (
                  <li key={chip.id}>
                    <Badge variant="secondary" className="font-normal">
                      <span className="text-muted-foreground mr-1 text-xs">
                        {chip.label}
                      </span>
                      <span className="text-foreground text-xs font-medium">
                        {chip.value}
                      </span>
                    </Badge>
                  </li>
                ))}
                {directionChips.map((chip) => (
                  <li key={chip.id}>
                    <Badge variant="secondary" className="font-normal">
                      <span className="text-muted-foreground mr-1 text-xs">
                        {chip.label}
                      </span>
                      <span className="text-foreground text-xs font-medium">
                        {chip.value}
                      </span>
                    </Badge>
                  </li>
                ))}
                {endpointChips.map((chip) => (
                  <li key={chip.id}>
                    {chip.aggregate ? (
                      <button
                        type="button"
                        onClick={() => openDrawer({ openEndpointPanel: true })}
                        className="focus-visible:ring-ring rounded-full focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <Badge
                          variant="secondary"
                          className="cursor-pointer font-normal"
                        >
                          <span className="text-foreground text-xs font-medium">
                            {chip.label}
                          </span>
                        </Badge>
                      </button>
                    ) : (
                      <Badge variant="secondary" className="font-normal">
                        <span className="text-foreground text-xs font-medium">
                          {chip.label}
                        </span>
                      </Badge>
                    )}
                  </li>
                ))}
                {sensorChips.map((chip) => (
                  <li key={chip.id}>
                    <Badge variant="secondary" className="font-normal">
                      <span className="text-muted-foreground mr-1 text-xs">
                        {chip.label}
                      </span>
                      <span className="text-foreground text-xs font-medium">
                        {chip.value}
                      </span>
                    </Badge>
                  </li>
                ))}
                {multiSelectChips.map((chip) => (
                  <li key={chip.key}>
                    <Badge variant="secondary" className="font-normal">
                      <span className="text-muted-foreground mr-1 text-xs">
                        {chip.label}
                      </span>
                      <span className="text-foreground text-xs font-medium">
                        {chip.value}
                      </span>
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {/* Results region (hero) */}
        <section
          aria-label={labels.resultsRegion}
          aria-live="polite"
          className="bg-card text-muted-foreground flex min-h-[60vh] flex-1 items-center justify-center rounded-lg border border-[var(--sidebar-border)] text-sm"
        >
          {loading
            ? labels.resultsLoading
            : resultError
              ? resultError
              : totalCount !== null
                ? t("resultsCount", { count: totalCount })
                : labels.resultsError}
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
          labels={labels.drawer}
          multiSelectLabels={multiSelectLabels}
          openEndpointPanelOnOpen={openEndpointPanelOnDrawerOpen}
          sensorOptions={sensorOptions}
          sensorState={sensorState}
          onSensorRetry={triggerSensorFetch}
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
  };
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
