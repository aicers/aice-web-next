"use client";

import {
  ChevronRight,
  Download,
  FileQuestion,
  Inbox,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  type EventAddressing,
  levelBadgeVariant,
  readEventAddressing,
} from "@/components/events/event-display-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Event, ThreatLevel, TriageScore } from "@/lib/detection/types";
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
  unknownTime: string;
  noSensor: string;
  confidenceLabel: string;
  triageSummary: (args: { count: number; max: string }) => string;
  endpointSeparator: string;
  moreCountSuffix: (count: number) => string;
  countryUnknown: string;
  countryUnavailable: string;
  levelLabels: Record<ThreatLevel, string>;
  attackKindLabel: string;
}

export interface ResultListState {
  status: "loading" | "ready" | "error" | "empty-prequery";
  events: Event[];
  totalCount: string | null;
  range: { start: string; end: string } | null;
  /** Wall-clock ms timestamp of the last successful refresh. */
  lastUpdatedMs: number | null;
}

interface ResultListProps {
  state: ResultListState;
  labels: ResultListLabels;
  locale: string;
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
  onRefresh,
  onOpenFilters,
  onRowOpen,
  onRowInvestigate,
}: ResultListProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <ResultListHeader state={state} labels={labels} onRefresh={onRefresh} />
      <ResultListBody
        state={state}
        labels={labels}
        locale={locale}
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
  onRefresh,
}: {
  state: ResultListState;
  labels: ResultListLabels;
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
          disabled={state.status === "loading"}
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
  onOpenFilters,
  onRefresh,
  onRowOpen,
  onRowInvestigate,
}: {
  state: ResultListState;
  labels: ResultListLabels;
  locale: string;
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
      {state.events.map((event) => (
        <EventRow
          key={eventListKey(event)}
          event={event}
          labels={labels}
          locale={locale}
          onRowOpen={onRowOpen}
          onRowInvestigate={onRowInvestigate}
        />
      ))}
    </ul>
  );
}

/**
 * Build a per-row key that's stable across renders without depending
 * on the array index. Cursor-based keying lands with pagination
 * (Phase Detection-11); until then a composite of `__typename`, time,
 * sensor, and addressing is unique enough for a single page slice.
 */
function eventListKey(event: Event): string {
  const a = readEventAddressing(event);
  const orig = a.origAddr ?? a.origAddrs[0] ?? "";
  const resp = a.respAddr ?? a.respAddrs[0] ?? "";
  return `${event.__typename}|${event.time}|${event.sensor}|${orig}|${resp}|${a.origPort ?? ""}|${a.respPort ?? ""}`;
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
  return (
    <li
      className={cn(
        "bg-card border-border group relative rounded-md border px-3 py-2 transition-colors",
        isInteractive && "hover:bg-accent/40 focus-within:bg-accent/40",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => onRowOpen?.(event)}
            disabled={!isInteractive}
            aria-label={labels.rowOpenLabel}
            className={cn(
              "block w-full text-left",
              isInteractive
                ? "cursor-pointer focus:outline-none"
                : "cursor-default",
            )}
          >
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
                <span className="text-muted-foreground truncate text-xs">
                  <span className="text-muted-foreground/70 mr-1">
                    {labels.attackKindLabel}
                  </span>
                  <span className="text-foreground">
                    {addressing.attackKind}
                  </span>
                </span>
              ) : null}
              {event.category ? (
                <Badge variant="outline" className="font-normal">
                  {event.category}
                </Badge>
              ) : null}
              <span className="text-muted-foreground text-xs">
                <span className="mr-1">{labels.confidenceLabel}</span>
                <span className="text-foreground tabular-nums">
                  {event.confidence.toFixed(2)}
                </span>
              </span>
              <TriageSummary
                triageScores={event.triageScores}
                labels={labels}
              />
            </div>
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
              <EndpointSummary addressing={addressing} labels={labels} />
              <span className="text-muted-foreground/70">·</span>
              <span className="truncate">
                {event.sensor || labels.noSensor}
              </span>
            </div>
          </button>
        </div>
        <div className="shrink-0 self-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={labels.rowInvestigateLabel}
            onClick={(e) => {
              e.stopPropagation();
              onRowInvestigate?.(event);
            }}
            disabled={typeof onRowInvestigate !== "function"}
            className="size-7"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
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
    <span className="text-muted-foreground text-xs">
      {labels.triageSummary({
        count: triageScores.length,
        max: max.toFixed(2),
      })}
    </span>
  );
}

function EndpointSummary({
  addressing,
  labels,
}: {
  addressing: EventAddressing;
  labels: ResultListLabels;
}) {
  const orig = pickEndpoint(
    addressing.origAddr,
    addressing.origAddrs,
    addressing.origPort,
    addressing.origCountry,
    addressing.origCountries,
  );
  const resp = pickEndpoint(
    addressing.respAddr,
    addressing.respAddrs,
    addressing.respPort,
    addressing.respCountry,
    addressing.respCountries,
    addressing.respPorts,
  );
  if (!orig && !resp) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <EndpointPart endpoint={orig} labels={labels} />
      <span className="text-muted-foreground/70">
        {labels.endpointSeparator}
      </span>
      <EndpointPart endpoint={resp} labels={labels} />
    </span>
  );
}

interface EndpointDisplay {
  address: string;
  extraAddresses: number;
  port: number | null;
  extraPorts: number;
  country: string | null;
  extraCountries: number;
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
  let extraAddresses = 0;
  if (!address && pluralAddrs.length > 0) {
    address = pluralAddrs[0];
    extraAddresses = pluralAddrs.length - 1;
  }
  if (!address) return null;
  let port = singularPort;
  let extraPorts = 0;
  if (port === null && pluralPorts.length > 0) {
    port = pluralPorts[0];
    extraPorts = pluralPorts.length - 1;
  }
  let country = singularCountry;
  let extraCountries = 0;
  if (!country && pluralCountries.length > 0) {
    country = pluralCountries[0];
    extraCountries = pluralCountries.length - 1;
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
  const portMore =
    endpoint.extraPorts > 0
      ? ` ${labels.moreCountSuffix(endpoint.extraPorts)}`
      : "";
  const country = endpoint.country
    ? formatCountryShort(endpoint.country, labels)
    : null;
  return (
    <span className="text-foreground inline-flex items-center gap-1 font-mono text-xs">
      <span className="truncate" title={endpoint.address}>
        {endpoint.address}
        {portLabel}
      </span>
      {endpoint.extraAddresses > 0 ? (
        <span className="text-muted-foreground/80">
          {" "}
          {labels.moreCountSuffix(endpoint.extraAddresses)}
        </span>
      ) : null}
      {portMore ? (
        <span className="text-muted-foreground/80">{portMore}</span>
      ) : null}
      {country ? (
        <span className="text-muted-foreground/80 ml-1 normal-case">
          ({country})
        </span>
      ) : null}
    </span>
  );
}

function formatCountryShort(code: string, labels: ResultListLabels): string {
  if (code === "XX") return labels.countryUnknown;
  if (code === "ZZ") return labels.countryUnavailable;
  return code;
}

function formatEventTime(
  iso: string,
  locale: string,
  fallback: string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
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
