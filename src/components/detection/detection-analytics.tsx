"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type RunAnalyticsQueryResult,
  runAnalyticsQuery,
} from "@/app/[locale]/(dashboard)/detection/analytics-actions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_TOP_N_OPTIONS,
  type AnalyticsDimension,
  type AnalyticsTopN,
} from "@/lib/detection/analytics";
import type { Filter } from "@/lib/detection/filter";
import {
  THREAT_CATEGORY_KEY_BY_VALUE,
  THREAT_LEVEL_KEY_BY_VALUE,
} from "@/lib/detection/filter-options";
import { buildPivotPatch, type PivotPatch } from "@/lib/detection/pivot";
import type { ThreatCategory, ThreatLevel } from "@/lib/detection/types";
import { cn } from "@/lib/utils";

/**
 * Phase Detection-14 collapsible Top N + Time Series strip. The
 * outer toggle (chevron + label) lives in `DetectionShell` so it can
 * be rendered cheaply when collapsed; this component owns everything
 * inside the expanded panel — the two Recharts visualizations and
 * the lazy fetch contract.
 *
 * Reviewer Round 1 follow-ups baked in:
 *
 *   - Dimension and Top N are now controlled props rather than
 *     local state, so a tab switch (which remounts the shell) does
 *     not silently reset the selector to the default.
 *   - A small in-memory cache, keyed by
 *     `${filterIdentity}|${dimension}|${topN}`, holds the most
 *     recent successful payload so a collapse-then-reopen at the
 *     same inputs reuses the cached result instead of paying
 *     another pair of analytics queries. The Retry button bypasses
 *     the cache; an open strip whose inputs change re-fetches and
 *     replaces the cached entry.
 *   - The Recharts components (BarChart, AreaChart) replace the
 *     hand-rolled SVG so the chart-library criterion the issue
 *     calls out — the same library must also cover funnel /
 *     Sankey / stacked-bar for the upcoming Triage menu — is
 *     satisfied by a single concrete dependency. Recharts ships
 *     `<FunnelChart>`, `<Sankey>`, and stacked `<Bar stackId>`,
 *     so the Triage menu can reuse the same dependency without a
 *     second selection round.
 *
 * Fetch lifecycle:
 *
 *   - The shell mounts this component unconditionally so the
 *     dimension / topN selection survives a collapse-and-reopen
 *     within the same tab session, but `open=false` short-circuits
 *     the fetch effect — collapsed strips do not hit the server.
 *   - On first expansion (and on every change to `open` /
 *     `filterIdentity` / `dimension` / `topN` while open) the effect
 *     either reuses a cached payload or dispatches `runAnalyticsQuery`.
 *     An abort controller drops any stale response so a quick filter
 *     edit followed by a dimension flip lands on the latest pair.
 *   - The shell remounts this subtree on tab activation, so each
 *     tab carries its own selection independently — but because
 *     the cache only lives across collapse-reopen within the same
 *     mounted instance, a tab switch does start with an empty
 *     cache. That is intentional: the multi-tab snapshot tracks
 *     selection but not result rows, so re-fetching on activation
 *     gets the operator current data for the (possibly stale)
 *     filter the tab still carries.
 */

export interface DetectionAnalyticsLabels {
  dimensionLabel: string;
  /** Per-dimension label rendered in the dimension selector. */
  dimensionOptions: Record<AnalyticsDimension, string>;
  topNLabel: string;
  /** Template for the chart title that interpolates the dimension label. */
  topNChartTitleTemplate: string;
  timeSeriesTitle: string;
  /** Localized "%d events" label rendered in the bar tooltip / row. */
  countSuffix: (count: number) => string;
  /** Localized "Bucket: %s" label rendered alongside the period heuristic. */
  bucketLabel: (period: string) => string;
  /** Pre-formatted period descriptors for the bucket label. */
  periodValues: {
    seconds: (n: number) => string;
    minutes: (n: number) => string;
    hours: (n: number) => string;
    days: (n: number) => string;
    weeks: (n: number) => string;
  };
  loadingTitle: string;
  loadingDescription: string;
  errorTitle: string;
  errorDescription: string;
  errorRetry: string;
  forbiddenTitle: string;
  forbiddenDescription: string;
  emptyTitle: string;
  emptyDescription: string;
  /**
   * Localized labels for known categorical values so the chart axis
   * can show "High" instead of `3` for level / category dimensions.
   */
  levelLabels: Record<ThreatLevel, string>;
  categoryLabels: Record<ThreatCategory, string>;
  /** "Country unknown" sentinel labels — match REview's `XX` / `ZZ`. */
  countryUnknown: string;
  countryUnavailable: string;
  /** ARIA label for chart bars when pivoting is wired. */
  pivotActivate: (args: { label: string; value: string }) => string;
}

export interface DetectionAnalyticsProps {
  /**
   * Whether the strip is expanded. Required as a prop (not just a
   * conditional render) so the component can react to the
   * collapse-then-reopen transition without losing its cache.
   */
  open: boolean;
  /** Active tab's committed filter — drives both Top N and time series. */
  filter: Filter;
  /**
   * Stable identity string that changes when the filter changes.
   * Threaded in from the shell so this component does not have to
   * re-derive identity from `filter` (which is a structurally-shared
   * object that updates only when committed). Used as part of the
   * cache key as well, so a filter edit invalidates the cache.
   */
  filterIdentity: string;
  labels: DetectionAnalyticsLabels;
  /** Currently-selected dimension, owned by the shell so a tab switch survives. */
  dimension: AnalyticsDimension;
  /** Currently-selected Top N count, owned by the shell. */
  topN: AnalyticsTopN;
  onDimensionChange: (next: AnalyticsDimension) => void;
  onTopNChange: (next: AnalyticsTopN) => void;
  /**
   * Pivot click handler. When provided, slice / bar clicks build a
   * pivot patch and forward to the wrapper. When undefined, the
   * affordance is hidden.
   */
  onPivot?: (patch: PivotPatch) => void;
}

type ReadyResult = Extract<RunAnalyticsQueryResult, { ok: true }>;

type FetchStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; result: ReadyResult }
  | { kind: "error"; code: "forbidden" | "server-error" | "invalid-input" };

function cacheKey(
  filterIdentity: string,
  dimension: AnalyticsDimension,
  topN: AnalyticsTopN,
): string {
  return `${filterIdentity}|${dimension}|${topN}`;
}

export function DetectionAnalytics({
  open,
  filter,
  filterIdentity,
  labels,
  dimension,
  topN,
  onDimensionChange,
  onTopNChange,
  onPivot,
}: DetectionAnalyticsProps) {
  const [status, setStatus] = useState<FetchStatus>({ kind: "idle" });
  // Guard against late responses from a superseded request landing
  // after a more-recent dispatch — we drop the payload silently
  // rather than letting it overwrite the fresher state.
  const requestIdRef = useRef(0);
  // Reviewer Round 1 (P2 lazy fetch): cached successful payloads
  // keyed by `${filterIdentity}|${dimension}|${topN}`. A
  // collapse-then-reopen at the same inputs hits this map and
  // skips the network round-trip entirely. Lives in a ref so a
  // cache write does not trigger a re-render.
  const cacheRef = useRef<Map<string, ReadyResult>>(new Map());

  // Keep a live ref to `filter` so the dispatch closure does not need
  // to re-bind every time the shell hands down a structurally-shared
  // (but reference-different) filter object. The fetch effect drives
  // re-runs off `filterIdentity` instead, which only changes when the
  // committed filter actually differs.
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const dispatchFetch = useCallback(
    (signal?: AbortSignal) => {
      const requestId = ++requestIdRef.current;
      const key = cacheKey(filterIdentity, dimension, topN);
      setStatus({ kind: "loading" });
      void runAnalyticsQuery(filterRef.current, dimension, topN).then(
        (result) => {
          if (signal?.aborted) return;
          if (requestId !== requestIdRef.current) return;
          if (result.ok) {
            cacheRef.current.set(key, result);
            setStatus({ kind: "ready", result });
            return;
          }
          if (result.code === "forbidden") {
            setStatus({ kind: "error", code: "forbidden" });
            return;
          }
          if (result.code === "invalid-input") {
            setStatus({ kind: "error", code: "invalid-input" });
            return;
          }
          setStatus({ kind: "error", code: "server-error" });
        },
        () => {
          if (signal?.aborted) return;
          if (requestId !== requestIdRef.current) return;
          setStatus({ kind: "error", code: "server-error" });
        },
      );
    },
    [dimension, topN, filterIdentity],
  );

  useEffect(() => {
    if (!open) return;
    const key = cacheKey(filterIdentity, dimension, topN);
    const cached = cacheRef.current.get(key);
    if (cached) {
      // Reviewer Round 1 (P2 lazy fetch): a collapse-then-reopen with
      // the same inputs (or a dimension/topN flip back to a
      // previously-fetched value) reuses the prior payload instead of
      // dispatching another pair of analytics queries. The Retry
      // button bypasses this branch by calling `dispatchFetch`
      // directly.
      requestIdRef.current += 1;
      setStatus({ kind: "ready", result: cached });
      return;
    }
    const controller = new AbortController();
    dispatchFetch(controller.signal);
    return () => controller.abort();
  }, [open, filterIdentity, dimension, topN, dispatchFetch]);

  if (!open) return null;

  return (
    <div className="border-t border-[var(--sidebar-border)] px-3 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span
            className="text-muted-foreground"
            id="detection-analytics-dimension-label"
          >
            {labels.dimensionLabel}
          </span>
          <Select
            value={dimension}
            onValueChange={(v) => onDimensionChange(v as AnalyticsDimension)}
          >
            <SelectTrigger
              aria-labelledby="detection-analytics-dimension-label"
              className="h-8 w-[10.5rem] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ANALYTICS_DIMENSIONS.map((d) => (
                <SelectItem key={d} value={d}>
                  {labels.dimensionOptions[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className="text-muted-foreground"
            id="detection-analytics-top-n-label"
          >
            {labels.topNLabel}
          </span>
          <Select
            value={String(topN)}
            onValueChange={(v) => onTopNChange(Number(v) as AnalyticsTopN)}
          >
            <SelectTrigger
              aria-labelledby="detection-analytics-top-n-label"
              className="h-8 w-[5rem] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ANALYTICS_TOP_N_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={String(opt)}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <AnalyticsBody
        status={status}
        dimension={dimension}
        labels={labels}
        onRetry={() => dispatchFetch()}
        onPivot={onPivot}
      />
    </div>
  );
}

function AnalyticsBody({
  status,
  dimension,
  labels,
  onRetry,
  onPivot,
}: {
  status: FetchStatus;
  dimension: AnalyticsDimension;
  labels: DetectionAnalyticsLabels;
  onRetry: () => void;
  onPivot?: (patch: PivotPatch) => void;
}) {
  if (status.kind === "idle" || status.kind === "loading") {
    return (
      <StatePanel
        icon={<RefreshCw className="size-6 animate-spin" aria-hidden="true" />}
        title={labels.loadingTitle}
        description={labels.loadingDescription}
        tone="neutral"
      />
    );
  }
  if (status.kind === "error") {
    if (status.code === "forbidden") {
      return (
        <StatePanel
          icon={<TriangleAlert className="size-6" aria-hidden="true" />}
          title={labels.forbiddenTitle}
          description={labels.forbiddenDescription}
          tone="error"
        />
      );
    }
    return (
      <StatePanel
        icon={<TriangleAlert className="size-6" aria-hidden="true" />}
        title={labels.errorTitle}
        description={labels.errorDescription}
        tone="error"
        action={
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {labels.errorRetry}
          </Button>
        }
      />
    );
  }
  const { result } = status;
  const dimensionLabel = labels.dimensionOptions[dimension];
  const dimensionRows = buildDimensionRows(dimension, result.topN, labels);
  const topNEmpty = dimensionRows.length === 0;
  const seriesEmpty = result.series.length === 0;

  if (topNEmpty && seriesEmpty) {
    return (
      <StatePanel
        icon={null}
        title={labels.emptyTitle}
        description={labels.emptyDescription}
        tone="neutral"
      />
    );
  }

  const periodText = formatPeriod(result.periodSeconds, labels.periodValues);

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section>
        <header className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-foreground text-xs font-medium">
            {labels.topNChartTitleTemplate.replace(
              "{dimension}",
              dimensionLabel,
            )}
          </h3>
        </header>
        {topNEmpty ? (
          <p className="text-muted-foreground py-6 text-center text-xs">
            {labels.emptyDescription}
          </p>
        ) : (
          <TopNChart
            rows={dimensionRows}
            dimension={dimension}
            countSuffix={labels.countSuffix}
            pivotActivate={labels.pivotActivate}
            onPivot={onPivot}
            dimensionLabel={dimensionLabel}
          />
        )}
      </section>
      <section>
        <header className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-foreground text-xs font-medium">
            {labels.timeSeriesTitle}
          </h3>
          <span className="text-muted-foreground text-[11px]">
            {labels.bucketLabel(periodText)}
          </span>
        </header>
        {seriesEmpty ? (
          <p className="text-muted-foreground py-6 text-center text-xs">
            {labels.emptyDescription}
          </p>
        ) : (
          <TimeSeriesChart
            series={result.series}
            periodSeconds={result.periodSeconds}
            rangeStart={result.rangeStart}
            rangeEnd={result.rangeEnd}
            countSuffix={labels.countSuffix}
          />
        )}
      </section>
    </div>
  );
}

interface DimensionRow {
  /** Display label (already localized for level / category, raw for IP / kind / country). */
  label: string;
  /** Raw value for pivot patch construction. */
  rawValue: string | number;
  count: number;
}

function buildDimensionRows(
  dimension: AnalyticsDimension,
  topN: { values: string[]; counts: number[] },
  labels: DetectionAnalyticsLabels,
): DimensionRow[] {
  const out: DimensionRow[] = [];
  for (let i = 0; i < topN.values.length && i < topN.counts.length; i++) {
    const raw = topN.values[i];
    const count = topN.counts[i];
    if (typeof raw !== "string" || typeof count !== "number") continue;
    if (!Number.isFinite(count)) continue;
    if (dimension === "level") {
      const num = Number(raw);
      const key =
        Number.isInteger(num) && num in THREAT_LEVEL_KEY_BY_VALUE
          ? THREAT_LEVEL_KEY_BY_VALUE[num as 1 | 2 | 3]
          : null;
      out.push({
        label: key ? labels.levelLabels[key as ThreatLevel] : raw,
        rawValue: Number.isInteger(num) ? num : raw,
        count,
      });
      continue;
    }
    if (dimension === "category") {
      const num = Number(raw);
      const key =
        Number.isInteger(num) && num in THREAT_CATEGORY_KEY_BY_VALUE
          ? THREAT_CATEGORY_KEY_BY_VALUE[num]
          : null;
      out.push({
        label: key ? labels.categoryLabels[key] : raw,
        rawValue: Number.isInteger(num) ? num : raw,
        count,
      });
      continue;
    }
    if (dimension === "country") {
      const label =
        raw === "XX"
          ? labels.countryUnknown
          : raw === "ZZ"
            ? labels.countryUnavailable
            : raw;
      out.push({ label, rawValue: raw, count });
      continue;
    }
    out.push({ label: raw, rawValue: raw, count });
  }
  return out;
}

interface TopNDatum {
  label: string;
  rawValue: string | number;
  count: number;
  patch: PivotPatch | null;
  ariaLabel?: string;
}

/**
 * Recharts horizontal `BarChart`. Each bar's `Cell` carries a click
 * handler when the dimension supports a pivot patch; the chart
 * itself stays a single dependency so the upcoming Triage funnel
 * view can reuse the same library (`<FunnelChart>` / `<Sankey>` /
 * stacked `<Bar stackId>`).
 */
function TopNChart({
  rows,
  dimension,
  countSuffix,
  pivotActivate,
  onPivot,
  dimensionLabel,
}: {
  rows: DimensionRow[];
  dimension: AnalyticsDimension;
  countSuffix: (count: number) => string;
  pivotActivate: DetectionAnalyticsLabels["pivotActivate"];
  onPivot?: (patch: PivotPatch) => void;
  dimensionLabel: string;
}) {
  const data = useMemo<TopNDatum[]>(
    () =>
      rows.map((row) => {
        const patch = onPivot ? buildPivotForDimension(dimension, row) : null;
        const ariaLabel =
          patch && onPivot
            ? pivotActivate({ label: dimensionLabel, value: row.label })
            : undefined;
        return {
          label: row.label,
          rawValue: row.rawValue,
          count: row.count,
          patch,
          ariaLabel,
        };
      }),
    [rows, dimension, onPivot, pivotActivate, dimensionLabel],
  );
  const handleClick = useCallback(
    (datum: TopNDatum) => {
      if (datum.patch && onPivot) onPivot(datum.patch);
    },
    [onPivot],
  );
  // Recharts `<XAxis>` / `<YAxis>` ticks render the count + label;
  // the chart container picks up the responsive width from the
  // surrounding grid cell.
  const height = Math.max(120, rows.length * 28);
  return (
    <div className="text-xs">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
        >
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fontSize: 10 }}
            stroke="currentColor"
          />
          <YAxis
            type="category"
            dataKey="label"
            width={120}
            tick={{ fontSize: 10 }}
            stroke="currentColor"
            interval={0}
          />
          <Tooltip
            cursor={{ fill: "var(--accent)", fillOpacity: 0.1 }}
            formatter={(value) =>
              typeof value === "number" ? countSuffix(value) : String(value)
            }
            labelStyle={{ fontSize: 11 }}
            contentStyle={{ fontSize: 11, padding: "4px 8px" }}
          />
          <Bar
            dataKey="count"
            fill="var(--primary)"
            fillOpacity={0.7}
            isAnimationActive={false}
          >
            {data.map((datum) => (
              <Cell
                key={String(datum.rawValue)}
                cursor={datum.patch ? "pointer" : "default"}
                aria-label={datum.ariaLabel}
                onClick={datum.patch ? () => handleClick(datum) : undefined}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {/* SR-only fallback: bars expose tooltips on hover, but a screen
          reader cannot reach those. Surface the same numbers in a
          hidden list so AT users can browse the values, and so the
          rows remain pivotable via the keyboard for clickable
          dimensions. */}
      <ul className="sr-only">
        {rows.map((row) => {
          const patch = onPivot ? buildPivotForDimension(dimension, row) : null;
          const aria =
            patch && onPivot
              ? pivotActivate({ label: dimensionLabel, value: row.label })
              : undefined;
          return (
            <li key={`sr-${String(row.rawValue)}`}>
              {patch && onPivot ? (
                <button
                  type="button"
                  aria-label={aria}
                  onClick={() => onPivot(patch)}
                >
                  {row.label}: {countSuffix(row.count)}
                </button>
              ) : (
                <span>
                  {row.label}: {countSuffix(row.count)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Translate a Top N row into a {@link PivotPatch} for the dimensions
 * whose values map cleanly onto `EventListFilterInput`. Country is
 * intentionally excluded — REview's `eventCountsByCountry` mixes
 * originator and responder rows so a single click cannot decide
 * between `respCountry` and `origCountry` without ambiguity. The
 * caller hides the affordance when this returns `null`.
 */
function buildPivotForDimension(
  dimension: AnalyticsDimension,
  row: DimensionRow,
): PivotPatch | null {
  const display = row.label;
  if (dimension === "srcIp") {
    return buildPivotPatch("origAddr", { raw: String(row.rawValue), display });
  }
  if (dimension === "dstIp") {
    return buildPivotPatch("respAddr", { raw: String(row.rawValue), display });
  }
  if (dimension === "kind") {
    return buildPivotPatch("kind", { raw: String(row.rawValue), display });
  }
  if (dimension === "level") {
    if (typeof row.rawValue !== "number") return null;
    return buildPivotPatch("level", { raw: row.rawValue, display });
  }
  if (dimension === "category") {
    if (typeof row.rawValue !== "number") return null;
    return buildPivotPatch("category", { raw: row.rawValue, display });
  }
  return null;
}

interface TimeSeriesDatum {
  index: number;
  /** ISO label used in tooltip / X-axis when the filter has bounds. */
  stamp: string;
  count: number;
}

/**
 * Recharts `AreaChart` for the event-frequency series. The series
 * is densely-packed integers (one bucket per `period`) so the
 * X-axis only renders the first / last labels and the tooltip
 * shows the per-bucket time stamp computed from `rangeStart` +
 * `index * periodSeconds`.
 */
function TimeSeriesChart({
  series,
  periodSeconds,
  rangeStart,
  rangeEnd,
  countSuffix,
}: {
  series: number[];
  periodSeconds: number;
  rangeStart: string | null;
  rangeEnd: string | null;
  countSuffix: (count: number) => string;
}) {
  const data = useMemo<TimeSeriesDatum[]>(() => {
    const startMs = rangeStart ? Date.parse(rangeStart) : Number.NaN;
    const startBase = Number.isFinite(startMs) ? startMs : 0;
    return series.map((count, index) => {
      const stampMs = Number.isFinite(startMs)
        ? startBase + index * periodSeconds * 1000
        : null;
      return {
        index,
        stamp: stampMs !== null ? formatRangeStamp(new Date(stampMs)) : "",
        count: typeof count === "number" && Number.isFinite(count) ? count : 0,
      };
    });
  }, [series, rangeStart, periodSeconds]);
  const startLabel = rangeStart
    ? formatRangeStamp(new Date(Date.parse(rangeStart)))
    : "";
  const endLabel = rangeEnd
    ? formatRangeStamp(new Date(Date.parse(rangeEnd)))
    : "";
  return (
    <figure className="flex flex-col gap-1">
      <div className="text-primary h-24 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="index"
              hide
              type="number"
              domain={[0, data.length - 1 || 1]}
            />
            <YAxis hide allowDecimals={false} />
            <Tooltip
              labelFormatter={(_value, payload) =>
                payload && payload.length > 0
                  ? (payload[0].payload as TimeSeriesDatum).stamp
                  : ""
              }
              formatter={(value) =>
                typeof value === "number" ? countSuffix(value) : String(value)
              }
              labelStyle={{ fontSize: 11 }}
              contentStyle={{ fontSize: 11, padding: "4px 8px" }}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke="currentColor"
              fill="currentColor"
              fillOpacity={0.18}
              strokeWidth={1.25}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {(startLabel || endLabel) && (
        <figcaption className="text-muted-foreground flex items-center justify-between text-[10px] tabular-nums">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </figcaption>
      )}
    </figure>
  );
}

function formatRangeStamp(d: Date): string {
  if (!Number.isFinite(d.getTime())) return "";
  // Compact UTC stamp `YYYY-MM-DD HH:mm` so the caption stays narrow at
  // typical strip widths regardless of the user's locale; full locale
  // formatting lives on the result list and quick-peek inspector.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatPeriod(
  seconds: number,
  values: DetectionAnalyticsLabels["periodValues"],
): string {
  if (seconds < 60) return values.seconds(seconds);
  if (seconds < 3600) return values.minutes(Math.round(seconds / 60));
  if (seconds < 86400) return values.hours(Math.round(seconds / 3600));
  if (seconds < 7 * 86400) return values.days(Math.round(seconds / 86400));
  return values.weeks(Math.round(seconds / (7 * 86400)));
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
      className={cn(
        "flex flex-col items-center gap-2 rounded-md border border-dashed py-6 text-center",
        tone === "error"
          ? "border-destructive/40 text-destructive"
          : "border-[var(--sidebar-border)] text-muted-foreground",
      )}
    >
      {icon}
      <p className="text-foreground text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-sm text-xs">{description}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
