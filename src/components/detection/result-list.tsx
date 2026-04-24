"use client";

import {
  ChevronRight,
  Download,
  FileQuestion,
  Inbox,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  levelBadgeVariant,
  readEventAddressing,
} from "@/components/events/event-display-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatEventTime } from "@/lib/detection/event-time";
import type {
  Event,
  ThreatCategory,
  ThreatLevel,
  TriageScore,
} from "@/lib/detection/types";
import { isEventAddressable } from "@/lib/events/event-locator";
import { cn } from "@/lib/utils";

/**
 * Phase Detection-9 result list. Renders a compact two-line entry
 * per event (severity / time / kind / confidence / triage on line 1;
 * `source → destination` plus sensor on line 2). The component only
 * presents — fetching, sort, pagination (Phase Detection-11) and
 * pivot wiring (Phase Detection-12) live elsewhere.
 *
 * The header area sits above the list with the result count + range,
 * the Download CSV affordance (wiring in Phase Detection-13), and an
 * `Updated <relative>` line with a Refresh button.
 */

export interface ResultListLabels {
  countWithRange: (args: { range: string; total: string }) => React.ReactNode;
  totalOnly: (args: { total: string }) => React.ReactNode;
  download: string;
  downloadComingSoon: string;
  refresh: string;
  updatedJustNow: string;
  updatedSecondsAgo: (s: number) => string;
  updatedMinutesAgo: (m: number) => string;
  updatedHoursAgo: (h: number) => string;
  loadingTitle: string;
  loadingDescription: string;
  errorTitle: string;
  errorDescription: string;
  errorRetry: string;
  emptyResultsTitle: string;
  emptyResultsDescription: string;
  emptyFilterTitle: string;
  emptyFilterDescription: string;
  emptyFilterAction: string;
  rowOpenLabel: string;
  rowInvestigateLabel: string;
  quickPeekClose: string;
  unknownTime: string;
  noSensor: string;
  confidenceLabel: string;
  triageSummary: (args: { count: number; max: string }) => string;
  endpointSeparator: string;
  moreCountSuffix: (count: number) => string;
  countryUnknown: string;
  countryUnavailable: string;
  levelLabels: Record<ThreatLevel, string>;
  categoryLabels: Record<ThreatCategory, string>;
  attackKindLabel: string;
}

export interface ResultListState {
  status: "loading" | "ready" | "error" | "empty-prequery";
  events: Event[];
  /**
   * Parallel to `events`: `eventKeys[i]` is the per-edge REview
   * cursor for `events[i]`. The list composes this with the
   * committed-query epoch to build a React row key. Within a single
   * committed slice the cursor is guaranteed unique (Relay connection
   * contract), so two otherwise-identical events can't alias onto a
   * shared row. REview does *not* document the cursor as a stable
   * per-event identity across queries — it is "a cursor for use in
   * pagination" — so cross-commit state leakage is prevented by the
   * epoch prefix on the row key rather than by the cursor value
   * alone.
   */
  eventKeys: string[];
  totalCount: string | null;
  range: { start: string; end: string } | null;
  /** Wall-clock ms timestamp of the last successful refresh. */
  lastUpdatedMs: number | null;
}

interface ResultListProps {
  state: ResultListState;
  labels: ResultListLabels;
  locale: string;
  /**
   * Monotonic counter bumped by the shell on every committed query
   * transition (Apply, chip removal, Refresh, error). Composed into
   * the React row key so `EventRow` / `MorePopover` state cannot be
   * carried across unrelated committed queries even if REview reuses
   * a positional cursor value in the new slice. Defaults to `0` in
   * callers that render a single slice (tests, Storybook).
   */
  queryEpoch?: number;
  /**
   * Whether the Refresh affordance is actionable. Fresh `+` tabs are
   * "pending" — they must go through the drawer's Apply path before
   * running their first query (Phase Detection-10). Disabling Refresh
   * in that state keeps the Apply-only contract enforced even though
   * the result header is always rendered.
   */
  canRefresh?: boolean;
  onRefresh: () => void;
  onOpenFilters?: () => void;
  /** Click on a row body — opens Quick peek (Phase Detection-18). */
  onRowOpen?: (event: Event) => void;
  /** Click on the Investigate icon — opens the full view (Phase Detection-19). */
  onRowInvestigate?: (event: Event) => void;
}

export function ResultList({
  state,
  labels,
  locale,
  queryEpoch = 0,
  canRefresh = true,
  onRefresh,
  onOpenFilters,
  onRowOpen,
  onRowInvestigate,
}: ResultListProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <ResultListHeader
        state={state}
        labels={labels}
        canRefresh={canRefresh}
        onRefresh={onRefresh}
      />
      <ResultListBody
        state={state}
        labels={labels}
        locale={locale}
        queryEpoch={queryEpoch}
        onOpenFilters={onOpenFilters}
        onRefresh={onRefresh}
        onRowOpen={onRowOpen}
        onRowInvestigate={onRowInvestigate}
      />
    </div>
  );
}

function ResultListHeader({
  state,
  labels,
  canRefresh,
  onRefresh,
}: {
  state: ResultListState;
  labels: ResultListLabels;
  canRefresh: boolean;
  onRefresh: () => void;
}) {
  const total = state.totalCount;
  const range = state.range;
  const showCount = total !== null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-foreground text-sm font-semibold">
        {showCount && range
          ? labels.countWithRange({
              range: `${range.start} – ${range.end}`,
              total,
            })
          : showCount
            ? labels.totalOnly({ total: total ?? "0" })
            : null}
      </h2>
      <div className="flex items-center gap-2">
        <UpdatedAffordance
          lastUpdatedMs={state.lastUpdatedMs}
          labels={labels}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          aria-label={labels.refresh}
          disabled={state.status === "loading" || !canRefresh}
        >
          <RefreshCw
            className={cn(
              "size-4",
              state.status === "loading" && "animate-spin",
            )}
            aria-hidden="true"
          />
          <span className="sr-only">{labels.refresh}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          // CSV export wiring lands in Phase Detection-13. Until then
          // the affordance is visible but disabled with a tooltip
          // explaining the deferred status.
          disabled
          title={labels.downloadComingSoon}
          aria-label={labels.download}
        >
          <Download className="size-4" aria-hidden="true" />
          {labels.download}
        </Button>
      </div>
    </div>
  );
}

function UpdatedAffordance({
  lastUpdatedMs,
  labels,
}: {
  lastUpdatedMs: number | null;
  labels: ResultListLabels;
}) {
  const [, force] = useState(0);
  // Re-render every 30s so "Updated 2 min ago" stays accurate without
  // demanding the parent re-render the entire shell.
  useEffect(() => {
    if (lastUpdatedMs === null) return;
    const handle = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(handle);
  }, [lastUpdatedMs]);

  if (lastUpdatedMs === null) return null;
  const elapsedMs = Date.now() - lastUpdatedMs;
  const text = formatRelativeUpdate(elapsedMs, labels);
  return <span className="text-muted-foreground text-xs">{text}</span>;
}

function formatRelativeUpdate(
  elapsedMs: number,
  labels: ResultListLabels,
): string {
  if (elapsedMs < 5_000) return labels.updatedJustNow;
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return labels.updatedSecondsAgo(seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return labels.updatedMinutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  return labels.updatedHoursAgo(hours);
}

function ResultListBody({
  state,
  labels,
  locale,
  queryEpoch,
  onOpenFilters,
  onRefresh,
  onRowOpen,
  onRowInvestigate,
}: {
  state: ResultListState;
  labels: ResultListLabels;
  locale: string;
  queryEpoch: number;
  onOpenFilters?: () => void;
  onRefresh: () => void;
  onRowOpen?: (event: Event) => void;
  onRowInvestigate?: (event: Event) => void;
}) {
  if (state.status === "loading" && state.events.length === 0) {
    return (
      <StatePanel
        icon={<RefreshCw className="size-8 animate-spin" aria-hidden="true" />}
        title={labels.loadingTitle}
        description={labels.loadingDescription}
        tone="neutral"
      />
    );
  }

  if (state.status === "error") {
    return (
      <StatePanel
        icon={<TriangleAlert className="size-8" aria-hidden="true" />}
        title={labels.errorTitle}
        description={labels.errorDescription}
        tone="error"
        action={
          <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
            {labels.errorRetry}
          </Button>
        }
      />
    );
  }

  if (state.status === "empty-prequery") {
    return (
      <StatePanel
        icon={<FileQuestion className="size-8" aria-hidden="true" />}
        title={labels.emptyFilterTitle}
        description={labels.emptyFilterDescription}
        tone="neutral"
        action={
          onOpenFilters ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenFilters}
            >
              {labels.emptyFilterAction}
            </Button>
          ) : null
        }
      />
    );
  }

  if (state.events.length === 0) {
    return (
      <StatePanel
        icon={<Inbox className="size-8" aria-hidden="true" />}
        title={labels.emptyResultsTitle}
        description={labels.emptyResultsDescription}
        tone="neutral"
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-slot="detection-result-list">
      {state.events.map((event, index) => {
        // Row key composes the committed-query epoch with the per-
        // edge REview cursor. Within a single committed slice the
        // cursor is unique (Relay connection contract), so two byte-
        // identical events render as distinct siblings. The epoch
        // prefix guards the cross-commit case: REview's schema only
        // documents `EventEdge.cursor` as "a cursor for use in
        // pagination", and if REview returns positional cursors
        // across different filters the same value can point at a
        // different event in the new slice. Prefixing with epoch
        // forces React to remount rows on every committed
        // transition so `EventRow` / `MorePopover` local state
        // cannot leak across unrelated queries.
        const cursor = state.eventKeys[index] ?? `row-${index}`;
        return (
          <EventRow
            key={`${queryEpoch}:${cursor}`}
            event={event}
            labels={labels}
            locale={locale}
            onRowOpen={onRowOpen}
            onRowInvestigate={onRowInvestigate}
          />
        );
      })}
    </ul>
  );
}

function EventRow({
  event,
  labels,
  locale,
  onRowOpen,
  onRowInvestigate,
}: {
  event: Event;
  labels: ResultListLabels;
  locale: string;
  onRowOpen?: (event: Event) => void;
  onRowInvestigate?: (event: Event) => void;
}) {
  const addressing = readEventAddressing(event);
  const kindLabel =
    EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  const isInteractive = typeof onRowOpen === "function";
  // Compute the endpoint sides up front so the row can omit the
  // entire source → destination line (and its separator to sensor)
  // for subtypes whose schema exposes no addressing at all — e.g.
  // ExtraThreat / WindowsThreat. Without this, those rows render a
  // bare `· sensor` fragment after the first line.
  const origEndpoint = pickEndpoint(
    addressing.origAddr,
    addressing.origAddrs,
    addressing.origPort,
    addressing.origCountry,
    addressing.origCountries,
  );
  const respEndpoint = pickEndpoint(
    addressing.respAddr,
    addressing.respAddrs,
    addressing.respPort,
    addressing.respCountry,
    addressing.respCountries,
    addressing.respPorts,
  );
  const hasEndpoint = Boolean(origEndpoint || respEndpoint);
  // Investigation requires an encodable locator (origAddr + respAddr). For
  // schema-limited subtypes (e.g. ExtraThreat, WindowsThreat, UnusualDestinationPattern
  // when neither side is present) the chevron would silently no-op, so
  // hide the affordance rather than rendering a dead control.
  const canInvestigate =
    typeof onRowInvestigate === "function" && isEventAddressable(event);
  return (
    <li
      className={cn(
        "bg-card border-border group relative rounded-md border px-3 py-2 transition-colors",
        isInteractive && "hover:bg-accent/40 focus-within:bg-accent/40",
      )}
    >
      {isInteractive ? (
        // Overlay "open Quick peek" button covers the whole row. Keeping
        // it as a sibling of the interactive controls (MorePopover,
        // investigate chevron) — instead of wrapping them — avoids
        // nesting interactive controls inside the row button.
        <button
          type="button"
          onClick={() => onRowOpen?.(event)}
          aria-label={labels.rowOpenLabel}
          className="focus-visible:ring-ring/50 absolute inset-0 z-0 cursor-pointer rounded-md focus:outline-none focus-visible:ring-2"
        />
      ) : null}
      <div className="pointer-events-none relative flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <Badge
              variant={levelBadgeVariant(event.level)}
              className="uppercase"
            >
              {labels.levelLabels[event.level] ?? event.level}
            </Badge>
            <span className="text-muted-foreground text-xs tabular-nums">
              {formatEventTime(event.time, locale, labels.unknownTime)}
            </span>
            <span className="text-foreground font-medium">{kindLabel}</span>
            {addressing.attackKind ? (
              // Secondary label: truncates at medium widths (the
              // `title` surfaces the full value on hover) and is
              // hidden entirely at narrow widths per #280's
              // density-not-column-drop strategy.
              <span
                className="text-muted-foreground hidden max-w-[16ch] truncate text-xs sm:inline-flex"
                title={addressing.attackKind}
              >
                <span className="text-muted-foreground/70 mr-1">
                  {labels.attackKindLabel}
                </span>
                <span className="text-foreground">{addressing.attackKind}</span>
              </span>
            ) : null}
            {event.category ? (
              <Badge
                variant="outline"
                className="hidden font-normal sm:inline-flex"
              >
                {labels.categoryLabels[event.category] ?? event.category}
              </Badge>
            ) : null}
            <span className="text-muted-foreground hidden text-xs sm:inline">
              <span className="mr-1">{labels.confidenceLabel}</span>
              <span className="text-foreground tabular-nums">
                {event.confidence.toFixed(2)}
              </span>
            </span>
            <TriageSummary triageScores={event.triageScores} labels={labels} />
          </div>
          <div className="text-muted-foreground mt-1 flex flex-col gap-x-2 gap-y-1 text-xs sm:flex-row sm:flex-wrap sm:items-center">
            {hasEndpoint ? (
              <EndpointSummary
                orig={origEndpoint}
                resp={respEndpoint}
                labels={labels}
              />
            ) : null}
            {hasEndpoint ? (
              <span className="text-muted-foreground/70 hidden sm:inline">
                ·
              </span>
            ) : null}
            <span className="truncate">{event.sensor || labels.noSensor}</span>
          </div>
        </div>
        {canInvestigate ? (
          <div className="pointer-events-auto relative z-10 shrink-0 self-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={labels.rowInvestigateLabel}
              onClick={(e) => {
                e.stopPropagation();
                onRowInvestigate?.(event);
              }}
              className="size-7"
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function TriageSummary({
  triageScores,
  labels,
}: {
  triageScores: TriageScore[] | null;
  labels: ResultListLabels;
}) {
  if (!triageScores || triageScores.length === 0) return null;
  let max = triageScores[0].score;
  for (const t of triageScores) if (t.score > max) max = t.score;
  return (
    <span className="text-muted-foreground hidden text-xs sm:inline">
      {labels.triageSummary({
        count: triageScores.length,
        max: max.toFixed(2),
      })}
    </span>
  );
}

/**
 * Render the source → destination line for an event row.
 *
 * Not every `Event` implementor in the vendored schema carries
 * endpoint fields: `ExtraThreat` and `WindowsThreat` model host- /
 * agent-side threats and expose no `origAddr` / `respAddr` / port
 * fields at all (see `schemas/review.graphql` — both types only
 * surface sensor, service, agent, and user context). A handful of
 * other subtypes omit one side or one port — for example
 * `UnusualDestinationPattern` is responder-array only, and
 * `RdpBruteForce` / `LdapBruteForce` omit the originator port. In
 * every such case the missing slot falls through to a `—`
 * placeholder via {@link EndpointPart}; the whole line is suppressed
 * only when neither side is addressable, so the rest of the row
 * (severity / time / kind / sensor) still renders.
 */
function EndpointSummary({
  orig,
  resp,
  labels,
}: {
  orig: EndpointDisplay | null;
  resp: EndpointDisplay | null;
  labels: ResultListLabels;
}) {
  if (!orig && !resp) return null;
  // At narrow widths the two endpoints stack vertically and the `→`
  // glyph is suppressed — #280's density strategy keeps IPs and ports
  // visible but drops the horizontal source → destination layout.
  return (
    <span className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center">
      <EndpointPart endpoint={orig} labels={labels} />
      <span className="text-muted-foreground/70 hidden sm:inline">
        {labels.endpointSeparator}
      </span>
      <EndpointPart endpoint={resp} labels={labels} />
    </span>
  );
}

interface EndpointDisplay {
  address: string;
  extraAddresses: string[];
  port: number | null;
  extraPorts: number[];
  country: string | null;
  extraCountries: string[];
}

function pickEndpoint(
  singularAddr: string | null,
  pluralAddrs: string[],
  singularPort: number | null,
  singularCountry: string | null,
  pluralCountries: string[],
  pluralPorts: number[] = [],
): EndpointDisplay | null {
  let address = singularAddr;
  let extraAddresses: string[] = [];
  if (!address && pluralAddrs.length > 0) {
    address = pluralAddrs[0];
    extraAddresses = pluralAddrs.slice(1);
  }
  if (!address) return null;
  let port = singularPort;
  let extraPorts: number[] = [];
  if (port === null && pluralPorts.length > 0) {
    port = pluralPorts[0];
    extraPorts = pluralPorts.slice(1);
  }
  let country = singularCountry;
  let extraCountries: string[] = [];
  if (!country && pluralCountries.length > 0) {
    country = pluralCountries[0];
    extraCountries = pluralCountries.slice(1);
  }
  return {
    address,
    extraAddresses,
    port,
    extraPorts,
    country,
    extraCountries,
  };
}

function EndpointPart({
  endpoint,
  labels,
}: {
  endpoint: EndpointDisplay | null;
  labels: ResultListLabels;
}) {
  if (!endpoint) return <span className="text-muted-foreground/60">—</span>;
  const portLabel = endpoint.port !== null ? `:${endpoint.port}` : "";
  const country = endpoint.country
    ? formatCountryShort(endpoint.country, labels)
    : null;
  return (
    <span className="text-foreground inline-flex items-center gap-1 font-mono text-xs">
      <span className="truncate" title={endpoint.address}>
        {endpoint.address}
        {portLabel}
      </span>
      {endpoint.extraAddresses.length > 0 ? (
        <MorePopover
          count={endpoint.extraAddresses.length}
          values={endpoint.extraAddresses}
          labels={labels}
        />
      ) : null}
      {endpoint.extraPorts.length > 0 ? (
        <MorePopover
          count={endpoint.extraPorts.length}
          values={endpoint.extraPorts.map((p) => String(p))}
          labels={labels}
        />
      ) : null}
      {country ? (
        <span className="text-muted-foreground/80 ml-1 normal-case">
          ({country})
        </span>
      ) : null}
    </span>
  );
}

/**
 * Compact `+N more` control that reveals the full list of hidden
 * values on activation. Uses a minimal inline popover — clicking
 * the button toggles a panel anchored beneath it; clicking outside
 * or pressing Escape closes it. Satisfies the spec's "popover for
 * the full list" acceptance without pulling in a new Radix
 * primitive.
 */
function MorePopover({
  count,
  values,
  labels,
}: {
  count: number;
  values: string[];
  labels: ResultListLabels;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  // Outside-click handler is scoped to this popover's own wrapper via
  // ref, so a click on the trigger counts as "inside" (the button's
  // onClick still runs and toggles closed) and, with multiple popovers
  // on the same row, clicking into another popover correctly closes
  // this one.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open]);
  return (
    <span
      className="pointer-events-auto relative z-10 inline-flex"
      ref={wrapperRef}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="text-muted-foreground/80 hover:text-foreground focus-visible:ring-ring/50 rounded px-1 focus-visible:ring-2 focus-visible:outline-none"
      >
        {labels.moreCountSuffix(count)}
      </button>
      {open ? (
        <div
          role="dialog"
          className="bg-popover text-popover-foreground absolute top-full z-20 mt-1 max-h-64 min-w-[10rem] overflow-auto rounded-md border p-2 shadow-md"
        >
          <ul className="flex flex-col gap-0.5 font-mono text-xs">
            {values.map((v) => (
              <li key={v} className="truncate">
                {v}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  );
}

function formatCountryShort(code: string, labels: ResultListLabels): string {
  if (code === "XX") return labels.countryUnknown;
  if (code === "ZZ") return labels.countryUnavailable;
  return code;
}

function StatePanel({
  icon,
  title,
  description,
  tone,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tone: "neutral" | "error";
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "bg-card flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-lg border p-6 text-center",
        tone === "error"
          ? "border-destructive/40 text-destructive"
          : "border-[var(--sidebar-border)] text-muted-foreground",
      )}
    >
      <div className={cn(tone === "error" ? "" : "text-muted-foreground")}>
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {action}
    </div>
  );
}
