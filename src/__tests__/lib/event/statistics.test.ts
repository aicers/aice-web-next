import { describe, expect, it } from "vitest";

import {
  coerceStatisticsMetric,
  EMPTY_STATISTICS_FILTER,
  isStatisticsMetric,
  isStatisticsProtocol,
  parseStatisticsFilterFromSearchParams,
  STATISTICS_PARAM_KEYS,
  type StatisticsFilter,
  statisticsFilterToSearchEntries,
  toStatisticsVariables,
} from "@/lib/event";

describe("statistics protocol/metric guards", () => {
  it("accepts the 0.27.0 allowed protocol keys and rejects others", () => {
    expect(isStatisticsProtocol("conn")).toBe(true);
    expect(isStatisticsProtocol("malformed_dns")).toBe(true);
    expect(isStatisticsProtocol("statistics")).toBe(true);
    expect(isStatisticsProtocol("telnet")).toBe(false);
    expect(isStatisticsProtocol("")).toBe(false);
  });

  it("coerces an unknown metric to the default", () => {
    expect(isStatisticsMetric("bps")).toBe(true);
    expect(isStatisticsMetric("throughput")).toBe(false);
    expect(coerceStatisticsMetric("size")).toBe("size");
    expect(coerceStatisticsMetric("nope")).toBe("bps");
    expect(coerceStatisticsMetric(undefined)).toBe("bps");
  });
});

describe("parseStatisticsFilterFromSearchParams", () => {
  it("returns the empty filter for no params", () => {
    expect(parseStatisticsFilterFromSearchParams({})).toEqual(
      EMPTY_STATISTICS_FILTER,
    );
  });

  it("splits, trims, and de-duplicates the sensor and protocol lists", () => {
    const filter = parseStatisticsFilterFromSearchParams({
      [STATISTICS_PARAM_KEYS.sensors]: "sensor-a, sensor-b ,sensor-a",
      [STATISTICS_PARAM_KEYS.protocols]: "conn,dns,conn",
      [STATISTICS_PARAM_KEYS.start]: "2026-06-09T00:00:00.000Z",
      [STATISTICS_PARAM_KEYS.end]: "2026-06-09T01:00:00.000Z",
    });
    expect(filter.sensors).toEqual(["sensor-a", "sensor-b"]);
    expect(filter.protocols).toEqual(["conn", "dns"]);
    expect(filter.start).toBe("2026-06-09T00:00:00.000Z");
    expect(filter.end).toBe("2026-06-09T01:00:00.000Z");
  });

  it("drops unknown protocol tokens from a hand-edited URL", () => {
    const filter = parseStatisticsFilterFromSearchParams({
      [STATISTICS_PARAM_KEYS.sensors]: "sensor-a",
      [STATISTICS_PARAM_KEYS.protocols]: "conn,telnet,tls",
    });
    expect(filter.protocols).toEqual(["conn", "tls"]);
  });

  it("ignores a repeated (array) param rather than mis-parsing it", () => {
    const filter = parseStatisticsFilterFromSearchParams({
      [STATISTICS_PARAM_KEYS.sensors]: ["sensor-a", "sensor-b"],
    });
    expect(filter.sensors).toEqual([]);
  });
});

describe("statisticsFilterToSearchEntries", () => {
  it("writes only the set fields, comma-joining the lists", () => {
    const filter: StatisticsFilter = {
      sensors: ["sensor-a", "sensor-b"],
      start: "2026-06-09T00:00:00.000Z",
      end: null,
      period: null,
      protocols: ["conn", "tls"],
    };
    expect(statisticsFilterToSearchEntries(filter)).toEqual([
      [STATISTICS_PARAM_KEYS.sensors, "sensor-a,sensor-b"],
      [STATISTICS_PARAM_KEYS.start, "2026-06-09T00:00:00.000Z"],
      [STATISTICS_PARAM_KEYS.protocols, "conn,tls"],
    ]);
  });

  it("round-trips through the URL parser", () => {
    const filter: StatisticsFilter = {
      sensors: ["s1", "s2"],
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-02T00:00:00.000Z",
      period: null,
      protocols: ["dns", "http"],
    };
    const source = Object.fromEntries(statisticsFilterToSearchEntries(filter));
    expect(parseStatisticsFilterFromSearchParams(source)).toEqual(filter);
  });

  it("emits nothing for the empty filter", () => {
    expect(statisticsFilterToSearchEntries(EMPTY_STATISTICS_FILTER)).toEqual(
      [],
    );
  });
});

describe("toStatisticsVariables", () => {
  it("returns null when no sensor is selected", () => {
    expect(toStatisticsVariables(EMPTY_STATISTICS_FILTER)).toBeNull();
  });

  it("emits sensors only when no time/protocol bounds are set", () => {
    expect(
      toStatisticsVariables({ ...EMPTY_STATISTICS_FILTER, sensors: ["s1"] }),
    ).toEqual({ sensors: ["s1"] });
  });

  it("includes time when a bound is set and protocols when non-empty", () => {
    expect(
      toStatisticsVariables({
        sensors: ["s1", "s2"],
        start: "2026-06-09T00:00:00.000Z",
        end: null,
        period: null,
        protocols: ["conn"],
      }),
    ).toEqual({
      sensors: ["s1", "s2"],
      time: { start: "2026-06-09T00:00:00.000Z", end: null },
      protocols: ["conn"],
    });
  });
});
