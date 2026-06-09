import { describe, expect, it } from "vitest";
import type { TimeSeriesNode } from "@/lib/event";
import { buildTimeSeries } from "@/lib/event";

describe("buildTimeSeries", () => {
  it("returns an empty series with no origin for no nodes", () => {
    expect(buildTimeSeries([])).toEqual({ origin: null, points: [] });
  });

  it("flattens a single node's data into index-keyed points", () => {
    const nodes: TimeSeriesNode[] = [
      { start: "2026-06-09T00:00:00Z", id: "p1", data: [1, 2, 3] },
    ];
    const series = buildTimeSeries(nodes);
    expect(series.origin).toBe("2026-06-09T00:00:00Z");
    expect(series.points).toEqual([
      { index: 0, value: 1 },
      { index: 1, value: 2 },
      { index: 2, value: 3 },
    ]);
  });

  it("orders nodes by start and concatenates with a continuous index", () => {
    const nodes: TimeSeriesNode[] = [
      { start: "2026-06-09T01:00:00Z", id: "p1", data: [10, 11] },
      { start: "2026-06-09T00:00:00Z", id: "p1", data: [1, 2] },
    ];
    const series = buildTimeSeries(nodes);
    expect(series.origin).toBe("2026-06-09T00:00:00Z");
    expect(series.points.map((p) => p.value)).toEqual([1, 2, 10, 11]);
    expect(series.points.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it("drops non-finite values so the axis cannot break", () => {
    const nodes: TimeSeriesNode[] = [
      {
        start: "2026-06-09T00:00:00Z",
        id: "p1",
        data: [1, Number.NaN, Number.POSITIVE_INFINITY, 4],
      },
    ];
    const series = buildTimeSeries(nodes);
    expect(series.points.map((p) => p.value)).toEqual([1, 4]);
    expect(series.points.map((p) => p.index)).toEqual([0, 1]);
  });

  it("sorts nodes with an unparseable start last, keeping their order", () => {
    const nodes: TimeSeriesNode[] = [
      { start: "not-a-date", id: "p1", data: [99] },
      { start: "2026-06-09T00:00:00Z", id: "p1", data: [1] },
    ];
    const series = buildTimeSeries(nodes);
    expect(series.origin).toBe("2026-06-09T00:00:00Z");
    expect(series.points.map((p) => p.value)).toEqual([1, 99]);
  });
});
