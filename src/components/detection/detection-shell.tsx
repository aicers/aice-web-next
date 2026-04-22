"use client";

import { Bookmark, ChevronRight, SlidersHorizontal, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { startTransition, useCallback, useRef, useState } from "react";
import { runEventQuery } from "@/app/[locale]/(dashboard)/detection/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildDirectionChips,
  type DirectionChip,
  type DirectionChipLabels,
  directionsForFilterInput,
  readDirectionsFromInput,
} from "@/lib/detection/direction";
import {
  buildEndpointChips,
  type EndpointChipLabels,
  type EndpointEntry,
  endpointsToEndpointInputs,
} from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import type { PeriodKey } from "@/lib/detection/period";
import type { FlowKind } from "@/lib/detection/types";
import type { PivotChip } from "@/lib/detection/url-filters";
import { cn } from "@/lib/utils";
import {
  FilterDrawer,
  type FilterDrawerDraft,
  type FilterDrawerLabels,
  isoToLocalInput,
} from "./filter-drawer";

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
  drawer: FilterDrawerLabels;
}

export interface DetectionShellInitialResult {
  totalCount: string | null;
  error: string | null;
}

interface DetectionShellProps {
  title: string;
  labels: DetectionShellLabels;
  initialFilter: Filter;
  initialPeriod: PeriodKey | null;
  initialResult: DetectionShellInitialResult;
  initialChips?: PivotChip[];
}

export function DetectionShell({
  title,
  labels,
  initialFilter,
  initialPeriod,
  initialResult,
  initialChips = [],
}: DetectionShellProps) {
  const t = useTranslations("detection.filters");
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
  const [draft, setDraft] = useState<FilterDrawerDraft | null>(null);

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

  const openDrawer = useCallback(
    (options?: { openEndpointPanel?: boolean }) => {
      setDraft(
        (current) =>
          current ??
          filterToDraft(committedFilter, committedPeriod, committedEndpoints),
      );
      setOpenEndpointPanelOnDrawerOpen(options?.openEndpointPanel ?? false);
      setDrawerOpen(true);
    },
    [committedFilter, committedPeriod, committedEndpoints],
  );

  const handleApply = useCallback(
    (applied: FilterDrawerDraft) => {
      if (!applied.startIso || !applied.endIso) return;
      const { directions: _ignored, ...structured } =
        extractStructuredInput(committedFilter);
      const directions = directionsForFilterInput(applied.directions);
      const endpoints = endpointsToEndpointInputs(applied.endpoints);
      const next: Filter = {
        mode: "structured",
        input: {
          ...structured,
          start: applied.startIso,
          end: applied.endIso,
          endpoints: endpoints.length > 0 ? endpoints : null,
          ...(directions ? { directions } : {}),
        },
      };
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
    [committedFilter, labels.resultsError],
  );

  const committedStart = structuredStart(committedFilter);
  const committedEnd = structuredEnd(committedFilter);
  const activeChipText = committedPeriod
    ? labels.drawer.periodOptions[committedPeriod]
    : committedStart && committedEnd
      ? t("activeRange", {
          start: isoToLocalInput(committedStart),
          end: isoToLocalInput(committedEnd),
        })
      : labels.activeChipsEmpty;
  const directionChips: DirectionChip[] = buildDirectionChips(
    structuredDirections(committedFilter),
    labels.directionChips,
  );
  const endpointChips = buildEndpointChips(
    committedEndpoints,
    labels.endpointChips,
  );
  const hasChips =
    initialChips.length > 0 ||
    directionChips.length > 0 ||
    endpointChips.length > 0;

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
              "flex min-h-8 flex-1 items-center gap-2 rounded-md border border-dashed border-[var(--sidebar-border)] px-3",
              !hasChips ? "text-muted-foreground text-xs" : "py-1",
            )}
          >
            {!hasChips ? (
              activeChipText
            ) : (
              <ul className="flex flex-wrap items-center gap-1.5">
                {initialChips.map((chip) => (
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
              </ul>
            )}
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
          labels={labels.drawer}
          openEndpointPanelOnOpen={openEndpointPanelOnDrawerOpen}
        />
      ) : null}
    </div>
  );
}

function filterToDraft(
  filter: Filter,
  period: PeriodKey | null,
  endpoints: EndpointEntry[],
): FilterDrawerDraft {
  const startIso = structuredStart(filter);
  const endIso = structuredEnd(filter);
  return {
    period,
    startLocal: isoToLocalInput(startIso),
    endLocal: isoToLocalInput(endIso),
    startIso,
    endIso,
    directions: readDirectionsFromInput(structuredDirections(filter)),
    endpoints,
  };
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
