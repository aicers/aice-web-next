import { describe, expect, it } from "vitest";

import type { Filter } from "@/lib/detection";
import {
  coerceTabForLivePage,
  createBlankTab,
  createDefaultTab,
  parseTabsFromSession,
  rehydrateTabs,
  resolveTabPeriod,
  serializeTabsForSession,
  TAB_CAP,
  type TabSnapshot,
  type TabsSnapshot,
} from "@/lib/detection";

const structuredFilter = (source?: string): Filter => ({
  mode: "structured",
  input: {
    start: "2026-04-01T00:00:00Z",
    end: "2026-04-01T01:00:00Z",
    ...(source ? { source } : {}),
  },
});

const tab = (
  id: string,
  overrides: Partial<TabSnapshot> = {},
): TabSnapshot => ({
  id,
  filter: structuredFilter(),
  period: "1h",
  endpoints: [],
  pivotOnly: {},
  name: null,
  autoRun: true,
  analyticsOpen: false,
  ...overrides,
});

describe("TAB_CAP", () => {
  it("is the 8-tab cap from the issue acceptance", () => {
    // Regression anchor — the issue specifies a hard cap of 8 tabs
    // with a disabled + affordance at the cap. The shell and the tab
    // bar both read from this constant, so changing it requires a
    // matching UX review.
    expect(TAB_CAP).toBe(8);
  });
});

describe("serializeTabsForSession / parseTabsFromSession", () => {
  it("round-trips a single-tab snapshot", () => {
    const snapshot: TabsSnapshot = {
      tabs: [tab("t1")],
      activeIndex: 0,
    };
    const serialized = serializeTabsForSession(snapshot);
    const parsed = parseTabsFromSession(serialized);
    expect(parsed).toEqual(snapshot);
  });

  it("round-trips an 8-tab snapshot", () => {
    const snapshot: TabsSnapshot = {
      tabs: Array.from({ length: TAB_CAP }, (_, i) =>
        tab(`t${i}`, { name: `Tab ${i}`, autoRun: false }),
      ),
      activeIndex: 3,
    };
    const parsed = parseTabsFromSession(serializeTabsForSession(snapshot));
    expect(parsed).toEqual(snapshot);
  });

  it("returns null on a missing payload", () => {
    expect(parseTabsFromSession(null)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseTabsFromSession("{ not json")).toBeNull();
  });

  it("returns null on a mismatched schema version", () => {
    expect(parseTabsFromSession(JSON.stringify({ v: 2, tabs: [] }))).toBeNull();
  });

  it("returns null when the tabs array is empty", () => {
    // An empty array would leave the shell with no tab to render,
    // which would break the "closing the last tab auto-creates a
    // default tab" contract. Reject rather than rehydrate into a
    // broken state.
    expect(
      parseTabsFromSession(JSON.stringify({ v: 1, tabs: [], activeIndex: 0 })),
    ).toBeNull();
  });

  it("rejects a tab with an invalid filter payload", () => {
    // Operator-tampered sessionStorage must not poison the shell
    // state. Invalid filters are treated the same as a missing
    // payload — fall back to the URL-driven default tab.
    const bad = JSON.stringify({
      v: 1,
      tabs: [{ id: "t1", filter: { mode: "nope" }, period: null }],
      activeIndex: 0,
    });
    expect(parseTabsFromSession(bad)).toBeNull();
  });

  it("rejects a structured filter whose `input` is null", () => {
    // `typeof null === "object"` in JS, so a naive check would let
    // this payload through; consumers that spread `filter.input`
    // would then crash. The defensive decoder drops it silently.
    const bad = JSON.stringify({
      v: 1,
      tabs: [
        {
          id: "t1",
          filter: { mode: "structured", input: null },
          period: "1h",
        },
      ],
      activeIndex: 0,
    });
    expect(parseTabsFromSession(bad)).toBeNull();
  });

  it("rejects a tab whose `period` is not a known PeriodKey", () => {
    // A bogus period string would flow into `resolveTabPeriod` and
    // `computePeriodRange` and fabricate `NaN` start / end values.
    // Reject at decode time rather than cast blindly.
    const bad = JSON.stringify({
      v: 1,
      tabs: [
        {
          id: "t1",
          filter: {
            mode: "structured",
            input: { start: "x", end: "y" },
          },
          period: "banana",
        },
      ],
      activeIndex: 0,
    });
    expect(parseTabsFromSession(bad)).toBeNull();
  });

  it("rejects a payload that exceeds the hard 8-tab cap", () => {
    // The interactive shell clamps `+` to TAB_CAP, but a tampered /
    // stale sessionStorage payload could still hydrate into an
    // over-cap strip without matching decode-time enforcement. Drop
    // it the same way we drop other malformed shapes.
    const overCap = JSON.stringify({
      v: 1,
      tabs: Array.from({ length: TAB_CAP + 1 }, (_, i) => ({
        id: `t${i}`,
        filter: {
          mode: "structured",
          input: { start: "a", end: "b" },
        },
        period: "1h",
        endpoints: [],
        pivotOnly: {},
        name: null,
        autoRun: true,
        analyticsOpen: false,
      })),
      activeIndex: 0,
    });
    expect(parseTabsFromSession(overCap)).toBeNull();
  });

  it("rejects a tab whose `endpoints` array contains a non-object entry", () => {
    // `Array.isArray([null])` is still true, but a naive pass-through
    // sends the `null` straight to consumers that spread each entry
    // (the chip builder, the endpoint strip renderer). Reject the
    // whole payload the same way we drop other malformed shapes.
    const bad = JSON.stringify({
      v: 1,
      tabs: [
        {
          id: "t1",
          filter: { mode: "structured", input: {} },
          period: null,
          endpoints: [null],
          pivotOnly: {},
          autoRun: true,
          analyticsOpen: false,
        },
      ],
      activeIndex: 0,
    });
    expect(parseTabsFromSession(bad)).toBeNull();
  });

  it("rejects a tab whose `endpoints` array contains an entry with an unknown `kind`", () => {
    // Hand-edited session payloads can still smuggle shapes that pass
    // the "is object" test but fail the `EndpointEntry` contract —
    // validating each field at decode time is what stops those from
    // reaching the renderer.
    const bad = JSON.stringify({
      v: 1,
      tabs: [
        {
          id: "t1",
          filter: { mode: "structured", input: {} },
          period: null,
          endpoints: [
            {
              id: "e1",
              raw: "10.0.0.1",
              kind: "unknown",
              direction: "BOTH",
              selected: true,
            },
          ],
          pivotOnly: {},
          autoRun: true,
          analyticsOpen: false,
        },
      ],
      activeIndex: 0,
    });
    expect(parseTabsFromSession(bad)).toBeNull();
  });

  it("rejects a fractional activeIndex rather than clamping it to a non-matching slot", () => {
    // `Math.max(0, Math.min(len-1, 0.5))` returns `0.5`, which then
    // fails the `i === idx` check in the single-tab rehydrate path —
    // the URL stops being the source of truth and the operator's
    // filter silently disappears on reload. Drop non-integer indices
    // the same way we drop other malformed payloads.
    const bad = JSON.stringify({
      v: 1,
      tabs: [
        {
          id: "t1",
          filter: { mode: "structured", input: {} },
          period: null,
          endpoints: [],
          pivotOnly: {},
          autoRun: true,
          analyticsOpen: false,
        },
      ],
      activeIndex: 0.5,
    });
    expect(parseTabsFromSession(bad)).toBeNull();
  });

  it("clamps an out-of-range activeIndex into the tabs array", () => {
    const snapshot: TabsSnapshot = {
      tabs: [tab("t1"), tab("t2")],
      activeIndex: 42,
    };
    const parsed = parseTabsFromSession(serializeTabsForSession(snapshot));
    expect(parsed?.activeIndex).toBe(1);
  });

  it("preserves a manual tab name across the round-trip", () => {
    const snapshot: TabsSnapshot = {
      tabs: [tab("t1", { name: "Corp network recon" })],
      activeIndex: 0,
    };
    const parsed = parseTabsFromSession(serializeTabsForSession(snapshot));
    expect(parsed?.tabs[0]?.name).toBe("Corp network recon");
  });

  it("preserves per-tab analyticsOpen across the round-trip so reloading restores the strip layout", () => {
    // Per-tab UI state (scroll, popovers, analytics expansion) is
    // non-shareable and must survive a local reload. URL-encoding it
    // would leak another operator's panel layout onto every shared
    // link.
    const snapshot: TabsSnapshot = {
      tabs: [
        tab("t1", { analyticsOpen: true }),
        tab("t2", { analyticsOpen: false }),
      ],
      activeIndex: 0,
    };
    const parsed = parseTabsFromSession(serializeTabsForSession(snapshot));
    expect(parsed?.tabs[0]?.analyticsOpen).toBe(true);
    expect(parsed?.tabs[1]?.analyticsOpen).toBe(false);
  });

  it("normalizes structured filter fields on decode, dropping malformed scalars / arrays", () => {
    // A tampered sessionStorage payload must not forward bad types
    // into `runEventQuery()` on the next auto-run. The session decoder
    // applies the same field-level normalization as the `tabs=<json>`
    // URL decoder: malformed `confidenceMin` / `levels` / `categories`
    // entries are dropped silently, and unknown keys are stripped.
    const bad = JSON.stringify({
      v: 1,
      tabs: [
        {
          id: "t1",
          filter: {
            mode: "structured",
            input: {
              confidenceMin: "0.8oops",
              confidenceMax: Number.POSITIVE_INFINITY,
              levels: ["1junk", 2],
              categories: [1.5, 3],
              directions: ["INBOUND", "nope"],
              source: "10.0.0.1",
              keywords: ["", "kw"],
              unknown: { poisoned: true },
            },
          },
          period: null,
          endpoints: [],
          pivotOnly: {},
          autoRun: true,
          analyticsOpen: false,
        },
      ],
      activeIndex: 0,
    });
    const parsed = parseTabsFromSession(bad);
    expect(parsed).not.toBeNull();
    const filter = parsed?.tabs[0]?.filter;
    expect(filter?.mode).toBe("structured");
    if (filter?.mode !== "structured") return;
    expect(filter.input.confidenceMin).toBeUndefined();
    expect(filter.input.confidenceMax).toBeUndefined();
    expect(filter.input.levels).toEqual([2]);
    expect(filter.input.categories).toEqual([3]);
    expect(filter.input.directions).toEqual(["INBOUND"]);
    expect(filter.input.source).toBe("10.0.0.1");
    expect(filter.input.keywords).toEqual(["kw"]);
    expect((filter.input as { unknown?: unknown }).unknown).toBeUndefined();
  });

  it("rebuilds structured filter endpoints from the validated EndpointEntry list instead of trusting nested input.endpoints", () => {
    // A hand-crafted session payload can plant arbitrary shapes under
    // `filter.input.endpoints`. The decoder must drop them and rebuild
    // from the separately-validated `endpoints` array so the first
    // auto-run submits a schema-owned `EndpointInput[]`.
    const endpointEntry = {
      id: "e1",
      raw: "10.0.0.1",
      kind: "host" as const,
      host: "10.0.0.1",
      direction: "SOURCE" as const,
      selected: true,
    };
    const bad = JSON.stringify({
      v: 1,
      tabs: [
        {
          id: "t1",
          filter: {
            mode: "structured",
            input: {
              endpoints: [{ smuggled: "junk" }],
            },
          },
          period: null,
          endpoints: [endpointEntry],
          pivotOnly: {},
          autoRun: true,
          analyticsOpen: false,
        },
      ],
      activeIndex: 0,
    });
    const parsed = parseTabsFromSession(bad);
    expect(parsed).not.toBeNull();
    const filter = parsed?.tabs[0]?.filter;
    expect(filter?.mode).toBe("structured");
    if (filter?.mode !== "structured") return;
    const endpoints = filter.input.endpoints ?? [];
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).not.toHaveProperty("smuggled");
    // `endpointsToEndpointInputs` produces `{ direction, custom: { hosts,
    // networks, ranges } }` — the schema-owned shape, not a flat `host`
    // field. The assertion here just makes sure we rebuilt from the
    // validated list instead of passing the smuggled object through.
    expect(endpoints[0]).toHaveProperty("custom");
    expect(endpoints[0]).toHaveProperty("direction", "FROM");
  });

  it("preserves the abstract Filter discriminator across the round-trip", () => {
    // Persistence round-trips the Phase Detection-2 `Filter` union,
    // not a raw `EventListFilterInput`. A query-mode tab must come
    // back with `mode: "query"` so the shell can route it through
    // the same code path on rehydration.
    const snapshot: TabsSnapshot = {
      tabs: [
        tab("t1", {
          filter: { mode: "query", text: "src:10.0.0.1 AND NOT dst:8.8.8.8" },
        }),
      ],
      activeIndex: 0,
    };
    const parsed = parseTabsFromSession(serializeTabsForSession(snapshot));
    expect(parsed?.tabs[0]?.filter).toEqual({
      mode: "query",
      text: "src:10.0.0.1 AND NOT dst:8.8.8.8",
    });
  });
});

describe("rehydrateTabs", () => {
  const urlTab: TabSnapshot = tab("url-active", {
    filter: structuredFilter("1.1.1.1"),
    name: null,
  });

  it("returns the URL tab alone when sessionStorage is empty", () => {
    const result = rehydrateTabs({
      urlTabs: [urlTab],
      urlActiveIndex: null,
      session: null,
    });
    expect(result).toEqual({ tabs: [urlTab], activeIndex: 0 });
  });

  it("uses the URL filter for the active tab, overwriting the stored one", () => {
    // The URL is the source of truth for the shareable active tab.
    // If the operator hand-edited the URL after a reload, the filter
    // advertised by the link wins over whatever the previous session
    // had cached for that slot.
    const stored: TabsSnapshot = {
      tabs: [tab("stored-0", { filter: structuredFilter("stored-ip") })],
      activeIndex: 0,
    };
    const result = rehydrateTabs({
      urlTabs: [urlTab],
      urlActiveIndex: null,
      session: stored,
    });
    expect(result.tabs[0]?.filter).toEqual(urlTab.filter);
  });

  it("preserves stored tab ids and manual names during rebase when the URL filter matches the stored slot", () => {
    // Local reload of the operator's own strip: the URL describes the
    // same filter as the stored active tab, so the fingerprint gate
    // permits carrying over the operator's rename and the stored id.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", {
          filter: structuredFilter("1.1.1.1"),
          name: "Internal",
        }),
        tab("stored-1", { name: "External" }),
      ],
      activeIndex: 0,
    };
    const result = rehydrateTabs({
      urlTabs: [urlTab],
      urlActiveIndex: 0,
      session: stored,
    });
    expect(result.tabs[0]?.id).toBe("stored-0");
    expect(result.tabs[0]?.name).toBe("Internal");
    expect(result.tabs[1]?.name).toBe("External");
  });

  it("does not leak a stored name / analyticsOpen onto an active-only shared URL whose filter differs from the local slot", () => {
    // Active-only shared link path: when the author's working set blew
    // the `?tabs=<json>` budget, the URL only carries the active tab's
    // filter via `?tab=N` plus the flat filter params. Without the
    // fingerprint gate, a local tab at slot N with an unrelated filter
    // could leak its private rename / analytics-strip state onto the
    // shared filter — breaking the URL-vs-session split documented at
    // the top of this module.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", { name: "Local A" }),
        tab("stored-1", { name: "Local B" }),
        tab("stored-2", {
          filter: structuredFilter("local-ip"),
          name: "Corp recon",
          analyticsOpen: true,
        }),
      ],
      activeIndex: 2,
    };
    const sharedUrlTab: TabSnapshot = tab("url-active", {
      filter: structuredFilter("shared-ip"),
      name: null,
      analyticsOpen: false,
    });
    const result = rehydrateTabs({
      urlTabs: [sharedUrlTab],
      urlActiveIndex: 2,
      session: stored,
    });
    // The URL-derived tab takes the slot wholesale: its own id, null
    // name, and collapsed strip pass through. The local tab's "Corp
    // recon" rename and expanded analytics state stay private.
    expect(result.tabs[2]?.id).toBe("url-active");
    expect(result.tabs[2]?.name).toBeNull();
    expect(result.tabs[2]?.analyticsOpen).toBe(false);
    expect(result.tabs[2]?.filter).toEqual(sharedUrlTab.filter);
    // Untouched neighbours still carry their own stored state.
    expect(result.tabs[0]?.name).toBe("Local A");
    expect(result.tabs[1]?.name).toBe("Local B");
  });

  it("honors the URL's activeIndex param when present", () => {
    const stored: TabsSnapshot = {
      tabs: [tab("a"), tab("b"), tab("c")],
      activeIndex: 0,
    };
    const result = rehydrateTabs({
      urlTabs: [urlTab],
      urlActiveIndex: 2,
      session: stored,
    });
    expect(result.activeIndex).toBe(2);
    expect(result.tabs[2]?.filter).toEqual(urlTab.filter);
    expect(result.tabs[0]?.id).toBe("a");
  });

  it("clamps an out-of-range URL index to 0 instead of resurrecting the stored activeIndex", () => {
    // URL state is the source of truth for the active tab index. An
    // out-of-range `?tab=99` on a stored two-tab strip must not fall
    // back to whichever slot the local operator was last sitting on —
    // otherwise opening a corrupted shared link lands the recipient on
    // the operator's private active slot rather than a predictable
    // default.
    const stored: TabsSnapshot = {
      tabs: [tab("a"), tab("b")],
      activeIndex: 1,
    };
    const result = rehydrateTabs({
      urlTabs: [urlTab],
      urlActiveIndex: 99,
      session: stored,
    });
    expect(result.activeIndex).toBe(0);
  });

  it("defaults a missing URL index to 0 on the single-tab path so a no-?tab shared link lands on slot 0 even when the local stored activeIndex is non-zero", () => {
    // `buildAllTabsSearchParams` deliberately omits `?tab=0` and the
    // SSR boundary reads an absent/invalid `?tab` as 0. Falling back
    // to `session.activeIndex` here would finish hydration on the
    // local operator's active slot — breaking the issue's "URL state
    // is the source of truth" rule for active-only shared links whose
    // author was sitting on slot 0.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", { filter: structuredFilter("local-a"), name: "A" }),
        tab("stored-1", { filter: structuredFilter("local-b"), name: "B" }),
        tab("stored-2", { filter: structuredFilter("local-c"), name: "C" }),
      ],
      activeIndex: 2,
    };
    const result = rehydrateTabs({
      urlTabs: [urlTab],
      urlActiveIndex: null,
      session: stored,
    });
    // Active tab is slot 0, not the stored activeIndex=2.
    expect(result.activeIndex).toBe(0);
    // The URL filter is rebased onto slot 0, not slot 2.
    expect(result.tabs[0]?.filter).toEqual(urlTab.filter);
    // Neighbouring slots stay as-is.
    expect(result.tabs[1]?.name).toBe("B");
    expect(result.tabs[2]?.name).toBe("C");
  });

  it("overlays session UI state onto a matching URL tab by filter fingerprint, not by index", () => {
    // Multi-tab URL path: the URL is authoritative for the entire
    // strip; the session only overlays non-shareable UI state when
    // the stored slot actually describes the same tab. Here tab 0's
    // stored filter matches the URL's tab 0 filter, so the operator's
    // manual name and analytics-strip state carry over on a local
    // reload of their own strip.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", {
          filter: structuredFilter("1.1.1.1"),
          name: "Stored A",
          analyticsOpen: true,
        }),
      ],
      activeIndex: 0,
    };
    const urlTabs: TabSnapshot[] = [
      tab("url-0", {
        filter: structuredFilter("1.1.1.1"),
        name: null,
        analyticsOpen: false,
      }),
      tab("url-1", {
        filter: structuredFilter("2.2.2.2"),
        name: null,
        autoRun: false,
      }),
    ];
    const result = rehydrateTabs({
      urlTabs,
      urlActiveIndex: 1,
      session: stored,
    });
    expect(result.tabs).toHaveLength(2);
    expect(result.activeIndex).toBe(1);
    // Index 0 had a stored fingerprint match: id and manual name
    // carry over, analyticsOpen is overlaid from session.
    expect(result.tabs[0]?.id).toBe("stored-0");
    expect(result.tabs[0]?.name).toBe("Stored A");
    expect(result.tabs[0]?.analyticsOpen).toBe(true);
    // Index 1 had no stored match: URL's id and state pass through.
    expect(result.tabs[1]?.id).toBe("url-1");
    expect(result.tabs[1]?.autoRun).toBe(false);
  });

  it("does not leak session state when the URL tab is pending and the stored tab is committed (autoRun mismatch)", () => {
    // `autoRun` is URL-encoded (single-tab path: `pending=1`; multi-tab
    // path: the per-slot `ar` field in `?tabs=<json>`), so it is part
    // of the shareable state. A local committed (`autoRun: true`) tab
    // must not bleed its manual name / analytics state onto a shared
    // slot that the URL explicitly marked as pending (`autoRun: false`)
    // just because every other filter field happens to match.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", {
          filter: structuredFilter("shared-ip"),
          period: null,
          autoRun: true,
          name: "Local rename",
          analyticsOpen: true,
        }),
      ],
      activeIndex: 0,
    };
    const urlTabs: TabSnapshot[] = [
      tab("url-0", {
        filter: structuredFilter("shared-ip"),
        period: null,
        autoRun: false,
        name: null,
        analyticsOpen: false,
      }),
      tab("url-1", {
        filter: structuredFilter("other-ip"),
        name: null,
      }),
    ];
    const result = rehydrateTabs({
      urlTabs,
      urlActiveIndex: 0,
      session: stored,
    });
    // Pending URL slot keeps its own id / null name / collapsed strip;
    // the committed local tab's rename does not leak onto it.
    expect(result.tabs[0]?.id).toBe("url-0");
    expect(result.tabs[0]?.name).toBeNull();
    expect(result.tabs[0]?.analyticsOpen).toBe(false);
    expect(result.tabs[0]?.autoRun).toBe(false);
  });

  it("does not leak session state onto a shared URL whose tab filters differ from the stored strip", () => {
    // Opening a collaborator's shared `?tabs=<json>` URL in a browser
    // that still has unrelated Detection session state must not paint
    // that operator's local renames or analytics-strip expansion onto
    // the shared tabs. The fingerprint gate keeps overlay behaviour
    // local to strips that actually match index-for-index.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", {
          filter: structuredFilter("stored-local-ip"),
          name: "Stale local name",
          analyticsOpen: true,
        }),
        tab("stored-1", {
          filter: structuredFilter("another-local-ip"),
          name: "Also stale",
          analyticsOpen: true,
        }),
      ],
      activeIndex: 0,
    };
    const urlTabs: TabSnapshot[] = [
      tab("url-0", {
        filter: structuredFilter("shared-ip"),
        name: null,
        analyticsOpen: false,
      }),
      tab("url-1", {
        filter: structuredFilter("another-shared-ip"),
        name: null,
        analyticsOpen: false,
      }),
    ];
    const result = rehydrateTabs({
      urlTabs,
      urlActiveIndex: 0,
      session: stored,
    });
    // URL's own ids, null name, and analyticsOpen=false pass through
    // unchanged — the stored ones do not leak onto the shared strip.
    expect(result.tabs[0]?.id).toBe("url-0");
    expect(result.tabs[0]?.name).toBeNull();
    expect(result.tabs[0]?.analyticsOpen).toBe(false);
    expect(result.tabs[1]?.id).toBe("url-1");
    expect(result.tabs[1]?.name).toBeNull();
    expect(result.tabs[1]?.analyticsOpen).toBe(false);
  });

  it("matches the fingerprint when a relative-period tab's rolled start/end drift across the URL round-trip", () => {
    // `resolveTabPeriod` rewrites `filter.input.start` / `end` on every
    // load for any `period: "1h"` tab. A URL-derived tab and its
    // sessionStorage twin therefore never share byte-identical
    // timestamps — the SSR clock read and the last sessionStorage write
    // clock read land a few seconds apart. The fingerprint must treat
    // the two as the same tab so the author's local reload of their
    // own `Last 1 hour` strip still inherits the stored id, manual
    // rename, and analytics-strip state.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", {
          period: "1h",
          filter: {
            mode: "structured",
            input: {
              start: "2026-04-24T11:00:00.000Z",
              end: "2026-04-24T12:00:00.000Z",
            },
          },
          name: "Local rename",
          analyticsOpen: true,
        }),
        tab("stored-1", {
          period: "1h",
          filter: {
            mode: "structured",
            input: {
              start: "2026-04-24T11:00:00.000Z",
              end: "2026-04-24T12:00:00.000Z",
            },
          },
          name: "Other rename",
          analyticsOpen: true,
        }),
      ],
      activeIndex: 0,
    };
    // URL tabs: same logical `Last 1 hour` window but rolled 30 seconds
    // later than the session snapshot, so the raw `filter` bytes differ.
    const urlTabs: TabSnapshot[] = [
      tab("url-0", {
        period: "1h",
        filter: {
          mode: "structured",
          input: {
            start: "2026-04-24T11:00:30.000Z",
            end: "2026-04-24T12:00:30.000Z",
          },
        },
        name: null,
        analyticsOpen: false,
      }),
      tab("url-1", {
        period: "1h",
        filter: {
          mode: "structured",
          input: {
            start: "2026-04-24T11:00:30.000Z",
            end: "2026-04-24T12:00:30.000Z",
          },
        },
        name: null,
        analyticsOpen: false,
      }),
    ];
    const result = rehydrateTabs({
      urlTabs,
      urlActiveIndex: 0,
      session: stored,
    });
    // Fingerprints normalize away the rolled timestamps on relative
    // periods, so the stored id / manual name / analytics-strip state
    // overlay onto the URL tabs as expected for a local reload.
    expect(result.tabs[0]?.id).toBe("stored-0");
    expect(result.tabs[0]?.name).toBe("Local rename");
    expect(result.tabs[0]?.analyticsOpen).toBe(true);
    expect(result.tabs[1]?.id).toBe("stored-1");
    expect(result.tabs[1]?.name).toBe("Other rename");
    expect(result.tabs[1]?.analyticsOpen).toBe(true);
  });

  it("matches the fingerprint when endpoint row ids are regenerated by the URL decoder", () => {
    // `decodeEndpoints` regenerates synthetic `endpoint-url-<n>` ids on
    // every URL decode, while sessionStorage round-trips the original
    // ids. The ids are client-only plumbing, never URL-encoded, so they
    // must be normalized away — otherwise a local reload of a strip
    // with any endpoint rows would drop the stored name / analyticsOpen
    // / id because the byte-for-byte `endpoints` comparison fails.
    const stored: TabsSnapshot = {
      tabs: [
        tab("stored-0", {
          endpoints: [
            {
              id: "endpoint-session-1",
              raw: "10.0.0.1",
              kind: "host",
              host: "10.0.0.1",
              direction: "BOTH",
              selected: true,
            },
          ],
          name: "Corp recon",
          analyticsOpen: true,
        }),
        tab("stored-1", { name: "Other" }),
      ],
      activeIndex: 0,
    };
    const urlTabs: TabSnapshot[] = [
      tab("url-0", {
        endpoints: [
          {
            id: "endpoint-url-1",
            raw: "10.0.0.1",
            kind: "host",
            host: "10.0.0.1",
            direction: "BOTH",
            selected: true,
          },
        ],
        name: null,
        analyticsOpen: false,
      }),
      tab("url-1", { name: null }),
    ];
    const result = rehydrateTabs({
      urlTabs,
      urlActiveIndex: 0,
      session: stored,
    });
    expect(result.tabs[0]?.id).toBe("stored-0");
    expect(result.tabs[0]?.name).toBe("Corp recon");
    expect(result.tabs[0]?.analyticsOpen).toBe(true);
  });
});

describe("resolveTabPeriod", () => {
  const NOW = new Date("2026-04-24T12:00:00Z");

  it("rolls a relative period forward to `now` on the committed filter", () => {
    // A tab labelled `Last 1 hour` must query the hour ending "now"
    // on every rerun path — Refresh, session-restored auto-run,
    // drawer seed. Serializing the start / end on the committed
    // filter froze the window; `resolveTabPeriod` thaws it.
    const stale: TabSnapshot = tab("t1", {
      period: "1h",
      filter: {
        mode: "structured",
        input: {
          // Captured at first Apply at 11:40 — 20 minutes before `now`.
          start: "2026-04-24T10:40:00.000Z",
          end: "2026-04-24T11:40:00.000Z",
          source: "1.1.1.1",
        },
      },
    });
    const rolled = resolveTabPeriod(stale, NOW);
    if (rolled.filter.mode !== "structured") {
      throw new Error("expected structured filter");
    }
    expect(rolled.filter.input.start).toBe("2026-04-24T11:00:00.000Z");
    expect(rolled.filter.input.end).toBe("2026-04-24T12:00:00.000Z");
    // Unrelated fields survive the roll.
    expect(rolled.filter.input.source).toBe("1.1.1.1");
    // Identity is preserved when the window is already fresh so
    // reference-equality checks in the shell can short-circuit.
    expect(resolveTabPeriod(rolled, NOW)).toBe(rolled);
  });

  it("leaves a tab without a period untouched when it already has an explicit range", () => {
    const custom: TabSnapshot = tab("t1", {
      period: null,
      filter: {
        mode: "structured",
        input: {
          start: "2026-04-01T00:00:00Z",
          end: "2026-04-01T01:00:00Z",
        },
      },
    });
    expect(resolveTabPeriod(custom, NOW)).toBe(custom);
  });

  it("leaves a tab without a period and without an explicit range unchanged", () => {
    // `resolveTabPeriod` is pure roll-forward: it never silently
    // injects a default period. Clearing that fallback is what makes
    // the chip-bar `×` affordance honest on committed tabs — removing
    // `Last 1 week` must not snap back to `Last 1 hour`. Cold-start
    // seeding of the default is handled upstream in the page loader
    // (see `snapshotFromSingleTabUrl`), which is the only path that
    // should ever fabricate a default.
    const cleared: TabSnapshot = tab("t1", {
      period: null,
      filter: { mode: "structured", input: {} },
    });
    expect(resolveTabPeriod(cleared, NOW)).toBe(cleared);

    const clearedCommitted: TabSnapshot = tab("t2", {
      period: null,
      filter: { mode: "structured", input: { source: "10.0.0.1" } },
      autoRun: true,
    });
    expect(resolveTabPeriod(clearedCommitted, NOW)).toBe(clearedCommitted);
  });

  it("leaves a pending tab with no period and no range unchanged", () => {
    // Issue #281 "the user must Apply": on a fresh `+` tab the
    // operator can remove the default `Last 1 hour` chip before
    // Applying. The resulting snapshot has `period: null` and no
    // explicit start / end, and `autoRun: false`. Reload must
    // reproduce that exact state — resurrecting the default period
    // would contradict the chip the operator just removed.
    const pending: TabSnapshot = tab("t1", {
      period: null,
      filter: { mode: "structured", input: {} },
      autoRun: false,
    });
    expect(resolveTabPeriod(pending, NOW)).toBe(pending);
  });

  it("returns query-mode tabs unchanged", () => {
    const q: TabSnapshot = tab("t1", {
      period: "1h",
      filter: { mode: "query", text: "src:1.1.1.1" },
    });
    expect(resolveTabPeriod(q, NOW)).toBe(q);
  });
});

describe("createBlankTab", () => {
  it("marks the tab as not auto-run so the `+` affordance does not auto-fire a query", () => {
    // Issue acceptance: "`+` creates an empty-filtered tab that does
    // not auto-run." The shell gates auto-run on this flag.
    const blank = createBlankTab({
      filter: structuredFilter(),
      period: "1h",
    });
    expect(blank.autoRun).toBe(false);
  });

  it("generates a unique id per call", () => {
    const a = createBlankTab({ filter: structuredFilter(), period: "1h" });
    const b = createBlankTab({ filter: structuredFilter(), period: "1h" });
    expect(a.id).not.toBe(b.id);
  });

  it("starts with no manual name so the tab bar renders the auto-generated summary", () => {
    const blank = createBlankTab({ filter: structuredFilter(), period: "1h" });
    expect(blank.name).toBeNull();
  });
});

describe("createDefaultTab", () => {
  it("marks the tab as auto-run so the shell fires the first query", () => {
    // Reviewer Round 18 item 1: closing the last tab must drop the
    // operator into a default tab (auto-executes `Last 1 hour`), not
    // a pending `+` tab. The shell's auto-run effect keys on this flag.
    const fresh = createDefaultTab({
      filter: structuredFilter(),
      period: "1h",
    });
    expect(fresh.autoRun).toBe(true);
  });

  it("generates a unique id per call", () => {
    const a = createDefaultTab({ filter: structuredFilter(), period: "1h" });
    const b = createDefaultTab({ filter: structuredFilter(), period: "1h" });
    expect(a.id).not.toBe(b.id);
  });

  it("starts with no manual name / endpoints / pivot params", () => {
    const fresh = createDefaultTab({
      filter: structuredFilter(),
      period: "1h",
    });
    expect(fresh.name).toBeNull();
    expect(fresh.endpoints).toEqual([]);
    expect(fresh.pivotOnly).toEqual({});
    expect(fresh.analyticsOpen).toBe(false);
  });
});

describe("coerceTabForLivePage", () => {
  // Reviewer Round 26 item 1: the URL / session decoders round-trip
  // `mode: "query"` for forward-compat, but the live Detection page
  // has no query editor — it must downgrade to a default structured
  // tab at the boundary so the chip bar and drawer never render a
  // broken filter.
  it("leaves structured tabs untouched", () => {
    const structured = tab("t-structured", {
      filter: structuredFilter("10.0.0.5"),
      period: "1h",
    });
    expect(coerceTabForLivePage(structured, "1h")).toBe(structured);
  });

  it("downgrades a query-mode tab to a default-period structured tab", () => {
    const query = tab("t-query", {
      filter: { mode: "query", text: "src:1.1.1.1 AND NOT dst:8.8.8.8" },
      period: null,
      endpoints: [],
      pivotOnly: { kind: "http" },
      autoRun: false,
    });
    const coerced = coerceTabForLivePage(query, "1h");
    expect(coerced.filter).toEqual({ mode: "structured", input: {} });
    expect(coerced.period).toBe("1h");
    expect(coerced.endpoints).toEqual([]);
    expect(coerced.pivotOnly).toEqual({});
    // The downgraded tab behaves like a cold-start default so the
    // page fetches `Last 1 hour` on load instead of landing on an
    // empty pre-query panel no operator asked for.
    expect(coerced.autoRun).toBe(true);
    // Preserve id / name so local per-tab runtime state (caches,
    // operator rename) still matches after the downgrade.
    expect(coerced.id).toBe("t-query");
    expect(coerced.name).toBe(query.name);
  });
});
