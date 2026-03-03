/**
 * Pluggable rate-limit storage.
 *
 * Swap to a Redis-backed implementation when horizontal scaling is needed.
 */
export interface RateLimitStore {
  /** Increment the counter for `key` inside a fixed window of `windowMs` milliseconds. */
  increment(key: string, windowMs: number): { count: number; resetAt: number };
  /** Remove the counter for `key`. */
  reset(key: string): void;
}

// ── In-memory implementation ──────────────────────────────────────

interface Bucket {
  count: number;
  windowStart: number;
}

/** How often the eviction sweep runs (ms). */
const EVICTION_INTERVAL_MS = 60_000;

/**
 * In-memory fixed-window counter.
 *
 * **Single-BFF assumption**: a single Node.js process serves all
 * traffic, so an in-process `Map` is sufficient.  To scale
 * horizontally, replace this with a Redis-backed implementation.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly evictionTimer: ReturnType<typeof setInterval>;

  /**
   * @param maxWindowMs  The longest window any limiter will use.
   *                     Buckets older than this are candidates for eviction.
   */
  constructor(private readonly maxWindowMs: number = 10 * 60 * 1000) {
    this.evictionTimer = setInterval(() => this.evict(), EVICTION_INTERVAL_MS);
    // Allow the Node.js process to exit even if the timer is still active.
    if (typeof this.evictionTimer === "object" && "unref" in this.evictionTimer)
      this.evictionTimer.unref();
  }

  increment(key: string, windowMs: number): { count: number; resetAt: number } {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (existing && now - existing.windowStart < windowMs) {
      existing.count += 1;
      return {
        count: existing.count,
        resetAt: existing.windowStart + windowMs,
      };
    }

    // Window expired (or first request) — start a fresh bucket.
    const bucket: Bucket = { count: 1, windowStart: now };
    this.buckets.set(key, bucket);
    return { count: 1, resetAt: now + windowMs };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Remove buckets whose window has long expired. */
  private evict(): void {
    const cutoff = Date.now() - this.maxWindowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  /** Stop the eviction timer. Call this in test teardown. */
  destroy(): void {
    clearInterval(this.evictionTimer);
    this.buckets.clear();
  }

  /** Visible bucket count — exposed for testing only. */
  get size(): number {
    return this.buckets.size;
  }
}
