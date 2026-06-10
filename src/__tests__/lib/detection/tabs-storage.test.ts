import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Filter } from "@/lib/detection/filter";
import { createTabSnapshot, type TabSnapshot } from "@/lib/detection/tabs";
import {
  clearTabsFromSession,
  deserializeTabsFromStorage,
  readTabsFromSession,
  serializeTabsForStorage,
  tabsStorageKey,
  writeTabsToSession,
} from "@/lib/detection/tabs-storage";

const FP_A = "fingerprint-account-a";
const FP_B = "fingerprint-account-b";

const FILTER_1H: Filter = {
  mode: "structured",
  input: {
    start: "2026-04-25T00:00:00.000Z",
    end: "2026-04-25T01:00:00.000Z",
  },
};

function makeTab(
  overrides: Partial<TabSnapshot> = {},
  events: TabSnapshot["result"]["events"] = [],
): TabSnapshot {
  const base = createTabSnapshot({ filter: FILTER_1H, period: "1h" });
  return {
    ...base,
    result: {
      ...base.result,
      events,
      hasQueried: events.length > 0,
      totalCount: events.length > 0 ? String(events.length) : null,
    },
    ...overrides,
  };
}

describe("serializeTabsForStorage / deserializeTabsFromStorage", () => {
  it("round-trips id, name, manualName, filter, pagination, draft, and analyticsOpen", () => {
    const tab = makeTab({
      name: "Custom",
      manualName: true,
      analyticsOpen: true,
    });
    const json = serializeTabsForStorage([tab], tab.id);
    const decoded = deserializeTabsFromStorage(json);
    expect(decoded).not.toBeNull();
    expect(decoded?.activeTabId).toBe(tab.id);
    expect(decoded?.tabs).toHaveLength(1);
    const roundTripped = decoded?.tabs[0];
    expect(roundTripped?.id).toBe(tab.id);
    expect(roundTripped?.name).toBe("Custom");
    expect(roundTripped?.manualName).toBe(true);
    expect(roundTripped?.analyticsOpen).toBe(true);
    expect(roundTripped?.filter).toEqual(FILTER_1H);
    expect(roundTripped?.pagination).toEqual(tab.pagination);
  });

  // Reviewer Round 1 (P2 per-tab state): the dimension and Top N
  // selection now ride alongside `analyticsOpen` so a reload restores
  // the operator's exact view, not just whether the strip was open.
  it("round-trips analyticsDimension and analyticsTopN", () => {
    const tab = makeTab({
      analyticsOpen: true,
      analyticsDimension: "country",
      analyticsTopN: 20,
    });
    const json = serializeTabsForStorage([tab], tab.id);
    const decoded = deserializeTabsFromStorage(json);
    const roundTripped = decoded?.tabs[0];
    expect(roundTripped?.analyticsDimension).toBe("country");
    expect(roundTripped?.analyticsTopN).toBe(20);
  });

  // `analyticsDimension` / `analyticsTopN` are required fields: a tab
  // missing them (or carrying an invalid value) is structurally
  // invalid and dropped, per the module's drop-don't-migrate policy.
  it("rejects a tab that omits analyticsDimension / analyticsTopN", () => {
    const payload = JSON.stringify({
      version: 1,
      activeTabId: "incomplete",
      tabs: [
        {
          id: "incomplete",
          name: null,
          manualName: false,
          filter: FILTER_1H,
          period: "1h",
          endpoints: [],
          pivotOnly: {},
          pagination: { pageSize: 50, page: 1, anchor: { kind: "head" } },
          draft: null,
          analyticsOpen: true,
        },
      ],
    });
    expect(deserializeTabsFromStorage(payload)).toBeNull();
  });

  it("rejects a tab whose analyticsDimension / analyticsTopN are invalid", () => {
    const payload = JSON.stringify({
      version: 1,
      activeTabId: "invalid",
      tabs: [
        {
          id: "invalid",
          name: null,
          manualName: false,
          filter: FILTER_1H,
          period: "1h",
          endpoints: [],
          pivotOnly: {},
          pagination: { pageSize: 50, page: 1, anchor: { kind: "head" } },
          draft: null,
          analyticsOpen: true,
          analyticsDimension: "notADimension",
          analyticsTopN: 12345,
        },
      ],
    });
    expect(deserializeTabsFromStorage(payload)).toBeNull();
  });

  it("strips the cached events so sessionStorage stays within quota", () => {
    const fakeEvent = {
      __typename: "PortScan",
      time: "2026-04-25T00:30:00Z",
      sensor: "sensor-1",
    } as unknown as TabSnapshot["result"]["events"][number];
    const tab = makeTab({}, [fakeEvent]);
    const decoded = deserializeTabsFromStorage(
      serializeTabsForStorage([tab], tab.id),
    );
    expect(decoded?.tabs[0].result.events).toEqual([]);
    expect(decoded?.tabs[0].result.hasQueried).toBe(false);
    expect(decoded?.tabs[0].result.totalCount).toBeNull();
  });

  it("does not persist the pending Quick peek token (Reviewer Round 9)", () => {
    // The token is a transient bootstrap-only signal — the URL itself
    // is the source of truth on rehydration, so the page recomputes
    // the token from `?event=` on the next reload. Persisting it
    // would risk re-emitting a stale token after the URL has been
    // intentionally stripped by another tab's reconcile.
    const tab = makeTab({ pendingQuickPeekToken: "token-from-bootstrap" });
    const decoded = deserializeTabsFromStorage(
      serializeTabsForStorage([tab], tab.id),
    );
    expect(decoded?.tabs[0].pendingQuickPeekToken).toBeNull();
  });

  it("returns null for a null / empty input", () => {
    expect(deserializeTabsFromStorage(null)).toBeNull();
    expect(deserializeTabsFromStorage("")).toBeNull();
  });

  it("returns null for a non-JSON payload", () => {
    expect(deserializeTabsFromStorage("not-json")).toBeNull();
  });

  it("returns null for a mismatched payload version", () => {
    const bad = JSON.stringify({ version: 99, activeTabId: "x", tabs: [] });
    expect(deserializeTabsFromStorage(bad)).toBeNull();
  });

  it("returns null when the payload has no tabs left after filtering", () => {
    const bad = JSON.stringify({
      version: 1,
      activeTabId: "x",
      tabs: [{ id: "x" /* missing required fields */ }],
    });
    expect(deserializeTabsFromStorage(bad)).toBeNull();
  });

  it("falls back to the first tab when activeTabId does not exist", () => {
    const a = makeTab();
    const b = makeTab();
    const json = serializeTabsForStorage([a, b], "not-in-list");
    const decoded = deserializeTabsFromStorage(json);
    expect(decoded?.activeTabId).toBe(a.id);
  });
});

describe("sessionStorage integration", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      sessionStorage: createMemoryStorage(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads back what was written under the per-fingerprint key", () => {
    const tab = makeTab();
    writeTabsToSession([tab], tab.id, FP_A);
    const key = tabsStorageKey(FP_A);
    expect(key).not.toBeNull();
    expect(
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      (window as Window).sessionStorage.getItem(key!),
    ).not.toBeNull();
    const decoded = readTabsFromSession(FP_A);
    expect(decoded?.activeTabId).toBe(tab.id);
    expect(decoded?.tabs[0].id).toBe(tab.id);
  });

  it("isolates payloads across fingerprints (account A vs B in same tab)", () => {
    // Account A writes its tab UX state to sessionStorage. The same
    // browser tab then signs in as account B (different fingerprint).
    // Reads under account B must NOT surface account A's payload —
    // even though sessionStorage survives sign-out / sign-in in the
    // same tab. (#393 Task C regression)
    const tab = makeTab();
    writeTabsToSession([tab], tab.id, FP_A);
    expect(readTabsFromSession(FP_A)?.tabs[0].id).toBe(tab.id);
    expect(readTabsFromSession(FP_B)).toBeNull();
  });

  it("invalidates payload on a same-account scope swap (X → Y)", () => {
    // Same account but a customer-assignment change yields a fresh
    // fingerprint. A read under the new fingerprint must miss rather
    // than rehydrating tab state computed against the old scope.
    const tab = makeTab();
    writeTabsToSession([tab], tab.id, "scope-x");
    expect(readTabsFromSession("scope-x")?.tabs[0].id).toBe(tab.id);
    expect(readTabsFromSession("scope-y")).toBeNull();
  });

  it("treats a null fingerprint as a no-op (no provider context)", () => {
    const tab = makeTab();
    expect(() => writeTabsToSession([tab], tab.id, null)).not.toThrow();
    expect(readTabsFromSession(null)).toBeNull();
    expect(() => clearTabsFromSession(null)).not.toThrow();
  });

  it("swallows writes that would throw (quota / privacy mode)", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        getItem: () => null,
        removeItem: () => {},
      },
    });
    const tab = makeTab();
    expect(() => writeTabsToSession([tab], tab.id, FP_A)).not.toThrow();
  });

  it("clearTabsFromSession removes the payload", () => {
    const tab = makeTab();
    writeTabsToSession([tab], tab.id, FP_A);
    clearTabsFromSession(FP_A);
    expect(readTabsFromSession(FP_A)).toBeNull();
  });

  it("returns null on a read when no payload is present", () => {
    expect(readTabsFromSession(FP_A)).toBeNull();
  });
});

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}
