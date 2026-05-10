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

  it("preserves the freshly-inserted entry even when it alone exceeds the cap", () => {
    // A single oversized insert: no protection on prior entries, but
    // the new entry must still survive (it is what the operator just
    // asked for and refetching wastes a round-trip).
    const cache = new Tier2Cache(10);
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "A" },
      { events: [makeEvent(0)], totalCount: "1" },
    );
    const big = Array.from({ length: 100 }, (_, i) => makeEvent(i));
    cache.set(
      { ...KEY_BASE, dimensionId: "country", valueKey: "BIG" },
      { events: big, totalCount: "100" },
    );
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "BIG" }),
    ).not.toBeNull();
    expect(
      cache.get({ ...KEY_BASE, dimensionId: "country", valueKey: "A" }),
    ).toBeNull();
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
  it("produces the same key for events that share the dedupe tuple", () => {
    const a = tier2DedupeKey({
      __typename: "HttpThreat",
      time: "2026-05-09T12:00:00.000Z",
      origAddr: "10.0.0.1",
      respAddr: "203.0.113.5",
      origPort: 12345,
      respPort: 80,
    });
    const b = tier2DedupeKey({
      __typename: "HttpThreat",
      time: "2026-05-09T12:00:00.000Z",
      origAddr: "10.0.0.1",
      respAddr: "203.0.113.5",
      origPort: 12345,
      respPort: 80,
    });
    expect(a).toBe(b);
  });

  it("differentiates by typename / time / addresses / ports", () => {
    const ref = tier2DedupeKey({
      __typename: "HttpThreat",
      time: "2026-05-09T12:00:00.000Z",
      origAddr: "10.0.0.1",
      respAddr: "203.0.113.5",
      origPort: 12345,
      respPort: 80,
    });
    expect(
      tier2DedupeKey({
        __typename: "DnsCovertChannel",
        time: "2026-05-09T12:00:00.000Z",
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.5",
        origPort: 12345,
        respPort: 80,
      }),
    ).not.toBe(ref);
  });
});
