/**
 * Per-dimension LRU cache for Tier 2 fetch results.
 *
 * Eviction unit is the *dimension result* — a whole fetched event
 * list for a single (period, dimension, value, customer) tuple. The
 * cap is measured by cumulative `JSON.stringify(events).length`, not
 * event count, so a cache of 5,000 small DNS queries and a cache of
 * 5,000 fat HTTP rows account for very different memory footprints.
 *
 * Cache key (per #453 acceptance, extended per #502):
 *
 *     `${periodStart}|${periodEnd}|${dimensionId}|${valueKey}|${customerScope}|${customerId}`
 *
 * The customer scope keeps cross-tenant entries from colliding when
 * the menu is opened against a different customer in the same
 * session; the asset-root `customerId` keeps two assets *within* the
 * same visible scope from colliding when they share a dimension
 * value whose resolution depends on the asset's tenant (per #502,
 * a `sameSensor` name like `edge-01` can map to a different REview
 * `nodeId` under each tenant — without `customerId` in the key, two
 * tenants pivoting `sameSensor=edge-01` would cross-contaminate).
 * The format is opaque to the cache — the caller decides how to
 * encode the scope.
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
  /**
   * Asset-root `customerId` the fetch was issued for. Two assets
   * under different tenants within the same visible `customerScope`
   * must not share a cache entry for dimensions whose resolution
   * depends on the asset's tenant (`sameSensor` — see #502).
   */
  customerId: number;
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
  /** Asset-root `customerId` the evicted entry was fetched for. */
  customerId: number;
}

export type Tier2EvictionListener = (event: Tier2EvictionEvent) => void;

export function encodeTier2CacheKey(key: Tier2CacheKey): string {
  return [
    key.periodStartIso,
    key.periodEndIso,
    key.dimensionId,
    key.valueKey,
    key.customerScope,
    String(key.customerId),
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
    const byteSize = tier2EntryByteSize(value.events);
    // Reject candidates that overflow the cap on their own *before*
    // touching any existing entries. Otherwise a single >100 MB result
    // would walk the LRU loop, evict every other entry to try to fit,
    // and only then discover the candidate is uncachable — destroying
    // unrelated cached dimensions that were already within budget. The
    // cap is a hard ceiling per #453, but it is also "do not displace
    // cached, in-budget results to make room for an uncachable one".
    // Existing overwrites are refreshed below; the rejection only
    // applies when the candidate alone busts the budget.
    if (byteSize > this.byteCap) {
      const existing = this.entries.get(cacheKey);
      if (existing) {
        // The stored entry is being overwritten by an oversized
        // candidate; remove it (and refund the bytes) since the caller
        // expects the prior result to be replaced. Surface a normal
        // eviction event so the operator sees the same refetch toast.
        this.byteUsage -= existing.byteSize;
        this.entries.delete(cacheKey);
      }
      this.listener?.({
        cacheKey,
        dimensionId: extractDimensionId(cacheKey),
        valueKey: extractValueKey(cacheKey),
        customerId: extractCustomerId(cacheKey),
      });
      return false;
    }
    // If a previous entry exists, refund its bytes first so the
    // accounting stays correct on overwrite.
    const existing = this.entries.get(cacheKey);
    if (existing) {
      this.byteUsage -= existing.byteSize;
      this.entries.delete(cacheKey);
    }
    const entry: InternalEntry = {
      ...value,
      byteSize,
      cacheKey,
    };
    this.entries.set(cacheKey, entry);
    this.byteUsage += byteSize;
    this.evictUntilWithinCap(cacheKey);
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
   * (LRU iteration starts from the oldest). The protected entry is
   * known to be within the cap by the time this runs ({@link set}
   * rejects oversized candidates up front), so this loop only needs to
   * make room for the freshly-inserted entry by freeing older ones.
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
        customerId: extractCustomerId(entry.cacheKey),
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

function extractCustomerId(cacheKey: string): number {
  const parts = cacheKey.split("|");
  const raw = parts[5] ?? "";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-event dedupe key. Tier 2 results are deduped against the
 * loaded corpus and against prior Tier 2 fetches by REview's stable
 * `Event.id` (required on the `Event` interface since review-web
 * 0.32.0 / review 0.49.0). The earlier composite of
 * `(__typename, time, orig/respAddr, orig/respPort)` was a
 * placeholder from #453 (Phase 1A-3) that could collide on
 * high-rate flows sharing a 5-tuple plus timestamp; the id is
 * collision-free by contract.
 */
export function tier2DedupeKey(event: Pick<TriageEvent, "id">): string {
  return event.id;
}
