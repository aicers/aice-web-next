/**
 * Per-dimension LRU cache for Tier 2 fetch results.
 *
 * Eviction unit is the *dimension result* — a whole fetched event
 * list for a single (period, dimension, value, customer) tuple. The
 * cap is measured by cumulative `JSON.stringify(events).length`, not
 * event count, so a cache of 5,000 small DNS queries and a cache of
 * 5,000 fat HTTP rows account for very different memory footprints.
 *
 * Cache key (per #453 acceptance):
 *
 *     `${periodStart}|${periodEnd}|${dimensionId}|${valueKey}|${customerScope}`
 *
 * The customer scope keeps cross-tenant entries from colliding when
 * the menu is opened against a different customer in the same
 * session. The format is opaque to the cache — the caller decides
 * how to encode the scope.
 */

import type { ScoredTriageEvent, TriageEvent } from "./types";

/** Default ceiling — 100 MB, per #453 acceptance. */
export const TIER2_CACHE_BYTE_CAP = 100 * 1024 * 1024;

/**
 * Per-dimension fetch cap (#453 acceptance). A single dimension fetch
 * walks at most this many events. The cap is held here (not next to
 * the server-only fetch impl) so the client hook can enforce the same
 * ceiling when continuing pagination after a peek.
 */
export const TIER2_PER_DIMENSION_CAP = 5_000;

export interface Tier2CacheKey {
  periodStartIso: string;
  periodEndIso: string;
  dimensionId: string;
  valueKey: string;
  /** Stable identifier for the customer scope. */
  customerScope: string;
}

export interface Tier2CacheEntry {
  events: TriageEvent[];
  /** REview's `EventConnection.totalCount`; null if the projection couldn't be evaluated. */
  totalCount: string | null;
  /** `JSON.stringify(events).length` — the cache's accounting unit. */
  byteSize: number;
}

interface InternalEntry extends Tier2CacheEntry {
  /** Encoded cache key — kept on the entry so eviction can locate it cheaply. */
  cacheKey: string;
}

/**
 * Cache eviction event surfaced to the UI so a non-blocking toast
 * can announce which dimension(s) were dropped.
 */
export interface Tier2EvictionEvent {
  cacheKey: string;
  dimensionId: string;
  valueKey: string;
}

export type Tier2EvictionListener = (event: Tier2EvictionEvent) => void;

export function encodeTier2CacheKey(key: Tier2CacheKey): string {
  return [
    key.periodStartIso,
    key.periodEndIso,
    key.dimensionId,
    key.valueKey,
    key.customerScope,
  ].join("|");
}

/** Approximate the byte size used to budget a cache entry. */
export function tier2EntryByteSize(
  events: ReadonlyArray<TriageEvent | ScoredTriageEvent>,
): number {
  // `JSON.stringify().length` is what the issue calls out. Cheap to
  // compute once at insert time, deterministic across runs, and
  // independent of any per-shape weighting that would drift as the
  // selection set evolves.
  return JSON.stringify(events).length;
}

export class Tier2Cache {
  private readonly entries = new Map<string, InternalEntry>();
  private byteUsage = 0;
  private listener: Tier2EvictionListener | null = null;

  constructor(private readonly byteCap: number = TIER2_CACHE_BYTE_CAP) {}

  setEvictionListener(listener: Tier2EvictionListener | null): void {
    this.listener = listener;
  }

  byteSize(): number {
    return this.byteUsage;
  }

  size(): number {
    return this.entries.size;
  }

  get(key: Tier2CacheKey): Tier2CacheEntry | null {
    const cacheKey = encodeTier2CacheKey(key);
    const hit = this.entries.get(cacheKey);
    if (!hit) return null;
    // Refresh LRU order: re-insert moves the entry to the most-recent slot.
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, hit);
    return hit;
  }

  /**
   * Insert (or overwrite) an entry. Returns `true` when the new entry
   * was retained by the cache and `false` when the entry alone exceeds
   * `byteCap` and was therefore rejected — in the rejection case an
   * eviction event is emitted for the rejected entry so the caller can
   * surface the same refetch toast as a normal LRU drop. The boolean
   * lets the hook layer skip writing the rejected result into its
   * in-memory ready state, which is what enforces the 100 MB cap as a
   * hard ceiling per #453.
   */
  set(key: Tier2CacheKey, value: Omit<Tier2CacheEntry, "byteSize">): boolean {
    const cacheKey = encodeTier2CacheKey(key);
    // If a previous entry exists, refund its bytes first so the
    // accounting stays correct on overwrite.
    const existing = this.entries.get(cacheKey);
    if (existing) {
      this.byteUsage -= existing.byteSize;
      this.entries.delete(cacheKey);
    }
    const byteSize = tier2EntryByteSize(value.events);
    const entry: InternalEntry = {
      ...value,
      byteSize,
      cacheKey,
    };
    this.entries.set(cacheKey, entry);
    this.byteUsage += byteSize;
    this.evictUntilWithinCap(cacheKey);
    // After evicting every other entry, if the protected entry alone
    // still busts the cap, drop it too — the cap is a hard ceiling per
    // #453, not "best effort except for the latest fetch". The eviction
    // listener fires for it so the operator sees the same toast.
    if (this.byteUsage > this.byteCap && this.entries.has(cacheKey)) {
      this.byteUsage -= entry.byteSize;
      this.entries.delete(cacheKey);
      this.listener?.({
        cacheKey,
        dimensionId: extractDimensionId(cacheKey),
        valueKey: extractValueKey(cacheKey),
      });
      return false;
    }
    return true;
  }

  delete(key: Tier2CacheKey): boolean {
    const cacheKey = encodeTier2CacheKey(key);
    const existing = this.entries.get(cacheKey);
    if (!existing) return false;
    this.byteUsage -= existing.byteSize;
    this.entries.delete(cacheKey);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.byteUsage = 0;
  }

  /**
   * Evict least-recently-used entries until the byte usage fits under
   * the cap. The freshly-inserted entry is preferred over older ones
   * (LRU iteration starts from the oldest). If after evicting every
   * other entry the protected entry alone still exceeds the cap, the
   * caller of {@link set} drops it too — see {@link set}'s rejection
   * path. Until then this loop only walks non-protected entries so a
   * single oversized result does not silently displace the cache when
   * other entries can be freed first.
   */
  private evictUntilWithinCap(protectKey: string): void {
    if (this.byteUsage <= this.byteCap) return;
    const iterator = this.entries.keys();
    while (this.byteUsage > this.byteCap) {
      const next = iterator.next();
      if (next.done) break;
      const candidate = next.value;
      if (candidate === protectKey) continue;
      const entry = this.entries.get(candidate);
      if (!entry) continue;
      this.byteUsage -= entry.byteSize;
      this.entries.delete(candidate);
      this.listener?.({
        cacheKey: entry.cacheKey,
        dimensionId: extractDimensionId(entry.cacheKey),
        valueKey: extractValueKey(entry.cacheKey),
      });
    }
  }
}

function extractDimensionId(cacheKey: string): string {
  return cacheKey.split("|")[2] ?? "";
}

function extractValueKey(cacheKey: string): string {
  return cacheKey.split("|")[3] ?? "";
}

/**
 * Per-event dedupe key. Tier 2 results are deduped against the
 * loaded corpus and against prior Tier 2 fetches by this composite
 * — REview does not expose a stable per-event id on `eventList`.
 */
export function tier2DedupeKey(
  event: Pick<
    TriageEvent,
    "__typename" | "time" | "origAddr" | "respAddr" | "origPort" | "respPort"
  >,
): string {
  return [
    event.__typename,
    event.time,
    event.origAddr ?? "",
    event.respAddr ?? "",
    event.origPort ?? "",
    event.respPort ?? "",
  ].join("|");
}
