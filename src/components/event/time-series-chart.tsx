"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { buildTimeSeries, type TimeSeriesNode } from "@/lib/event";

import { EventResultContainer, EventStatePanel } from "./result-panels";

const LINE_COLOR = "#2563eb";

/** Locale-aware compact number for axis ticks and tooltips. */
function formatValue(value: number, locale: string): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * The Periodic Time Series chart. Giganto returns the series as one or
 * more `TimeSeries` nodes; {@link buildTimeSeries} orders them by their
 * `start` origin and concatenates the `data` arrays into one line. The
 * X-axis is the cumulative sample index (the series carries no
 * per-sample interval), and the earliest `start` is shown as the origin.
 * Values are plain `Float`s, so no 64-bit parsing is needed.
 */
export function TimeSeriesChart({
  nodes,
  locale,
}: {
  nodes: TimeSeriesNode[];
  locale: string;
}) {
  const t = useTranslations("event.timeSeries");
  const series = useMemo(() => buildTimeSeries(nodes), [nodes]);

  if (series.points.length === 0) {
    return <EventStatePanel message={t("noData")} />;
  }

  return (
    <div className="space-y-3">
      {series.origin ? (
        <p className="text-muted-foreground text-xs">
          {t("origin", { start: series.origin })}
        </p>
      ) : null}
      <EventResultContainer className="h-80 w-full p-3 text-xs">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={series.points}
            margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          >
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="index"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              minTickGap={32}
              allowDecimals={false}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              width={64}
              tickFormatter={(value) =>
                typeof value === "number" ? formatValue(value, locale) : ""
              }
            />
            <Tooltip
              labelFormatter={(value) =>
                t("sample", { index: typeof value === "number" ? value : 0 })
              }
              formatter={(value) => [
                typeof value === "number" ? formatValue(value, locale) : "",
                t("value"),
              ]}
              labelStyle={{ fontSize: 11 }}
              contentStyle={{ fontSize: 11, padding: "4px 8px" }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={LINE_COLOR}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </EventResultContainer>
    </div>
  );
}
