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
    expect(
      parsePivotSearchParams({ source: "10.0.0.5", other: "ignored" }),
    ).toEqual({
      source: "10.0.0.5",
      destination: undefined,
      kind: undefined,
      origPort: undefined,
      respPort: undefined,
      proto: undefined,
      window: undefined,
    });
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
    expect(
      pivotParamsFromFilterInput({
        start: "2026-04-22T00:00:00.000Z",
        end: "2026-04-22T01:00:00.000Z",
        keywords: [],
        hostnames: null,
      }),
    ).toEqual({
      source: undefined,
      destination: undefined,
      keywords: undefined,
      hostnames: undefined,
      userIds: undefined,
      userNames: undefined,
      userDepartments: undefined,
    });
  });

  it("merges pivot-only params with filter-side fields, letting filter-side win for overlaps", () => {
    expect(
      mergePivotParams(
        { source: "pivot-source", kind: "HttpThreat", window: "1d" },
        { source: "filter-source", keywords: ["a", "b"] },
      ),
    ).toEqual({
      source: "filter-source",
      destination: undefined,
      kind: "HttpThreat",
      origPort: undefined,
      respPort: undefined,
      proto: undefined,
      window: "1d",
      keywords: ["a", "b"],
      hostnames: undefined,
      userIds: undefined,
      userNames: undefined,
      userDepartments: undefined,
    });
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
