"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildStatisticsSeries,
  DEFAULT_STATISTICS_METRIC,
  exactDisplay,
  formatCount,
  formatMetricValue,
  STATISTICS_METRICS,
  type StatisticsMetric,
  type StatisticsRawEvent,
  type StatisticsSeriesDatum,
} from "@/lib/event";

import { EventResultContainer, EventStatePanel } from "./result-panels";

/**
 * Per-protocol line colors. A fixed palette (rather than a CSS token)
 * because the series count is data-driven — protocols cycle through
 * these in sorted order so a given protocol keeps a stable color within
 * one render.
 */
const SERIES_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#4f46e5",
  "#0d9488",
  "#9333ea",
] as const;

/** Compact UTC stamp `YYYY-MM-DD HH:mm` for axis ticks and tooltips. */
function formatStamp(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The Statistics aggregation chart. Renders one line per protocol for a
 * single selected metric (bps / pps / eps / count / size) — drawing
 * every metric × protocol at once is unreadable, so the metric is a
 * client-side selector over the already-fetched data (no refetch).
 *
 * `StatisticsInfo.timestamp` is epoch nanoseconds; the X-axis is the
 * converted epoch-millisecond bucket time, formatted as a compact UTC
 * stamp. 64-bit `count` / `size` are parsed BigInt-safe before
 * charting (see `buildStatisticsSeries`).
 */
export function StatisticsChart({
  events,
  locale,
}: {
  events: StatisticsRawEvent[];
  locale: string;
}) {
  const t = useTranslations("event.statistics");
  const tpr = useTranslations("event.protocols");
  const [metric, setMetric] = useState<StatisticsMetric>(
    DEFAULT_STATISTICS_METRIC,
  );

  const series = useMemo(
    () => buildStatisticsSeries(events, metric),
    [events, metric],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label htmlFor="stat-metric" className="text-sm">
          {t("metric")}
        </Label>
        <Select
          value={metric}
          onValueChange={(value) => setMetric(value as StatisticsMetric)}
        >
          <SelectTrigger id="stat-metric" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATISTICS_METRICS.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`metrics.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {series.data.length === 0 || series.protocols.length === 0 ? (
        <EventStatePanel message={t("noMetricData")} />
      ) : (
        <EventResultContainer className="h-80 w-full p-3 text-xs">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={series.data}
              margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
            >
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatStamp}
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                minTickGap={32}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                width={64}
                tickFormatter={(value) =>
                  typeof value === "number"
                    ? formatMetricValue(value, metric, locale)
                    : String(value)
                }
              />
              <Tooltip
                labelFormatter={(value) =>
                  typeof value === "number" ? formatStamp(value) : String(value)
                }
                formatter={(value, name, item) => {
                  // Prefer the exact BigInt total for count/size: the
                  // plotted `value` is rounded past 2^53, but the tooltip
                  // must show the integer Giganto returned.
                  const datum = item?.payload as
                    | StatisticsSeriesDatum
                    | undefined;
                  const exact =
                    datum && typeof datum.t === "number"
                      ? exactDisplay(series, datum.t, String(name))
                      : null;
                  const text =
                    exact !== null
                      ? formatCount(exact, locale)
                      : typeof value === "number"
                        ? formatMetricValue(value, metric, locale)
                        : String(value);
                  return [text, tpr(String(name))];
                }}
                labelStyle={{ fontSize: 11 }}
                contentStyle={{ fontSize: 11, padding: "4px 8px" }}
              />
              <Legend
                formatter={(value) => tpr(String(value))}
                wrapperStyle={{ fontSize: 11 }}
              />
              {series.protocols.map((protocol, index) => (
                <Line
                  key={protocol}
                  type="monotone"
                  dataKey={protocol}
                  stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </EventResultContainer>
      )}
    </div>
  );
}
