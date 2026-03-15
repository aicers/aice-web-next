import "server-only";

// ── Types ──────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ── SettingsCache ──────────────────────────────────────────────────

/**
 * Generic per-key in-memory cache with TTL.
 *
 * Designed for caching DB-backed system settings so that hot paths
 * (e.g. `withAuth`) do not query the database on every request.
 *
 * @param T  The cached value type.
 * @param ttlSeconds  Time-to-live in seconds (default 60).
 */
export class SettingsCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlSeconds = 60) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /** Return the cached value for `key`, or `undefined` if missing/expired. */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a value under `key` with the configured TTL. */
  set(key: string, value: T): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Invalidate a single key, or all keys if `key` is omitted.
   */
  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  /** Alias for `invalidate()` — clear the entire cache. */
  invalidateAll(): void {
    this.cache.clear();
  }
}
