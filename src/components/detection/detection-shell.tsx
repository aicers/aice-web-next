"use client";

import { Bookmark, SlidersHorizontal, Star } from "lucide-react";
import { startTransition, useCallback, useRef, useState } from "react";
import {
  type RunEventQueryResult,
  runEventQuery,
} from "@/app/[locale]/(dashboard)/detection/actions";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useRouter } from "@/i18n/navigation";
import type { Filter } from "@/lib/detection/filter";
import type { PeriodKey } from "@/lib/detection/period";
import type { Event } from "@/lib/detection/types";
import { encodeEventLocator } from "@/lib/events/event-locator";
import { cn } from "@/lib/utils";

import {
  ActiveFilterChipBar,
  type ActiveFilterChipBarLabels,
  buildSummarizeLabels,
} from "./active-filter-chip-bar";
import { EventList, type EventListLabels } from "./event-list";
import {
  FilterDrawer,
  type FilterDrawerDraft,
  type FilterDrawerLabels,
  isoToLocalInput,
} from "./filter-drawer";
import {
  QuickPeekInspector,
  type QuickPeekInspectorLabels,
} from "./quick-peek-inspector";

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
  list: EventListLabels;
  /**
   * Flat translation map fed to `buildSummarizeLabels`. Kept flat
   * so the page-level loader can hand `t(...)` outputs in directly
   * without re-shaping per call site.
   */
  chipBar: Parameters<typeof buildSummarizeLabels>[0];
  drawer: FilterDrawerLabels;
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
  const router = useRouter();
  // Tracks the desktop breakpoint defined in `globals.css`
  // (`--breakpoint-desktop: 1280px`). The Quick peek inspector is
  // rendered as an inline right-side pane at or above this width
  // (the list shrinks to make room); below it, the inspector falls
  // back to the Sheet overlay so the list keeps its full width.
  const isDesktop = useMediaQuery("(min-width: 1280px)");
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quickPeekEvent, setQuickPeekEvent] = useState<Event | null>(null);
  const quickPeekOpen = quickPeekEvent !== null;
  const quickPeekInline = isDesktop && quickPeekOpen;

  const [committedFilter, setCommittedFilter] = useState<Filter>(initialFilter);
  const [committedPeriod, setCommittedPeriod] = useState<PeriodKey | null>(
    initialPeriod,
  );
  const [draft, setDraft] = useState<FilterDrawerDraft | null>(null);

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
  const [loading, setLoading] = useState(false);
  // Monotonic id for the in-flight request; a late response whose id
  // no longer matches is dropped so the results region can't drift
  // away from the committed filter when the operator applies twice
  // in quick succession or a chip removal lands while a refresh is
  // still resolving.
  const latestRequestIdRef = useRef(0);

  const chipBarLabels: ActiveFilterChipBarLabels = buildSummarizeLabels(
    labels.chipBar,
  );

  const dispatchQuery = useCallback(
    (next: Filter) => {
      setLoading(true);
      setResultError(null);
      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      startTransition(async () => {
        let result: RunEventQueryResult;
        try {
          result = await runEventQuery(next);
        } catch {
          if (latestRequestIdRef.current !== requestId) return;
          setTotalCount(null);
          setEvents([]);
          setResultError(labels.resultsError);
          setLoading(false);
          return;
        }
        if (latestRequestIdRef.current !== requestId) return;
        if (result.ok) {
          setTotalCount(result.totalCount);
          setEvents(result.events);
          setCursors(result.cursors);
          setFetchedAt(result.fetchedAt);
          setResultError(null);
        } else {
          setTotalCount(null);
          setEvents([]);
          setCursors([]);
          setResultError(labels.resultsError);
        }
        setLoading(false);
      });
    },
    [labels.resultsError],
  );

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
      dispatchQuery(next);
    },
    [committedFilter, dispatchQuery],
  );

  const handleChipChange = useCallback(
    (next: Filter) => {
      setCommittedFilter(next);
      // Removing the period/range chip also clears the period
      // selection so the drawer doesn't lie about the current state.
      if (
        next.mode === "structured" &&
        (!next.input.start || !next.input.end)
      ) {
        setCommittedPeriod(null);
      }
      // Invalidate the drawer draft so the next open rebuilds it
      // from the newly committed filter. Otherwise a lingering
      // draft from a previously-closed-but-unapplied edit would
      // resurface and contradict what the chip bar / list now show.
      setDraft(null);
      dispatchQuery(next);
    },
    [dispatchQuery],
  );

  const handleRefresh = useCallback(() => {
    dispatchQuery(committedFilter);
  }, [committedFilter, dispatchQuery]);

  // The row affordance jumps to the full Investigation view. Events
  // without addressing can't be resolved by the locator decoder — the
  // encode helper returns null there and we silently no-op so the
  // operator doesn't land on an "Invalid event link" page. The token
  // is a base64url string so no further URL-encoding is needed.
  const handleOpenInvestigation = useCallback(
    (event: Event) => {
      const token = encodeEventLocator(event);
      if (!token) return;
      router.push(`/events/${token}?returnTo=%2Fdetection`);
    },
    [router],
  );

  const handleSelect = useCallback((event: Event) => {
    setQuickPeekEvent(event);
  }, []);

  const handleQuickPeekOpenChange = useCallback((open: boolean) => {
    if (!open) setQuickPeekEvent(null);
  }, []);

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
              onClick={openDrawer}
            >
              <SlidersHorizontal className="size-4" />
              {labels.filtersOpen}
            </Button>
            <ActiveFilterChipBar
              filter={committedFilter}
              labels={chipBarLabels}
              period={committedPeriod}
              onChange={handleChipChange}
              onChipFocus={() => openDrawer()}
            />
          </div>

          {/* Result list — the hero of the page. */}
          <EventList
            events={resultError ? [] : events}
            cursors={resultError ? [] : cursors}
            totalCount={totalCount}
            loading={loading}
            error={resultError}
            fetchedAt={fetchedAt}
            labels={labels.list}
            onRefresh={handleRefresh}
            onSelect={handleSelect}
            onOpenInvestigation={handleOpenInvestigation}
          />

          {/* Collapsible analytics strip (collapsed by default). */}
          <div className="rounded-lg border border-[var(--sidebar-border)]">
            <button
              type="button"
              onClick={() => setAnalyticsOpen((open) => !open)}
              aria-expanded={analyticsOpen}
              aria-controls="detection-analytics-panel"
              className="text-foreground flex w-full items-center gap-2 px-3 py-2 text-sm font-medium"
            >
              <span
                className={cn(
                  "inline-block size-2 rounded-sm border-r-2 border-b-2 border-current transition-transform",
                  analyticsOpen ? "rotate-45" : "-rotate-45",
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

        {/* Wide-viewport Quick peek: the inspector shares horizontal
            space with the list. Narrow viewports fall back to the
            Sheet overlay rendered below so the list keeps full
            width. */}
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
          labels={labels.drawer}
        />
      ) : null}

      {/* Narrow-viewport Quick peek: overlay Sheet. Explicitly kept
          closed when the inline pane owns rendering so the body
          doesn't mount twice. */}
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
