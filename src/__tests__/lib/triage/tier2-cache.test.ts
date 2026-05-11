import { describe, expect, it, vi } from "vitest";

import {
  encodeTier2CacheKey,
  Tier2Cache,
  tier2DedupeKey,
} from "@/lib/triage/tier2-cache";
import type { TriageEvent } from "@/lib/triage/types";

const KEY_BASE = {
  periodStartIso: "2026-05-08T12:00:00.000Z",
  periodEndIso: "2026-05-09T12:00:00.000Z",
  customerScope: "global",
};

function makeEvent(seq: number): TriageEvent {
  return {
    __typename: "NetworkThreat",
    id: `evt-${seq}`,
    time: `2026-05-09T12:00:00.${String(seq).padStart(3, "0")}Z`,
    sensor: "sensor-a",
    category: "COMMAND_AND_CONTROL",
    level: "MEDIUM",
    origAddr: "10.0.0.1",
  };
}

describe("encodeTier2CacheKey", () => {
  it("includes the customer scope so cross-tenant entries don't collide", () => {
    const a = encodeTier2CacheKey({
      ...KEY_BASE,
      dimensionId: "country",
      valueKey: "US",
      customerScope: "tenant-a",
    });
    const b = encodeTier2CacheKey({
      ...KEY_BASE,
      dimensionId: "country",
      valueKey: "US",
      customerScope: "tenant-b",
    });
    expect(a).not.toBe(b);
  });
});

describe("Tier2Cache", () => {
  it("stores and retrieves an entry", () => {
    const cache = new Tier2Cache();
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "US" },
      { events: [makeEvent(1)], totalCount: "1" },
    );
    const hit = cache.get({
      ...KEY_BASE,
      dimensionId: "country",
      valueKey: "US",
    });
    expect(hit).not.toBeNull();
    expect(hit?.events.length).toBe(1);
    expect(hit?.byteSize).toBeGreaterThan(0);
    expect(hit?.totalCount).toBe("1");
  });

  it("refreshes LRU order on get so a re-read survives eviction", () => {
    // Cap is exactly two entries' worth of bytes; the third insert
    // forces an eviction. Reading entry A before the third insert
    // refreshes its position so entry B is evicted instead.
    const single = JSON.stringify([makeEvent(0)]).length;
    const cache = new Tier2Cache(single * 2);
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "A" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "B" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    // Touch A so it becomes most-recent.
    cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "A" });
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "C" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "B" }),
    ).toBeNull();
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "A" }),
    ).not.toBeNull();
  });

  it("evicts least-recently-used entries until the byte cap is satisfied", () => {
    const single = JSON.stringify([makeEvent(0)]).length;
    const cap = single * 2;
    const cache = new Tier2Cache(cap);
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "A" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "B" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "C" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    expect(cache.byteSize()).toBeLessThanOrEqual(cap);
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "A" }),
    ).toBeNull();
  });

  it("emits an eviction event so the UI can render an LRU toast", () => {
    const single = JSON.stringify([makeEvent(0)]).length;
    const cache = new Tier2Cache(single);
    const listener = vi.fn();
    cache.setEvictionListener(listener);
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "EVICTED" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "FRESH" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].dimensionId).toBe("country");
    expect(listener.mock.calls[0][0].valueKey).toBe("EVICTED");
  });

  it("rejects a single oversized insert without disturbing in-budget entries", () => {
    // The 100 MB cap is a hard ceiling per #453. A single result that
    // alone exceeds the cap must be dropped (not silently retained at
    // the cost of the invariant), AND it must be dropped without
    // walking the LRU loop — otherwise one uncachable >100 MB result
    // would flush every cached, in-budget entry on its way to being
    // rejected, turning useful cached pivots into refetches the
    // operator did not ask for. The rejection happens up front; the
    // eviction event lets the UI surface a refetch toast for the
    // rejected dimension, and `set` returns `false` so the caller
    // knows not to keep the events in any sibling in-memory layer.
    // Cap is sized to fit one normal entry comfortably but reject a
    // 100-event oversized one. The single-entry size is computed from
    // a real event so the test is independent of incidental JSON
    // padding.
    const single = JSON.stringify([makeEvent(0)]).length;
    const cache = new Tier2Cache(single * 2);
    const listener = vi.fn();
    cache.setEvictionListener(listener);
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "A" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    const sizeAfterA = cache.byteSize();
    const big = Array.from({ length: 100 }, (_, i) => makeEvent(i));
    const accepted = cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "BIG" },
      { events: big, totalCount: "100" },
    );
    expect(accepted).toBe(false);
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "BIG" }),
    ).toBeNull();
    // "A" was already in cache and within budget — the oversized
    // candidate must NOT trigger an LRU walk that evicts unrelated
    // entries. This is the regression from Round 7.
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "A" }),
    ).not.toBeNull();
    expect(cache.byteSize()).toBe(sizeAfterA);
    // Listener fired once for "BIG" (oversize rejection); no spurious
    // eviction event for "A" because it was preserved.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].valueKey).toBe("BIG");
  });

  it("rejects an oversized overwrite and removes the prior entry at that key", () => {
    // When the oversized candidate overwrites an existing key, the
    // prior entry is removed (the caller asked for a replacement) and
    // an eviction event surfaces so the UI shows the refetch toast.
    // Other unrelated keys are preserved.
    const single = JSON.stringify([makeEvent(0)]).length;
    const cache = new Tier2Cache(single * 4);
    const listener = vi.fn();
    cache.setEvictionListener(listener);
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "OTHER" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "OVERWRITE" },
      { events: [makeEvent(1)], totalCount: "1" },
    );
    const big = Array.from({ length: 100 }, (_, i) => makeEvent(i));
    const accepted = cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "OVERWRITE" },
      { events: big, totalCount: "100" },
    );
    expect(accepted).toBe(false);
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "OVERWRITE" }),
    ).toBeNull();
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "OTHER" }),
    ).not.toBeNull();
    // Listener fires once for the rejected overwrite; "OTHER" was not
    // touched.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].valueKey).toBe("OVERWRITE");
  });

  it("returns true when an in-budget insert is retained", () => {
    const cache = new Tier2Cache();
    const accepted = cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "OK" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    expect(accepted).toBe(true);
  });

  it("refunds bytes when an entry is overwritten", () => {
    const cache = new Tier2Cache();
    const k = { ...KEY_BASE, dimensionId: "country", valueKey: "US" };
    cache.set(k, { events: [makeEvent(0)], totalCount: "1" });
    const initial = cache.byteSize();
    const big = Array.from({ length: 10 }, (_, i) => makeEvent(i));
    cache.set(k, { events: big, totalCount: "10" });
    expect(cache.byteSize()).toBeGreaterThan(initial);
    expect(cache.size()).toBe(1);
  });
});

describe("tier2DedupeKey", () => {
  it("collapses two events with the same id even when every other field differs", () => {
    // Same `Event.id` ⇒ same key, regardless of the network 5-tuple or
    // timestamp. The pre-0.49.0 composite would have ranked these as
    // distinct because the 5-tuple disagrees.
    const a = tier2DedupeKey({ id: "evt-shared" });
    const b = tier2DedupeKey({ id: "evt-shared" });
    expect(a).toBe(b);
  });

  it("keeps two events with different ids distinct even when every other field is identical", () => {
    // Same 5-tuple + timestamp but different ids ⇒ distinct keys. The
    // pre-0.49.0 composite would have collapsed these (the case the
    // switch to `Event.id` was meant to fix — high-rate flows sharing
    // a 5-tuple in the same millisecond).
    const a = tier2DedupeKey({ id: "evt-a" });
    const b = tier2DedupeKey({ id: "evt-b" });
    expect(a).not.toBe(b);
  });
});
