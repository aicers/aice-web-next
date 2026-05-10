"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";
import { stringNumberGreaterThan } from "./string-number";
import {
  TIER2_PER_DIMENSION_CAP,
  Tier2Cache,
  type Tier2EvictionEvent,
  tier2DedupeKey,
} from "./tier2-cache";
import { fetchTier2Dimension } from "./tier2-fetch";
import { isTier2ServerDimension, type Tier2Dimension } from "./tier2-filter";
import type { TriageEvent } from "./types";

/**
 * Threshold at which the pre-fetch confirmation modal asks the
 * operator to confirm before issuing a Tier 2 fetch (#453).
 */
export const TIER2_PREFETCH_MODAL_THRESHOLD = 20_000;

export interface UseTier2PivotArgs {
  periodStartIso: string;
  periodEndIso: string;
  /** Stable identifier for the customer scope; gates cache reuse. */
  customerScope: string;
  /** True when the menu is in Tier 2 mode. */
  enabled: boolean;
}

export interface Tier2DimensionState {
  status: "idle" | "loading" | "ready" | "error";
  events: TriageEvent[];
  totalCount: string | null;
  truncated: boolean;
  error: string | null;
}

export interface Tier2PendingProjection {
  dimension: Tier2Dimension;
  valueKey: string;
  /** REview's `totalCount` when projection is known, else null. */
  totalCount: string | null;
}

export interface Tier2FetchError {
  dimension: Tier2Dimension;
  valueKey: string;
  message: string;
}

export interface Tier2FetchInFlight {
  dimension: Tier2Dimension;
  valueKey: string;
}

export interface UseTier2Pivot {
  scope: "tier1" | "tier2";
  /** Get the cached Tier 2 result for a dimension click, if any. */
  getCached: (
    dimension: Tier2Dimension,
    valueKey: string,
  ) => Tier2DimensionState | null;
  /**
   * Trigger a Tier 2 fetch for a dimension click. If the projection
   * is known to exceed the modal threshold, the call resolves to
   * `{ pending: <projection> }` and the caller is expected to render
   * the confirmation modal; calling {@link confirmFetch} resumes.
   */
  startFetch: (dimension: Tier2Dimension, valueKey: string) => void;
  /** Resume a fetch the operator confirmed through the modal. */
  confirmFetch: () => void;
  /** Cancel a pending pre-fetch projection. */
  cancelFetch: () => void;
  pending: Tier2PendingProjection | null;
  evictions: Tier2EvictionEvent[];
  acknowledgeEviction: (cacheKey: string) => void;
  /** Outstanding fetch errors awaiting operator acknowledgement. */
  errors: Tier2FetchError[];
  /** Dismiss a surfaced fetch error and clear its dimension state. */
  acknowledgeError: (dimension: Tier2Dimension, valueKey: string) => void;
  /** Dimensions currently fetching — drives the progress indicator. */
  inFlight: Tier2FetchInFlight[];
  /**
   * `true` when the event already exists in the Tier 1 corpus
   * (per the dedupe key) — used by row rendering to decide whether
   * a Tier 2 row qualifies for the "weak signal" affordance.
   */
  isInTier1Corpus: (event: TriageEvent) => boolean;
}

/**
 * Lifecycle hook orchestrating the Tier 2 fetch path.
 *
 * Caches results in a per-render-stable {@link Tier2Cache} keyed on
 * `(period, dimension, value, customerScope)`. A single fetch can be
 * gated behind the pre-fetch confirmation modal; resolving the gate
 * dispatches the underlying server action.
 *
 * Tier 1 corpus membership is provided by the caller via the
 * `tier1Corpus` argument so weak-signal rendering can be evaluated at
 * the row layer without rebuilding the dedupe set per render.
 */
interface PeekStash {
  dimension: Tier2Dimension;
  valueKey: string;
  events: TriageEvent[];
  totalCount: string | null;
  endCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
}

export function useTier2Pivot(
  args: UseTier2PivotArgs & { tier1Corpus: ReadonlyArray<TriageEvent> },
): UseTier2Pivot {
  const cacheRef = useRef<Tier2Cache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new Tier2Cache();

  const tier1KeySet = useMemo(() => {
    const set = new Set<string>();
    for (const ev of args.tier1Corpus) set.add(tier2DedupeKey(ev));
    return set;
  }, [args.tier1Corpus]);

  const [renderTick, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((n) => n + 1), []);

  const stateMapRef = useRef<Map<string, Tier2DimensionState>>(new Map());
  const peekStashRef = useRef<PeekStash | null>(null);
  const [pending, setPending] = useState<Tier2PendingProjection | null>(null);
  const [evictions, setEvictions] = useState<Tier2EvictionEvent[]>([]);
  // Bumped whenever the period or customer scope rotates. Each
  // in-flight fetch captures the current generation when it starts and
  // refuses to write its result back if the generation no longer
  // matches — without this, a fetch that began before a period change
  // could land in `stateMapRef` after the reset effect cleared it,
  // and `getCached` would resurrect a result that belongs to a stale
  // (period, customer) tuple. The in-memory key intentionally stays
  // `${dimension}|${valueKey}` so the LRU layer is the only place that
  // carries the full scoped key; the generation guard keeps the
  // unscoped layer from leaking cross-scope rows.
  const generationRef = useRef(0);

  // Wire eviction listener exactly once. The cache lives across
  // renders; we keep the React state in sync with the cache events
  // through this listener. The listener also drops the corresponding
  // in-memory state entry so re-pivoting after eviction triggers a
  // refetch instead of returning the strongly-referenced events that
  // the cache has already discarded — that would violate both the
  // memory-cap invariant and the stated eviction behavior.
  useEffect(() => {
    const cache = cacheRef.current;
    if (!cache) return;
    cache.setEvictionListener((event) => {
      stateMapRef.current.delete(`${event.dimensionId}|${event.valueKey}`);
      setEvictions((prev) => [...prev, event]);
      bump();
    });
    return () => {
      cache.setEvictionListener(null);
    };
  }, [bump]);

  // Reset cached state when the period or customer scope rotates —
  // the cache key includes those fields, so stale entries become
  // unreachable; clearing keeps the byte-budget honest. The deps
  // intentionally name the trigger fields (period bounds and scope)
  // even though the body does not reference them; biome's exhaustive-
  // deps rule reports these as removable, so the suppression below
  // documents the trigger contract.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps name the period/scope rotate trigger
  useEffect(() => {
    generationRef.current += 1;
    cacheRef.current?.clear();
    stateMapRef.current.clear();
    peekStashRef.current = null;
    setEvictions([]);
    setPending(null);
    bump();
  }, [args.periodStartIso, args.periodEndIso, args.customerScope, bump]);

  const stateKey = useCallback(
    (dimension: Tier2Dimension, valueKey: string) => `${dimension}|${valueKey}`,
    [],
  );

  const cacheKeyFor = useCallback(
    (dimension: Tier2Dimension, valueKey: string) => ({
      periodStartIso: args.periodStartIso,
      periodEndIso: args.periodEndIso,
      dimensionId: dimension,
      valueKey,
      customerScope: args.customerScope,
    }),
    [args.periodStartIso, args.periodEndIso, args.customerScope],
  );

  const getCached = useCallback(
    (dimension: Tier2Dimension, valueKey: string) => {
      const cache = cacheRef.current;
      if (!cache) return null;
      const inMemory = stateMapRef.current.get(stateKey(dimension, valueKey));
      if (inMemory) return inMemory;
      const hit = cache.get(cacheKeyFor(dimension, valueKey));
      if (!hit) return null;
      return {
        status: "ready" as const,
        events: hit.events,
        totalCount: hit.totalCount,
        truncated: false,
        error: null,
      };
    },
    [cacheKeyFor, stateKey],
  );

  const setError = useCallback(
    (key: string, err: unknown) => {
      stateMapRef.current.set(key, {
        status: "error",
        events: [],
        totalCount: null,
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
      bump();
    },
    [bump],
  );

  const writeReady = useCallback(
    (
      dimension: Tier2Dimension,
      valueKey: string,
      result: {
        events: TriageEvent[];
        totalCount: string | null;
        truncated: boolean;
      },
    ) => {
      const key = stateKey(dimension, valueKey);
      cacheRef.current?.set(cacheKeyFor(dimension, valueKey), {
        events: result.events,
        totalCount: result.totalCount,
      });
      stateMapRef.current.set(key, {
        status: "ready",
        events: result.events,
        totalCount: result.totalCount,
        truncated: result.truncated,
        error: null,
      });
      bump();
    },
    [bump, cacheKeyFor, stateKey],
  );

  const continueFromStash = useCallback(
    async (stash: PeekStash, capturedGen: number) => {
      const key = stateKey(stash.dimension, stash.valueKey);
      try {
        // Resume from the peek's cursor so the first page (already in
        // `stash.events`) is not refetched. Pass `alreadyFetched` so
        // the impl subtracts the peek rows from the per-dimension cap
        // budget — without this the merge could exceed
        // TIER2_PER_DIMENSION_CAP because the impl would otherwise
        // start a fresh budget from the peek's cursor.
        const rest = await fetchTier2Dimension({
          periodStartIso: args.periodStartIso,
          periodEndIso: args.periodEndIso,
          dimension: stash.dimension,
          valueKey: stash.valueKey,
          afterCursor: stash.endCursor,
          alreadyFetched: stash.events.length,
        });
        if (capturedGen !== generationRef.current) return;
        const merged = [...stash.events, ...rest.events];
        // Defensive slice — if a downstream change ever lets the
        // server overshoot the budget (or alreadyFetched is wired
        // wrong) the merge still respects the cap.
        const capped = merged.slice(0, TIER2_PER_DIMENSION_CAP);
        const truncated = rest.truncated || merged.length > capped.length;
        writeReady(stash.dimension, stash.valueKey, {
          events: capped,
          totalCount: stash.totalCount ?? rest.totalCount,
          truncated,
        });
      } catch (err) {
        if (capturedGen !== generationRef.current) return;
        setError(key, err);
      }
    },
    [args.periodStartIso, args.periodEndIso, stateKey, setError, writeReady],
  );

  const startFetch = useCallback(
    (dimension: Tier2Dimension, valueKey: string) => {
      if (!args.enabled) return;
      if (!isTier2ServerDimension(dimension)) return;
      const existing = getCached(dimension, valueKey);
      if (existing && existing.status === "ready") return;
      const key = stateKey(dimension, valueKey);
      const capturedGen = generationRef.current;
      stateMapRef.current.set(key, {
        status: "loading",
        events: [],
        totalCount: null,
        truncated: false,
        error: null,
      });
      bump();

      void (async () => {
        let peek: Awaited<ReturnType<typeof fetchTier2Dimension>>;
        try {
          peek = await fetchTier2Dimension({
            periodStartIso: args.periodStartIso,
            periodEndIso: args.periodEndIso,
            dimension,
            valueKey,
            firstPageOnly: true,
          });
        } catch (err) {
          if (capturedGen !== generationRef.current) return;
          setError(key, err);
          return;
        }
        if (capturedGen !== generationRef.current) return;
        // Single-page fits the whole result: skip the modal and the
        // continuation round-trip.
        if (!peek.hasMore) {
          writeReady(dimension, valueKey, {
            events: peek.events,
            totalCount: peek.totalCount,
            truncated: peek.truncated,
          });
          return;
        }
        // Decide whether the projection trips the modal. With a known
        // `totalCount` we compare directly; without one, fall back to
        // a "≥ N" estimate from the first page — only show the modal
        // when the first page filled (otherwise the count is small).
        const overByTotal = stringNumberGreaterThan(
          peek.totalCount,
          TIER2_PREFETCH_MODAL_THRESHOLD,
        );
        const overByEstimate =
          peek.totalCount === null &&
          peek.events.length >= REVIEW_MAX_PAGE_SIZE;
        if (overByTotal || overByEstimate) {
          peekStashRef.current = {
            dimension,
            valueKey,
            events: peek.events,
            totalCount: peek.totalCount,
            endCursor: peek.endCursor,
            hasMore: peek.hasMore,
            truncated: peek.truncated,
          };
          setPending({
            dimension,
            valueKey,
            totalCount: peek.totalCount,
          });
          return;
        }
        // Under threshold — continue the walk silently from the peek's
        // cursor.
        await continueFromStash(
          {
            dimension,
            valueKey,
            events: peek.events,
            totalCount: peek.totalCount,
            endCursor: peek.endCursor,
            hasMore: peek.hasMore,
            truncated: peek.truncated,
          },
          capturedGen,
        );
      })();
    },
    [
      args.enabled,
      args.periodStartIso,
      args.periodEndIso,
      bump,
      continueFromStash,
      getCached,
      setError,
      stateKey,
      writeReady,
    ],
  );

  const confirmFetch = useCallback(() => {
    const stash = peekStashRef.current;
    peekStashRef.current = null;
    setPending(null);
    if (!stash) return;
    void continueFromStash(stash, generationRef.current);
  }, [continueFromStash]);

  const cancelFetch = useCallback(() => {
    const stash = peekStashRef.current;
    peekStashRef.current = null;
    setPending(null);
    if (!stash) return;
    // Drop the loading entry so the panel does not show a permanent
    // spinner on a cancelled pivot.
    stateMapRef.current.delete(stateKey(stash.dimension, stash.valueKey));
    bump();
  }, [bump, stateKey]);

  const acknowledgeEviction = useCallback((cacheKey: string) => {
    setEvictions((prev) => prev.filter((e) => e.cacheKey !== cacheKey));
  }, []);

  const acknowledgeError = useCallback(
    (dimension: Tier2Dimension, valueKey: string) => {
      stateMapRef.current.delete(stateKey(dimension, valueKey));
      bump();
    },
    [bump, stateKey],
  );

  // `renderTick` is the bump-driven render counter. The state map
  // itself is a ref, so without naming the tick the memo would never
  // recompute when an error is added or acknowledged. Biome's
  // exhaustive-deps reports it as removable; the suppression below
  // documents the trigger contract.
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderTick is the rebuild trigger
  const errors = useMemo<Tier2FetchError[]>(() => {
    const list: Tier2FetchError[] = [];
    for (const [k, state] of stateMapRef.current.entries()) {
      if (state.status !== "error") continue;
      const sep = k.indexOf("|");
      if (sep <= 0) continue;
      list.push({
        dimension: k.slice(0, sep) as Tier2Dimension,
        valueKey: k.slice(sep + 1),
        message: state.error ?? "",
      });
    }
    return list;
  }, [renderTick]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: renderTick is the rebuild trigger
  const inFlight = useMemo<Tier2FetchInFlight[]>(() => {
    const list: Tier2FetchInFlight[] = [];
    for (const [k, state] of stateMapRef.current.entries()) {
      if (state.status !== "loading") continue;
      const sep = k.indexOf("|");
      if (sep <= 0) continue;
      list.push({
        dimension: k.slice(0, sep) as Tier2Dimension,
        valueKey: k.slice(sep + 1),
      });
    }
    return list;
  }, [renderTick]);

  const isInTier1Corpus = useCallback(
    (event: TriageEvent) => tier1KeySet.has(tier2DedupeKey(event)),
    [tier1KeySet],
  );

  return {
    scope: args.enabled ? "tier2" : "tier1",
    getCached,
    startFetch,
    confirmFetch,
    cancelFetch,
    pending,
    evictions,
    acknowledgeEviction,
    errors,
    acknowledgeError,
    inFlight,
    isInTier1Corpus,
  };
}
