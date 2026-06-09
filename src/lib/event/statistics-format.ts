/**
 * Pure parsing/charting helpers for the Statistics view. Kept in the
 * lib (not the component) so they are unit-testable.
 *
 * Two upstream shapes need care before they reach recharts:
 *
 *   - `StatisticsInfo.timestamp` is `StringNumberI64` — the bucket key
 *     in **epoch nanoseconds**, as a string. It is converted to epoch
 *     milliseconds via `BigInt` (never `Number` on the raw value) so a
 *     19-digit nanosecond key does not lose precision before the
 *     millisecond divide.
 *   - `count` / `size` are nullable `StringNumberU64` and can exceed
 *     `Number.MAX_SAFE_INTEGER`. They are parsed BigInt-safe and only
 *     then coerced to `number` for plotting (recharts needs a number);
 *     the exact integer is preserved for display via {@link formatCount}.
 */

import { formatCount } from "./format";
import type { StatisticsMetric } from "./statistics";
import type { StatisticsDetail, StatisticsRawEvent } from "./types";

const NS_PER_MS = BigInt(1_000_000);

/**
 * Convert an epoch-nanosecond `StringNumberI64` timestamp to epoch
 * milliseconds. Returns `null` for a non-integer literal so a malformed
 * bucket key is skipped rather than charted at the epoch.
 */
export function nanosToMillis(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  try {
    const ms = BigInt(value) / NS_PER_MS;
    const millis = Number(ms);
    return Number.isFinite(millis) ? millis : null;
  } catch {
    return null;
  }
}

/**
 * Extract one metric from a `StatisticsDetail` as a chartable number,
 * or `null` when the value is absent/malformed. `bps` / `pps` / `eps`
 * are nullable floats; `count` / `size` are nullable `StringNumberU64`
 * strings parsed BigInt-safe before the `number` coercion.
 */
export function metricValue(
  detail: StatisticsDetail,
  metric: StatisticsMetric,
): number | null {
  if (metric === "bps" || metric === "pps" || metric === "eps") {
    const value = detail[metric];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  const raw = detail[metric];
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return null;
  try {
    const value = Number(BigInt(raw));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** A single timestamp bucket: `t` plus one numeric value per protocol. */
export type StatisticsSeriesDatum = { t: number } & Record<string, number>;

export interface StatisticsSeries {
  /** Buckets sorted ascending by `t` (epoch milliseconds). */
  data: StatisticsSeriesDatum[];
  /** Protocol keys present in the data, sorted for stable series order. */
  protocols: string[];
}

/**
 * Build the per-protocol series for one metric from the raw
 * `statistics` result.
 *
 * `statistics` returns one timeline per sensor; the Statistics view can
 * select several sensors, so buckets that share a timestamp are summed
 * across sensors per protocol (every metric here is additive — total
 * bps / pps / eps / count / size). A protocol with no non-null value at
 * a timestamp is left absent from that bucket rather than plotted as 0.
 */
export function buildStatisticsSeries(
  events: StatisticsRawEvent[],
  metric: StatisticsMetric,
): StatisticsSeries {
  const buckets = new Map<number, Map<string, number>>();
  const protocolSet = new Set<string>();

  for (const event of events) {
    for (const info of event.stats) {
      const ms = nanosToMillis(info.timestamp);
      if (ms === null) continue;
      let row = buckets.get(ms);
      if (!row) {
        row = new Map();
        buckets.set(ms, row);
      }
      for (const detail of info.detail) {
        const value = metricValue(detail, metric);
        if (value === null) continue;
        protocolSet.add(detail.protocol);
        row.set(detail.protocol, (row.get(detail.protocol) ?? 0) + value);
      }
    }
  }

  const protocols = [...protocolSet].sort();
  const data: StatisticsSeriesDatum[] = [...buckets.entries()]
    .filter(([, row]) => row.size > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([t, row]) => {
      const datum: StatisticsSeriesDatum = { t };
      for (const protocol of protocols) {
        const value = row.get(protocol);
        if (value !== undefined) datum[protocol] = value;
      }
      return datum;
    });

  return { data, protocols };
}

/**
 * Format a charted metric value for tooltips. `count` / `size` are
 * whole numbers grouped via {@link formatCount}; the per-second rates
 * keep up to two fractional digits.
 */
export function formatMetricValue(
  value: number,
  metric: StatisticsMetric,
  locale: string,
): string {
  if (metric === "count" || metric === "size") {
    return formatCount(String(Math.round(value)), locale);
  }
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}
