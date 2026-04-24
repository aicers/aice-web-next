import { describe, expect, it } from "vitest";

import {
  buildActiveTabSearchParams,
  buildAllTabsSearchParams,
  parseActiveTabSearchParams,
  parseTabsJsonParam,
  readActiveTabIndex,
  type TabSnapshot,
  type TabUrlState,
} from "@/lib/detection";

/** Minimal valid `TabUrlState` — callers override only the fields they care about. */
const base = (overrides: Partial<TabUrlState> = {}): TabUrlState => ({
  filter: {
    mode: "structured",
    input: {
      start: "2026-04-22T00:00:00.000Z",
      end: "2026-04-22T01:00:00.000Z",
    },
  },
  period: null,
  endpoints: [],
  pivotOnly: {},
  autoRun: true,
  ...overrides,
});

function roundTrip(state: TabUrlState): TabUrlState {
  const search = buildActiveTabSearchParams(state);
  const record = Object.fromEntries(search);
  return parseActiveTabSearchParams(record);
}

describe("buildActiveTabSearchParams", () => {
  it("carries a period chip selection through the URL without start/end", () => {
    const search = buildActiveTabSearchParams(base({ period: "1w" }));
    expect(search.get("period")).toBe("1w");
    // When a period is active the range is rolling-derived at load, so
    // the absolute start/end stay off the URL — otherwise a shared link
    // would pin to the original instants instead of re-rolling forward.
    expect(search.get("start")).toBeNull();
    expect(search.get("end")).toBeNull();
  });

  it("carries an explicit start/end when no period is set", () => {
    const search = buildActiveTabSearchParams(base());
    expect(search.get("period")).toBeNull();
    expect(search.get("start")).toBe("2026-04-22T00:00:00.000Z");
    expect(search.get("end")).toBe("2026-04-22T01:00:00.000Z");
  });

  it("serialises all structured filter fields the drawer exposes", () => {
    const search = buildActiveTabSearchParams(
      base({
        filter: {
          mode: "structured",
          input: {
            start: "2026-04-22T00:00:00.000Z",
            end: "2026-04-22T01:00:00.000Z",
            directions: ["OUTBOUND", "INBOUND"],
            confidenceMin: 0.25,
            confidenceMax: 0.9,
            levels: [1, 3],
            countries: ["US", "KR"],
            categories: [1, 2, 3],
            kinds: ["HttpThreat", "PortScan"],
            learningMethods: ["UNSUPERVISED"],
            sensors: ["sensor-1", "sensor-2"],
          },
        },
      }),
    );
    expect(search.get("directions")).toBe("OUTBOUND,INBOUND");
    expect(search.get("cmin")).toBe("0.25");
    expect(search.get("cmax")).toBe("0.9");
    expect(search.get("levels")).toBe("1,3");
    expect(search.get("countries")).toBe("US,KR");
    expect(search.get("categories")).toBe("1,2,3");
    expect(search.get("kinds")).toBe("HttpThreat,PortScan");
    expect(search.get("learningMethods")).toBe("UNSUPERVISED");
    expect(search.get("sensors")).toBe("sensor-1,sensor-2");
  });

  it("serialises endpoint rows (raw|direction|selected) so the active tab reproduces custom network filters", () => {
    const search = buildActiveTabSearchParams(
      base({
        endpoints: [
          {
            id: "e1",
            raw: "10.0.0.1",
            kind: "host",
            host: "10.0.0.1",
            direction: "SOURCE",
            selected: true,
          },
          {
            id: "e2",
            raw: "192.168.10.0/24",
            kind: "network",
            network: "192.168.10.0/24",
            direction: "BOTH",
            selected: false,
          },
        ],
      }),
    );
    expect(search.get("endpoints")).toBe("10.0.0.1|s|1;192.168.10.0/24|b|0");
  });
});

describe("parseActiveTabSearchParams + buildActiveTabSearchParams round-trip", () => {
  it("round-trips a full filter the drawer can produce", () => {
    const original = base({
      filter: {
        mode: "structured",
        input: {
          start: "2026-04-22T00:00:00.000Z",
          end: "2026-04-22T01:00:00.000Z",
          source: "10.0.0.5",
          destination: "203.0.113.45",
          keywords: ["alpha", "beta"],
          hostnames: ["host-a"],
          directions: ["OUTBOUND", "INTERNAL"],
          confidenceMin: 0.1,
          confidenceMax: 0.75,
          levels: [2, 3],
          countries: ["US"],
          categories: [5, 7],
          kinds: ["HttpThreat"],
          learningMethods: ["SEMI_SUPERVISED"],
          sensors: ["sensor-1"],
        },
      },
    });
    const roundTripped = roundTrip(original);
    expect(roundTripped).toEqual(original);
  });

  it("round-trips a period tab without reinstating start/end", () => {
    const original = base({
      period: "1h",
      filter: {
        mode: "structured",
        input: {
          // The shell carries start/end on the in-memory filter for the
          // query, but they are intentionally dropped from the URL when
          // a period chip is active.
          start: "2026-04-22T00:00:00.000Z",
          end: "2026-04-22T01:00:00.000Z",
          source: "1.2.3.4",
        },
      },
    });
    const roundTripped = roundTrip(original);
    expect(roundTripped.period).toBe("1h");
    expect(roundTripped.filter).toEqual({
      mode: "structured",
      input: { source: "1.2.3.4" },
    });
  });

  it("round-trips endpoints, re-parsing the raw text into host/network/range", () => {
    const original = base({
      endpoints: [
        {
          id: "e1",
          raw: "10.0.0.1",
          kind: "host",
          host: "10.0.0.1",
          direction: "SOURCE",
          selected: true,
        },
        {
          id: "e2",
          raw: "10.1.1.1 - 10.1.1.20",
          kind: "range",
          range: { start: "10.1.1.1", end: "10.1.1.20" },
          direction: "DESTINATION",
          selected: false,
        },
      ],
    });
    const roundTripped = roundTrip(original);
    expect(roundTripped.endpoints).toHaveLength(2);
    expect(roundTripped.endpoints[0]).toMatchObject({
      raw: "10.0.0.1",
      kind: "host",
      host: "10.0.0.1",
      direction: "SOURCE",
      selected: true,
    });
    expect(roundTripped.endpoints[1]).toMatchObject({
      raw: "10.1.1.1 - 10.1.1.20",
      kind: "range",
      range: { start: "10.1.1.1", end: "10.1.1.20" },
      direction: "DESTINATION",
      selected: false,
    });
  });

  it("rebuilds filter.input.endpoints from the top-level endpoints param so the SSR fetch applies endpoint constraints", () => {
    // Reviewer Round 27: the single-tab rehydrate path (ordinary
    // one-tab links plus multi-tab working sets that overflowed the
    // `tabs=` budget) previously decoded `?endpoints=…` into the
    // UI-side `state.endpoints` list but never merged it back into
    // `filter.input.endpoints`. The SSR `searchEvents(filter, …)` and
    // the shell's Refresh / non-endpoint chip-remove paths query
    // `filter.input` directly, so the reload showed endpoint chips
    // while running the unfiltered query. The `tabs=<json>` decoder
    // already rebuilds `input.endpoints` from the UI-side list; the
    // single-tab path must do the same.
    const parsed = parseActiveTabSearchParams({
      endpoints: "10.0.0.1|s|1;192.168.10.0/24|b|1",
    });
    expect(parsed.endpoints).toHaveLength(2);
    const input =
      parsed.filter.mode === "structured" ? parsed.filter.input : null;
    expect(input?.endpoints).toEqual([
      {
        direction: null,
        custom: {
          hosts: [],
          networks: ["192.168.10.0/24"],
          ranges: [],
        },
      },
      {
        direction: "FROM",
        custom: {
          hosts: ["10.0.0.1"],
          networks: [],
          ranges: [],
        },
      },
    ]);
  });

  it("skips deselected endpoint rows when rebuilding filter.input.endpoints", () => {
    // The UI-side endpoint list keeps deselected rows so the operator
    // can re-enable them with a click, but the GraphQL query must only
    // receive selected constraints. `endpointsToEndpointInputs` already
    // filters by `selected`, so the rebuild in `parseActiveTabSearchParams`
    // inherits that behaviour.
    const parsed = parseActiveTabSearchParams({
      endpoints: "10.0.0.1|s|1;10.0.0.2|s|0",
    });
    expect(parsed.endpoints).toHaveLength(2);
    const input =
      parsed.filter.mode === "structured" ? parsed.filter.input : null;
    expect(input?.endpoints).toEqual([
      {
        direction: "FROM",
        custom: {
          hosts: ["10.0.0.1"],
          networks: [],
          ranges: [],
        },
      },
    ]);
  });

  it("drops a one-sided explicit range (start without end, or vice versa) rather than booting a committed tab with a hidden half-range", () => {
    // Reviewer Round 18 item 2: `?start=…` without `?end=…` (and vice
    // versa) is malformed. The chip summarizer refuses to render a
    // time chip unless both bounds are present, but the SSR path
    // previously forwarded the half-range to the query and the cold-
    // start `Last 1 hour` default was suppressed because
    // `snapshotFromSingleTabUrl` saw "time intent expressed". Drop
    // both sides silently so the cold-start default can kick in.
    const onlyStart = parseActiveTabSearchParams({
      start: "2026-04-22T00:00:00.000Z",
    });
    expect(
      onlyStart.filter.mode === "structured" && onlyStart.filter.input.start,
    ).toBeUndefined();
    expect(
      onlyStart.filter.mode === "structured" && onlyStart.filter.input.end,
    ).toBeUndefined();

    const onlyEnd = parseActiveTabSearchParams({
      end: "2026-04-22T01:00:00.000Z",
    });
    expect(
      onlyEnd.filter.mode === "structured" && onlyEnd.filter.input.start,
    ).toBeUndefined();
    expect(
      onlyEnd.filter.mode === "structured" && onlyEnd.filter.input.end,
    ).toBeUndefined();
  });

  it("drops numeric params with trailing garbage or fractional junk rather than silently truncating", () => {
    // Reviewer Round 20 item 2: `Number.parseFloat`/`parseInt` accept
    // trailing garbage (`0.8oops` → 0.8, `1junk` → 1) and fractional
    // values (`1.5` → 1). A hand-edited or corrupted shared link must
    // not silently activate the wrong confidence / level / category
    // filter. Strict regex parsers reject the malformed token so the
    // field falls through to the caller's default.
    const parsed = parseActiveTabSearchParams({
      cmin: "0.8oops",
      cmax: "0x1",
      levels: "1junk,2",
      categories: "1.5,3,4oops",
      kinds: "HttpThreat",
    });
    const input =
      parsed.filter.mode === "structured" ? parsed.filter.input : null;
    expect(input?.confidenceMin).toBeUndefined();
    expect(input?.confidenceMax).toBeUndefined();
    // The well-formed tokens in a list survive; only the bad ones drop.
    expect(input?.levels).toEqual([2]);
    expect(input?.categories).toEqual([3]);
  });

  it("accepts well-formed numeric params across the full decimal grammar", () => {
    // Guard-rails: the strict regex must not over-reject legitimate
    // shapes (negative values, exponential notation, integer-only
    // fractions, multi-digit integer lists).
    const parsed = parseActiveTabSearchParams({
      cmin: "0.25",
      cmax: "1e-3",
      levels: "1,10,100",
      categories: "-1,2",
    });
    const input =
      parsed.filter.mode === "structured" ? parsed.filter.input : null;
    expect(input?.confidenceMin).toBe(0.25);
    expect(input?.confidenceMax).toBe(0.001);
    expect(input?.levels).toEqual([1, 10, 100]);
    expect(input?.categories).toEqual([-1, 2]);
  });

  it("drops unknown directions/learning-methods/period values silently", () => {
    // A hand-edited URL must not be able to poison shell state. Unknown
    // tokens are dropped rather than accepted verbatim.
    const parsed = parseActiveTabSearchParams({
      directions: "OUTBOUND,BOGUS,INBOUND",
      learningMethods: "MADE_UP",
      period: "999y",
    });
    expect(
      parsed.filter.mode === "structured" && parsed.filter.input.directions,
    ).toEqual(["OUTBOUND", "INBOUND"]);
    expect(
      parsed.filter.mode === "structured" &&
        parsed.filter.input.learningMethods,
    ).toBeUndefined();
    expect(parsed.period).toBeNull();
  });

  it("round-trips the pending flag so a + tab reload doesn't trigger an auto-query", () => {
    // Issue acceptance: "Open +, reload before applying → the fresh
    // tab is still active and still blank." The URL marker drives the
    // server page's SSR-skip branch and the shell's autoRun gate.
    const search = buildActiveTabSearchParams(base({ autoRun: false }));
    expect(search.get("pending")).toBe("1");
    const parsed = parseActiveTabSearchParams(Object.fromEntries(search));
    expect(parsed.autoRun).toBe(false);
  });

  it("omits the pending flag when the active tab's query has run", () => {
    const search = buildActiveTabSearchParams(base({ autoRun: true }));
    expect(search.get("pending")).toBeNull();
    const parsed = parseActiveTabSearchParams(Object.fromEntries(search));
    expect(parsed.autoRun).toBe(true);
  });

  it("round-trips a query-mode filter through the URL so the abstract Filter discriminator survives", () => {
    // The issue's persistence contract says a tab's filter is the
    // abstract `Filter` type, not a raw `EventListFilterInput`. A
    // query-mode active tab in the single-tab / URL-budget-fallback
    // path must keep its discriminator across a shared URL.
    const original = base({
      filter: { mode: "query", text: "severity:high AND source:10.0.0.5" },
      period: null,
      endpoints: [],
    });
    const search = buildActiveTabSearchParams(original);
    expect(search.get("mode")).toBe("query");
    expect(search.get("q")).toBe("severity:high AND source:10.0.0.5");
    expect(search.get("period")).toBeNull();
    expect(search.get("start")).toBeNull();
    expect(search.get("end")).toBeNull();
    const parsed = parseActiveTabSearchParams(Object.fromEntries(search));
    expect(parsed.filter).toEqual({
      mode: "query",
      text: "severity:high AND source:10.0.0.5",
    });
    expect(parsed.period).toBeNull();
    expect(parsed.endpoints).toEqual([]);
    expect(parsed.autoRun).toBe(true);
  });

  it("marks a committed tab whose time chip was removed with notime=1 so reload does not resurrect the default period", () => {
    // Reviewer round 7: the chip-bar `×` on `Last 1 week` for an
    // already-run tab has to actually remove the time filter. Without
    // the `notime=1` marker, the URL after removal is indistinguishable
    // from a cold-start `/detection` entry, and SSR would snap the tab
    // back to `Last 1 hour` on reload.
    const cleared = base({
      period: null,
      autoRun: true,
      filter: {
        mode: "structured",
        input: { source: "10.0.0.1" },
      },
    });
    const search = buildActiveTabSearchParams(cleared);
    expect(search.get("notime")).toBe("1");
    expect(search.get("period")).toBeNull();
    expect(search.get("start")).toBeNull();
    expect(search.get("end")).toBeNull();
    const parsed = parseActiveTabSearchParams(Object.fromEntries(search));
    expect(parsed.period).toBeNull();
    expect(parsed.noTimeFilter).toBe(true);
    expect(parsed.autoRun).toBe(true);
  });

  it("omits notime=1 when the tab has a period or explicit range", () => {
    // The marker only appears when the operator actively cleared the
    // time filter. A period chip or explicit range already signals
    // intent, so no extra marker is needed.
    const withPeriod = buildActiveTabSearchParams(base({ period: "1h" }));
    expect(withPeriod.get("notime")).toBeNull();
    const withRange = buildActiveTabSearchParams(base());
    expect(withRange.get("notime")).toBeNull();
  });

  it("omits notime=1 on a pending tab — pending=1 already conveys the no-query state", () => {
    const pending = buildActiveTabSearchParams(
      base({
        period: null,
        autoRun: false,
        filter: { mode: "structured", input: {} },
      }),
    );
    expect(pending.get("pending")).toBe("1");
    expect(pending.get("notime")).toBeNull();
  });

  it("carries the pending flag on a query-mode + tab so reload does not auto-run", () => {
    const search = buildActiveTabSearchParams(
      base({
        filter: { mode: "query", text: "" },
        autoRun: false,
      }),
    );
    expect(search.get("pending")).toBe("1");
    const parsed = parseActiveTabSearchParams(Object.fromEntries(search));
    expect(parsed.filter).toEqual({ mode: "query", text: "" });
    expect(parsed.autoRun).toBe(false);
  });
});

describe("buildAllTabsSearchParams + parseTabsJsonParam", () => {
  const sampleTab = (overrides: Partial<TabSnapshot> = {}): TabSnapshot => ({
    id: "tab-sample",
    filter: {
      mode: "structured",
      input: {
        start: "2026-04-22T00:00:00.000Z",
        end: "2026-04-22T01:00:00.000Z",
      },
    },
    period: "1h",
    endpoints: [],
    pivotOnly: {},
    name: null,
    autoRun: true,
    analyticsOpen: false,
    ...overrides,
  });

  it("includes every tab in the URL when the working set fits inside the budget", () => {
    const tabs: TabSnapshot[] = [
      sampleTab({ id: "a", autoRun: true }),
      sampleTab({
        id: "b",
        autoRun: false,
        filter: {
          mode: "structured",
          input: { source: "10.0.0.5", start: "x", end: "y" },
        },
      }),
    ];
    const { search, tabsIncluded } = buildAllTabsSearchParams({
      tabs,
      activeIndex: 1,
      pathname: "/detection",
    });
    expect(tabsIncluded).toBe(true);
    expect(search.get("tab")).toBe("1");
    const parsed = parseTabsJsonParam(Object.fromEntries(search));
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]?.autoRun).toBe(true);
    expect(parsed?.[1]?.autoRun).toBe(false);
    expect(
      parsed?.[1]?.filter.mode === "structured" &&
        parsed?.[1]?.filter.input.source,
    ).toBe("10.0.0.5");
  });

  it("drops the tabs JSON when the resulting URL would exceed the budget", () => {
    // Stuff each tab with a huge free-form payload to blow past the
    // 4 KB budget, then confirm the tabs param falls back to
    // active-only — the URL stays valid and sessionStorage carries
    // the rest locally.
    const filler = "x".repeat(2500);
    const tabs: TabSnapshot[] = Array.from({ length: 3 }, (_, i) =>
      sampleTab({
        id: `t-${i}`,
        filter: {
          mode: "structured",
          input: { source: filler, start: "a", end: "b" },
        },
      }),
    );
    const { tabsIncluded } = buildAllTabsSearchParams({
      tabs,
      activeIndex: 0,
      pathname: "/detection",
    });
    expect(tabsIncluded).toBe(false);
  });

  it("omits the tabs JSON for a single-tab working set", () => {
    const { search, tabsIncluded } = buildAllTabsSearchParams({
      tabs: [sampleTab({ id: "only" })],
      activeIndex: 0,
      pathname: "/detection",
    });
    expect(tabsIncluded).toBe(false);
    expect(search.get("tabs")).toBeNull();
    expect(search.get("tab")).toBeNull();
  });

  it("rejects a malformed tabs JSON payload silently so a hand-edited URL can't poison state", () => {
    expect(parseTabsJsonParam({ tabs: "{ not json" })).toBeNull();
    expect(parseTabsJsonParam({ tabs: "[]" })).toBeNull();
    expect(parseTabsJsonParam({ tabs: "[{}]" })).toBeNull();
  });

  it("rejects a tabs payload whose structured filter has a null input", () => {
    // `typeof null === "object"` in JS, so without an explicit guard
    // this shape would slip past validation and then crash consumers
    // that spread `filter.input`. The URL decoder must drop it the
    // same way the session decoder does.
    const payload = JSON.stringify([
      { f: { mode: "structured", input: null }, p: null, ar: true },
    ]);
    expect(parseTabsJsonParam({ tabs: payload })).toBeNull();
  });

  it("rejects a tabs payload whose period is not a known PeriodKey", () => {
    // An unknown `p` (e.g. `"banana"`) used to be silently treated as
    // `null`, which hydrated the entry as a committed no-time tab and
    // issued an all-time search. Reject the whole payload instead so a
    // hand-edited `?tabs=` link cannot change query semantics.
    const payload = JSON.stringify([
      {
        f: { mode: "structured", input: { source: "1.1.1.1" } },
        p: "banana",
        ar: true,
      },
    ]);
    expect(parseTabsJsonParam({ tabs: payload })).toBeNull();
  });

  it("normalizes structured filter fields instead of trusting the raw tabs JSON", () => {
    // A hand-edited `?tabs=` payload can smuggle the wrong types into
    // fields that `parseActiveTabSearchParams` validates strictly. The
    // tabs decoder must apply the same field-level rules so malformed
    // values are dropped rather than forwarded into `searchEvents()`.
    const payload = JSON.stringify([
      {
        f: {
          mode: "structured",
          input: {
            confidenceMin: "0.8oops",
            confidenceMax: Number.NaN,
            levels: ["1junk", 1, 1.5, "2"],
            categories: [1.5, 2, "3", 4],
            directions: ["OUTBOUND", "NOPE", 5],
            learningMethods: ["UNSUPERVISED", "bogus"],
            sensors: ["s-1", "", "s-1", 42],
            countries: ["US", 123, "KR"],
            kinds: ["HttpThreat", null, "PortScan"],
            keywords: ["alpha", "alpha", ""],
            // A stray / unknown key must be stripped outright so a
            // crafted URL cannot inject fields the drawer does not
            // surface.
            something: "evil",
          },
        },
        p: "1h",
        ar: true,
      },
    ]);
    const parsed = parseTabsJsonParam({ tabs: payload });
    expect(parsed).toHaveLength(1);
    const tab = parsed?.[0];
    if (!tab || tab.filter.mode !== "structured") {
      throw new Error("expected structured tab");
    }
    const input = tab.filter.input as Record<string, unknown>;
    expect(input.confidenceMin).toBeUndefined();
    expect(input.confidenceMax).toBeUndefined();
    expect(input.levels).toEqual([1]);
    expect(input.categories).toEqual([2, 4]);
    expect(input.directions).toEqual(["OUTBOUND"]);
    expect(input.learningMethods).toEqual(["UNSUPERVISED"]);
    expect(input.sensors).toEqual(["s-1"]);
    expect(input.countries).toEqual(["US", "KR"]);
    expect(input.kinds).toEqual(["HttpThreat", "PortScan"]);
    expect(input.keywords).toEqual(["alpha"]);
    expect(input.something).toBeUndefined();
  });

  it("drops raw input.endpoints and rebuilds from the separately-validated UI list", () => {
    // Nested `EndpointInput` is not deep-validated against the GraphQL
    // schema by the tabs decoder, so the first auto-run would submit
    // whatever the URL carried. Drop the raw value and rebuild from
    // the `e` field (which goes through strict per-row validation) so
    // the committed filter stays consistent with the UI strip.
    const payload = JSON.stringify([
      {
        f: {
          mode: "structured",
          input: {
            endpoints: [{ hacked: true }],
            source: "1.2.3.4",
          },
        },
        p: "1h",
        ar: true,
        e: "10.0.0.1|s|1",
      },
    ]);
    const parsed = parseTabsJsonParam({ tabs: payload });
    const tab = parsed?.[0];
    if (!tab || tab.filter.mode !== "structured") {
      throw new Error("expected structured tab");
    }
    const submittedEndpoints = tab.filter.input.endpoints;
    expect(Array.isArray(submittedEndpoints)).toBe(true);
    expect(submittedEndpoints).toHaveLength(1);
    expect(submittedEndpoints?.[0]?.direction).toBe("FROM");
    expect(submittedEndpoints?.[0]?.custom?.hosts).toEqual(["10.0.0.1"]);
    expect(tab.endpoints).toHaveLength(1);
    expect(tab.endpoints[0]?.raw).toBe("10.0.0.1");
  });

  it("omits redundant fields from the serialized tabs payload to save URL budget", () => {
    // Reviewer Round 26 item 2: `serializeTabForUrl` used to copy the
    // filter verbatim, including `input.endpoints` (the decoder
    // rebuilds from `e`) and `input.start`/`input.end` on a
    // period-backed tab (the decoder rolls to "now" on load). Those
    // bytes consumed URL budget for no reason and made the strip
    // fall back to single-tab sharing sooner than necessary.
    const tabs: TabSnapshot[] = [
      sampleTab({
        id: "only",
        filter: {
          mode: "structured",
          input: {
            start: "2026-04-22T00:00:00.000Z",
            end: "2026-04-22T01:00:00.000Z",
            source: "10.0.0.5",
            endpoints: [
              // Nested endpoint shape — the decoder throws this away.
              {
                direction: "FROM",
                custom: { hosts: ["10.0.0.7"], networks: [], ranges: [] },
              },
            ],
          },
        },
        period: "1h",
      }),
      sampleTab({ id: "second" }),
    ];
    const { search } = buildAllTabsSearchParams({
      tabs,
      activeIndex: 0,
      pathname: "/detection",
    });
    const payload = search.get("tabs");
    if (!payload) throw new Error("expected tabs payload");
    const parsed = JSON.parse(payload) as Array<{
      f: { mode: string; input: Record<string, unknown> };
    }>;
    // `start` / `end` on a period-backed tab are derivable from `p`
    // and must stay off the wire.
    expect(parsed[0]?.f.input.start).toBeUndefined();
    expect(parsed[0]?.f.input.end).toBeUndefined();
    // `endpoints` on a structured filter is rebuilt from the `e`
    // field and must stay off the wire.
    expect(parsed[0]?.f.input.endpoints).toBeUndefined();
    // Non-derivable fields still ride along.
    expect(parsed[0]?.f.input.source).toBe("10.0.0.5");
  });

  it("rejects a shared tabs URL that exceeds the 8-tab cap", () => {
    // The interactive shell enforces the cap on `+`, but a
    // hand-edited shared link should not be able to hydrate more
    // than TAB_CAP tabs. Reject at decode time so the URL cannot
    // push the strip past the documented limit.
    const oversized = Array.from({ length: 9 }, (_, i) => ({
      f: {
        mode: "structured",
        input: { start: "a", end: "b", source: `10.0.0.${i}` },
      },
      p: "1h",
      ar: true,
    }));
    expect(parseTabsJsonParam({ tabs: JSON.stringify(oversized) })).toBeNull();
  });
});

describe("readActiveTabIndex", () => {
  it("returns null on missing / malformed / out-of-range values", () => {
    expect(readActiveTabIndex({}, 3)).toBeNull();
    expect(readActiveTabIndex({ tab: "nope" }, 3)).toBeNull();
    expect(readActiveTabIndex({ tab: "-1" }, 3)).toBeNull();
    expect(readActiveTabIndex({ tab: "5" }, 3)).toBeNull();
  });

  it("rejects fractional and trailing-garbage values rather than truncating", () => {
    // `Number.parseInt` would quietly return 1 for both of these; a
    // hand-edited or corrupted shared link must not silently activate
    // the wrong tab.
    expect(readActiveTabIndex({ tab: "1.5" }, 3)).toBeNull();
    expect(readActiveTabIndex({ tab: "1junk" }, 3)).toBeNull();
    expect(readActiveTabIndex({ tab: "+1" }, 3)).toBeNull();
    expect(readActiveTabIndex({ tab: "0x1" }, 3)).toBeNull();
  });

  it("returns the index when valid", () => {
    expect(readActiveTabIndex({ tab: "2" }, 3)).toBe(2);
  });
});
