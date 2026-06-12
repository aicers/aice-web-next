"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { useTimestampFormatter } from "@/components/timestamp";
import type { NodeStatusSample } from "@/hooks/use-node-status-polling";
import { cn } from "@/lib/utils";

export type ResourceMetric = "cpu" | "memory" | "disk";

interface ResourceSparklineProps {
  metric: ResourceMetric;
  samples: readonly NodeStatusSample[];
  isStale: boolean;
  pollIntervalMs: number;
  lastSampleAt: Date | null;
}

interface SparklinePoint {
  x: number;
  y: number;
  segmentBoundary: boolean;
  capturedAt: Date;
}

const VIEWBOX_WIDTH = 240;
const VIEWBOX_HEIGHT = 48;
const PADDING = 4;

function ratioFor(
  metric: ResourceMetric,
  sample: NodeStatusSample,
): number | null {
  if (metric === "cpu") {
    if (sample.cpuUsage === null) return null;
    return Math.max(0, Math.min(1, sample.cpuUsage / 100));
  }
  if (metric === "memory") {
    if (sample.totalMemory === null || sample.usedMemory === null) return null;
    const total = Number(sample.totalMemory);
    const used = Number(sample.usedMemory);
    if (!Number.isFinite(total) || total <= 0) return null;
    return Math.max(0, Math.min(1, used / total));
  }
  // disk
  if (sample.totalDiskSpace === null || sample.usedDiskSpace === null) {
    return null;
  }
  const total = Number(sample.totalDiskSpace);
  const used = Number(sample.usedDiskSpace);
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, used / total));
}

function buildSegments(points: SparklinePoint[]): SparklinePoint[][] {
  // Break the polyline at any sample whose `segmentBoundary === true`.
  // Each returned segment is a contiguous run; gaps render as no line.
  const segments: SparklinePoint[][] = [];
  let current: SparklinePoint[] = [];
  for (const point of points) {
    if (point.segmentBoundary && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function ResourceSparkline({
  metric,
  samples,
  isStale,
  pollIntervalMs,
  lastSampleAt,
}: ResourceSparklineProps) {
  const t = useTranslations("nodes.detail.charts");

  const points = useMemo<SparklinePoint[]>(() => {
    if (samples.length === 0) return [];
    const usable: Array<{
      index: number;
      ratio: number;
      sample: NodeStatusSample;
      boundary: boolean;
    }> = [];
    // A boundary sample whose metric is null is filtered from the
    // plottable set, but its `segmentBoundary` flag must still split
    // the polyline — otherwise the next usable sample would fuse
    // across the gap and silently interpolate, exactly what the
    // segment-boundary rule forbids. Carry the boundary forward to
    // whichever usable sample renders next.
    let pendingBoundary = false;
    samples.forEach((sample, index) => {
      const ratio = ratioFor(metric, sample);
      if (ratio === null) {
        if (sample.segmentBoundary) pendingBoundary = true;
        return;
      }
      const boundary = sample.segmentBoundary || pendingBoundary;
      pendingBoundary = false;
      usable.push({ index, ratio, sample, boundary });
    });
    if (usable.length === 0) return [];
    const total = samples.length;
    const innerWidth = VIEWBOX_WIDTH - PADDING * 2;
    const innerHeight = VIEWBOX_HEIGHT - PADDING * 2;
    return usable.map(({ index, ratio, sample, boundary }) => {
      const x =
        total <= 1
          ? VIEWBOX_WIDTH / 2
          : PADDING + (index / (total - 1)) * innerWidth;
      const y = PADDING + (1 - ratio) * innerHeight;
      return {
        x,
        y,
        segmentBoundary: boundary,
        capturedAt: sample.capturedAt,
      };
    });
  }, [samples, metric]);

  const samplesLabel = useMemo(() => {
    if (samples.length === 0) return null;
    const elapsedMs =
      samples.length > 1
        ? samples[samples.length - 1].capturedAt.getTime() -
          samples[0].capturedAt.getTime()
        : pollIntervalMs;
    const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
    return t("samplesLabel", { samples: samples.length, minutes });
  }, [samples, pollIntervalMs, t]);

  // The progress bar's numeric label appends `lastSampleAt` only while
  // the buffer is stale — that's the rule from #312 / #376. The central
  // formatter hook defers the locale formatting until after mount
  // (`resolved` false / `format` null pre-mount) so SSR and the first
  // client paint agree on the markup.
  const { resolved, format } = useTimestampFormatter();
  const staleStamp =
    resolved && isStale && lastSampleAt !== null ? format(lastSampleAt) : null;

  const latestSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const latestRatio =
    latestSample !== null ? ratioFor(metric, latestSample) : null;
  const numericLabel = formatNumericLabel(t, metric, latestSample);
  const labelWithStamp =
    staleStamp !== null ? `${numericLabel} · ${staleStamp}` : numericLabel;

  const segments = buildSegments(points);
  const lastPoint = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div
      className="space-y-1"
      data-testid={`node-detail-sparkline-${metric}`}
      data-stale={isStale ? "true" : "false"}
      data-metric={metric}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{t(metric)}</span>
        {samplesLabel ? (
          <span
            className={cn(
              "text-muted-foreground text-xs",
              isStale && "text-amber-600",
            )}
            data-testid={`node-detail-sparkline-label-${metric}`}
          >
            {samplesLabel}
            {isStale ? ` · ${t("stale")}` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            {t("noSamples")}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t(metric)}
        className="h-12 w-full rounded-sm bg-muted/40"
      >
        {segments.map((segment, segIdx) => {
          if (segment.length < 2) return null;
          // Stable per-segment key from the segment's first capturedAt
          // — buildSegments preserves this across re-renders.
          const key = `${metric}-${segment[0].capturedAt.getTime()}`;
          const isLastSegment = segIdx === segments.length - 1;
          // Stale styling is restricted to the latest point (handled
          // by the `<circle>` below) and the trailing edge only — i.e.
          // the line stroke between the last two samples of the most
          // recent segment. Earlier segments and the leading portion
          // of the trailing segment stay in the normal `text-primary`
          // colour even while `isStale === true`. Without this split,
          // the whole rendered history would mute when stale, which
          // misrepresents what the operator is looking at.
          if (isStale && isLastSegment && segment.length >= 2) {
            const head = segment.slice(0, segment.length - 1);
            const tail = segment.slice(segment.length - 2);
            const headD =
              head.length >= 2
                ? head
                    .map(
                      (p, j) =>
                        `${j === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
                    )
                    .join(" ")
                : null;
            const tailD = tail
              .map(
                (p, j) =>
                  `${j === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
              )
              .join(" ");
            return (
              <g
                key={key}
                data-testid={`node-detail-sparkline-segment-${metric}-${key}`}
              >
                {headD !== null && (
                  <path
                    d={headD}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-primary"
                    data-testid={`node-detail-sparkline-segment-${metric}-${key}-head`}
                  />
                )}
                <path
                  d={tailD}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-muted-foreground"
                  data-testid={`node-detail-sparkline-segment-${metric}-${key}-tail`}
                />
              </g>
            );
          }
          const d = segment
            .map(
              (p, j) =>
                `${j === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
            )
            .join(" ");
          return (
            <path
              key={key}
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-primary"
              data-testid={`node-detail-sparkline-segment-${metric}-${key}`}
            />
          );
        })}
        {lastPoint !== null && (
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={isStale ? 2.5 : 2}
            className={cn(
              "fill-primary",
              isStale && "fill-amber-500 stroke-amber-600 stroke-[0.5]",
            )}
            data-testid={`node-detail-sparkline-latest-${metric}`}
          />
        )}
      </svg>
      {latestSample !== null && (
        <ResourceProgressBar
          ratio={latestRatio}
          label={labelWithStamp}
          isStale={isStale}
          testId={`node-detail-sparkline-progress-${metric}`}
        />
      )}
    </div>
  );
}

function formatBytes(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatNumericLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  metric: ResourceMetric,
  sample: NodeStatusSample | null,
): string {
  if (sample === null) return t("noSamples");
  if (metric === "cpu") {
    if (sample.cpuUsage === null) return t("noSamples");
    return t("cpuValue", { percent: sample.cpuUsage.toFixed(1) });
  }
  if (metric === "memory") {
    if (sample.totalMemory === null || sample.usedMemory === null) {
      return t("noSamples");
    }
    return t("memoryValue", {
      used: formatBytes(sample.usedMemory),
      total: formatBytes(sample.totalMemory),
    });
  }
  if (sample.totalDiskSpace === null || sample.usedDiskSpace === null) {
    return t("noSamples");
  }
  return t("diskValue", {
    used: formatBytes(sample.usedDiskSpace),
    total: formatBytes(sample.totalDiskSpace),
  });
}

function ResourceProgressBar({
  ratio,
  label,
  isStale,
  testId,
}: {
  ratio: number | null;
  label: string;
  isStale: boolean;
  testId: string;
}) {
  const pct = ratio !== null ? Math.min(100, Math.max(0, ratio * 100)) : null;
  const severity =
    pct === null
      ? "none"
      : pct >= 95
        ? "critical"
        : pct >= 80
          ? "warning"
          : "ok";
  return (
    <div
      className="flex flex-col gap-1"
      data-testid={testId}
      data-severity={severity}
      data-stale={isStale ? "true" : "false"}
    >
      <div className="bg-muted relative h-1.5 w-full overflow-hidden rounded">
        {pct !== null && (
          <div
            className={cn(
              "h-full rounded",
              severity === "critical" && "bg-destructive",
              severity === "warning" && "bg-amber-500",
              severity === "ok" && "bg-emerald-600",
              isStale && "opacity-60",
            )}
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        )}
      </div>
      <span
        className={cn(
          "text-muted-foreground text-xs",
          isStale && "text-amber-600",
        )}
      >
        {label}
      </span>
    </div>
  );
}
