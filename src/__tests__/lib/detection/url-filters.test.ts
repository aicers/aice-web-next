import { describe, expect, it } from "vitest";

import {
  buildDetectionPivotUrl,
  buildPivotChips,
  parsePivotSearchParams,
} from "@/lib/detection/url-filters";

const chipLabels = {
  source: "Source IP",
  destination: "Destination IP",
  kind: "Kind",
  origPort: "Source port",
  respPort: "Destination port",
  proto: "Protocol",
  window: "Window",
  windowLastDay: "Last 24 hours",
  windowLastWeek: "Last 7 days",
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
      label: "Window",
      value: "Last 7 days",
    });
  });

  it("returns an empty array when nothing is set", () => {
    expect(buildPivotChips({}, chipLabels)).toEqual([]);
  });
});
