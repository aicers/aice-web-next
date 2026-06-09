/**
 * Shape the `periodicTimeSeries` response into a flat numeric series for
 * charting.
 *
 * Giganto returns the series as one or more `TimeSeries` nodes, each a
 * contiguous chunk with its own `start` origin and a `data: [Float!]`
 * array. The view draws a single line, so the nodes are ordered by
 * `start` and their `data` arrays concatenated into one index-keyed
 * series; the earliest `start` is surfaced as the series origin. The
 * values are plain `Float`s — no 64-bit string parsing is needed (unlike
 * Statistics) — but null/empty results are still guarded.
 */

import type { TimeSeriesNode } from "./types";

/** One plotted sample: its cumulative index and value. */
export interface TimeSeriesPoint {
  index: number;
  value: number;
}

export interface TimeSeriesData {
  /** Earliest node `start` (the series origin), or `null` when empty. */
  origin: string | null;
  points: TimeSeriesPoint[];
}

/** Parse a `DateTime` origin to epoch ms for ordering; `null` if invalid. */
function startMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build the flat, index-keyed series from the returned nodes. Nodes are
 * sorted by `start` ascending (nodes with an unparseable `start` keep
 * their original relative order, sorted last), then each finite `data`
 * value is appended with the next cumulative index. Non-finite values
 * are dropped so a stray `NaN`/`Infinity` cannot break the axis.
 */
export function buildTimeSeries(nodes: TimeSeriesNode[]): TimeSeriesData {
  const ordered = nodes
    .map((node, position) => ({ node, position, ms: startMs(node.start) }))
    .sort((a, b) => {
      if (a.ms === null && b.ms === null) return a.position - b.position;
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      return a.ms - b.ms;
    });

  const points: TimeSeriesPoint[] = [];
  for (const { node } of ordered) {
    for (const value of node.data) {
      if (typeof value === "number" && Number.isFinite(value)) {
        points.push({ index: points.length, value });
      }
    }
  }

  const origin = ordered.length > 0 ? ordered[0].node.start : null;
  return { origin, points };
}
