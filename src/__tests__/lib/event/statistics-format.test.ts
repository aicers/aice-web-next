import { describe, expect, it } from "vitest";

import {
  buildStatisticsSeries,
  formatMetricValue,
  metricValue,
  nanosToMillis,
  type StatisticsDetail,
  type StatisticsRawEvent,
} from "@/lib/event";

function detail(
  protocol: string,
  over: Partial<StatisticsDetail> = {},
): StatisticsDetail {
  return {
    protocol,
    bps: null,
    pps: null,
    eps: null,
    count: null,
    size: null,
    ...over,
  };
}

describe("nanosToMillis", () => {
  it("converts epoch nanoseconds to epoch milliseconds without precision loss", () => {
    // 2024-03-04T05:06:07Z in nanoseconds.
    expect(nanosToMillis("1709528767000000000")).toBe(1709528767000);
  });

  it("truncates sub-millisecond nanoseconds toward zero", () => {
    expect(nanosToMillis("1709528767000999999")).toBe(1709528767000);
  });

  it("returns null for a non-integer literal", () => {
    expect(nanosToMillis("not-a-number")).toBeNull();
    expect(nanosToMillis("1.5")).toBeNull();
    expect(nanosToMillis("")).toBeNull();
  });
});

describe("metricValue", () => {
  it("returns nullable floats as-is", () => {
    expect(metricValue(detail("conn", { bps: 1024.5 }), "bps")).toBe(1024.5);
    expect(metricValue(detail("conn", { bps: null }), "bps")).toBeNull();
  });

  it("parses StringNumberU64 count/size via BigInt", () => {
    expect(metricValue(detail("conn", { count: "120" }), "count")).toBe(120);
    expect(metricValue(detail("conn", { size: null }), "size")).toBeNull();
    expect(metricValue(detail("conn", { count: "x" }), "count")).toBeNull();
  });

  it("coerces a u64 above MAX_SAFE_INTEGER to a finite number for charting", () => {
    const value = metricValue(
      detail("dns", { count: "18446744073709551615" }),
      "count",
    );
    expect(value).not.toBeNull();
    expect(Number.isFinite(value as number)).toBe(true);
  });
});

describe("buildStatisticsSeries", () => {
  const events: StatisticsRawEvent[] = [
    {
      sensor: "sensor-a",
      stats: [
        {
          timestamp: "1709528767000000000",
          detail: [
            detail("conn", { bps: 1000, count: "10" }),
            detail("dns", { bps: 200, count: "5" }),
          ],
        },
        {
          timestamp: "1709528827000000000",
          detail: [detail("conn", { bps: 2000, count: "20" })],
        },
      ],
    },
  ];

  it("builds one ascending series per protocol for the chosen metric", () => {
    const { data, protocols } = buildStatisticsSeries(events, "bps");
    expect(protocols).toEqual(["conn", "dns"]);
    expect(data).toEqual([
      { t: 1709528767000, conn: 1000, dns: 200 },
      { t: 1709528827000, conn: 2000 },
    ]);
  });

  it("omits a protocol from a bucket where its metric is null", () => {
    const { data } = buildStatisticsSeries(events, "eps");
    // No eps anywhere → no protocol keys, no buckets retained.
    expect(data).toEqual([]);
  });

  it("sums across sensors that share a timestamp", () => {
    const multi: StatisticsRawEvent[] = [
      events[0],
      {
        sensor: "sensor-b",
        stats: [
          {
            timestamp: "1709528767000000000",
            detail: [detail("conn", { bps: 500 })],
          },
        ],
      },
    ];
    const { data } = buildStatisticsSeries(multi, "bps");
    expect(data[0]).toMatchObject({ t: 1709528767000, conn: 1500 });
  });

  it("skips buckets with a malformed timestamp", () => {
    const bad: StatisticsRawEvent[] = [
      {
        sensor: "sensor-a",
        stats: [
          { timestamp: "bad", detail: [detail("conn", { bps: 1 })] },
          {
            timestamp: "1709528767000000000",
            detail: [detail("conn", { bps: 2 })],
          },
        ],
      },
    ];
    const { data } = buildStatisticsSeries(bad, "bps");
    expect(data).toEqual([{ t: 1709528767000, conn: 2 }]);
  });
});

describe("formatMetricValue", () => {
  it("groups count/size as whole numbers", () => {
    expect(formatMetricValue(1234567, "count", "en-US")).toBe("1,234,567");
  });

  it("keeps up to two fractional digits for rates", () => {
    expect(formatMetricValue(1024.5, "bps", "en-US")).toBe("1,024.5");
  });
});
