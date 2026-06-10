import { describe, expect, it } from "vitest";

import type { EndpointEntry } from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import {
  buildSearchParamsForFilter,
  type EncodedTabFilter,
  FILTER_URL_PARAM,
  LEGACY_FILTER_PARAM_KEYS,
  parseFilterFromUrlParam,
  pivotExtrasFromPivotParams,
  serializeFilterToUrlParam,
} from "@/lib/detection/filter-url";

const STRUCTURED_RICH: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-25T00:00:00.000Z",
    end: "2026-04-25T01:00:00.000Z",
    levels: ["MEDIUM", "HIGH"],
    countries: ["KR", "US"],
    learningMethods: ["UNSUPERVISED"],
    categories: [1, 5],
    kinds: ["HttpThreat", "PortScan"],
    directions: ["INBOUND", "OUTBOUND"],
    confidenceMin: 0.4,
    confidenceMax: 0.9,
    sensors: ["sensor-1", "sensor-2"],
    source: "10.0.0.5",
    destination: "203.0.113.45",
    keywords: ["alpha", "beta"],
    hostnames: ["host-a"],
    userIds: ["uid-1"],
    userNames: ["Alice"],
    userDepartments: ["SOC"],
    endpoints: [
      {
        direction: "FROM",
        custom: {
          hosts: ["10.1.1.1"],
          networks: ["192.168.0.0/16"],
          ranges: [{ start: "10.2.0.1", end: "10.2.0.10" }],
        },
      },
    ],
  },
};

const ENDPOINTS_FIXTURE: EndpointEntry[] = [
  {
    id: "ep-1",
    raw: "10.1.1.1",
    kind: "host",
    host: "10.1.1.1",
    direction: "SOURCE",
    selected: true,
  },
];

describe("serializeFilterToUrlParam / parseFilterFromUrlParam", () => {
  // The reviewer flagged that the legacy pivot encoder dropped every
  // structured-filter field except source/destination/kind/window and
  // the tag inputs. The encoded `?f=` blob exists to round-trip the
  // full {@link Filter} shape — pin every field explicitly so a
  // future encoding change can't silently regress one of them.
  it("round-trips every structured-filter field, the period, endpoints, and pivot extras", () => {
    const payload: EncodedTabFilter = {
      filter: STRUCTURED_RICH,
      period: "1h",
      endpoints: ENDPOINTS_FIXTURE,
      pivotExtras: { origPort: 54321, respPort: 80, proto: 6 },
    };
    const encoded = serializeFilterToUrlParam(payload);
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.filter).toEqual(STRUCTURED_RICH);
    expect(decoded?.period).toBe("1h");
    expect(decoded?.endpoints).toEqual(ENDPOINTS_FIXTURE);
    expect(decoded?.pivotExtras).toEqual({
      origPort: 54321,
      respPort: 80,
      proto: 6,
    });
  });

  it("round-trips a query-mode filter (the search-language branch reserved for a later phase)", () => {
    const filter: Filter = {
      mode: "query",
      text: "level:high AND src:10.0.0.5",
    };
    const encoded = serializeFilterToUrlParam({
      filter,
      period: null,
      endpoints: [],
      pivotExtras: {},
    });
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded?.filter).toEqual(filter);
  });

  it("survives multi-byte characters in the encoded payload", () => {
    // Plain `btoa` throws on multi-byte chars; the encoder routes
    // through TextEncoder so KR labels and other Unicode survive.
    const filter: Filter = {
      mode: "structured",
      input: {
        start: "2026-04-25T00:00:00.000Z",
        end: "2026-04-25T01:00:00.000Z",
        userNames: ["김철수", "한국어"],
      },
    };
    const encoded = serializeFilterToUrlParam({
      filter,
      period: null,
      endpoints: [],
      pivotExtras: {},
    });
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded?.filter).toEqual(filter);
  });

  it("returns null on absent / malformed / wrong-version payloads", () => {
    expect(parseFilterFromUrlParam(null)).toBeNull();
    expect(parseFilterFromUrlParam(undefined)).toBeNull();
    expect(parseFilterFromUrlParam("")).toBeNull();
    expect(parseFilterFromUrlParam("!!! not base64 !!!")).toBeNull();
    // valid base64 but JSON garbage:
    expect(parseFilterFromUrlParam(btoaUrl('{"v":2,"filter":{}}'))).toBeNull();
    expect(
      parseFilterFromUrlParam(
        btoaUrl(JSON.stringify({ v: 1, filter: { mode: "bogus" } })),
      ),
    ).toBeNull();
  });

  it("drops bogus pivot extras rather than letting strings or NaN through", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: STRUCTURED_RICH,
        period: "1h",
        endpoints: [],
        pivotExtras: { origPort: "abc", respPort: Number.NaN, proto: 6 },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded?.pivotExtras).toEqual({ proto: 6 });
  });

  it("uses URL-safe base64 (no `+`, `/`, or trailing `=`)", () => {
    // The encoded blob lives inside a single search-param value; the
    // URL-safe alphabet keeps us from depending on the URL parser
    // re-encoding `+`/`/` (URLSearchParams happens to, but a hand-
    // crafted href doesn't).
    const encoded = serializeFilterToUrlParam({
      filter: STRUCTURED_RICH,
      period: "1h",
      endpoints: [],
      pivotExtras: {},
    });
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("parseFilterFromUrlParam — Reviewer Round 6 (item 2) deep validation", () => {
  // `?f=` is shareable URL input; a malformed payload that previously
  // passed the shallow `isFilter` check could crash later helpers (e.g.
  // chip / draft helpers calling `.filter(...)` on `categories: string`).
  // The decoder now coerces every EventListFilterInput field to its
  // schema-declared shape, dropping anything that doesn't match.
  it("drops a non-array `categories` field rather than crashing", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: {
            start: "2026-04-25T00:00:00.000Z",
            end: "2026-04-25T01:00:00.000Z",
            categories: "not-an-array",
          },
        },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded?.filter.mode).toBe("structured");
    if (decoded?.filter.mode !== "structured") return;
    expect(decoded.filter.input.categories).toBeUndefined();
    expect(decoded.filter.input.start).toBe("2026-04-25T00:00:00.000Z");
    expect(decoded.filter.input.end).toBe("2026-04-25T01:00:00.000Z");
  });

  it("drops non-string entries from string array fields", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: {
            keywords: ["valid", 42, null, "also-valid", { nested: true }],
            hostnames: "not-an-array",
            kinds: ["HttpThreat", 99],
          },
        },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    if (decoded?.filter.mode !== "structured") {
      throw new Error("expected structured filter");
    }
    expect(decoded.filter.input.keywords).toEqual(["valid", "also-valid"]);
    expect(decoded.filter.input.hostnames).toBeUndefined();
    expect(decoded.filter.input.kinds).toEqual(["HttpThreat"]);
  });

  it("drops unknown ThreatLevel values from levels and non-finite confidence bounds", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: {
            levels: ["HIGH", "two", null, "NOT_A_LEVEL", "LOW"],
            confidenceMin: "abc",
            confidenceMax: 0.9,
          },
        },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    if (decoded?.filter.mode !== "structured") {
      throw new Error("expected structured filter");
    }
    expect(decoded.filter.input.levels).toEqual(["HIGH", "LOW"]);
    expect(decoded.filter.input.confidenceMin).toBeUndefined();
    expect(decoded.filter.input.confidenceMax).toBe(0.9);
  });

  it("drops non-string `levels` entries (a level must be a ThreatLevel string)", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: { levels: [1, 3, "MEDIUM", 999, "HIGH"] },
        },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    if (decoded?.filter.mode !== "structured") {
      throw new Error("expected structured filter");
    }
    expect(decoded.filter.input.levels).toEqual(["MEDIUM", "HIGH"]);
  });

  it("drops unknown enum values from directions and learningMethods", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: {
            directions: ["INBOUND", "SIDEWAYS", "OUTBOUND"],
            learningMethods: ["UNSUPERVISED", "BOGUS"],
          },
        },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    if (decoded?.filter.mode !== "structured") {
      throw new Error("expected structured filter");
    }
    expect(decoded.filter.input.directions).toEqual(["INBOUND", "OUTBOUND"]);
    expect(decoded.filter.input.learningMethods).toEqual(["UNSUPERVISED"]);
  });

  it("drops endpoints with missing or wrong-typed fields rather than crashing downstream", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: {
            endpoints: [
              {
                direction: "FROM",
                custom: { hosts: ["1.1.1.1"], networks: [], ranges: [] },
              },
              "not-an-object",
              { direction: "FROM", custom: { hosts: 42 } },
            ],
          },
        },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    if (decoded?.filter.mode !== "structured") {
      throw new Error("expected structured filter");
    }
    expect(decoded.filter.input.endpoints).toHaveLength(2);
    expect(decoded.filter.input.endpoints?.[0].direction).toBe("FROM");
    expect(decoded.filter.input.endpoints?.[0].custom?.hosts).toEqual([
      "1.1.1.1",
    ]);
    // The non-array `hosts: 42` is coerced to an empty array rather
    // than passing the string straight through to the BFF.
    expect(decoded.filter.input.endpoints?.[1].direction).toBe("FROM");
    expect(decoded.filter.input.endpoints?.[1].custom?.hosts).toEqual([]);
  });

  it("drops the top-level `endpoints` array entries that are missing required fields", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: {},
        },
        endpoints: [
          {
            id: "ep-ok",
            raw: "10.1.1.1",
            kind: "host",
            host: "10.1.1.1",
            direction: "SOURCE",
            selected: true,
          },
          { id: "ep-no-kind", raw: "x", direction: "BOTH", selected: true },
          { id: "ep-bad-dir", raw: "x", kind: "host", direction: "BOGUS" },
          "not-an-object",
        ],
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded?.endpoints).toHaveLength(1);
    expect(decoded?.endpoints[0].id).toBe("ep-ok");
  });

  it("rejects an unknown period rather than passing it through as a string", () => {
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: { mode: "structured", input: {} },
        period: "not-a-period",
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded?.period).toBeNull();
  });

  it("returns a structured filter with all fields stripped rather than null when input is empty-after-coercion", () => {
    // Even if every field was malformed, an empty input is a valid
    // filter. The decoder downgrades to that rather than null so the
    // page renders the default-window result instead of the legacy
    // pivot fallback.
    const encoded = btoaUrl(
      JSON.stringify({
        v: 1,
        filter: {
          mode: "structured",
          input: {
            categories: "bad",
            levels: "bad",
            kinds: 42,
          },
        },
      }),
    );
    const decoded = parseFilterFromUrlParam(encoded);
    expect(decoded).not.toBeNull();
    if (decoded?.filter.mode !== "structured") {
      throw new Error("expected structured filter");
    }
    expect(decoded.filter.input).toEqual({});
  });
});

describe("buildSearchParamsForFilter", () => {
  it("emits a single `?f=` param carrying the encoded blob", () => {
    const search = buildSearchParamsForFilter({
      filter: STRUCTURED_RICH,
      period: "1h",
      endpoints: [],
      pivotExtras: {},
    });
    expect(search.has(FILTER_URL_PARAM)).toBe(true);
    // Should be exactly one entry — the legacy pivot keys are not
    // emitted from this helper.
    expect(Array.from(search.keys())).toEqual([FILTER_URL_PARAM]);
  });
});

describe("pivotExtrasFromPivotParams", () => {
  // The page bootstraps from a legacy Investigation handoff URL
  // (`?source=X&window=1d`) and needs to lift the URL-only port /
  // proto fields into the encoded blob on the next state mutation
  // so they aren't silently lost when the URL writer flips over.
  it("picks origPort / respPort / proto and drops the drawer-owned fields", () => {
    expect(
      pivotExtrasFromPivotParams({
        source: "10.0.0.5",
        window: "1d",
        kind: "HttpThreat",
        origPort: 54321,
        respPort: 80,
        proto: 6,
      }),
    ).toEqual({ origPort: 54321, respPort: 80, proto: 6 });
  });

  it("returns an empty object when no pivot extras are set", () => {
    expect(pivotExtrasFromPivotParams({ source: "10.0.0.5" })).toEqual({});
  });
});

describe("LEGACY_FILTER_PARAM_KEYS", () => {
  it("lists every key the legacy pivot encoder writes so the new writer can clear them", () => {
    // The list is documented as the union the legacy encoder writes.
    // Pin the contents so a future addition to either side is caught
    // at unit-test time.
    expect(LEGACY_FILTER_PARAM_KEYS.slice().sort()).toEqual(
      [
        "destination",
        "hostnames",
        "keywords",
        "kind",
        "origPort",
        "proto",
        "respPort",
        "source",
        "userDepartments",
        "userIds",
        "userNames",
        "window",
      ].sort(),
    );
  });
});

function btoaUrl(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
