import { describe, expect, it } from "vitest";

import { computePeriodRange } from "@/lib/detection/period";
import {
  coerceEventPeriod,
  computeEventPeriodRange,
  EVENT_PERIOD_KEYS,
  FILTER_PARAM_KEYS,
  filterToSearchEntries,
  isEventPeriodKey,
  parseFilterFromSearchParams,
  parseStatisticsFilterFromSearchParams,
  parseTimeSeriesFilterFromSearchParams,
  STATISTICS_PARAM_KEYS,
  statisticsFilterToSearchEntries,
  TIME_SERIES_PARAM_KEYS,
  timeSeriesFilterToSearchEntries,
} from "@/lib/event";

describe("EVENT_PERIOD_KEYS", () => {
  it("is the one-week-capped subset, in order, with no longer windows", () => {
    expect(EVENT_PERIOD_KEYS).toEqual(["1h", "12h", "1d", "1w"]);
    for (const longer of ["1m", "3m", "6m", "1y", "3y"]) {
      expect(EVENT_PERIOD_KEYS as readonly string[]).not.toContain(longer);
    }
  });
});

describe("isEventPeriodKey / coerceEventPeriod", () => {
  it("accepts only the Event-scoped keys", () => {
    for (const key of EVENT_PERIOD_KEYS) {
      expect(isEventPeriodKey(key)).toBe(true);
      expect(coerceEventPeriod(key)).toBe(key);
    }
  });

  it("drops longer Detection keys, unknown text, and nullish input to null", () => {
    for (const value of ["1m", "3y", "", "week", "1W"]) {
      expect(isEventPeriodKey(value)).toBe(false);
      expect(coerceEventPeriod(value)).toBeNull();
    }
    expect(coerceEventPeriod(null)).toBeNull();
    expect(coerceEventPeriod(undefined)).toBeNull();
  });
});

describe("computeEventPeriodRange", () => {
  it("reuses Detection's window so 1w matches Detection's 1w exactly", () => {
    const now = new Date("2026-06-11T12:00:00.000Z");
    for (const key of EVENT_PERIOD_KEYS) {
      expect(computeEventPeriodRange(key, now)).toEqual(
        computePeriodRange(key, now),
      );
    }
  });
});

describe("period round-trips through each view's URL filter state", () => {
  it("raw-events filter persists and re-parses a valid period", () => {
    const entries = filterToSearchEntries({
      ...parseFilterFromSearchParams({}),
      sensor: "s1",
      period: "1w",
    });
    const source = Object.fromEntries(entries);
    expect(source[FILTER_PARAM_KEYS.period]).toBe("1w");
    expect(parseFilterFromSearchParams(source).period).toBe("1w");
  });

  it("raw-events filter drops an out-of-range period to null on parse", () => {
    const filter = parseFilterFromSearchParams({
      [FILTER_PARAM_KEYS.period]: "3y",
    });
    expect(filter.period).toBeNull();
  });

  it("statistics filter persists and re-parses a valid period", () => {
    const entries = statisticsFilterToSearchEntries({
      sensors: ["s1"],
      start: null,
      end: null,
      period: "12h",
      protocols: [],
    });
    const source = Object.fromEntries(entries);
    expect(source[STATISTICS_PARAM_KEYS.period]).toBe("12h");
    expect(parseStatisticsFilterFromSearchParams(source).period).toBe("12h");
  });

  it("statistics filter drops an out-of-range period to null on parse", () => {
    const filter = parseStatisticsFilterFromSearchParams({
      [STATISTICS_PARAM_KEYS.period]: "1y",
    });
    expect(filter.period).toBeNull();
  });

  it("time-series filter persists and re-parses a valid period", () => {
    const entries = timeSeriesFilterToSearchEntries({
      id: "policy-1",
      start: null,
      end: null,
      period: "1d",
    });
    const source = Object.fromEntries(entries);
    expect(source[TIME_SERIES_PARAM_KEYS.period]).toBe("1d");
    expect(parseTimeSeriesFilterFromSearchParams(source).period).toBe("1d");
  });

  it("time-series filter drops an out-of-range period to null on parse", () => {
    const filter = parseTimeSeriesFilterFromSearchParams({
      [TIME_SERIES_PARAM_KEYS.period]: "6m",
    });
    expect(filter.period).toBeNull();
  });
});
