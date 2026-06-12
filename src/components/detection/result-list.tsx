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
import { MorePopover } from "@/components/detection/more-popover";
import {
  EVENT_KIND_FRIENDLY_NAMES,
  type EventIdentity,
  levelBadgeVariant,
  readEventAddressing,
  readEventIdentity,
} from "@/components/events/event-display-helpers";
import {
  useResolvedTimeFormat,
  useTimezone,
} from "@/components/providers/account-preferences-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  THREAT_CATEGORY_KEY_BY_VALUE,
  THREAT_CATEGORY_VALUES,
} from "@/lib/detection/filter-options";
import {
  buildPivotPatch,
  type PivotColumnKey,
  type PivotPatch,
} from "@/lib/detection/pivot";
import type {
  Event,
  ThreatCategory,
  ThreatLevel,
  TriageScore,
} from "@/lib/detection/types";
import { formatEventTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";

/**
 * Phase Detection-9 result list. Renders a compact two-line entry
 * per event (severity / time / kind / confidence / triage on line 1;
 * `source → destination` plus sensor and the identity cells on line
 * 2). The component only presents — fetching, sort, pagination
 * (Phase Detection-11) and pivot wiring (Phase Detection-12) live
 * elsewhere.
 *
 * The header area sits above the list with the result count + range,
 * the Download CSV affordance (wiring in Phase Detection-13), and an
 * `Updated <relative>` line with a Refresh button.
 *
 * Identity columns (Phase Detection-28 / #347): the second line
 * carries `User: …` and `Host: …` cells after the sensor on every
 * row. When the event subtype emits the underlying field per the
 * REview schema (the subtypes select them in `EVENT_LIST_QUERY` —
 * HTTP-class threats, `BlocklistNtlm`, `BlocklistRadius`, FTP
 * plain-text events, `WindowsThreat`), the cell renders as a
 * pivotable button that activates the same `userName` / `hostname`
 * patches the pivot library already maps. Subtypes that do not
 * emit the field render the cell as a non-pivotable `User: —` /
 * `Host: —` token so the column position stays stable across the
 * list — #280's density rules still hold because severity, time,
 * and endpoints never depend on either cell. The remaining three
 * pivot columns mapped by the engine (`userId`, `userDepartment`,
 * `direction`) are deferred to #348 because the per-event payload
 * does not carry them yet.
 */

export interface ResultListLabels {
  countWithRange: (args: { range: string; total: string }) => React.ReactNode;
  totalOnly: (args: { total: string }) => React.ReactNode;
  download: string;
  downloadRunning: string;
  downloadErrorTitle: string;
  downloadErrorDismiss: string;
  refresh: string;
  updatedJustNow: string;
  updatedSecondsAgo: (s: number) => string;
  updatedMinutesAgo: (m: number) => string;
  updatedHoursAgo: (h: number) => string;
  /**
   * Issue #429 §3: stale-data inline notice surfaced after a preset
   * activation focused an existing tab whose last fetch is older than
   * the threshold. Coexists with the `Updated …` timestamp; the notice
   * is gated on a match-focus event and the staleness threshold so a
   * fresh tab does not spam it.
   *
   * Distinct from `updated*Ago` — those compose the always-on
   * `Updated …` chip and prepending another `Last updated` to them
   * would produce duplicated wording (`Last updated Updated 14 min
   * ago`). The stale-notice variants are full sentences so the two
   * surfaces never share a fragment.
   */
  staleNoticeJustNow: string;
  staleNoticeSecondsAgo: (s: number) => string;
  staleNoticeMinutesAgo: (m: number) => string;
  staleNoticeHoursAgo: (h: number) => string;
  staleNoticeRefresh: string;
  /**
   * Issue #429 §6: inline notice surfaced when the operator's open
   * Quick peek was closed because the event disappeared from the
   * latest slice (e.g. a Refresh narrowed it out). Lets the operator
   * understand why the inspector vanished instead of silently
   * stripping it.
   */
  peekLostNotice: string;
  peekLostDismiss: string;
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
  /**
   * Localized template for the activation a11y label rendered on
   * pivotable cells, e.g. `Filter results by Level: High`. The
   * pivot affordance only renders when the parent provides
   * `onPivot`; this label is read by screen readers as the button's
   * `aria-label`.
   */
  pivotActivate: (args: { label: string; value: string }) => string;
  pivotColumnLabels: {
    origAddr: string;
    respAddr: string;
    origCountry: string;
    respCountry: string;
    level: string;
    category: string;
    kind: string;
    userName: string;
    hostname: string;
  };
  /**
   * Per-locale prefix labels for the userName / hostname identity
   * cells (#347). Rendered as a small muted preamble before the
   * value so the operator can tell which column the cell belongs
   * to without a header row — e.g. `User: jdoe` / `Host:
   * mail.example.com`. Subtypes whose schema does not emit the
   * field render the cell as a non-pivotable `<prefix> —` token
   * (e.g. `User: —`) so the column position stays stable across
   * the list and the operator can tell that the row simply has no
   * identity to pivot on.
   */
  userNameLabel: string;
  hostnameLabel: string;
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
  onRefresh: () => void;
  onOpenFilters?: () => void;
  /** Click on a row body — opens Quick peek (Phase Detection-18). */
  onRowOpen?: (event: Event) => void;
  /** Click on the Investigate icon — opens the full view (Phase Detection-19). */
  onRowInvestigate?: (event: Event) => void;
  /**
   * Pivot (drill-down) activation hook (Phase Detection-12).
   *
   * When provided, pivotable cells (level / kind / category /
   * source IP / destination IP / country / userName / hostname)
   * render as buttons that call into this handler with a
   * {@link PivotPatch} the multi-tab wrapper applies on top of the
   * active tab's filter. When undefined, every cell renders as
   * plain text — covers the single-tab storybook / standalone
   * shell paths where there is no tab system to receive the new
   * filter.
   */
  onPivot?: (patch: PivotPatch) => void;
  /**
   * CSV export affordance wiring (Phase Detection-13). When
   * omitted, the Download button is disabled — preserves the
   * existing "feature not wired" rendering used by tests and
   * storyboards that don't thread an export controller through.
   */
  onDownload?: () => void;
  /**
   * When `true`, the Download button is disabled and labelled with
   * the "exporting" busy text so the operator sees progress while
   * the stream is in flight.
   */
  downloadRunning?: boolean;
  /**
   * Localized error message surfaced below the header when the
   * last export failed. Dismissing the banner is wired up by the
   * shell via `onDismissDownloadError`.
   */
  downloadError?: string | null;
  onDismissDownloadError?: () => void;
  /**
   * Issue #429 §3: most recent match-focus event. When the wrapper
   * focused the active tab on a preset activation, the result-list
   * header shows an inline "Last updated …" notice with a Refresh
   * button if the tab's last fetch is older than the staleness
   * threshold. Each new event (distinguished by `at`) renders the
   * notice once; subsequent unrelated state changes do not re-emit
   * it. Refresh is the operator's choice — focus does not auto-
   * refetch.
   */
  matchFocusEvent?: { at: number } | null;
  /**
   * Issue #429 §6: most recent timestamp at which the open Quick peek
   * was closed because its event was no longer in the slice. Each
   * distinct value renders the inline "no longer in the list" notice
   * once until the operator dismisses it. `null` keeps the notice
   * hidden — the standard state for tabs whose peek was never opened
   * or was dismissed by the operator directly.
   */
  peekLostAt?: number | null;
  onDismissPeekLost?: () => void;
}

/**
 * Issue #429 §3: staleness threshold for the match-focus notice. A tab
 * whose last fetch is older than this surfaces the inline "Last
 * updated …" notice on a match-focus. Independent of the tab's data
 * window — a Last 1 year tab and a Last 1 hour tab use the same rule.
 */
export const STALE_THRESHOLD_MS = 2 * 60 * 1000;

export function ResultList({
  state,
  labels,
  locale,
  queryEpoch = 0,
  onRefresh,
  onOpenFilters,
  onRowOpen,
  onRowInvestigate,
  onPivot,
  onDownload,
  downloadRunning,
  downloadError,
  onDismissDownloadError,
  matchFocusEvent,
  peekLostAt,
  onDismissPeekLost,
}: ResultListProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <ResultListHeader
        state={state}
        labels={labels}
        onRefresh={onRefresh}
        onDownload={onDownload}
        matchFocusEvent={matchFocusEvent}
        downloadRunning={downloadRunning}
      />
      {downloadError ? (
        <DownloadErrorBanner
          message={downloadError}
          title={labels.downloadErrorTitle}
          dismissLabel={labels.downloadErrorDismiss}
          onDismiss={onDismissDownloadError}
        />
      ) : null}
      <PeekLostNotice
        peekLostAt={peekLostAt ?? null}
        message={labels.peekLostNotice}
        dismissLabel={labels.peekLostDismiss}
        onDismiss={onDismissPeekLost}
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
        onPivot={onPivot}
      />
    </div>
  );
}

/**
 * Issue #429 §6: inline notice rendered after the active tab's Quick
 * peek was closed because its event disappeared from the latest slice.
 * Re-renders on each fresh `peekLostAt` value (a different timestamp
 * means a fresh "lost" event) and disappears once the operator
 * dismisses it. The shell pairs each notice with a `setPeekLostAt`
 * call inside the slice-reconcile path so legitimate peek dismissals
 * (operator clicked the close button) do NOT trigger the notice.
 */
function PeekLostNotice({
  peekLostAt,
  message,
  dismissLabel,
  onDismiss,
}: {
  peekLostAt: number | null;
  message: string;
  dismissLabel: string;
  onDismiss?: () => void;
}) {
  const [acknowledgedAt, setAcknowledgedAt] = useState<number | null>(null);
  if (peekLostAt === null) return null;
  if (peekLostAt === acknowledgedAt) return null;
  return (
    <div
      role="status"
      data-slot="result-peek-lost-notice"
      className="text-muted-foreground border-muted bg-muted/30 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
    >
      <span>{message}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => {
          setAcknowledgedAt(peekLostAt);
          onDismiss?.();
        }}
      >
        {dismissLabel}
      </Button>
    </div>
  );
}

function ResultListHeader({
  state,
  labels,
  onRefresh,
  onDownload,
  downloadRunning,
  matchFocusEvent,
}: {
  state: ResultListState;
  labels: ResultListLabels;
  onRefresh: () => void;
  onDownload?: () => void;
  downloadRunning?: boolean;
  matchFocusEvent?: { at: number } | null;
}) {
  const total = state.totalCount;
  const range = state.range;
  const showCount = total !== null;
  const downloadDisabled =
    !onDownload ||
    downloadRunning === true ||
    state.status === "loading" ||
    state.status === "error" ||
    state.status === "empty-prequery" ||
    state.events.length === 0;
  const downloadLabel = downloadRunning
    ? labels.downloadRunning
    : labels.download;
  return (
    <div className="flex flex-col gap-1">
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
          {/*
           * Refresh stays disabled in `empty-prequery` so a `+`-created
           * tab cannot run its first query without going through Apply
           * (#281: new tabs must not auto-run).
           */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            aria-label={labels.refresh}
            disabled={
              state.status === "loading" || state.status === "empty-prequery"
            }
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
            onClick={onDownload}
            disabled={downloadDisabled}
            aria-label={downloadLabel}
            aria-busy={downloadRunning === true}
          >
            <Download className="size-4" aria-hidden="true" />
            {downloadLabel}
          </Button>
        </div>
      </div>
      <StaleFocusNotice
        lastUpdatedMs={state.lastUpdatedMs}
        labels={labels}
        matchFocusEvent={matchFocusEvent ?? null}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function DownloadErrorBanner({
  title,
  message,
  dismissLabel,
  onDismiss,
}: {
  title: string;
  message: string;
  dismissLabel: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{message}</p>
      </div>
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          className="text-destructive hover:text-destructive"
        >
          {dismissLabel}
        </Button>
      ) : null}
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

/**
 * Issue #429 §3: stale-data inline notice surfaced after a preset
 * activation match-focuses an existing tab whose last fetch is older
 * than {@link STALE_THRESHOLD_MS}. The notice is gated on a
 * match-focus event (re-rendered once per `matchFocusEvent.at`) so the
 * "once per focus event" rule in §6 is enforced — repeated clicks of
 * the same preset within a short window do not stack toasts.
 *
 * Coexists with the existing `UpdatedAffordance` timestamp; the two
 * surfaces communicate different things — the timestamp is always-on
 * informational copy, this notice is a one-shot "you came back to
 * stale data, here's a Refresh" affordance.
 *
 * Refresh is the operator's choice (§3) — clicking it triggers the
 * same list refetch the manual Refresh button performs. Focus does
 * not auto-refetch.
 */
function StaleFocusNotice({
  lastUpdatedMs,
  labels,
  matchFocusEvent,
  onRefresh,
}: {
  lastUpdatedMs: number | null;
  labels: ResultListLabels;
  matchFocusEvent: { at: number } | null;
  onRefresh: () => void;
}) {
  // Track the last `matchFocusEvent.at` we have already shown so a
  // tab-state change unrelated to focus (e.g. the operator scrolled,
  // hovered a row) cannot re-emit the notice. The notice clears as
  // soon as the operator dismisses it or refreshes.
  //
  // `shownEventAt` is intentionally NOT a dep of the gating effect:
  // after a dismissal sets it back to `null`, we do not want the effect
  // to immediately re-fire on the same focusAt and re-render the
  // notice. The effect only re-evaluates when a fresh focus event
  // arrives or `lastUpdatedMs` advances — both of which are
  // operator-driven signals that legitimately deserve a fresh decision.
  const [shownEventAt, setShownEventAt] = useState<number | null>(null);
  const focusAt = matchFocusEvent?.at ?? null;
  useEffect(() => {
    if (focusAt === null) return;
    if (lastUpdatedMs === null) return;
    if (Date.now() - lastUpdatedMs < STALE_THRESHOLD_MS) return;
    setShownEventAt(focusAt);
  }, [focusAt, lastUpdatedMs]);

  if (shownEventAt === null) return null;
  if (focusAt !== shownEventAt) return null;
  if (lastUpdatedMs === null) return null;
  const elapsedMs = Date.now() - lastUpdatedMs;
  const message = formatStaleNotice(elapsedMs, labels);
  return (
    <div
      role="status"
      data-slot="result-stale-notice"
      className="text-muted-foreground flex items-center justify-end gap-2 text-xs"
    >
      <span>{message}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => {
          setShownEventAt(null);
          onRefresh();
        }}
      >
        {labels.staleNoticeRefresh}
      </Button>
    </div>
  );
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

function formatStaleNotice(
  elapsedMs: number,
  labels: ResultListLabels,
): string {
  if (elapsedMs < 5_000) return labels.staleNoticeJustNow;
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return labels.staleNoticeSecondsAgo(seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return labels.staleNoticeMinutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  return labels.staleNoticeHoursAgo(hours);
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
  onPivot,
}: {
  state: ResultListState;
  labels: ResultListLabels;
  locale: string;
  queryEpoch: number;
  onOpenFilters?: () => void;
  onRefresh: () => void;
  onRowOpen?: (event: Event) => void;
  onRowInvestigate?: (event: Event) => void;
  onPivot?: (patch: PivotPatch) => void;
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

  // Gate row interactivity on `status === "ready"`. Reviewer Round 8:
  // for same-filter Refresh the shell closes the peek at dispatch but
  // the `loading` branch above keeps rendering the previous slice so
  // the results region does not flash an empty panel. Leaving
  // `onRowOpen` / `onRowInvestigate` wired through that retained-
  // slice window would let a click on a stale row reopen Quick peek
  // on an event the fresh slice may no longer return — exactly the
  // stale-inspector window #290's state contract forbids. Dropping
  // the handlers makes the overlay button + investigate chevron
  // disappear, so the rows render as a read-only snapshot until the
  // fresh slice lands. Reviewer Round 3 removed the equivalent
  // window for Apply / chip × (the shell now clears events
  // synchronously on those paths), so this gate's hot target is the
  // Refresh case.
  const rowsInteractive = state.status === "ready";
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
            onRowOpen={rowsInteractive ? onRowOpen : undefined}
            onRowInvestigate={rowsInteractive ? onRowInvestigate : undefined}
            onPivot={rowsInteractive ? onPivot : undefined}
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
  onPivot,
}: {
  event: Event;
  labels: ResultListLabels;
  locale: string;
  onRowOpen?: (event: Event) => void;
  onRowInvestigate?: (event: Event) => void;
  onPivot?: (patch: PivotPatch) => void;
}) {
  const timezone = useTimezone();
  const timeFormat = useResolvedTimeFormat();
  const addressing = readEventAddressing(event);
  const identity = readEventIdentity(event);
  const kindLabel =
    EVENT_KIND_FRIENDLY_NAMES[event.__typename] ?? event.__typename;
  // Issue #290 acceptance: selecting any row opens the Quick peek.
  const canOpenPeek = typeof onRowOpen === "function";
  const isInteractive = canOpenPeek;
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
  const canInvestigate = typeof onRowInvestigate === "function";
  const pivot = onPivot;
  // Resolve the level pivot up front so the level badge can render
  // either as a plain Badge or as a pivot button without duplicating
  // the value-shape coercion in the JSX.
  const levelPatch = pivot ? buildLevelPivotPatch(event.level, labels) : null;
  const categoryPatch =
    pivot && event.category
      ? buildCategoryPivotPatch(event.category, labels)
      : null;
  const kindPatch = pivot
    ? buildPivotPatch("kind", { raw: event.__typename, display: kindLabel })
    : null;
  const userNamePatch =
    pivot && identity.userName
      ? buildPivotPatch("userName", {
          raw: identity.userName,
          display: identity.userName,
        })
      : null;
  const hostnamePatch =
    pivot && identity.hostname
      ? buildPivotPatch("hostname", {
          raw: identity.hostname,
          display: identity.hostname,
        })
      : null;
  return (
    <li
      className={cn(
        "bg-card border-border group relative rounded-md border px-3 py-2 transition-colors",
        isInteractive && "hover:bg-accent/40 focus-within:bg-accent/40",
      )}
    >
      {canOpenPeek ? (
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
            <PivotCell
              patch={levelPatch}
              onPivot={pivot}
              ariaLabel={
                levelPatch
                  ? labels.pivotActivate({
                      label: labels.pivotColumnLabels.level,
                      value: levelPatch.displayValue,
                    })
                  : undefined
              }
            >
              <Badge
                variant={levelBadgeVariant(event.level)}
                className="uppercase"
              >
                {labels.levelLabels[event.level] ?? event.level}
              </Badge>
            </PivotCell>
            <span className="text-muted-foreground text-xs tabular-nums">
              {formatEventTime(
                event.time,
                locale,
                labels.unknownTime,
                timezone,
                timeFormat,
              )}
            </span>
            <PivotCell
              patch={kindPatch}
              onPivot={pivot}
              ariaLabel={
                kindPatch
                  ? labels.pivotActivate({
                      label: labels.pivotColumnLabels.kind,
                      value: kindLabel,
                    })
                  : undefined
              }
            >
              <span className="text-foreground font-medium">{kindLabel}</span>
            </PivotCell>
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
              <PivotCell
                patch={categoryPatch}
                onPivot={pivot}
                ariaLabel={
                  categoryPatch
                    ? labels.pivotActivate({
                        label: labels.pivotColumnLabels.category,
                        value: categoryPatch.displayValue,
                      })
                    : undefined
                }
                className="hidden sm:inline-flex"
              >
                <Badge variant="outline" className="font-normal">
                  {labels.categoryLabels[event.category] ?? event.category}
                </Badge>
              </PivotCell>
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
                onPivot={pivot}
              />
            ) : null}
            {hasEndpoint ? (
              <span className="text-muted-foreground/70 hidden sm:inline">
                ·
              </span>
            ) : null}
            <span className="truncate">{event.sensor || labels.noSensor}</span>
            <IdentitySummary
              identity={identity}
              userNamePatch={userNamePatch}
              hostnamePatch={hostnamePatch}
              labels={labels}
              onPivot={pivot}
            />
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
  onPivot,
}: {
  orig: EndpointDisplay | null;
  resp: EndpointDisplay | null;
  labels: ResultListLabels;
  onPivot?: (patch: PivotPatch) => void;
}) {
  if (!orig && !resp) return null;
  // At narrow widths the two endpoints stack vertically and the `→`
  // glyph is suppressed — #280's density strategy keeps IPs and ports
  // visible but drops the horizontal source → destination layout.
  return (
    <span className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center">
      <EndpointPart
        endpoint={orig}
        labels={labels}
        onPivot={onPivot}
        side="orig"
      />
      <span className="text-muted-foreground/70 hidden sm:inline">
        {labels.endpointSeparator}
      </span>
      <EndpointPart
        endpoint={resp}
        labels={labels}
        onPivot={onPivot}
        side="resp"
      />
    </span>
  );
}

/**
 * Render the userName / hostname identity cells for an event row
 * (Phase Detection-28 / #347). Each cell renders as a labelled
 * pivot button (e.g. `User: jdoe`) when the event subtype emits the
 * underlying field; subtypes whose schema does not emit the field
 * render the cell as a non-pivotable `User: —` / `Host: —` token
 * so the column position stays stable across the result list and
 * the operator can tell that the row simply has no identity to
 * pivot on (rather than guessing whether the column was hidden).
 * #280's responsive density rules stay intact — severity, time,
 * and endpoints never depend on either cell.
 */
function IdentitySummary({
  identity,
  userNamePatch,
  hostnamePatch,
  labels,
  onPivot,
}: {
  identity: EventIdentity;
  userNamePatch: PivotPatch | null;
  hostnamePatch: PivotPatch | null;
  labels: ResultListLabels;
  onPivot?: (patch: PivotPatch) => void;
}) {
  return (
    <>
      <span className="text-muted-foreground/70 hidden sm:inline">·</span>
      <IdentityCell
        prefix={labels.userNameLabel}
        value={identity.userName}
        patch={userNamePatch}
        ariaLabel={
          userNamePatch && identity.userName
            ? labels.pivotActivate({
                label: labels.pivotColumnLabels.userName,
                value: identity.userName,
              })
            : undefined
        }
        onPivot={onPivot}
      />
      <span className="text-muted-foreground/70 hidden sm:inline">·</span>
      <IdentityCell
        prefix={labels.hostnameLabel}
        value={identity.hostname}
        patch={hostnamePatch}
        ariaLabel={
          hostnamePatch && identity.hostname
            ? labels.pivotActivate({
                label: labels.pivotColumnLabels.hostname,
                value: identity.hostname,
              })
            : undefined
        }
        onPivot={onPivot}
      />
    </>
  );
}

function IdentityCell({
  prefix,
  value,
  patch,
  ariaLabel,
  onPivot,
}: {
  prefix: string;
  value: string | null;
  patch: PivotPatch | null;
  ariaLabel?: string;
  onPivot?: (patch: PivotPatch) => void;
}) {
  // Subtypes whose schema does not emit the field render `prefix —`
  // as plain text so the column position stays stable across rows;
  // the dash is intentionally non-pivotable because there is no
  // value to merge into the active filter.
  if (!value) {
    return (
      <span className="inline-flex items-center">
        <span className="text-muted-foreground/70 mr-1">{prefix}</span>
        <span className="text-muted-foreground/60">—</span>
      </span>
    );
  }
  return (
    <PivotCell patch={patch} onPivot={onPivot} ariaLabel={ariaLabel}>
      <span className="text-muted-foreground/70 mr-1">{prefix}</span>
      <span className="text-foreground truncate" title={value}>
        {value}
      </span>
    </PivotCell>
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
  onPivot,
  side,
}: {
  endpoint: EndpointDisplay | null;
  labels: ResultListLabels;
  onPivot?: (patch: PivotPatch) => void;
  side: "orig" | "resp";
}) {
  if (!endpoint) return <span className="text-muted-foreground/60">—</span>;
  const portLabel = endpoint.port !== null ? `:${endpoint.port}` : "";
  const country = endpoint.country
    ? formatCountryShort(endpoint.country, labels)
    : null;
  const addrColumn: PivotColumnKey = side === "orig" ? "origAddr" : "respAddr";
  const countryColumn: PivotColumnKey =
    side === "orig" ? "origCountry" : "respCountry";
  const ipPatch = onPivot
    ? buildPivotPatch(addrColumn, {
        raw: endpoint.address,
        display: endpoint.address,
      })
    : null;
  // Country pivots use the literal code (e.g. "KR") rather than the
  // localized name, since the filter side stores ISO country codes.
  // The display string still substitutes the localized sentinel
  // ("Location unknown") when the code is `XX` / `ZZ` so the toast
  // reads naturally.
  const countryPatch =
    onPivot &&
    endpoint.country &&
    endpoint.country !== "XX" &&
    endpoint.country !== "ZZ"
      ? buildPivotPatch(countryColumn, {
          raw: endpoint.country,
          display: endpoint.country,
        })
      : null;
  return (
    <span className="text-foreground inline-flex items-center gap-1 font-mono text-xs">
      <PivotCell
        patch={ipPatch}
        onPivot={onPivot}
        ariaLabel={
          ipPatch
            ? labels.pivotActivate({
                label:
                  side === "orig"
                    ? labels.pivotColumnLabels.origAddr
                    : labels.pivotColumnLabels.respAddr,
                value: endpoint.address,
              })
            : undefined
        }
      >
        <span className="truncate" title={endpoint.address}>
          {endpoint.address}
          {portLabel}
        </span>
      </PivotCell>
      {endpoint.extraAddresses.length > 0 ? (
        <MorePopover
          count={endpoint.extraAddresses.length}
          values={endpoint.extraAddresses}
          moreCountSuffix={labels.moreCountSuffix}
        />
      ) : null}
      {endpoint.extraPorts.length > 0 ? (
        <MorePopover
          count={endpoint.extraPorts.length}
          values={endpoint.extraPorts.map((p) => String(p))}
          moreCountSuffix={labels.moreCountSuffix}
        />
      ) : null}
      {country ? (
        <PivotCell
          patch={countryPatch}
          onPivot={onPivot}
          ariaLabel={
            countryPatch
              ? labels.pivotActivate({
                  label:
                    side === "orig"
                      ? labels.pivotColumnLabels.origCountry
                      : labels.pivotColumnLabels.respCountry,
                  value: country,
                })
              : undefined
          }
          className="ml-1"
        >
          <span className="text-muted-foreground/80 normal-case">
            ({country})
          </span>
        </PivotCell>
      ) : null}
    </span>
  );
}

function formatCountryShort(code: string, labels: ResultListLabels): string {
  if (code === "XX") return labels.countryUnknown;
  if (code === "ZZ") return labels.countryUnavailable;
  return code;
}

/**
 * Wraps a pivotable cell value as a button that fires `onPivot`
 * when activated. When `patch` is null or `onPivot` is undefined
 * the children render verbatim — covers single-tab / standalone
 * shells and rows whose value is not pivotable in v1 (sensor,
 * customer placeholders).
 *
 * The cell layers above the row's overlay button via
 * `pointer-events-auto z-10`. The parent inner content carries
 * `pointer-events-none` so the row-open click does not steal
 * activation from cells the operator targets directly.
 */
function PivotCell({
  patch,
  onPivot,
  ariaLabel,
  className,
  children,
}: {
  patch: PivotPatch | null;
  onPivot?: (patch: PivotPatch) => void;
  ariaLabel?: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (!patch || !onPivot) {
    if (className) return <span className={className}>{children}</span>;
    return children;
  }
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onPivot(patch);
      }}
      className={cn(
        "pointer-events-auto relative z-10 inline-flex items-center rounded-sm",
        "hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "cursor-pointer",
        className,
      )}
      data-slot="detection-pivot-cell"
    >
      {children}
    </button>
  );
}

function buildLevelPivotPatch(
  level: ThreatLevel,
  labels: ResultListLabels,
): PivotPatch | null {
  return buildPivotPatch("level", {
    raw: level,
    display: labels.levelLabels[level] ?? level,
  });
}

function buildCategoryPivotPatch(
  category: ThreatCategory,
  labels: ResultListLabels,
): PivotPatch | null {
  const matchedValue = THREAT_CATEGORY_VALUES.find(
    (n) => THREAT_CATEGORY_KEY_BY_VALUE[n] === category,
  );
  if (matchedValue === undefined) return null;
  return buildPivotPatch("category", {
    raw: matchedValue,
    display: labels.categoryLabels[category] ?? category,
  });
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
