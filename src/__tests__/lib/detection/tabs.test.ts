import { afterEach, describe, expect, it, vi } from "vitest";

import type { Filter } from "@/lib/detection/filter";
import { INITIAL_PAGINATION_STATE } from "@/lib/detection/pagination";
import {
  ACTIVE_TAB_URL_PARAM,
  autoTabName,
  canAddTab,
  closeTab,
  createTabId,
  createTabSnapshot,
  MAX_TABS,
  preserveActiveTabParam,
  type TabSnapshot,
} from "@/lib/detection/tabs";

const FILTER_1H: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-25T00:00:00.000Z",
    end: "2026-04-25T01:00:00.000Z",
  },
};

const FILTER_1D: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-24T00:00:00.000Z",
    end: "2026-04-25T00:00:00.000Z",
  },
};

function makeTab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    ...createTabSnapshot({ filter: FILTER_1H, period: "1h" }),
    ...overrides,
  };
}

describe("createTabId", () => {
  it("produces unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(createTabId());
    expect(ids.size).toBe(100);
  });

  it("stays short enough for URLs", () => {
    // The wrapper puts the id into `?tab=<id>`; a 10-char alphanumeric
    // stays negligible next to the filter params.
    expect(createTabId()).toHaveLength(10);
  });
});

describe("autoTabName", () => {
  it("joins the first two chip values with a middle dot", () => {
    expect(
      autoTabName(["Last 1 hour", "High", "Source: 10.0.0.5"], "New tab"),
    ).toBe("Last 1 hour · High");
  });

  it("drops empty and whitespace-only values before joining", () => {
    expect(autoTabName(["Last 1 hour", "   ", "High"], "New tab")).toBe(
      "Last 1 hour · High",
    );
  });

  it("returns the fallback when the chip list is empty", () => {
    expect(autoTabName([], "New tab")).toBe("New tab");
  });

  it("returns the fallback when every chip is blank", () => {
    expect(autoTabName(["   ", "\t"], "New tab")).toBe("New tab");
  });

  it("returns the single chip value when only one non-empty entry is present", () => {
    expect(autoTabName(["Last 1 hour"], "New tab")).toBe("Last 1 hour");
  });
});

describe("canAddTab", () => {
  it("returns true while the tab count is below MAX_TABS", () => {
    const tabs = Array.from({ length: MAX_TABS - 1 }, () => makeTab());
    expect(canAddTab(tabs)).toBe(true);
  });

  it("returns false at the cap", () => {
    const tabs = Array.from({ length: MAX_TABS }, () => makeTab());
    expect(canAddTab(tabs)).toBe(false);
  });
});

describe("createTabSnapshot", () => {
  it("starts with an empty result cache, default pagination, and no draft", () => {
    const tab = createTabSnapshot({ filter: FILTER_1H, period: "1h" });
    expect(tab.result.events).toEqual([]);
    expect(tab.result.hasQueried).toBe(false);
    expect(tab.result.loading).toBe(false);
    expect(tab.pagination).toEqual(INITIAL_PAGINATION_STATE);
    expect(tab.draft).toBeNull();
    expect(tab.name).toBeNull();
    expect(tab.manualName).toBe(false);
  });
});

describe("preserveActiveTabParam", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the URL's tab param into the search", () => {
    vi.stubGlobal("window", {
      location: { search: "?tab=abc12345ef&source=1.2.3.4" },
    });
    const search = new URLSearchParams("source=9.9.9.9");
    preserveActiveTabParam(search);
    expect(search.get(ACTIVE_TAB_URL_PARAM)).toBe("abc12345ef");
    // The caller's other params are left intact.
    expect(search.get("source")).toBe("9.9.9.9");
  });

  it("is a no-op when the current URL has no tab param", () => {
    vi.stubGlobal("window", { location: { search: "?source=1.2.3.4" } });
    const search = new URLSearchParams();
    preserveActiveTabParam(search);
    expect(search.has(ACTIVE_TAB_URL_PARAM)).toBe(false);
  });

  it("is a no-op when window is undefined (SSR)", () => {
    vi.stubGlobal("window", undefined);
    const search = new URLSearchParams();
    expect(() => preserveActiveTabParam(search)).not.toThrow();
    expect(search.has(ACTIVE_TAB_URL_PARAM)).toBe(false);
  });
});

describe("closeTab", () => {
  it("picks the right-hand neighbour when closing the active tab", () => {
    const a = makeTab();
    const b = makeTab();
    const c = makeTab();
    const result = closeTab({ tabs: [a, b, c], activeTabId: b.id }, b.id, () =>
      makeTab(),
    );
    expect(result.tabs.map((t) => t.id)).toEqual([a.id, c.id]);
    expect(result.activeTabId).toBe(c.id);
    expect(result.autoCreated).toBe(false);
  });

  it("falls back to the left-hand neighbour when closing the last tab", () => {
    const a = makeTab();
    const b = makeTab();
    const result = closeTab({ tabs: [a, b], activeTabId: b.id }, b.id, () =>
      makeTab(),
    );
    expect(result.tabs.map((t) => t.id)).toEqual([a.id]);
    expect(result.activeTabId).toBe(a.id);
    expect(result.autoCreated).toBe(false);
  });

  it("keeps the active tab unchanged when closing an inactive tab", () => {
    const a = makeTab();
    const b = makeTab();
    const c = makeTab();
    const result = closeTab({ tabs: [a, b, c], activeTabId: b.id }, c.id, () =>
      makeTab(),
    );
    expect(result.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(result.activeTabId).toBe(b.id);
  });

  it("auto-creates a default tab when the only tab is closed", () => {
    const only = makeTab({ filter: FILTER_1D });
    const seeded = makeTab();
    const result = closeTab(
      { tabs: [only], activeTabId: only.id },
      only.id,
      () => seeded,
    );
    expect(result.tabs).toEqual([seeded]);
    expect(result.activeTabId).toBe(seeded.id);
    expect(result.autoCreated).toBe(true);
  });

  it("no-ops when the id is not in the list", () => {
    const a = makeTab();
    const result = closeTab(
      { tabs: [a], activeTabId: a.id },
      "not-a-real-id",
      () => makeTab(),
    );
    expect(result.tabs).toEqual([a]);
    expect(result.activeTabId).toBe(a.id);
    expect(result.autoCreated).toBe(false);
  });
});
