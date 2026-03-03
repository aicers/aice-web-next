import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryRateLimitStore } from "@/lib/rate-limit/store";

describe("InMemoryRateLimitStore", () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryRateLimitStore();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  // ── increment() ─────────────────────────────────────────────────

  describe("increment()", () => {
    it("returns count=1 for a new key", () => {
      const result = store.increment("k1", 60_000);

      expect(result.count).toBe(1);
      expect(result.resetAt).toBeGreaterThan(Date.now());
    });

    it("increments count within the same window", () => {
      store.increment("k1", 60_000);
      store.increment("k1", 60_000);
      const result = store.increment("k1", 60_000);

      expect(result.count).toBe(3);
    });

    it("resets count when the window expires", () => {
      store.increment("k1", 60_000);
      store.increment("k1", 60_000);

      // Advance past the 60 s window
      vi.advanceTimersByTime(61_000);

      const result = store.increment("k1", 60_000);
      expect(result.count).toBe(1);
    });

    it("keeps independent counts for different keys", () => {
      store.increment("a", 60_000);
      store.increment("a", 60_000);
      store.increment("b", 60_000);

      expect(store.increment("a", 60_000).count).toBe(3);
      expect(store.increment("b", 60_000).count).toBe(2);
    });

    it("returns resetAt = windowStart + windowMs", () => {
      const now = Date.now();
      const result = store.increment("k1", 5_000);

      expect(result.resetAt).toBe(now + 5_000);
    });

    it("preserves resetAt when incrementing within the same window", () => {
      const r1 = store.increment("k1", 60_000);
      vi.advanceTimersByTime(10_000);
      const r2 = store.increment("k1", 60_000);

      expect(r2.resetAt).toBe(r1.resetAt);
    });
  });

  // ── reset() ─────────────────────────────────────────────────────

  describe("reset()", () => {
    it("clears a specific key", () => {
      store.increment("k1", 60_000);
      store.increment("k1", 60_000);
      store.reset("k1");

      const result = store.increment("k1", 60_000);
      expect(result.count).toBe(1);
    });

    it("does not affect other keys", () => {
      store.increment("a", 60_000);
      store.increment("b", 60_000);
      store.reset("a");

      expect(store.increment("b", 60_000).count).toBe(2);
    });
  });

  // ── eviction ────────────────────────────────────────────────────

  describe("eviction", () => {
    it("removes expired entries during eviction sweep", () => {
      // Use a store with maxWindowMs = 5 000
      store.destroy();
      store = new InMemoryRateLimitStore(5_000);

      store.increment("old", 5_000);
      expect(store.size).toBe(1);

      // Advance past maxWindowMs so the bucket becomes a candidate
      vi.advanceTimersByTime(6_000);

      // Trigger the eviction interval (60 s default)
      vi.advanceTimersByTime(60_000);

      expect(store.size).toBe(0);
    });

    it("keeps non-expired entries during eviction sweep", () => {
      store.destroy();
      store = new InMemoryRateLimitStore(120_000);

      store.increment("fresh", 120_000);

      // Advance 60 s — bucket is still within maxWindowMs
      vi.advanceTimersByTime(60_000);

      expect(store.size).toBe(1);
    });
  });

  // ── destroy() ───────────────────────────────────────────────────

  describe("destroy()", () => {
    it("clears all buckets", () => {
      store.increment("a", 60_000);
      store.increment("b", 60_000);
      store.destroy();

      expect(store.size).toBe(0);
    });
  });
});
