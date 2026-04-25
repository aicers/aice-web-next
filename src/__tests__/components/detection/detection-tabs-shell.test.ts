import { describe, expect, it, vi } from "vitest";

// `detection-tabs-shell` is a `"use client"` module that imports the
// full DetectionShell, which itself pulls in next-intl, lucide, and a
// handful of UI primitives. We only need the pure helpers — mock the
// React surface and the heavy children so the import resolves under
// the vitest environment without dragging the whole client runtime in.
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, vi.fn()],
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/detection",
}));
vi.mock("@/components/detection/detection-shell", () => ({
  DetectionShell: () => null,
}));
vi.mock("@/components/detection/tab-bar", () => ({
  TabBar: () => null,
}));

import type { DetectionShellStateSnapshot } from "@/components/detection/detection-shell";
import {
  bootstrapTabToSnapshot,
  buildDefaultTabSnapshot,
  buildUrlSearchForTab,
  mergeSnapshot,
  mergeStoredTabsOnRehydrate,
  routeSnapshotToTab,
} from "@/components/detection/detection-tabs-shell";
import type { Filter } from "@/lib/detection/filter";
import { parseFilterFromUrlParam } from "@/lib/detection/filter-url";
import { INITIAL_PAGINATION_STATE } from "@/lib/detection/pagination";
import {
  createTabSnapshot,
  type TabId,
  type TabSnapshot,
} from "@/lib/detection/tabs";

const RICH_FILTER: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-25T00:00:00.000Z",
    end: "2026-04-25T01:00:00.000Z",
    levels: [3],
    countries: ["KR"],
    learningMethods: ["SEMI_SUPERVISED"],
    categories: [2],
    kinds: ["HttpThreat"],
    directions: ["INBOUND"],
    confidenceMin: 0.5,
    confidenceMax: 0.95,
  },
};

describe("buildUrlSearchForTab — Reviewer Round 1 (item 1)", () => {
  it("encodes the full structured Filter (levels, countries, learning methods, categories, directions, confidence) into the `?f=` blob", () => {
    const tab = createTabSnapshot({ filter: RICH_FILTER, period: "1h" });
    const search = buildUrlSearchForTab(tab);
    const decoded = parseFilterFromUrlParam(search.get("f"));
    expect(decoded?.filter).toEqual(RICH_FILTER);
    expect(decoded?.period).toBe("1h");
  });

  it('round-trips a `mode: "query"` filter — the future search-language branch', () => {
    const filter: Filter = { mode: "query", text: "level:high" };
    const tab = createTabSnapshot({ filter, period: null });
    const search = buildUrlSearchForTab(tab);
    const decoded = parseFilterFromUrlParam(search.get("f"));
    expect(decoded?.filter).toEqual(filter);
  });

  it("round-trips the URL-only pivot extras (origPort/respPort/proto)", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      pivotOnly: { origPort: 54321, respPort: 80, proto: 6 },
    };
    const search = buildUrlSearchForTab(tab);
    const decoded = parseFilterFromUrlParam(search.get("f"));
    expect(decoded?.pivotExtras).toEqual({
      origPort: 54321,
      respPort: 80,
      proto: 6,
    });
  });

  it("layers pagination on top of the encoded filter blob", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      pagination: {
        pageSize: 100,
        page: 3,
        anchor: { kind: "after", cursor: "abc" },
      },
    };
    const search = buildUrlSearchForTab(tab);
    expect(search.get("page")).toBe("3");
    expect(search.get("pageSize")).toBe("100");
    expect(search.get("after")).toBe("abc");
    expect(search.has("f")).toBe(true);
  });

  it("does not emit any of the legacy pivot keys (source / kind / window / hostnames / …)", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      pivotOnly: { origPort: 80 },
    };
    const search = buildUrlSearchForTab(tab);
    for (const legacy of [
      "source",
      "destination",
      "kind",
      "window",
      "keywords",
      "hostnames",
      "userIds",
      "userNames",
      "userDepartments",
    ]) {
      expect(search.has(legacy)).toBe(false);
    }
  });
});

describe("mergeSnapshot — Reviewer Round 1 (item 2)", () => {
  // `handleShellStateChange` calls `mergeSnapshot` on every shell
  // commit so the React `tabs` state mirrors the live shell. The
  // ref-only model the original shell used left the tab bar's
  // auto-derived label, the loading dot, and the session
  // persistence write all pinned to the bootstrap snapshot.
  it("replaces tab-relevant fields (filter / period / result.*) with the snapshot's values", () => {
    const tab = createTabSnapshot({
      filter: { mode: "structured", input: { start: "old", end: "old" } },
      period: "1h",
    });
    const snapshot: DetectionShellStateSnapshot = {
      filter: RICH_FILTER,
      period: "1d",
      endpoints: [],
      pivotOnly: { origPort: 1234 },
      pagination: { ...INITIAL_PAGINATION_STATE, page: 5 },
      draft: null,
      analyticsOpen: true,
      quickPeekEvent: null,
      result: {
        events: [],
        eventKeys: [],
        totalCount: "42",
        pageInfo: null,
        resultError: null,
        lastUpdatedMs: 1_700_000_000_000,
        hasQueried: true,
        queryEpoch: 7,
        loading: false,
        walking: null,
      },
    };
    const merged = mergeSnapshot(tab, snapshot);
    expect(merged.filter).toEqual(RICH_FILTER);
    expect(merged.period).toBe("1d");
    expect(merged.pagination.page).toBe(5);
    expect(merged.analyticsOpen).toBe(true);
    expect(merged.pivotOnly).toEqual({ origPort: 1234 });
    expect(merged.result.totalCount).toBe("42");
    expect(merged.result.hasQueried).toBe(true);
    expect(merged.result.queryEpoch).toBe(7);
  });

  it("preserves the existing tab id, name, and manual-rename bit", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      name: "My pinned tab",
      manualName: true,
    };
    const snapshot: DetectionShellStateSnapshot = {
      filter: RICH_FILTER,
      period: "1h",
      endpoints: [],
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      draft: null,
      analyticsOpen: false,
      quickPeekEvent: null,
      result: {
        events: [],
        eventKeys: [],
        totalCount: null,
        pageInfo: null,
        resultError: null,
        lastUpdatedMs: null,
        hasQueried: false,
        queryEpoch: 0,
        loading: false,
        walking: null,
      },
    };
    const merged = mergeSnapshot(tab, snapshot);
    expect(merged.id).toBe(tab.id);
    expect(merged.name).toBe("My pinned tab");
    expect(merged.manualName).toBe(true);
  });
});

describe("bootstrapTabToSnapshot — Reviewer Round 1 (item 3)", () => {
  // The shell honours `initialResult.lastUpdatedMs` only when the
  // bootstrap explicitly threads it through; the bootstrap helper
  // owns that initial stamp for the SSR-completed first slice.
  it("seeds lastUpdatedMs when the SSR query succeeded", () => {
    const before = Date.now();
    const tab = bootstrapTabToSnapshot({
      id: "boot",
      filter: RICH_FILTER,
      period: "1h",
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      result: {
        totalCount: "10",
        error: null,
        events: [],
        eventKeys: [],
        pageInfo: null,
      },
    });
    expect(tab.result.hasQueried).toBe(true);
    expect(tab.result.lastUpdatedMs).not.toBeNull();
    expect(tab.result.lastUpdatedMs ?? 0).toBeGreaterThanOrEqual(before);
  });

  it("leaves lastUpdatedMs / hasQueried unset when the SSR query errored", () => {
    const tab = bootstrapTabToSnapshot({
      id: "boot",
      filter: RICH_FILTER,
      period: "1h",
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      result: {
        totalCount: null,
        error: "boom",
        events: [],
        eventKeys: [],
        pageInfo: null,
      },
    });
    expect(tab.result.hasQueried).toBe(false);
    expect(tab.result.lastUpdatedMs).toBeNull();
  });

  it("threads through the rich endpoint entries the encoded URL blob restored", () => {
    const tab = bootstrapTabToSnapshot({
      id: "boot",
      filter: RICH_FILTER,
      period: "1h",
      pivotOnly: {},
      endpoints: [
        {
          id: "ep-1",
          raw: "10.1.1.1",
          kind: "host",
          host: "10.1.1.1",
          direction: "BOTH",
          selected: true,
        },
      ],
      pagination: INITIAL_PAGINATION_STATE,
      result: {
        totalCount: "0",
        error: null,
        events: [],
        eventKeys: [],
        pageInfo: null,
      },
    });
    expect(tab.endpoints).toHaveLength(1);
    expect(tab.endpoints[0].raw).toBe("10.1.1.1");
  });
});

describe("buildDefaultTabSnapshot", () => {
  it("seeds the default 1-hour filter and an empty result cache (the `+` affordance contract)", () => {
    const tab = buildDefaultTabSnapshot();
    expect(tab.period).toBe("1h");
    expect(tab.filter.mode).toBe("structured");
    expect(tab.result.hasQueried).toBe(false);
    expect(tab.result.events).toEqual([]);
    expect(tab.result.lastUpdatedMs).toBeNull();
  });
});

describe("routeSnapshotToTab — Reviewer Round 2 (item 1)", () => {
  // The wrapper used to read `activeTabIdRef.current` inside the
  // shell's onStateChange handler, but a remounted shell's mount-time
  // snapshot effect fires BEFORE the parent's ref-update effect under
  // React's child-before-parent passive ordering. That meant the
  // incoming tab's snapshot landed in the outgoing tab's slot during
  // an A→B switch, and switching back to A then showed B's filter.
  // The contract is now: the routing key is the captured `targetTabId`
  // from the render that mounted the keyed shell, so a snapshot
  // emitted by the shell mounted as B can never write tab A.
  const tabA = createTabSnapshot({
    filter: { mode: "structured", input: { start: "A", end: "A" } },
    period: "1h",
  });
  const tabB = createTabSnapshot({
    filter: { mode: "structured", input: { start: "B", end: "B" } },
    period: "12h",
  });
  function snapshotFor(filter: Filter): DetectionShellStateSnapshot {
    return {
      filter,
      period: null,
      endpoints: [],
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      draft: null,
      analyticsOpen: false,
      quickPeekEvent: null,
      result: {
        events: [],
        eventKeys: [],
        totalCount: "0",
        pageInfo: null,
        resultError: null,
        lastUpdatedMs: 1_700_000_000_000,
        hasQueried: true,
        queryEpoch: 1,
        loading: false,
        walking: null,
      },
    };
  }
  const tabs = [tabA, tabB];

  it("writes the snapshot only into the slot whose id matches `targetTabId`", () => {
    const incoming = snapshotFor({
      mode: "structured",
      input: { start: "B-applied", end: "B-applied" },
    });
    const next = routeSnapshotToTab(tabs, tabB.id, incoming);
    expect(next.find((t) => t.id === tabA.id)?.filter).toEqual(tabA.filter);
    expect(next.find((t) => t.id === tabB.id)?.filter).toEqual(incoming.filter);
  });

  it("never leaks the incoming snapshot into a sibling tab even if the caller passes a stale id", () => {
    // Simulates the pre-fix bug shape: a shell mounted as B emits its
    // snapshot, but the routing helper is told to write it to tab A
    // (the bug was the wrapper reading the still-stale ref). The
    // contract under test is: whichever id wins routing, the OTHER
    // tab MUST be untouched. With the captured-id wiring the wrapper
    // can no longer hand in the wrong id at all, but we lock the
    // surrounding helper too so a future regression in either
    // direction fails here.
    const incoming = snapshotFor({
      mode: "structured",
      input: { start: "wrong", end: "wrong" },
    });
    const next = routeSnapshotToTab(tabs, tabA.id, incoming);
    expect(next.find((t) => t.id === tabB.id)?.filter).toEqual(tabB.filter);
    expect(next.find((t) => t.id === tabA.id)?.filter).toEqual(incoming.filter);
  });

  it("returns the input list unchanged when no slot matches the target id", () => {
    const incoming = snapshotFor(tabA.filter);
    const next = routeSnapshotToTab(tabs, "nonexistent" as TabId, incoming);
    expect(next).toEqual(tabs);
  });
});

describe("buildUrlSearchForTab — Reviewer Round 2 (item 2)", () => {
  // The wrapper's URL effect rewrites the address bar on every `tabs`
  // change — which now includes the snapshot-mirrored
  // `quickPeekEvent`. A `buildUrlSearchForTab` that omitted the
  // `?event=` token would have the wrapper clobber the param the
  // shell wrote in `writeQuickPeekToUrl`, breaking the share /
  // refresh contract on Quick peek.
  const httpThreatEvent = {
    __typename: "HttpThreat",
    time: "2026-04-25T12:00:00.000Z",
    sensor: "sensor-1",
    confidence: 0.81,
    category: "LATERAL_MOVEMENT",
    level: "HIGH",
    triageScores: null,
    origAddr: "10.0.0.5",
    origPort: 49152,
    respAddr: "203.0.113.45",
    respPort: 443,
    proto: 6,
  } as unknown as TabSnapshot["quickPeekEvent"] & {};

  it("emits the `event=` param when the tab carries a Quick peek selection", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      quickPeekEvent: httpThreatEvent,
    };
    const search = buildUrlSearchForTab(tab);
    expect(search.has("event")).toBe(true);
    // Token is the same one the shell would write via
    // `writeQuickPeekToUrl(encodeEventLocator(event))`, so refresh
    // restores the same row even when the wrapper rewrites the URL
    // after the snapshot mirror.
    expect(search.get("event")?.length ?? 0).toBeGreaterThan(0);
  });

  it("omits the `event=` param when the tab has no Quick peek selection", () => {
    const tab = createTabSnapshot({ filter: RICH_FILTER, period: "1h" });
    const search = buildUrlSearchForTab(tab);
    expect(search.has("event")).toBe(false);
  });
});

describe("mergeStoredTabsOnRehydrate — Reviewer Round 6 (item 1)", () => {
  // The previous shape always returned [bootstrap, ...others], which
  // moved the active tab to the front of the bar on every reload —
  // breaking the "Reload restores the tab set and active index"
  // acceptance item and changing neighbour-close semantics.
  const tabA = createTabSnapshot({
    filter: { mode: "structured", input: { start: "A", end: "A" } },
    period: "1h",
  });
  const tabB = createTabSnapshot({
    filter: { mode: "structured", input: { start: "B", end: "B" } },
    period: "12h",
  });
  const tabC = createTabSnapshot({
    filter: { mode: "structured", input: { start: "C", end: "C" } },
    period: "1d",
  });

  it("preserves stored order when the URL bootstrap matches a non-front stored slot", () => {
    // URL bootstrap is B (the previously active tab). Stored order is
    // [A, B, C]. Without the fix the merged list would have been
    // [B, A, C]; with the fix it stays [A, B, C].
    const stored = [tabA, tabB, tabC];
    const merged = mergeStoredTabsOnRehydrate([tabB], stored);
    expect(merged.map((t) => t.id)).toEqual([tabA.id, tabB.id, tabC.id]);
  });

  it("uses the bootstrap's URL-authoritative filter for the matched slot", () => {
    // The reload's `?f=` blob may carry an updated filter (e.g. an
    // Apply that committed right before the reload). The merge keeps
    // that filter — only the UX-only fields (name, manualName, draft,
    // analyticsOpen) come from the stored slot.
    const bootstrap: TabSnapshot = {
      ...tabB,
      filter: {
        mode: "structured",
        input: { start: "B-applied", end: "B-applied" },
      },
    };
    const stored = [tabA, { ...tabB, name: "Renamed", manualName: true }, tabC];
    const merged = mergeStoredTabsOnRehydrate([bootstrap], stored);
    const slot = merged.find((t) => t.id === tabB.id);
    expect(slot?.filter).toEqual(bootstrap.filter);
    expect(slot?.name).toBe("Renamed");
    expect(slot?.manualName).toBe(true);
  });

  it("prepends the bootstrap when no stored tab matches (shared-link landing on a session with tabs)", () => {
    const bootstrap = createTabSnapshot({
      filter: { mode: "structured", input: { start: "shared", end: "shared" } },
      period: "1h",
    });
    const merged = mergeStoredTabsOnRehydrate([bootstrap], [tabA, tabB]);
    expect(merged.map((t) => t.id)).toEqual([bootstrap.id, tabA.id, tabB.id]);
  });

  it("caps the merged list at MAX_TABS so a legacy > 8 payload still loads", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      createTabSnapshot({
        filter: { mode: "structured", input: { start: `${i}`, end: `${i}` } },
        period: "1h",
      }),
    );
    const merged = mergeStoredTabsOnRehydrate([many[0]], many);
    expect(merged.length).toBe(8);
    // The matched slot survives — it's at index 0 of the stored list.
    expect(merged[0].id).toBe(many[0].id);
  });

  it("returns the bootstrap list unchanged when the bootstrap is empty", () => {
    expect(mergeStoredTabsOnRehydrate([], [tabA])).toEqual([]);
  });
});

describe("buildUrlSearchForTab — Reviewer Round 3 (atomic transition)", () => {
  // The shell's `applyTransitionReset` pins pagination back to
  // HEAD + page=1 synchronously on Apply / chip ×, so a mid-flight
  // snapshot merged into the tab never carries a stale `after=` /
  // `before=` / `last=` cursor under the newly committed filter.
  // The wrapper's URL effect reads from that snapshot, so this
  // assertion also locks the URL-writer contract: no stale
  // pagination keys can reach the URL for a transition in flight.
  const MID_FLIGHT_TRANSITION: TabSnapshot = {
    ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
    // Post-reset pagination: HEAD anchor, page 1, default page size.
    pagination: { pageSize: 50, page: 1, anchor: { kind: "head" } },
    result: {
      // Post-reset result cache: no rows, no pageInfo, no total,
      // no last-updated stamp. `loading: true` models the shell
      // mid-flight; `loading` is intentionally NOT snapshotted
      // back into the shell on remount.
      events: [],
      eventKeys: [],
      totalCount: null,
      pageInfo: null,
      resultError: null,
      lastUpdatedMs: null,
      hasQueried: true,
      queryEpoch: 1,
      loading: true,
      walking: null,
    },
  };

  it("omits after= / before= / last= cursor keys when pagination is at HEAD (the post-reset state)", () => {
    const search = buildUrlSearchForTab(MID_FLIGHT_TRANSITION);
    expect(search.has("after")).toBe(false);
    expect(search.has("before")).toBe(false);
    expect(search.has("last")).toBe(false);
  });

  it("omits the page= key when the tab is at page 1 so a transition URL does not leak a stale cursor page", () => {
    const search = buildUrlSearchForTab(MID_FLIGHT_TRANSITION);
    expect(search.has("page")).toBe(false);
  });

  it("still emits the full encoded filter blob so a share-this-URL reload reproduces the operator's Apply", () => {
    const search = buildUrlSearchForTab(MID_FLIGHT_TRANSITION);
    expect(search.has("f")).toBe(true);
    const decoded = parseFilterFromUrlParam(search.get("f"));
    expect(decoded?.filter).toEqual(RICH_FILTER);
  });
});
