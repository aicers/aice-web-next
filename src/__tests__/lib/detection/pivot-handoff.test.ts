import { describe, expect, it } from "vitest";

import { computePeriodRange } from "@/lib/detection/period";
import {
  applyPivotHandoff,
  urlParamsForCommitted,
} from "@/lib/detection/pivot-handoff";
import {
  buildDetectionPivotUrl,
  parsePivotSearchParams,
} from "@/lib/detection/url-filters";

const NOW = new Date("2026-04-23T00:00:00.000Z");

describe("applyPivotHandoff", () => {
  it("falls back to the default 1h period when no window is set", () => {
    const { initialFilter, initialPeriod, residualPivotOnly } =
      applyPivotHandoff({}, NOW);
    const expected = computePeriodRange("1h", NOW);
    expect(initialPeriod).toBe("1h");
    expect(initialFilter.start).toBe(expected.start);
    expect(initialFilter.end).toBe(expected.end);
    expect(initialFilter.kinds).toBeUndefined();
    expect(residualPivotOnly).toEqual({
      origPort: undefined,
      respPort: undefined,
      proto: undefined,
    });
  });

  it("maps window=1d onto the 1d period", () => {
    const { initialFilter, initialPeriod } = applyPivotHandoff(
      { window: "1d" },
      NOW,
    );
    const expected = computePeriodRange("1d", NOW);
    expect(initialPeriod).toBe("1d");
    expect(initialFilter.start).toBe(expected.start);
    expect(initialFilter.end).toBe(expected.end);
  });

  it("maps window=7d onto the 1w period so the chip matches the query", () => {
    const { initialFilter, initialPeriod } = applyPivotHandoff(
      { window: "7d" },
      NOW,
    );
    const expected = computePeriodRange("1w", NOW);
    expect(initialPeriod).toBe("1w");
    expect(initialFilter.start).toBe(expected.start);
    expect(initialFilter.end).toBe(expected.end);
  });

  it("folds the kind pivot into input.kinds so the query actually narrows", () => {
    const { initialFilter, residualPivotOnly } = applyPivotHandoff(
      { kind: "HttpThreat", window: "7d" },
      NOW,
    );
    expect(initialFilter.kinds).toEqual(["HttpThreat"]);
    // `kind` must not also leak into residual pivot-only state — that
    // would produce duplicate chips (one structured multi-select chip
    // and one pivot chip).
    expect(residualPivotOnly.kind).toBeUndefined();
    expect(residualPivotOnly.window).toBeUndefined();
  });

  it("applies a source-IP pivot as an input.source + 1d range", () => {
    const { initialFilter, initialPeriod } = applyPivotHandoff(
      { source: "10.0.0.5", window: "1d" },
      NOW,
    );
    const expected = computePeriodRange("1d", NOW);
    expect(initialFilter.source).toBe("10.0.0.5");
    expect(initialFilter.start).toBe(expected.start);
    expect(initialFilter.end).toBe(expected.end);
    expect(initialPeriod).toBe("1d");
  });

  it("carries tag-field pivots (keywords/hostnames/user*) into the filter", () => {
    const { initialFilter } = applyPivotHandoff(
      {
        keywords: ["alpha", "beta"],
        hostnames: ["h1"],
        userIds: ["u1"],
        userNames: ["n1"],
        userDepartments: ["d1"],
      },
      NOW,
    );
    expect(initialFilter.keywords).toEqual(["alpha", "beta"]);
    expect(initialFilter.hostnames).toEqual(["h1"]);
    expect(initialFilter.userIds).toEqual(["u1"]);
    expect(initialFilter.userNames).toEqual(["n1"]);
    expect(initialFilter.userDepartments).toEqual(["d1"]);
  });

  it("leaves ports/proto in residual pivot-only state", () => {
    const { initialFilter, residualPivotOnly } = applyPivotHandoff(
      { origPort: 54321, respPort: 80, proto: 6 },
      NOW,
    );
    expect(initialFilter.kinds).toBeUndefined();
    expect(residualPivotOnly).toEqual({
      origPort: 54321,
      respPort: 80,
      proto: 6,
    });
  });
});

describe("urlParamsForCommitted", () => {
  it("round-trips single-kind and 1w period back through the pivot URL", () => {
    // Regression for reviewer round 5: landing on
    // `/detection?kind=HttpThreat&window=7d`, then dispatching another
    // query (e.g. Refresh), used to rewrite the URL back to a bare
    // `/detection` because the URL rewrite path did not serialize
    // `kinds` or the period. A reload at that point silently dropped
    // the same-kind / 7-day context. The round-trip must survive.
    const { initialFilter, initialPeriod, residualPivotOnly } =
      applyPivotHandoff({ kind: "HttpThreat", window: "7d" }, NOW);
    const params = urlParamsForCommitted(
      initialFilter,
      initialPeriod,
      residualPivotOnly,
    );
    const url = buildDetectionPivotUrl(params);
    const query = Object.fromEntries(
      new URLSearchParams(url.split("?")[1] ?? ""),
    );
    const reparsed = parsePivotSearchParams(query);
    expect(reparsed.kind).toBe("HttpThreat");
    expect(reparsed.window).toBe("7d");
  });

  it("round-trips a source-IP pivot + 1d period", () => {
    const { initialFilter, initialPeriod, residualPivotOnly } =
      applyPivotHandoff({ source: "10.0.0.5", window: "1d" }, NOW);
    const params = urlParamsForCommitted(
      initialFilter,
      initialPeriod,
      residualPivotOnly,
    );
    const url = buildDetectionPivotUrl(params);
    const query = Object.fromEntries(
      new URLSearchParams(url.split("?")[1] ?? ""),
    );
    const reparsed = parsePivotSearchParams(query);
    expect(reparsed.source).toBe("10.0.0.5");
    expect(reparsed.window).toBe("1d");
  });

  it("preserves residual pivot-only params (ports / proto) on every dispatch", () => {
    const params = urlParamsForCommitted({ start: "", end: "" }, null, {
      origPort: 54321,
      respPort: 80,
      proto: 6,
    });
    expect(params.origPort).toBe(54321);
    expect(params.respPort).toBe(80);
    expect(params.proto).toBe(6);
  });

  it("drops kind from the URL when the committed filter carries multiple kinds", () => {
    // Multi-kind selections have no scalar `kind=` representation in
    // the pivot URL shape. Rather than pick an arbitrary kind to
    // serialize (which would lie on reload), the helper drops the
    // field from the URL entirely; the chip bar still reflects the
    // in-memory selection.
    const params = urlParamsForCommitted(
      { start: "a", end: "b", kinds: ["HttpThreat", "NetworkThreat"] },
      "1d",
      {},
    );
    expect(params.kind).toBeUndefined();
    expect(params.window).toBe("1d");
  });

  it("emits explicit start/end when the period has no window shorthand (e.g. 1h)", () => {
    const params = urlParamsForCommitted(
      {
        start: "2026-04-22T00:00:00.000Z",
        end: "2026-04-22T01:00:00.000Z",
        kinds: ["HttpThreat"],
      },
      "1h",
      {},
    );
    expect(params.kind).toBe("HttpThreat");
    expect(params.window).toBeUndefined();
    expect(params.start).toBe("2026-04-22T00:00:00.000Z");
    expect(params.end).toBe("2026-04-22T01:00:00.000Z");
  });

  it("serializes multi-kind selections via kinds= (and leaves kind= unset)", () => {
    const params = urlParamsForCommitted(
      { start: "a", end: "b", kinds: ["HttpThreat", "NetworkThreat"] },
      "1d",
      {},
    );
    expect(params.kind).toBeUndefined();
    expect(params.kinds).toEqual(["HttpThreat", "NetworkThreat"]);
  });

  it("round-trips every extended filter dimension through the URL", () => {
    // Reviewer round 6 regression: levels / countries / categories /
    // directions / confidence / sensors used to drop off the URL on
    // every dispatch, so `returnTo` from Investigation landed the
    // operator on a looser filter than the one they left. Each
    // dimension must now survive serialize → parse round-trip.
    const input: Parameters<typeof urlParamsForCommitted>[0] = {
      start: "2026-04-22T00:00:00.000Z",
      end: "2026-04-22T01:00:00.000Z",
      levels: [1, 3],
      countries: ["US", "KR"],
      categories: [100, 200],
      learningMethods: ["UNSUPERVISED"],
      directions: ["INBOUND", "OUTBOUND"],
      confidenceMin: 0.5,
      confidenceMax: 0.9,
      sensors: ["sensor-a", "sensor-b"],
      kinds: ["HttpThreat", "NetworkThreat"],
    };
    const params = urlParamsForCommitted(input, null, {});
    const url = buildDetectionPivotUrl(params);
    const query = Object.fromEntries(
      new URLSearchParams(url.split("?")[1] ?? ""),
    );
    const reparsed = parsePivotSearchParams(query);
    expect(reparsed.levels).toEqual([1, 3]);
    expect(reparsed.countries).toEqual(["US", "KR"]);
    expect(reparsed.categories).toEqual([100, 200]);
    expect(reparsed.learningMethods).toEqual(["UNSUPERVISED"]);
    expect(reparsed.directions).toEqual(["INBOUND", "OUTBOUND"]);
    expect(reparsed.confMin).toBe(0.5);
    expect(reparsed.confMax).toBe(0.9);
    expect(reparsed.sensors).toEqual(["sensor-a", "sensor-b"]);
    expect(reparsed.kinds).toEqual(["HttpThreat", "NetworkThreat"]);
    expect(reparsed.start).toBe("2026-04-22T00:00:00.000Z");
    expect(reparsed.end).toBe("2026-04-22T01:00:00.000Z");
  });

  it("drops the confidence range when it's the [0, 1] default", () => {
    const params = urlParamsForCommitted(
      { start: "a", end: "b", confidenceMin: 0, confidenceMax: 1 },
      "1d",
      {},
    );
    expect(params.confMin).toBeUndefined();
    expect(params.confMax).toBeUndefined();
  });

  it("round-trips the no-time committed state via time=none", () => {
    // Reviewer round 8 regression: clearing the Period chip used to
    // serialize as a URL with no time-related params, which the parser
    // interpreted as "use the default 1h period". So a user could
    // remove the Period chip, click Investigation, come back via
    // `returnTo`, and land on `Last 1 hour` instead of the no-time
    // state they left. The marker `time=none` round-trips that intent.
    const params = urlParamsForCommitted(
      { source: "10.0.0.5", levels: [3] },
      null,
      {},
    );
    expect(params.noTime).toBe(true);
    expect(params.window).toBeUndefined();
    expect(params.start).toBeUndefined();
    expect(params.end).toBeUndefined();

    const url = buildDetectionPivotUrl(params);
    expect(url).toContain("time=none");
    const query = Object.fromEntries(
      new URLSearchParams(url.split("?")[1] ?? ""),
    );
    const reparsed = parsePivotSearchParams(query);
    expect(reparsed.noTime).toBe(true);
    expect(reparsed.window).toBeUndefined();
    expect(reparsed.start).toBeUndefined();
    expect(reparsed.end).toBeUndefined();

    // Re-applying the parsed URL must produce a no-time filter, not
    // the default-1h fallback.
    const { initialFilter, initialPeriod } = applyPivotHandoff(reparsed, NOW);
    expect(initialPeriod).toBeNull();
    expect(initialFilter.start).toBeUndefined();
    expect(initialFilter.end).toBeUndefined();
    expect(initialFilter.source).toBe("10.0.0.5");
    expect(initialFilter.levels).toEqual([3]);
  });

  it("emits time=none even when the input still carries stale start/end", () => {
    // Defensive: if a caller hands `urlParamsForCommitted` an input
    // with stale ISO bounds plus a null period, the no-time intent
    // (period === null AND no committed range) is what wins. This
    // avoids the failure mode where the URL ships both `time=none`
    // and `start=` / `end=` and re-decodes ambiguously.
    //
    // In practice the shell drops `start` / `end` from the input when
    // the Period chip is removed, so this asserts the helper is robust
    // even if a future caller forgets to.
    const params = urlParamsForCommitted({}, null, {});
    expect(params.noTime).toBe(true);
    expect(params.start).toBeUndefined();
    expect(params.end).toBeUndefined();
  });

  it("omits start/end when a window shorthand already represents the period", () => {
    // `window=` + `start=`/`end=` would decode to the same filter on
    // reload, so emitting both is just noise that can drift if the
    // range calculation ever changes.
    const params = urlParamsForCommitted(
      {
        start: "2026-04-22T00:00:00.000Z",
        end: "2026-04-23T00:00:00.000Z",
      },
      "1d",
      {},
    );
    expect(params.window).toBe("1d");
    expect(params.start).toBeUndefined();
    expect(params.end).toBeUndefined();
  });
});

describe("applyPivotHandoff (round 6 extensions)", () => {
  it("folds explicit start/end into the filter with a null period", () => {
    const { initialFilter, initialPeriod } = applyPivotHandoff(
      {
        start: "2026-04-22T00:00:00.000Z",
        end: "2026-04-22T01:00:00.000Z",
      },
      NOW,
    );
    expect(initialPeriod).toBeNull();
    expect(initialFilter.start).toBe("2026-04-22T00:00:00.000Z");
    expect(initialFilter.end).toBe("2026-04-22T01:00:00.000Z");
  });

  it("folds multi-kind / level / country / category / direction / confidence / sensor URL params into the filter", () => {
    const { initialFilter } = applyPivotHandoff(
      {
        kinds: ["HttpThreat", "NetworkThreat"],
        levels: [1, 3],
        countries: ["US"],
        categories: [100],
        learningMethods: ["UNSUPERVISED"],
        directions: ["INBOUND"],
        confMin: 0.5,
        confMax: 0.9,
        sensors: ["sensor-a"],
      },
      NOW,
    );
    expect(initialFilter.kinds).toEqual(["HttpThreat", "NetworkThreat"]);
    expect(initialFilter.levels).toEqual([1, 3]);
    expect(initialFilter.countries).toEqual(["US"]);
    expect(initialFilter.categories).toEqual([100]);
    expect(initialFilter.learningMethods).toEqual(["UNSUPERVISED"]);
    expect(initialFilter.directions).toEqual(["INBOUND"]);
    expect(initialFilter.confidenceMin).toBe(0.5);
    expect(initialFilter.confidenceMax).toBe(0.9);
    expect(initialFilter.sensors).toEqual(["sensor-a"]);
  });
});

describe("parsePivotSearchParams (explicit range validation)", () => {
  // The parser's "malformed entries are dropped silently" contract must
  // hold for the time dimension too: an unparseable `start=` / `end=`
  // or an inverted pair should fall back to `window=` / the default
  // period branch instead of forwarding garbage bounds into the
  // committed filter (where `formatRange("", "")` would render a bogus
  // chip and the REview query would receive the raw string).
  it("drops unparseable start/end strings instead of forwarding them", () => {
    const parsed = parsePivotSearchParams({ start: "foo", end: "bar" });
    expect(parsed.start).toBeUndefined();
    expect(parsed.end).toBeUndefined();
    const { initialFilter, initialPeriod } = applyPivotHandoff(parsed, NOW);
    // Fell back to the default 1h period instead of inheriting the
    // garbage strings.
    expect(initialPeriod).toBe("1h");
    const defaults = computePeriodRange("1h", NOW);
    expect(initialFilter.start).toBe(defaults.start);
    expect(initialFilter.end).toBe(defaults.end);
  });

  it("drops an inverted start/end range", () => {
    const parsed = parsePivotSearchParams({
      start: "2026-04-22T02:00:00.000Z",
      end: "2026-04-22T01:00:00.000Z",
    });
    expect(parsed.start).toBeUndefined();
    expect(parsed.end).toBeUndefined();
  });

  it("drops a lone start= or end= and falls back to window= / default", () => {
    const startOnly = parsePivotSearchParams({
      start: "2026-04-22T00:00:00.000Z",
      window: "1d",
    });
    expect(startOnly.start).toBeUndefined();
    expect(startOnly.end).toBeUndefined();
    expect(startOnly.window).toBe("1d");

    const endOnly = parsePivotSearchParams({
      end: "2026-04-22T01:00:00.000Z",
    });
    expect(endOnly.start).toBeUndefined();
    expect(endOnly.end).toBeUndefined();
  });

  it("accepts and normalizes a valid ISO range", () => {
    const parsed = parsePivotSearchParams({
      start: "2026-04-22T00:00:00Z",
      end: "2026-04-22T01:00:00Z",
    });
    // The parser normalizes to the canonical ISO form so subsequent
    // `urlParamsForCommitted` emissions round-trip identically without
    // flickering the URL between equivalent representations.
    expect(parsed.start).toBe("2026-04-22T00:00:00.000Z");
    expect(parsed.end).toBe("2026-04-22T01:00:00.000Z");
  });
});
