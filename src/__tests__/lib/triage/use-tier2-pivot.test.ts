/**
 * Regression coverage for two Round 6 hook-layer blockers (#453):
 *
 *   1. The cache LRU layer must track hook-level reads. `getCached()`
 *      previously returned the in-memory state without touching the
 *      cache, so a re-pivot of A served from `stateMapRef` never
 *      refreshed A's recency — a later over-cap insert would evict A
 *      even though it was just used.
 *   2. The pre-fetch confirmation modal slot used to be a single ref;
 *      two large-projection clicks fired before either peek resolved
 *      orphaned the earlier dimension in `loading` because the second
 *      peek's stash overwrote the first. The modal must instead queue
 *      pending projections per dimension and walk them serially.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tier2Cache } from "@/lib/triage/tier2-cache";
import type { Tier2Dimension } from "@/lib/triage/tier2-filter";
import type { TriageEvent } from "@/lib/triage/types";
import { useTier2Pivot } from "@/lib/triage/use-tier2-pivot";

// ── Mocks ────────────────────────────────────────────────────

const fetchTier2DimensionMock = vi.fn();

vi.mock("@/lib/triage/tier2-fetch", () => ({
  fetchTier2Dimension: (input: unknown) => fetchTier2DimensionMock(input),
}));

// ── Test helpers ─────────────────────────────────────────────

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

interface FetchResolution {
  events: TriageEvent[];
  totalCount: string | null;
  endCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
}

function deferred(): {
  promise: Promise<FetchResolution>;
  resolve: (value: FetchResolution) => void;
  reject: (err: unknown) => void;
} {
  let resolveFn: ((value: FetchResolution) => void) | undefined;
  let rejectFn: ((err: unknown) => void) | undefined;
  const promise = new Promise<FetchResolution>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return {
    promise,
    resolve: (value) => resolveFn?.(value),
    reject: (err) => rejectFn?.(err),
  };
}

const HOOK_ARGS_BASE = {
  periodStartIso: "2026-05-08T12:00:00.000Z",
  periodEndIso: "2026-05-09T12:00:00.000Z",
  customerScope: "global",
  enabled: true,
  tier1Corpus: [] as ReadonlyArray<TriageEvent>,
};

// ── Tests ────────────────────────────────────────────────────

beforeEach(() => {
  fetchTier2DimensionMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useTier2Pivot — LRU recency tracks hook reads", () => {
  it("invokes Tier2Cache.get when a getCached read is served from the in-memory state", async () => {
    // The cache's own LRU semantics (refresh on get) is covered in
    // tier2-cache.test.ts. This test pins the *hook-layer* contract:
    // calling getCached for an entry that lives in `stateMapRef` must
    // still touch the cache so the LRU layer tracks hook-level reads.
    // Without this, a re-pivot of A served from stateMapRef never
    // refreshed A's recency, and a later over-cap insert could evict
    // A even though it was just used.
    fetchTier2DimensionMock.mockImplementation(async () => ({
      events: [makeEvent(0)],
      totalCount: "1",
      endCursor: null,
      hasMore: false,
      truncated: false,
    }));

    const cacheGetSpy = vi.spyOn(Tier2Cache.prototype, "get");
    const { result } = renderHook(() => useTier2Pivot(HOOK_ARGS_BASE));
    const dim: Tier2Dimension = "country";

    await act(async () => {
      result.current.startFetch(dim, "A");
      // Allow the awaited peek to resolve and the result to land in
      // both the cache and `stateMapRef`.
      await Promise.resolve();
      await Promise.resolve();
    });

    cacheGetSpy.mockClear();

    // Re-pivot A — this is the hook-layer read path that previously
    // bypassed `cache.get()`.
    act(() => {
      const cached = result.current.getCached(dim, "A");
      expect(cached?.status).toBe("ready");
    });

    expect(cacheGetSpy).toHaveBeenCalled();
    const callKey = cacheGetSpy.mock.calls[0][0] as { valueKey: string };
    expect(callKey.valueKey).toBe("A");
  });
});

describe("useTier2Pivot — modal queue serializes large-projection clicks", () => {
  it("queues a second large-projection click instead of overwriting the first", async () => {
    // Two parallel server-filtered fetches both return >20,000 events
    // — projection trips the modal threshold for each. With the old
    // single-slot stash, the later peek overwrote the earlier one and
    // orphaned the first dimension in `loading` with no confirm/cancel
    // affordance. The queue must keep both reachable.
    const peekA = deferred();
    const peekB = deferred();
    const continueA = deferred();
    const continueB = deferred();

    fetchTier2DimensionMock.mockImplementation(
      async (input: {
        valueKey: string;
        firstPageOnly?: boolean;
      }): Promise<FetchResolution> => {
        if (input.firstPageOnly === true) {
          if (input.valueKey === "A") return peekA.promise;
          if (input.valueKey === "B") return peekB.promise;
        } else {
          if (input.valueKey === "A") return continueA.promise;
          if (input.valueKey === "B") return continueB.promise;
        }
        throw new Error(`unexpected fetch ${JSON.stringify(input)}`);
      },
    );

    const { result } = renderHook(() => useTier2Pivot(HOOK_ARGS_BASE));
    const dim: Tier2Dimension = "country";

    // Fire two clicks back-to-back, before either peek resolves.
    act(() => {
      result.current.startFetch(dim, "A");
      result.current.startFetch(dim, "B");
    });
    expect(result.current.getCached(dim, "A")?.status).toBe("loading");
    expect(result.current.getCached(dim, "B")?.status).toBe("loading");

    const fullPage = Array.from({ length: 100 }, (_, i) => makeEvent(i));

    // Resolve A's peek first, then B's. Queue order follows peek-
    // resolution order — the contract the bug fix needs is that *both*
    // are reachable through the modal, not a particular ordering.
    await act(async () => {
      peekA.resolve({
        events: fullPage,
        totalCount: "25000",
        endCursor: "cursor-a",
        hasMore: true,
        truncated: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      peekB.resolve({
        events: fullPage,
        totalCount: "30000",
        endCursor: "cursor-b",
        hasMore: true,
        truncated: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Both peeks have resolved; the modal fronts the head — A in this
    // test (peek A resolved first). The original bug repro had the
    // first dimension stuck in `loading` after the second peek
    // overwrote its stash; the queue now keeps both reachable.
    expect(result.current.pending?.valueKey).toBe("A");

    // Confirm A — the continuation fires, the queue advances to B,
    // and B is still in `loading` waiting for its turn.
    await act(async () => {
      result.current.confirmFetch();
      await Promise.resolve();
    });
    expect(result.current.pending?.valueKey).toBe("B");
    expect(result.current.getCached(dim, "B")?.status).toBe("loading");

    // Drain the continuation for A.
    await act(async () => {
      continueA.resolve({
        events: [makeEvent(1)],
        totalCount: "25000",
        endCursor: null,
        hasMore: false,
        truncated: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.getCached(dim, "A")?.status).toBe("ready");

    // Cancelling B clears its loading entry — the orphaned-loading
    // bug repro should NOT happen: B is reachable through the queue.
    await act(async () => {
      result.current.cancelFetch();
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.getCached(dim, "B")).toBeNull();

    // Drain B's continuation promise so vitest doesn't warn about
    // unresolved promises.
    continueB.resolve({
      events: [],
      totalCount: null,
      endCursor: null,
      hasMore: false,
      truncated: false,
    });
  });

  it("carries an approximate first-page count on the projection when totalCount is unavailable", async () => {
    // Round 7 regression: when `totalCount` is unknown but the first
    // page of the cursor walk filled, the modal must render an
    // approximate "≥ N" estimate from that first page rather than the
    // generic "size unknown" copy. The hook surfaces the lower bound on
    // `Tier2PendingProjection.approximateMinimum`; without this field
    // the modal would discard the estimate before rendering.
    fetchTier2DimensionMock.mockImplementation(async () => ({
      events: Array.from({ length: 100 }, (_, i) => makeEvent(i)),
      totalCount: null,
      endCursor: "cursor",
      hasMore: true,
      truncated: false,
    }));

    const { result } = renderHook(() => useTier2Pivot(HOOK_ARGS_BASE));
    const dim: Tier2Dimension = "country";

    await act(async () => {
      result.current.startFetch(dim, "FALLBACK");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.pending).not.toBeNull();
    expect(result.current.pending?.totalCount).toBeNull();
    expect(result.current.pending?.approximateMinimum).toBe("100");

    await act(async () => {
      result.current.cancelFetch();
    });
  });

  it("ignores duplicate clicks while a peek for the same dimension is in flight", async () => {
    // Without the `loading` guard in `startFetch`, double-clicking a
    // dimension issues duplicate first-page peeks; if the second peek
    // resolves later, its stash overwrites the first one and the
    // operator sees the modal flicker between identical projections.
    const peek = deferred();
    fetchTier2DimensionMock.mockImplementation(async () => peek.promise);

    const { result } = renderHook(() => useTier2Pivot(HOOK_ARGS_BASE));
    const dim: Tier2Dimension = "country";

    act(() => {
      result.current.startFetch(dim, "A");
      result.current.startFetch(dim, "A");
      result.current.startFetch(dim, "A");
    });

    expect(fetchTier2DimensionMock).toHaveBeenCalledTimes(1);

    // Drain so the test exits cleanly.
    await act(async () => {
      peek.resolve({
        events: [makeEvent(0)],
        totalCount: "1",
        endCursor: null,
        hasMore: false,
        truncated: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.getCached(dim, "A")?.status).toBe("ready");
  });
});
