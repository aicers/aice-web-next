import { describe, expect, it } from "vitest";

import {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_TOP_N_OPTIONS,
  computeFrequencyPeriodSeconds,
  DEFAULT_ANALYTICS_DIMENSION,
  DEFAULT_ANALYTICS_TOP_N,
  filterTimeRangeSeconds,
} from "@/lib/detection";

describe("filterTimeRangeSeconds", () => {
  it("returns the span between valid ISO bounds", () => {
    expect(
      filterTimeRangeSeconds({
        start: "2026-04-22T11:00:00Z",
        end: "2026-04-22T12:00:00Z",
      }),
    ).toBe(3600);
  });

  it("returns null when either bound is missing", () => {
    expect(filterTimeRangeSeconds({ start: null, end: null })).toBeNull();
    expect(
      filterTimeRangeSeconds({ start: "2026-04-22T11:00:00Z", end: null }),
    ).toBeNull();
    expect(
      filterTimeRangeSeconds({ start: null, end: "2026-04-22T12:00:00Z" }),
    ).toBeNull();
  });

  it("returns null on malformed timestamps", () => {
    expect(
      filterTimeRangeSeconds({ start: "not a date", end: "also not" }),
    ).toBeNull();
  });

  it("returns null when end is at or before start", () => {
    expect(
      filterTimeRangeSeconds({
        start: "2026-04-22T12:00:00Z",
        end: "2026-04-22T11:00:00Z",
      }),
    ).toBeNull();
    expect(
      filterTimeRangeSeconds({
        start: "2026-04-22T12:00:00Z",
        end: "2026-04-22T12:00:00Z",
      }),
    ).toBeNull();
  });
});

describe("computeFrequencyPeriodSeconds", () => {
  function range(seconds: number) {
    const start = new Date("2026-04-22T00:00:00Z");
    const end = new Date(start.getTime() + seconds * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  it("falls back to the minimum 60s bucket when bounds are missing", () => {
    expect(computeFrequencyPeriodSeconds({})).toBe(60);
    expect(computeFrequencyPeriodSeconds({ start: null, end: null })).toBe(60);
  });

  it("uses 60s buckets for 1h windows (matches the issue's hint)", () => {
    expect(computeFrequencyPeriodSeconds(range(3600))).toBe(60);
  });

  it("uses 600s buckets for 1d windows (matches the issue's hint)", () => {
    expect(computeFrequencyPeriodSeconds(range(24 * 3600))).toBe(600);
  });

  it("uses 1h buckets for 1w windows", () => {
    expect(computeFrequencyPeriodSeconds(range(7 * 24 * 3600))).toBe(3600);
  });

  it("uses 6h buckets for ~1m windows (matches the issue's hint)", () => {
    expect(computeFrequencyPeriodSeconds(range(30 * 24 * 3600))).toBe(6 * 3600);
  });

  it("uses 1d buckets for ~3m windows", () => {
    expect(computeFrequencyPeriodSeconds(range(90 * 24 * 3600))).toBe(
      24 * 3600,
    );
  });

  it("uses 1w buckets for ~1y windows", () => {
    expect(computeFrequencyPeriodSeconds(range(365 * 24 * 3600))).toBe(
      7 * 24 * 3600,
    );
  });

  it("falls through to ~30d buckets for multi-year windows", () => {
    expect(computeFrequencyPeriodSeconds(range(3 * 365 * 24 * 3600))).toBe(
      30 * 24 * 3600,
    );
  });

  it("never returns a bucket smaller than the 60s floor", () => {
    expect(
      computeFrequencyPeriodSeconds({
        start: "2026-04-22T12:00:00Z",
        end: "2026-04-22T12:00:30Z",
      }),
    ).toBe(60);
  });
});

describe("analytics dimension vocabulary", () => {
  it("exposes the six dimensions the issue requires", () => {
    expect([...ANALYTICS_DIMENSIONS].sort()).toEqual([
      "category",
      "country",
      "dstIp",
      "kind",
      "level",
      "srcIp",
    ]);
  });

  it("exposes 5 / 10 / 20 as Top N choices with a default of 10", () => {
    expect([...ANALYTICS_TOP_N_OPTIONS]).toEqual([5, 10, 20]);
    expect(DEFAULT_ANALYTICS_TOP_N).toBe(10);
  });

  it("defaults to a dimension that lives in the vocabulary", () => {
    expect(ANALYTICS_DIMENSIONS).toContain(DEFAULT_ANALYTICS_DIMENSION);
  });
});
