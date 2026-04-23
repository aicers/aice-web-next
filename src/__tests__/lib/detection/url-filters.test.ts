import { describe, expect, it } from "vitest";

import {
  buildDetectionPivotUrl,
  buildPivotChips,
  mergePivotParams,
  parsePivotSearchParams,
  pivotParamsFromFilterInput,
} from "@/lib/detection/url-filters";

const chipLabels = {
  source: "Source",
  destination: "Destination",
  kind: "Kind",
  origPort: "Source port",
  respPort: "Destination port",
  proto: "Protocol",
  window: "Window",
  windowLastDay: "Last 24 hours",
  windowLastWeek: "Last 7 days",
  keywords: "Keywords",
  hostnames: "Hostnames",
  userIds: "User IDs",
  userNames: "User Names",
  userDepartments: "User Departments",
  countAggregate: (label: string, count: number) => `${label}: ${count}`,
};

describe("parsePivotSearchParams", () => {
  it("ignores unknown keys", () => {
    const parsed = parsePivotSearchParams({
      source: "10.0.0.5",
      other: "ignored",
    });
    expect(parsed.source).toBe("10.0.0.5");
    expect(parsed.destination).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
    expect(parsed.kinds).toBeUndefined();
    expect(parsed.window).toBeUndefined();
    expect(parsed.levels).toBeUndefined();
    expect(parsed.directions).toBeUndefined();
  });

  it("parses the extended filter dimensions introduced in round 6", () => {
    const parsed = parsePivotSearchParams({
      kinds: "HttpThreat,NetworkThreat",
      level: "1,3",
      country: "US,KR",
      category: "100,200",
      learningMethod: "UNSUPERVISED,SEMI_SUPERVISED",
      direction: "INBOUND,OUTBOUND",
      confMin: "0.50",
      confMax: "0.90",
      sensor: "sensor-a,sensor-b",
      start: "2026-04-22T00:00:00.000Z",
      end: "2026-04-22T01:00:00.000Z",
    });
    expect(parsed.kinds).toEqual(["HttpThreat", "NetworkThreat"]);
    expect(parsed.levels).toEqual([1, 3]);
    expect(parsed.countries).toEqual(["US", "KR"]);
    expect(parsed.categories).toEqual([100, 200]);
    expect(parsed.learningMethods).toEqual(["UNSUPERVISED", "SEMI_SUPERVISED"]);
    expect(parsed.directions).toEqual(["INBOUND", "OUTBOUND"]);
    expect(parsed.confMin).toBe(0.5);
    expect(parsed.confMax).toBe(0.9);
    expect(parsed.sensors).toEqual(["sensor-a", "sensor-b"]);
    expect(parsed.start).toBe("2026-04-22T00:00:00.000Z");
    expect(parsed.end).toBe("2026-04-22T01:00:00.000Z");
  });

  it("rejects invalid enum entries and out-of-range confidence values", () => {
    const parsed = parsePivotSearchParams({
      direction: "ZZZ,INBOUND",
      learningMethod: "NOT_A_METHOD,UNSUPERVISED",
      confMin: "-1",
      confMax: "1.5",
    });
    expect(parsed.directions).toEqual(["INBOUND"]);
    expect(parsed.learningMethods).toEqual(["UNSUPERVISED"]);
    expect(parsed.confMin).toBeUndefined();
    expect(parsed.confMax).toBeUndefined();
  });

  it("coerces numeric fields and rejects non-numeric values", () => {
    expect(parsePivotSearchParams({ origPort: "54321" }).origPort).toBe(54321);
    expect(
      parsePivotSearchParams({ origPort: "abc" }).origPort,
    ).toBeUndefined();
  });

  it("accepts only known window values", () => {
    expect(parsePivotSearchParams({ window: "1d" }).window).toBe("1d");
    expect(parsePivotSearchParams({ window: "7d" }).window).toBe("7d");
    expect(parsePivotSearchParams({ window: "42h" }).window).toBeUndefined();
  });

  it("drops array-shaped values", () => {
    expect(
      parsePivotSearchParams({ source: ["10.0.0.5", "10.0.0.6"] }).source,
    ).toBeUndefined();
  });

  it("parses comma-separated list fields and trims/drops empties", () => {
    expect(
      parsePivotSearchParams({ keywords: "alpha, beta , ,gamma" }).keywords,
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  it("treats an empty list as absent (undefined)", () => {
    expect(
      parsePivotSearchParams({ keywords: " , , " }).keywords,
    ).toBeUndefined();
    expect(parsePivotSearchParams({ keywords: "" }).keywords).toBeUndefined();
  });

  it("dedupes list fields so a crafted URL can't produce duplicate values", () => {
    expect(
      parsePivotSearchParams({ keywords: "alpha,alpha,beta,alpha" }).keywords,
    ).toEqual(["alpha", "beta"]);
    expect(
      parsePivotSearchParams({ hostnames: "host-a, host-b , host-a" })
        .hostnames,
    ).toEqual(["host-a", "host-b"]);
  });
});

describe("buildDetectionPivotUrl", () => {
  it("returns a bare /detection URL when no params are set", () => {
    expect(buildDetectionPivotUrl({})).toBe("/detection");
  });

  it("encodes the full same-session pivot", () => {
    expect(
      buildDetectionPivotUrl({
        source: "10.0.0.5",
        destination: "203.0.113.45",
        origPort: 54321,
        respPort: 80,
        proto: 6,
        window: "1d",
      }),
    ).toBe(
      "/detection?source=10.0.0.5&destination=203.0.113.45&origPort=54321&respPort=80&proto=6&window=1d",
    );
  });

  it("encodes array fields as comma-separated lists and round-trips", () => {
    const url = buildDetectionPivotUrl({
      keywords: ["alpha", "beta"],
      hostnames: ["h1"],
    });
    // URLSearchParams may percent-encode the comma; parsePivotSearchParams
    // must decode it back to the original array regardless.
    const query = Object.fromEntries(
      new URLSearchParams(url.split("?")[1] ?? ""),
    );
    expect(parsePivotSearchParams(query).keywords).toEqual(["alpha", "beta"]);
    expect(parsePivotSearchParams(query).hostnames).toEqual(["h1"]);
  });

  it("omits empty arrays so cleared tag inputs disappear from the URL", () => {
    expect(buildDetectionPivotUrl({ keywords: [] })).toBe("/detection");
  });
});

describe("buildPivotChips", () => {
  it("renders chips in a stable order", () => {
    const chips = buildPivotChips(
      {
        source: "10.0.0.5",
        destination: "203.0.113.45",
        kind: "HttpThreat",
        window: "7d",
      },
      chipLabels,
    );
    expect(chips.map((chip) => chip.id)).toEqual([
      "source",
      "destination",
      "kind",
      "window",
    ]);
    expect(chips[3]).toEqual({
      id: "window",
      field: "window",
      label: "Window",
      value: "Last 7 days",
    });
  });

  it("returns an empty array when nothing is set", () => {
    expect(buildPivotChips({}, chipLabels)).toEqual([]);
  });

  it("expands array fields to individual chips when at or below the threshold", () => {
    const chips = buildPivotChips(
      { keywords: ["alpha", "beta", "gamma"] },
      chipLabels,
    );
    expect(chips.map((c) => c.value)).toEqual(["alpha", "beta", "gamma"]);
    expect(chips.every((c) => c.field === "keywords")).toBe(true);
    expect(chips.some((c) => c.aggregate)).toBe(false);
  });

  it("yields nothing for a filter input whose free-form fields are all empty/null", () => {
    const params = pivotParamsFromFilterInput({
      start: "2026-04-22T00:00:00.000Z",
      end: "2026-04-22T01:00:00.000Z",
      keywords: [],
      hostnames: null,
    });
    expect(params.source).toBeUndefined();
    expect(params.destination).toBeUndefined();
    expect(params.keywords).toBeUndefined();
    expect(params.hostnames).toBeUndefined();
    expect(params.userIds).toBeUndefined();
    expect(params.userNames).toBeUndefined();
    expect(params.userDepartments).toBeUndefined();
  });

  it("merges pivot-only params with filter-side fields, letting filter-side win for overlaps", () => {
    const merged = mergePivotParams(
      { source: "pivot-source", kind: "HttpThreat", window: "1d" },
      { source: "filter-source", keywords: ["a", "b"] },
    );
    expect(merged.source).toBe("filter-source");
    expect(merged.kind).toBe("HttpThreat");
    expect(merged.window).toBe("1d");
    expect(merged.keywords).toEqual(["a", "b"]);
    expect(merged.destination).toBeUndefined();
  });

  it("aggregates array fields to a single count chip past the threshold", () => {
    const chips = buildPivotChips(
      {
        hostnames: ["h1", "h2", "h3", "h4", "h5", "h6", "h7"],
      },
      chipLabels,
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({
      id: "hostnames:agg",
      field: "hostnames",
      label: "Hostnames",
      value: "Hostnames: 7",
      aggregate: true,
    });
  });
});
