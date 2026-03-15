import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("SettingsCache", () => {
  let SettingsCache: typeof import("@/lib/auth/settings-cache").SettingsCache;

  beforeEach(async () => {
    vi.useFakeTimers();
    const mod = await import("@/lib/auth/settings-cache");
    SettingsCache = mod.SettingsCache;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for unknown key", () => {
    const cache = new SettingsCache<string>();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a value", () => {
    const cache = new SettingsCache<number>();
    cache.set("key", 42);
    expect(cache.get("key")).toBe(42);
  });

  it("expires entries after TTL", () => {
    const cache = new SettingsCache<string>(10); // 10 seconds
    cache.set("key", "value");

    // Still valid at 9 seconds
    vi.advanceTimersByTime(9_000);
    expect(cache.get("key")).toBe("value");

    // Expired at 11 seconds
    vi.advanceTimersByTime(2_000);
    expect(cache.get("key")).toBeUndefined();
  });

  it("uses 60-second default TTL", () => {
    const cache = new SettingsCache<string>();
    cache.set("key", "value");

    vi.advanceTimersByTime(59_000);
    expect(cache.get("key")).toBe("value");

    vi.advanceTimersByTime(2_000);
    expect(cache.get("key")).toBeUndefined();
  });

  it("invalidate(key) removes only the specified key", () => {
    const cache = new SettingsCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");

    cache.invalidate("a");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });

  it("invalidate() without key clears all entries", () => {
    const cache = new SettingsCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");

    cache.invalidate();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("invalidateAll() clears all entries", () => {
    const cache = new SettingsCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");

    cache.invalidateAll();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("set() refreshes the TTL for an existing key", () => {
    const cache = new SettingsCache<string>(10);
    cache.set("key", "v1");

    vi.advanceTimersByTime(8_000);
    cache.set("key", "v2"); // refresh TTL

    vi.advanceTimersByTime(8_000); // 16s total, but only 8s since refresh
    expect(cache.get("key")).toBe("v2");
  });
});
