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
  createContext: (defaultValue: unknown) => ({
    Provider: "div",
    Consumer: "div",
    displayName: "MockedContext",
    _currentValue: defaultValue,
  }),
  useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
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
  applyTabScrollTransition,
  bootstrapTabToSnapshot,
  buildDefaultTabSnapshot,
  buildUrlSearchForTab,
  clearTabPresetMetadata,
  findMatchingTab,
  mergeSnapshot,
  mergeStoredTabsOnRehydrate,
  resolveActivatePresetEffect,
  resolveLoadSavedFilterEffect,
  resolvePivotEffect,
  routeSnapshotToTab,
  shouldClearMatchFocusEvent,
} from "@/components/detection/detection-tabs-shell";
import type { EndpointEntry } from "@/lib/detection/endpoint-filter";
import type { Filter } from "@/lib/detection/filter";
import { parseFilterFromUrlParam } from "@/lib/detection/filter-url";
import { INITIAL_PAGINATION_STATE } from "@/lib/detection/pagination";
import type { PivotAction } from "@/lib/detection/pivot";
import {
  createTabSnapshot,
  type OriginPreset,
  type TabId,
  type TabSnapshot,
} from "@/lib/detection/tabs";

const RICH_FILTER: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-25T00:00:00.000Z",
    end: "2026-04-25T01:00:00.000Z",
    levels: ["HIGH"],
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
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
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
        forbiddenSensorIds: null,
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

  // #278 Reviewer Round 3 #1: `forbiddenSensorIds` must round-trip
  // through the snapshot mirror or the banner + one-click recovery
  // disappear on the next tab switch after a client-side Apply.
  it("mirrors forbiddenSensorIds from the snapshot into the tab cache so the banner survives a tab switch / remount", () => {
    const tab = createTabSnapshot({ filter: RICH_FILTER, period: "1h" });
    const snapshot: DetectionShellStateSnapshot = {
      filter: RICH_FILTER,
      period: "1h",
      endpoints: [],
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      draft: null,
      analyticsOpen: false,
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
      result: {
        events: [],
        eventKeys: [],
        totalCount: null,
        pageInfo: null,
        resultError: "Sensor selection no longer accessible",
        lastUpdatedMs: null,
        hasQueried: true,
        queryEpoch: 1,
        loading: false,
        walking: null,
        forbiddenSensorIds: ["7", "13"],
      },
    };
    const merged = mergeSnapshot(tab, snapshot);
    expect(merged.result.forbiddenSensorIds).toEqual(["7", "13"]);
  });

  it("clears forbiddenSensorIds when the shell recovers / dismisses and emits a null mirror", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      result: {
        ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }).result,
        forbiddenSensorIds: ["7", "13"],
      },
    };
    const snapshot: DetectionShellStateSnapshot = {
      filter: RICH_FILTER,
      period: "1h",
      endpoints: [],
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      draft: null,
      analyticsOpen: false,
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
      result: {
        events: [],
        eventKeys: [],
        totalCount: "0",
        pageInfo: null,
        resultError: null,
        lastUpdatedMs: 1_700_000_000_000,
        hasQueried: true,
        queryEpoch: 2,
        loading: false,
        walking: null,
        forbiddenSensorIds: null,
      },
    };
    const merged = mergeSnapshot(tab, snapshot);
    expect(merged.result.forbiddenSensorIds).toBeNull();
  });

  // Reviewer Round 1 (P2 per-tab state): the multi-tab wrapper has to
  // persist the analytics selector so a tab switch / reload restores
  // the operator's chosen dimension / Top N. The snapshot merge is
  // the bridge from live shell state into the React `tabs` array.
  it("copies analyticsDimension and analyticsTopN from the snapshot into the tab", () => {
    const tab = createTabSnapshot({ filter: RICH_FILTER, period: "1h" });
    const snapshot: DetectionShellStateSnapshot = {
      filter: RICH_FILTER,
      period: "1h",
      endpoints: [],
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      draft: null,
      analyticsOpen: true,
      analyticsDimension: "country",
      analyticsTopN: 20,
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
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
        forbiddenSensorIds: null,
      },
    };
    const merged = mergeSnapshot(tab, snapshot);
    expect(merged.analyticsDimension).toBe("country");
    expect(merged.analyticsTopN).toBe(20);
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
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
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
        forbiddenSensorIds: null,
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

  it("marks hasQueried true (with no lastUpdatedMs) when the SSR query errored — Reviewer Round 8 (item 1)", () => {
    // The bootstrap tab always attempts the first query, so a
    // failure still counts as "this tab has run a query". Without
    // this, the Round 7 `!hasQueried` guard on `handleRefresh` would
    // strand the error panel's Retry button as a no-op.
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
    expect(tab.result.hasQueried).toBe(true);
    expect(tab.result.resultError).toBe("boom");
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
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
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
        forbiddenSensorIds: null,
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
    id: "evt-AAAA",
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

describe("buildUrlSearchForTab — Reviewer Round 9 (pending token round-trip)", () => {
  // The wrapper's mount-time URL effect rewrites the address bar from
  // the tab snapshot. When a shared link's first slice errors, the
  // shell intentionally preserves the URL `?event=` token (the empty
  // errored slice cannot prove the token stale), but the snapshot's
  // `quickPeekEvent` is still null because no event has been
  // resolved. Without `pendingQuickPeekToken` round-tripping, the
  // wrapper would clobber the URL on its first replaceState — the
  // operator would lose the locator before Retry could match it
  // against the recovered slice.
  const resolvedEvent = {
    __typename: "HttpThreat",
    id: "evt-BBBB",
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

  it("emits the pending token when `quickPeekEvent` is null but `pendingQuickPeekToken` is set", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      quickPeekEvent: null,
      pendingQuickPeekToken: "pending-token-abc",
    };
    const search = buildUrlSearchForTab(tab);
    expect(search.get("event")).toBe("pending-token-abc");
  });

  it("prefers the resolved `quickPeekEvent` locator over `pendingQuickPeekToken` when both are present", () => {
    // Once the shell resolves the URL token to a concrete event,
    // pending should already have been cleared. This case is
    // defensive — if both fields end up set together (e.g. a future
    // refactor neglects to clear pending), the URL writer should
    // still encode the resolved peek's locator so the address bar
    // matches the inspector's currently-open row.
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      quickPeekEvent: resolvedEvent,
      pendingQuickPeekToken: "stale-pending",
    };
    const search = buildUrlSearchForTab(tab);
    const emitted = search.get("event");
    expect(emitted).not.toBe("stale-pending");
    expect(emitted?.length ?? 0).toBeGreaterThan(0);
  });

  it("omits `event=` when both `quickPeekEvent` and `pendingQuickPeekToken` are null", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
    };
    const search = buildUrlSearchForTab(tab);
    expect(search.has("event")).toBe(false);
  });
});

describe("bootstrapTabToSnapshot — Reviewer Round 9 (pending token seed)", () => {
  it("carries `quickPeekToken` from the SSR bootstrap into `pendingQuickPeekToken`", () => {
    // The page reads `?event=<locator>` from `searchParams`,
    // strict-validates it via `decodeEventLocator`, and threads it
    // through `initialTab.quickPeekToken`. The bootstrap helper
    // promotes it to the tab's pending field so the wrapper's URL
    // effect can re-emit the token instead of stripping it during
    // an errored-bootstrap reload.
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
      quickPeekToken: "ssr-validated-token",
    });
    expect(tab.pendingQuickPeekToken).toBe("ssr-validated-token");
  });

  it("seeds `pendingQuickPeekToken: null` when the URL carried no `?event=` param", () => {
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
    expect(tab.pendingQuickPeekToken).toBeNull();
  });
});

describe("mergeSnapshot — Reviewer Round 9 (pending token round-trip)", () => {
  it("copies `pendingQuickPeekToken` from the shell snapshot into the tab", () => {
    // When the shell's mount-restore effect seeds the pending token
    // (errored bootstrap path) and emits the next snapshot, the
    // wrapper's tab slot must receive the pending field — otherwise
    // a later URL write would lose the placeholder and the wrapper
    // would clobber `?event=` on the next tabs change.
    const tab = createTabSnapshot({ filter: RICH_FILTER, period: "1h" });
    const snapshot: DetectionShellStateSnapshot = {
      filter: RICH_FILTER,
      period: "1h",
      endpoints: [],
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      draft: null,
      analyticsOpen: false,
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
      quickPeekEvent: null,
      pendingQuickPeekToken: "pending-token-xyz",
      timeMode: "custom",
      result: {
        events: [],
        eventKeys: [],
        totalCount: null,
        pageInfo: null,
        resultError: "boom",
        lastUpdatedMs: null,
        hasQueried: true,
        queryEpoch: 0,
        loading: false,
        walking: null,
        forbiddenSensorIds: null,
      },
    };
    const merged = mergeSnapshot(tab, snapshot);
    expect(merged.pendingQuickPeekToken).toBe("pending-token-xyz");
    expect(merged.quickPeekEvent).toBeNull();
  });

  it("clears `pendingQuickPeekToken` when the shell resolves the peek and emits the cleared snapshot", () => {
    const tab: TabSnapshot = {
      ...createTabSnapshot({ filter: RICH_FILTER, period: "1h" }),
      pendingQuickPeekToken: "pending-token-xyz",
    };
    const snapshot: DetectionShellStateSnapshot = {
      filter: RICH_FILTER,
      period: "1h",
      endpoints: [],
      pivotOnly: {},
      pagination: INITIAL_PAGINATION_STATE,
      draft: null,
      analyticsOpen: false,
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
      quickPeekEvent: null,
      pendingQuickPeekToken: null,
      timeMode: "custom",
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
        forbiddenSensorIds: null,
      },
    };
    const merged = mergeSnapshot(tab, snapshot);
    expect(merged.pendingQuickPeekToken).toBeNull();
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

  // Reviewer Round 1 (P2 per-tab state): the rehydrate merge has to
  // promote the stored tab's analytics dimension / Top N onto the
  // fresh URL bootstrap, otherwise the operator would see the
  // selector reset to the default after every reload.
  it("restores analyticsDimension and analyticsTopN from the matched stored slot onto the bootstrap", () => {
    const stored: TabSnapshot = {
      ...tabB,
      analyticsOpen: true,
      analyticsDimension: "country",
      analyticsTopN: 20,
    };
    const bootstrap: TabSnapshot = {
      ...tabB,
      analyticsOpen: false,
      analyticsDimension: "srcIp",
      analyticsTopN: 10,
    };
    const merged = mergeStoredTabsOnRehydrate(
      [bootstrap],
      [tabA, stored, tabC],
    );
    const slot = merged.find((t) => t.id === tabB.id);
    expect(slot?.analyticsOpen).toBe(true);
    expect(slot?.analyticsDimension).toBe("country");
    expect(slot?.analyticsTopN).toBe(20);
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

describe("resolvePivotEffect — Reviewer Round 1 (toast / focus / create / cap wiring)", () => {
  // The wrapper's `handlePivot` callback used to inline the
  // PivotAction → side-effect mapping, leaving the React surface
  // (toast contents / flash + focus / append-and-activate) covered
  // only indirectly through the pure `openPivotTab` tests. Round 1
  // feedback called this out — these tests pin the contract directly
  // so a regression in the mapping fails here instead of slipping
  // through to a manual trace.

  const TEMPLATES = {
    alreadyFilteredTemplate: "Already filtered by {value}",
    tabCapReachedTemplate: "Tab cap reached ({max} max)",
    maxTabs: 8,
  };
  const TAB_A = createTabSnapshot({
    filter: { mode: "structured", input: { kinds: ["HttpThreat"] } },
    period: "1h",
  });
  const TAB_B = createTabSnapshot({
    filter: { mode: "structured", input: { countries: ["KR"] } },
    period: "1h",
  });

  it("substitutes the clicked value into the duplicate-toast template (toastDuplicate → toast)", () => {
    const action: PivotAction = {
      kind: "toastDuplicate",
      displayValue: "10.0.0.5",
    };
    const effect = resolvePivotEffect(action, [TAB_A], TEMPLATES);
    expect(effect.kind).toBe("toast");
    if (effect.kind !== "toast") return;
    expect(effect.message).toBe("Already filtered by 10.0.0.5");
  });

  it("substitutes `{max}` into the cap-reached template (toastCapReached → toast)", () => {
    const action: PivotAction = {
      kind: "toastCapReached",
      displayValue: "ignored",
    };
    const effect = resolvePivotEffect(action, [TAB_A], TEMPLATES);
    expect(effect.kind).toBe("toast");
    if (effect.kind !== "toast") return;
    expect(effect.message).toBe("Tab cap reached (8 max)");
  });

  it("activates the matching tab and flashes its label (focusTab → focus)", () => {
    // The wrapper consumes both `activeTabId` and `flashTabId` from
    // the same effect object — they must point at the SAME tab so
    // the operator sees the cue land on the tab they just got
    // focused. The handler also re-applies `currentTabs` so any
    // shell-side snapshot edit batched alongside the pivot click
    // is not dropped on the floor.
    const action: PivotAction = {
      kind: "focusTab",
      tabId: TAB_B.id,
      displayValue: "KR",
    };
    const effect = resolvePivotEffect(action, [TAB_A, TAB_B], TEMPLATES);
    expect(effect.kind).toBe("focus");
    if (effect.kind !== "focus") return;
    expect(effect.activeTabId).toBe(TAB_B.id);
    expect(effect.flashTabId).toBe(TAB_B.id);
    expect(effect.tabs.map((t) => t.id)).toEqual([TAB_A.id, TAB_B.id]);
  });

  it("appends a fresh tab pre-marked for auto-run (createTab → create)", () => {
    // The seed must be marked `hasQueried: true` + `loading: true` so
    // the shell's resume-on-mount effect runs the pivoted query
    // automatically — issue #283: "create a new tab with the target
    // filter, auto-execute, and activate it". Without `loading: true`
    // the new tab would land in the pre-query empty state and the
    // operator would have to click Apply manually.
    const targetFilter: Filter = {
      mode: "structured",
      input: { kinds: ["HttpThreat"], countries: ["KR"] },
    };
    const targetEndpoints: EndpointEntry[] = [
      {
        id: "e-1",
        raw: "10.0.0.5",
        kind: "host",
        host: "10.0.0.5",
        direction: "SOURCE",
        selected: true,
      },
    ];
    const action: PivotAction = {
      kind: "createTab",
      filter: targetFilter,
      endpoints: targetEndpoints,
      period: "1h",
      displayValue: "KR",
    };
    const effect = resolvePivotEffect(action, [TAB_A], TEMPLATES);
    expect(effect.kind).toBe("create");
    if (effect.kind !== "create") return;
    // The fresh tab is appended after the live tab list (preserving
    // the existing tab order) and the activeTabId is set to it.
    expect(effect.tabs).toHaveLength(2);
    expect(effect.tabs[0].id).toBe(TAB_A.id);
    const seed = effect.tabs[1];
    expect(effect.activeTabId).toBe(seed.id);
    expect(seed.filter).toEqual(targetFilter);
    expect(seed.endpoints).toEqual(targetEndpoints);
    expect(seed.period).toBe("1h");
    // Auto-run handshake — the resume-on-mount effect requires both
    // flags so the shell does not show the pre-query empty state.
    expect(seed.result.hasQueried).toBe(true);
    expect(seed.result.loading).toBe(true);
  });

  it("does not mutate the input tab list (focus / create return fresh arrays)", () => {
    const focusAction: PivotAction = {
      kind: "focusTab",
      tabId: TAB_B.id,
      displayValue: "KR",
    };
    const createAction: PivotAction = {
      kind: "createTab",
      filter: { mode: "structured", input: { countries: ["KR"] } },
      endpoints: [],
      period: null,
      displayValue: "KR",
    };
    const original = [TAB_A, TAB_B];
    const focused = resolvePivotEffect(focusAction, original, TEMPLATES);
    const created = resolvePivotEffect(createAction, original, TEMPLATES);
    if (focused.kind === "focus") expect(focused.tabs).not.toBe(original);
    if (created.kind === "create") expect(created.tabs).not.toBe(original);
    // Original list is untouched in either branch.
    expect(original).toHaveLength(2);
    expect(original[0]).toBe(TAB_A);
    expect(original[1]).toBe(TAB_B);
  });
});

describe("resolveLoadSavedFilterEffect — Reviewer Round 2 (cap toast vs. create)", () => {
  // The wrapper's saved-filter activation handler used to silently
  // no-op at the 8-tab cap; the rail row and "Load in new tab" menu
  // item stayed enabled, so the operator saw nothing happen. Round 2
  // feedback called this out — these tests pin the cap-vs-create
  // contract directly so the React handler can stay a thin
  // dispatcher around this pure function.
  const FILTER: Filter = {
    mode: "structured",
    input: { kinds: ["HttpThreat"] },
  };
  const TAB = createTabSnapshot({
    filter: { mode: "structured", input: { countries: ["KR"] } },
    period: "1h",
  });

  it("emits a `tabCapReached` toast when the tab list is at the cap", () => {
    const tabs = Array.from({ length: 8 }, () => TAB);
    const effect = resolveLoadSavedFilterEffect(FILTER, tabs, {
      tabCapReachedTemplate: "Tab cap reached ({max} max)",
      maxTabs: 8,
      period: null,
      endpoints: [],
    });
    expect(effect).toEqual({
      kind: "toast",
      message: "Tab cap reached (8 max)",
    });
  });

  it("seeds a fresh tab pre-marked hasQueried + loading so resume-on-mount runs the query", () => {
    const effect = resolveLoadSavedFilterEffect(FILTER, [TAB], {
      tabCapReachedTemplate: "Tab cap reached ({max} max)",
      maxTabs: 8,
      period: "1h",
      endpoints: [],
    });
    expect(effect.kind).toBe("create");
    if (effect.kind !== "create") return;
    expect(effect.tab.filter).toEqual(FILTER);
    expect(effect.tab.period).toBe("1h");
    expect(effect.tab.result.hasQueried).toBe(true);
    expect(effect.tab.result.loading).toBe(true);
  });

  it("threads the rehydrated endpoint mirror onto the seed tab", () => {
    const endpoints: EndpointEntry[] = [
      {
        id: "1",
        raw: "10.0.0.1",
        kind: "host",
        host: "10.0.0.1",
        direction: "SOURCE",
        selected: true,
      },
    ];
    const effect = resolveLoadSavedFilterEffect(FILTER, [TAB], {
      tabCapReachedTemplate: "Tab cap reached ({max} max)",
      maxTabs: 8,
      period: null,
      endpoints,
    });
    if (effect.kind !== "create") throw new Error("expected create branch");
    expect(effect.tab.endpoints).toEqual(endpoints);
  });
});

describe("findMatchingTab — issue #429 §2 + §6", () => {
  const SAVED_PRESET: OriginPreset = { kind: "saved", id: "sf-1" };
  const RECOMMENDED_PRESET: OriginPreset = {
    kind: "recommended",
    id: "rec-1",
  };
  const PRESET_FILTER: Filter = {
    mode: "structured",
    input: {
      start: "2026-04-25T00:00:00.000Z",
      end: "2026-04-25T01:00:00.000Z",
      kinds: ["HttpThreat"],
    },
  };

  function presetTab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
    return {
      ...createTabSnapshot({
        filter: PRESET_FILTER,
        period: "1h",
        originPreset: SAVED_PRESET,
        timeMode: "preset",
      }),
      ...overrides,
    };
  }

  it("returns null when no tab carries an origin preset", () => {
    const manual = createTabSnapshot({ filter: PRESET_FILTER, period: "1h" });
    expect(findMatchingTab([manual], SAVED_PRESET, PRESET_FILTER)).toBeNull();
  });

  it("focuses the matching tab on a second activation of the same preset", () => {
    const tab = presetTab();
    expect(findMatchingTab([tab], SAVED_PRESET, PRESET_FILTER)?.id).toBe(
      tab.id,
    );
  });

  it("does not match across kinds — saved-id `sf-1` and recommended-id `sf-1` stay distinct", () => {
    // The kind discriminator is required because saved and recommended
    // ids occupy separate namespaces. A coincidental id collision must
    // not collapse the two onto each other.
    const tab = presetTab({
      originPreset: { kind: "saved", id: "sf-1" },
    });
    expect(
      findMatchingTab(
        [tab],
        { kind: "recommended", id: "sf-1" },
        PRESET_FILTER,
      ),
    ).toBeNull();
  });

  it("does not match when the tab's non-time fields have been narrowed", () => {
    const narrowed = presetTab({
      filter: {
        mode: "structured",
        input: { ...PRESET_FILTER.input, levels: ["HIGH"] },
      },
    });
    expect(findMatchingTab([narrowed], SAVED_PRESET, PRESET_FILTER)).toBeNull();
  });

  it("does not match when the tab's `timeMode` has flipped to `custom`", () => {
    const customTime = presetTab({ timeMode: "custom" });
    expect(
      findMatchingTab([customTime], SAVED_PRESET, PRESET_FILTER),
    ).toBeNull();
  });

  it("ignores the start/end ISO pair so a tab created hours ago still matches", () => {
    // Mirrors the spec: a tab created at 11:00 with `Last 1 hour` is
    // still a `Last 1 hour` tab at 11:30 even though its absolute
    // start/end have not moved (the matcher does not advance them).
    const olderTab = presetTab({
      filter: {
        mode: "structured",
        input: {
          start: "2099-01-01T00:00:00.000Z",
          end: "2099-01-01T01:00:00.000Z",
          kinds: ["HttpThreat"],
        },
      },
    });
    expect(findMatchingTab([olderTab], SAVED_PRESET, PRESET_FILTER)?.id).toBe(
      olderTab.id,
    );
  });

  it("focuses the most recently activated tab when multiple match", () => {
    const older = presetTab({ lastActivatedAt: 1_000 });
    const newer = presetTab({ lastActivatedAt: 5_000 });
    const match = findMatchingTab([older, newer], SAVED_PRESET, PRESET_FILTER);
    expect(match?.id).toBe(newer.id);
  });

  it("handles recommended presets the same way as saved", () => {
    const tab = presetTab({ originPreset: RECOMMENDED_PRESET });
    expect(findMatchingTab([tab], RECOMMENDED_PRESET, PRESET_FILTER)?.id).toBe(
      tab.id,
    );
  });
});

describe("resolveActivatePresetEffect — issue #429", () => {
  const FILTER: Filter = {
    mode: "structured",
    input: { kinds: ["HttpThreat"] },
  };
  const SAVED_PRESET: OriginPreset = { kind: "saved", id: "sf-1" };

  it("seeds the new tab with the supplied origin preset and `timeMode: 'preset'`", () => {
    const effect = resolveActivatePresetEffect(FILTER, [], {
      tabCapReachedTemplate: "Tab cap reached ({max} max)",
      maxTabs: 8,
      period: "1h",
      endpoints: [],
      originPreset: SAVED_PRESET,
    });
    if (effect.kind !== "create") throw new Error("expected create branch");
    expect(effect.tab.originPreset).toEqual(SAVED_PRESET);
    expect(effect.tab.timeMode).toBe("preset");
    expect(effect.tab.result.hasQueried).toBe(true);
    expect(effect.tab.result.loading).toBe(true);
  });

  it("falls back to a manual tab (no preset, `timeMode: 'custom'`) when no preset is supplied", () => {
    const effect = resolveActivatePresetEffect(FILTER, [], {
      tabCapReachedTemplate: "Tab cap reached ({max} max)",
      maxTabs: 8,
      period: "1h",
      endpoints: [],
    });
    if (effect.kind !== "create") throw new Error("expected create branch");
    expect(effect.tab.originPreset).toBeNull();
    expect(effect.tab.timeMode).toBe("custom");
  });

  it("emits the cap toast when the tab list is at the cap", () => {
    const tab = createTabSnapshot({ filter: FILTER, period: null });
    const tabs = Array.from({ length: 8 }, () => tab);
    const effect = resolveActivatePresetEffect(FILTER, tabs, {
      tabCapReachedTemplate: "Tab cap reached ({max} max)",
      maxTabs: 8,
      period: null,
      endpoints: [],
      originPreset: SAVED_PRESET,
    });
    expect(effect).toEqual({
      kind: "toast",
      message: "Tab cap reached (8 max)",
    });
  });
});

describe("clearTabPresetMetadata — Reviewer Round 2 (item 2)", () => {
  // Regression: the dropdown's "Load in current tab" affordance
  // replaces the active tab's filter without disturbing
  // `originPreset` or `timeMode`. The next activation of the
  // preset that originally seeded the tab would silently focus the
  // now-misaligned slot — e.g. load a "Last 1 day" saved filter
  // into a "Last 1 hour" recommended-preset tab, then re-click the
  // "Last 1 hour" preset, and `findMatchingTab` would return the
  // mutated tab. This helper drops both fields so the matcher
  // disqualifies the slot.
  const PRESET: OriginPreset = { kind: "saved", id: "sf-1" };
  const FILTER: Filter = {
    mode: "structured",
    input: { kinds: ["HttpThreat"] },
  };

  it("nulls the originPreset binding so future activations cannot focus this tab", () => {
    const tab = createTabSnapshot({
      filter: FILTER,
      period: "1h",
      originPreset: PRESET,
      timeMode: "preset",
    });
    const cleared = clearTabPresetMetadata(tab);
    expect(cleared.originPreset).toBeNull();
  });

  it("flips timeMode to `custom` so a tab whose filter just changed cannot be re-matched on time alone", () => {
    const tab = createTabSnapshot({
      filter: FILTER,
      period: "1h",
      originPreset: PRESET,
      timeMode: "preset",
    });
    expect(clearTabPresetMetadata(tab).timeMode).toBe("custom");
  });

  it("disqualifies the cleared tab from `findMatchingTab` against its original preset", () => {
    const original = createTabSnapshot({
      filter: FILTER,
      period: "1h",
      originPreset: PRESET,
      timeMode: "preset",
    });
    expect(findMatchingTab([original], PRESET, FILTER)?.id).toBe(original.id);
    const cleared = clearTabPresetMetadata(original);
    expect(findMatchingTab([cleared], PRESET, FILTER)).toBeNull();
  });

  it("preserves all non-preset fields (filter / period / endpoints / pagination / id / name)", () => {
    const tab = createTabSnapshot({
      filter: FILTER,
      period: "1h",
      originPreset: PRESET,
      timeMode: "preset",
    });
    const cleared = clearTabPresetMetadata(tab);
    expect(cleared.id).toBe(tab.id);
    expect(cleared.filter).toEqual(tab.filter);
    expect(cleared.period).toBe(tab.period);
    expect(cleared.endpoints).toEqual(tab.endpoints);
    expect(cleared.pagination).toEqual(tab.pagination);
    expect(cleared.name).toBe(tab.name);
    expect(cleared.lastActivatedAt).toBe(tab.lastActivatedAt);
  });
});

describe("shouldClearMatchFocusEvent — Reviewer Round 2 (item 3)", () => {
  // Regression: the wrapper used to keep `matchFocusEvent` set even
  // after focus left the matched tab. Switching away from and back
  // to the matched tab remounts the keyed `<DetectionShell>`, the
  // result-list's local `shownEventAt` resets to null, and the
  // stale-data notice fires a second time for the same activation —
  // breaking the §6 "once per focus event" rule. The wrapper now
  // clears the event the moment focus leaves its target tab.
  const TAB_A = "tab-a" as TabId;
  const TAB_B = "tab-b" as TabId;

  it("returns false when there is no event in flight", () => {
    expect(
      shouldClearMatchFocusEvent({ matchFocusEvent: null, activeTabId: TAB_A }),
    ).toBe(false);
  });

  it("returns false while focus is still on the event's target tab", () => {
    expect(
      shouldClearMatchFocusEvent({
        matchFocusEvent: { tabId: TAB_A },
        activeTabId: TAB_A,
      }),
    ).toBe(false);
  });

  it("returns true once focus moves to a different tab — the keyed-remount replay path", () => {
    expect(
      shouldClearMatchFocusEvent({
        matchFocusEvent: { tabId: TAB_A },
        activeTabId: TAB_B,
      }),
    ).toBe(true);
  });
});

describe("applyTabScrollTransition — Reviewer Round 5 (issue #429 §3 scroll preservation)", () => {
  // Regression: the wrapper's keyed `<DetectionShell>` swap restored
  // the matched tab's filter / events / pagination / Quick peek but
  // not its result-list scroll position. The parent dashboard
  // scroller is shared across tabs, so its `scrollTop` bled across
  // activations. This helper parks the outgoing tab's scrollTop and
  // returns the incoming tab's saved value (or 0 for a fresh tab).
  const TAB_A = "tab-a" as TabId;
  const TAB_B = "tab-b" as TabId;
  const TAB_C = "tab-c" as TabId;

  it("captures the outgoing tab's scrollTop into the positions map", () => {
    const result = applyTabScrollTransition({
      positions: new Map(),
      outgoingTabId: TAB_A,
      outgoingScrollTop: 1234,
      incomingTabId: TAB_B,
    });
    expect(result.positions.get(TAB_A)).toBe(1234);
  });

  it("restores the incoming tab's saved scrollTop on a switch back — the match-focus-after-switch-away path the reviewer flagged", () => {
    // Operator: scroll Tab A to 500, switch to Tab B (scrolls to 0),
    // re-click the preset that focuses Tab A. The restored scrollTop
    // for the incoming Tab A must be 500, not Tab B's 0.
    const afterFirstSwitch = applyTabScrollTransition({
      positions: new Map(),
      outgoingTabId: TAB_A,
      outgoingScrollTop: 500,
      incomingTabId: TAB_B,
    });
    expect(afterFirstSwitch.restoredScrollTop).toBe(0);
    const afterMatchFocus = applyTabScrollTransition({
      positions: afterFirstSwitch.positions,
      outgoingTabId: TAB_B,
      outgoingScrollTop: 80,
      incomingTabId: TAB_A,
    });
    expect(afterMatchFocus.restoredScrollTop).toBe(500);
  });

  it("returns 0 for an incoming tab that has never been scrolled — fresh tabs start at the top, not at the outgoing tab's offset", () => {
    const result = applyTabScrollTransition({
      positions: new Map([[TAB_A, 999]]),
      outgoingTabId: TAB_A,
      outgoingScrollTop: 999,
      incomingTabId: TAB_C,
    });
    expect(result.restoredScrollTop).toBe(0);
  });

  it("overwrites a stale outgoing entry rather than holding onto the prior value", () => {
    const result = applyTabScrollTransition({
      positions: new Map([[TAB_A, 100]]),
      outgoingTabId: TAB_A,
      outgoingScrollTop: 250,
      incomingTabId: TAB_B,
    });
    expect(result.positions.get(TAB_A)).toBe(250);
  });

  it("does not mutate the input positions map (returns a fresh Map)", () => {
    const input = new Map([[TAB_A, 100]]);
    const result = applyTabScrollTransition({
      positions: input,
      outgoingTabId: TAB_A,
      outgoingScrollTop: 200,
      incomingTabId: TAB_B,
    });
    expect(input.get(TAB_A)).toBe(100);
    expect(result.positions).not.toBe(input);
  });
});
