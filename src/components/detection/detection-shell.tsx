"use client";

import { Bookmark, ChevronRight, SlidersHorizontal, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { startTransition, useCallback, useRef, useState } from "react";
import { runEventQuery } from "@/app/[locale]/(dashboard)/detection/actions";
import { Button } from "@/components/ui/button";
import type { Filter } from "@/lib/detection/filter";
import type { PeriodKey } from "@/lib/detection/period";
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
}

export function DetectionShell({
  title,
  labels,
  initialFilter,
  initialPeriod,
  initialResult,
}: DetectionShellProps) {
  const t = useTranslations("detection.filters");
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [committedFilter, setCommittedFilter] = useState<Filter>(initialFilter);
  const [committedPeriod, setCommittedPeriod] = useState<PeriodKey | null>(
    initialPeriod,
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

  const openDrawer = useCallback(() => {
    setDraft(
      (current) => current ?? filterToDraft(committedFilter, committedPeriod),
    );
    setDrawerOpen(true);
  }, [committedFilter, committedPeriod]);

  const handleApply = useCallback(
    (applied: FilterDrawerDraft) => {
      if (!applied.startIso || !applied.endIso) return;
      const structured = extractStructuredInput(committedFilter);
      const next: Filter = {
        mode: "structured",
        input: {
          ...structured,
          start: applied.startIso,
          end: applied.endIso,
        },
      };
      setCommittedFilter(next);
      setCommittedPeriod(applied.period);
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
            onClick={openDrawer}
          >
            <SlidersHorizontal className="size-4" />
            {labels.filtersOpen}
          </Button>
          <div
            role="toolbar"
            aria-label={labels.filtersOpen}
            className="text-muted-foreground flex min-h-8 flex-1 items-center rounded-md border border-dashed border-[var(--sidebar-border)] px-3 text-xs"
          >
            {activeChipText}
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
        />
      ) : null}
    </div>
  );
}

function filterToDraft(
  filter: Filter,
  period: PeriodKey | null,
): FilterDrawerDraft {
  const startIso = structuredStart(filter);
  const endIso = structuredEnd(filter);
  return {
    period,
    startLocal: isoToLocalInput(startIso),
    endLocal: isoToLocalInput(endIso),
    startIso,
    endIso,
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
