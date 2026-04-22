"use client";

import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { Event } from "@/lib/detection/types";
import { cn } from "@/lib/utils";

import { EventRow, type EventRowLabels } from "./event-row";

export interface EventListLabels extends EventRowLabels {
  /** Accessible name for the result list section. */
  region: string;
  /** Text shown in the loading placeholder before any rows render. */
  loading: string;
  /**
   * Fallback header label used before any query has run (no
   * `totalCount` available yet). Once a query lands — even one
   * that returns zero results — the header switches to
   * `headerCountKnown` so the operator still sees a count.
   */
  headerCount: string;
  /**
   * `Detected Events {range} / {total}` template — `{total}` is
   * the BigInt-safe `StringNumber` so we never coerce to `number`,
   * and `{range}` is produced locally from the current page bounds
   * (see `headerCountRange`) so it stays in sync with pagination
   * when that lands.
   */
  headerCountKnown: string;
  /**
   * `{start}-{end}` template for the range token inside
   * `headerCountKnown`. Kept as a separate message so locales that
   * prefer a different separator (e.g. em-dash, CJK wave dash) can
   * override it without touching the outer sentence.
   */
  headerCountRange: string;
  downloadCsv: string;
  downloadCsvComingSoon: string;
  refresh: string;
  /** `Updated {relative}` template. */
  updatedRelative: string;
  /** Relative-time bucket "just now" (last 60 s). */
  updatedJustNow: string;
  /** Relative-time bucket when no fetch has happened yet. */
  updatedNever: string;
  emptyTitle: string;
  emptyBody: string;
}

interface EventListProps {
  /**
   * The current page's events. Empty array means "query returned
   * zero results" — the empty state renders. `null` is reserved for
   * loading.
   */
  events: Event[] | null;
  /**
   * Parallel-indexed Relay cursors (one per event). Used as the
   * stable React key so reconciliation doesn't collapse distinct
   * events that happen to share `__typename|time|sensor|addressing`
   * (host-based events with no addressing, or honest duplicates).
   * Each entry may be `null` if the server ever omits a cursor; the
   * key helper falls back to a composite for those rows.
   */
  cursors: (string | null)[];
  /**
   * BigInt-safe total result count. `null` when no successful query
   * has run yet — the count cell renders `—` in that case.
   */
  totalCount: string | null;
  loading: boolean;
  error: string | null;
  /** ISO-8601 UTC timestamp of the last successful fetch, or null. */
  fetchedAt: string | null;
  labels: EventListLabels;
  onRefresh: () => void;
  onSelect?: (event: Event) => void;
  onOpenInvestigation?: (event: Event) => void;
}

/**
 * The result list region — the hero of the Detection page.
 *
 * Renders a header row (count + range, Download CSV, Updated /
 * Refresh), then a scrollable list of `EventRow` entries, an empty
 * state, or an error state. The component owns no filter state of
 * its own; the parent shell drives the data.
 */
export function EventList({
  events,
  cursors,
  totalCount,
  loading,
  error,
  fetchedAt,
  labels,
  onRefresh,
  onSelect,
  onOpenInvestigation,
}: EventListProps) {
  const visibleCount = events?.length ?? 0;
  const headerCount = formatHeaderCount(
    events === null ? null : totalCount,
    visibleCount,
    labels,
  );
  const updated = useRelativeTime(fetchedAt, labels);

  return (
    <section
      aria-label={labels.region}
      aria-busy={loading || undefined}
      className="bg-card flex min-h-[60vh] flex-1 flex-col rounded-lg border border-[var(--sidebar-border)]"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--sidebar-border)] px-3 py-2 sm:px-4">
        <h2 className="text-foreground text-sm font-semibold">{headerCount}</h2>
        <div className="text-muted-foreground ml-auto flex items-center gap-3 text-xs">
          <span aria-live="polite">{updated}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            aria-label={labels.refresh}
            disabled={loading}
            className="px-2"
          >
            <RefreshCw
              className={cn("size-4", loading && "animate-spin")}
              aria-hidden="true"
            />
            <span className="sr-only sm:not-sr-only">{labels.refresh}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            aria-disabled="true"
            aria-label={labels.downloadCsv}
            title={labels.downloadCsvComingSoon}
            className="px-2 sm:px-3"
          >
            <Download className="size-4" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">{labels.downloadCsv}</span>
          </Button>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        aria-live="polite"
        aria-relevant="additions removals"
      >
        {error ? (
          <ListPlaceholder>
            <p className="text-destructive text-sm font-medium">{error}</p>
          </ListPlaceholder>
        ) : events === null || (loading && visibleCount === 0) ? (
          <ListPlaceholder>
            <p className="text-muted-foreground text-sm">{labels.loading}</p>
          </ListPlaceholder>
        ) : events.length === 0 ? (
          <ListPlaceholder>
            <p className="text-foreground text-sm font-medium">
              {labels.emptyTitle}
            </p>
            <p className="text-muted-foreground text-xs">{labels.emptyBody}</p>
          </ListPlaceholder>
        ) : (
          <ul className="flex flex-col">
            {events.map((event, index) => (
              <EventRow
                key={rowKey(cursors[index], event, index)}
                event={event}
                labels={labels}
                onSelect={onSelect}
                onOpenInvestigation={onOpenInvestigation}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Build the header label. v1 ships without pagination (explicit
 * non-goal), so `{start}` is hardcoded: 1 when there are rows, 0
 * when the query returned zero results. A zero-result query still
 * carries information (we know the filter matched nothing), so the
 * header keeps the `<range> / <total>` form rather than falling back
 * to the bare label. When pagination lands we pass `rangeStart`
 * through from the edge cursors instead.
 */
export function formatHeaderCount(
  totalCount: string | null,
  visibleCount: number,
  labels: Pick<
    EventListLabels,
    "headerCount" | "headerCountKnown" | "headerCountRange"
  >,
): string {
  if (totalCount === null) return labels.headerCount;
  const range = labels.headerCountRange
    .replace("{start}", visibleCount > 0 ? "1" : "0")
    .replace("{end}", String(visibleCount));
  return labels.headerCountKnown
    .replace("{range}", range)
    .replace("{total}", totalCount);
}

function ListPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-1 px-4 py-12 text-center">
      {children}
    </div>
  );
}

/**
 * Tick once a minute so the "Updated …" string stays current
 * without refetching. Returns the localised relative phrase.
 */
function useRelativeTime(
  fetchedAt: string | null,
  labels: Pick<
    EventListLabels,
    "updatedRelative" | "updatedJustNow" | "updatedNever"
  >,
): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!fetchedAt) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, [fetchedAt]);
  if (!fetchedAt)
    return labels.updatedRelative.replace("{relative}", labels.updatedNever);
  const diffMs = Date.now() - Date.parse(fetchedAt);
  return labels.updatedRelative.replace(
    "{relative}",
    relativePhrase(diffMs, labels.updatedJustNow),
  );
}

/**
 * Stable React key for an event. Prefers the opaque Relay `cursor`
 * the server hands back per edge — that's a unique identity across
 * the page. Falls back to a composite of discriminating fields only
 * if a cursor ever comes back `null` (host-based events with no
 * addressing would otherwise collapse onto the same key, and React
 * would recycle DOM/state across distinct events). The `index`
 * suffix in the fallback keeps sibling rows keyed apart even when
 * the composite still collides.
 */
function rowKey(
  cursor: string | null | undefined,
  event: Event,
  index: number,
): string {
  if (cursor) return cursor;
  const e = event as unknown as Record<string, unknown>;
  const orig = e.origAddr ?? (Array.isArray(e.origAddrs) ? e.origAddrs[0] : "");
  const resp = e.respAddr ?? (Array.isArray(e.respAddrs) ? e.respAddrs[0] : "");
  const origPort = e.origPort ?? "";
  const respPort =
    e.respPort ?? (Array.isArray(e.respPorts) ? e.respPorts[0] : "");
  return `${event.__typename}|${event.time}|${event.sensor}|${orig}:${origPort}|${resp}:${respPort}|${index}`;
}

function relativePhrase(diffMs: number, justNow: string): string {
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  if (seconds < 60) return justNow;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
