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
} from "@/components/detection/detection-tabs-shell";
import type { Filter } from "@/lib/detection/filter";
import { parseFilterFromUrlParam } from "@/lib/detection/filter-url";
import { INITIAL_PAGINATION_STATE } from "@/lib/detection/pagination";
import { createTabSnapshot, type TabSnapshot } from "@/lib/detection/tabs";

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
