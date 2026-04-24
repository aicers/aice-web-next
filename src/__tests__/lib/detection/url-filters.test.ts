import { describe, expect, it } from "vitest";

import {
  buildDetectionPivotUrl,
  buildPivotChips,
  mergePivotParams,
  parsePivotSearchParams,
  periodKeyToPivotWindow,
  pivotParamsFromFilterInput,
  pivotWindowToPeriodKey,
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

describe("pivotWindowToPeriodKey", () => {
  // The Detection page feeds pivot URLs like `/detection?source=X&window=1d`
  // through this mapping when seeding the committed filter's start/end —
  // the reviewer flagged that Quick peek / Related Events pivots were
  // landing on the default 1h period because the window was silently
  // dropped. Pin the mapping so a regression in either direction
  // (missing case, wrong period key) is caught at unit-test time
  // rather than only surfacing as a destination-page query.
  it("maps `1d` onto the `1d` period key", () => {
    expect(pivotWindowToPeriodKey("1d")).toBe("1d");
  });

  it("maps `7d` onto the `1w` period key (drawer calendar vocabulary)", () => {
    expect(pivotWindowToPeriodKey("7d")).toBe("1w");
  });

  it("returns null when no window is specified", () => {
    expect(pivotWindowToPeriodKey(undefined)).toBeNull();
  });
});

describe("periodKeyToPivotWindow", () => {
  // The Detection URL writer calls this when extracting `window=`
  // from the committed period so a drawer edit (period swap, chip
  // removal) replaces — rather than inherits — the first-render
  // pivot token. Pin the inverse mapping so the two sides stay in
  // lockstep; a silent drift here would reintroduce the Round 10
  // regression where `window=7d` stuck to the URL after the user
  // picked a different period.
  it("maps `1d` back to the `1d` pivot window", () => {
    expect(periodKeyToPivotWindow("1d")).toBe("1d");
  });

  it("maps `1w` back to the `7d` pivot window", () => {
    expect(periodKeyToPivotWindow("1w")).toBe("7d");
  });

  it("returns undefined for periods with no pivot-URL representation", () => {
    expect(periodKeyToPivotWindow("1h")).toBeUndefined();
    expect(periodKeyToPivotWindow("12h")).toBeUndefined();
    expect(periodKeyToPivotWindow("1m")).toBeUndefined();
    expect(periodKeyToPivotWindow(null)).toBeUndefined();
    expect(periodKeyToPivotWindow(undefined)).toBeUndefined();
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
      kind: undefined,
      window: undefined,
      keywords: undefined,
      hostnames: undefined,
      userIds: undefined,
      userNames: undefined,
      userDepartments: undefined,
    });
  });

  it("extracts `kind` from a single-valued `kinds` and `window` from the committed period", () => {
    expect(
      pivotParamsFromFilterInput(
        {
          start: "2026-04-22T00:00:00.000Z",
          end: "2026-04-22T01:00:00.000Z",
          kinds: ["HttpThreat"],
        },
        "1w",
      ),
    ).toEqual({
      source: undefined,
      destination: undefined,
      kind: "HttpThreat",
      window: "7d",
      keywords: undefined,
      hostnames: undefined,
      userIds: undefined,
      userNames: undefined,
      userDepartments: undefined,
    });
  });

  it("drops `kind` when the committed filter carries multiple kinds — no single-valued pivot URL representation", () => {
    expect(
      pivotParamsFromFilterInput({
        start: "2026-04-22T00:00:00.000Z",
        end: "2026-04-22T01:00:00.000Z",
        kinds: ["HttpThreat", "DnsCovertChannel"],
      }).kind,
    ).toBeUndefined();
  });

  it("drops `window` when the committed period has no pivot representation", () => {
    expect(
      pivotParamsFromFilterInput(
        {
          start: "2026-04-22T00:00:00.000Z",
          end: "2026-04-22T01:00:00.000Z",
        },
        "1h",
      ).window,
    ).toBeUndefined();
  });

  it("merges pivot-only params with filter-side fields; filter-side owns the drawer-backed fields so stale `kind` / `window` can be cleared", () => {
    // Simulates the Round 10 scenario: page loaded from
    // `/detection?kind=HttpThreat&window=7d` (pivotOnly carries a
    // snapshot, or carries nothing in the new shape), then the
    // operator removes the Kind chip and picks a 1h period. The
    // filter-side wipes both tokens; the merged URL params drop
    // them rather than re-emitting the first-render values.
    expect(
      mergePivotParams(
        {
          kind: "HttpThreat",
          window: "7d",
          origPort: 54321,
        },
        { source: "filter-source", keywords: ["a", "b"] },
      ),
    ).toEqual({
      source: "filter-source",
      destination: undefined,
      kind: undefined,
      origPort: 54321,
      respPort: undefined,
      proto: undefined,
      window: undefined,
      keywords: ["a", "b"],
      hostnames: undefined,
      userIds: undefined,
      userNames: undefined,
      userDepartments: undefined,
    });
  });

  it("preserves ports / proto through the merge — they have no filter-drawer source yet", () => {
    // Round 10 complement: ports / proto still ride through
    // `pivotOnly` until Phase Network/IP wires them into the
    // drawer, so they should survive an Apply that only touches
    // drawer-backed fields.
    expect(
      mergePivotParams(
        { origPort: 54321, respPort: 80, proto: 6 },
        { source: "10.0.0.5" },
      ),
    ).toEqual({
      source: "10.0.0.5",
      destination: undefined,
      kind: undefined,
      origPort: 54321,
      respPort: 80,
      proto: 6,
      window: undefined,
      keywords: undefined,
      hostnames: undefined,
      userIds: undefined,
      userNames: undefined,
      userDepartments: undefined,
    });
  });

  it("lets filter-side replace `kind` with a different value — swapping kinds in the drawer overwrites the stale pivot token", () => {
    expect(
      mergePivotParams(
        { kind: "HttpThreat", window: "7d" },
        {
          source: undefined,
          destination: undefined,
          kind: "DnsCovertChannel",
          window: "1d",
        },
      ),
    ).toMatchObject({
      kind: "DnsCovertChannel",
      window: "1d",
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
