import { describe, expect, it } from "vitest";

import {
  EMPTY_TIME_SERIES_FILTER,
  parseTimeSeriesFilterFromSearchParams,
  TIME_SERIES_PARAM_KEYS,
  type TimeSeriesFilter,
  timeSeriesFilterToSearchEntries,
  toTimeSeriesFilterInput,
} from "@/lib/event";

describe("parseTimeSeriesFilterFromSearchParams", () => {
  it("returns the empty filter for no params", () => {
    expect(parseTimeSeriesFilterFromSearchParams({})).toEqual(
      EMPTY_TIME_SERIES_FILTER,
    );
  });

  it("reads the id and time bounds", () => {
    const filter = parseTimeSeriesFilterFromSearchParams({
      [TIME_SERIES_PARAM_KEYS.id]: "policy-1",
      [TIME_SERIES_PARAM_KEYS.start]: "2026-06-09T00:00:00.000Z",
      [TIME_SERIES_PARAM_KEYS.end]: "2026-06-09T01:00:00.000Z",
    });
    expect(filter).toEqual({
      id: "policy-1",
      start: "2026-06-09T00:00:00.000Z",
      end: "2026-06-09T01:00:00.000Z",
    });
  });

  it("trims and drops empty values", () => {
    const filter = parseTimeSeriesFilterFromSearchParams({
      [TIME_SERIES_PARAM_KEYS.id]: "  policy-2  ",
      [TIME_SERIES_PARAM_KEYS.start]: "   ",
    });
    expect(filter.id).toBe("policy-2");
    expect(filter.start).toBeNull();
  });

  it("ignores a repeated (array) param rather than mis-parsing it", () => {
    const filter = parseTimeSeriesFilterFromSearchParams({
      [TIME_SERIES_PARAM_KEYS.id]: ["policy-1", "policy-2"],
    });
    expect(filter.id).toBeNull();
  });
});

describe("timeSeriesFilterToSearchEntries", () => {
  it("writes only the set fields", () => {
    const filter: TimeSeriesFilter = {
      id: "policy-1",
      start: "2026-06-09T00:00:00.000Z",
      end: null,
    };
    expect(timeSeriesFilterToSearchEntries(filter)).toEqual([
      [TIME_SERIES_PARAM_KEYS.id, "policy-1"],
      [TIME_SERIES_PARAM_KEYS.start, "2026-06-09T00:00:00.000Z"],
    ]);
  });

  it("round-trips through the URL parser", () => {
    const filter: TimeSeriesFilter = {
      id: "policy-9",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-02T00:00:00.000Z",
    };
    const source = Object.fromEntries(timeSeriesFilterToSearchEntries(filter));
    expect(parseTimeSeriesFilterFromSearchParams(source)).toEqual(filter);
  });

  it("emits nothing for the empty filter", () => {
    expect(timeSeriesFilterToSearchEntries(EMPTY_TIME_SERIES_FILTER)).toEqual(
      [],
    );
  });
});

describe("toTimeSeriesFilterInput", () => {
  it("returns null when no id is selected", () => {
    expect(toTimeSeriesFilterInput(EMPTY_TIME_SERIES_FILTER)).toBeNull();
  });

  it("emits the id only when no time bounds are set", () => {
    expect(
      toTimeSeriesFilterInput({ id: "policy-1", start: null, end: null }),
    ).toEqual({ id: "policy-1" });
  });

  it("includes the time window when a bound is set", () => {
    expect(
      toTimeSeriesFilterInput({
        id: "policy-1",
        start: "2026-06-09T00:00:00.000Z",
        end: null,
      }),
    ).toEqual({
      id: "policy-1",
      time: { start: "2026-06-09T00:00:00.000Z", end: null },
    });
  });
});
