/**
 * Cache lifecycle coverage for the wrapper-owned `customerCache`
 * state in {@link DetectionTabsShell} (#384, Reviewer Round 6 #3).
 *
 * The full `DetectionTabsShell` mount is heavy (next-intl provider,
 * next/navigation, session, sessionStorage, the full result-cache
 * machinery, …), and the cache logic itself is small enough to
 * verify without it: the wrapper holds a `useState<CustomerCache>`
 * initialised to `{ status: "idle" }`, exposes a `triggerCustomerFetch`
 * that runs `fetchCustomersForFilter()` and stores the result, and
 * relies on `shouldTriggerCustomerFetch(cache)` (the same helper the
 * shell consumes on the drawer-open path) to decide whether a fetch
 * is needed.
 *
 * This file mounts a thin harness that mirrors that shape and proves
 * the four lifecycle invariants the issue called out:
 *   1. First drawer-open transitions `idle → loading → loaded` and
 *      issues exactly one fetch.
 *   2. Second drawer-open with the cache `loaded` is a no-op (no
 *      additional fetch — `shouldTriggerCustomerFetch` returns false).
 *   3. A subsequent "new tab" event does not invalidate the cache —
 *      the wrapper's state survives, so a fresh shell mounted under
 *      the same wrapper sees the existing `loaded` snapshot.
 *   4. Manual refresh always re-fetches and replaces the cached
 *      options (separate code path from `shouldTriggerCustomerFetch`).
 *
 * Plus pure-helper coverage of `shouldTriggerCustomerFetch` and
 * `customerStateForCache` so each cache `status` is locked to its
 * intended UI mapping.
 */

import { act, render } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

// `detection-shell.tsx` transitively imports `next/navigation` /
// `@/i18n/navigation`, both of which trip the jsdom-environment
// module resolver. Stub the navigation barrels so the helper imports
// succeed without dragging in next-intl's client-router internals.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const { customerStateForCache, shouldTriggerCustomerFetch } = await import(
  "@/components/detection/detection-shell"
);

type CustomerCache = Parameters<typeof shouldTriggerCustomerFetch>[0];

type FetchResult = {
  ok: true;
  kind: "admin" | "assigned" | "empty";
  customers: { id: number; name: string }[];
};

interface HarnessAPI {
  cache: CustomerCache;
  triggerOnDrawerOpen: () => void;
  triggerManualRefresh: () => void;
  remountShell: () => void;
}

function CacheHarness({
  onReady,
  fetchFn,
}: {
  onReady: (api: HarnessAPI) => void;
  fetchFn: () => Promise<FetchResult>;
}) {
  // Mirrors `DetectionTabsShell`'s own `useState<CustomerCache>` —
  // initialised `idle`, never pre-seeded `loaded` from SSR scope (see
  // the wrapper's Reviewer Round 3 #1 comment).
  const [cache, setCache] = useState<CustomerCache>(() => ({
    status: "idle",
  }));
  const [shellRemountKey, setShellRemountKey] = useState(0);

  const runFetch = useCallback(async () => {
    setCache({ status: "loading" });
    try {
      const result = await fetchFn();
      if (result.ok) {
        setCache({
          status: "loaded",
          kind: result.kind,
          options: result.customers.map((c) => ({ id: c.id, name: c.name })),
        });
      } else {
        setCache({ status: "error" });
      }
    } catch {
      setCache({ status: "error" });
    }
  }, [fetchFn]);

  // Drawer-open path: only fetch when the cache says we should. This
  // is the contract `DetectionShell` relies on at the two open-drawer
  // call sites — a `loaded` cache is a no-op.
  const triggerOnDrawerOpen = useCallback(() => {
    if (shouldTriggerCustomerFetch(cache)) {
      void runFetch();
    }
  }, [cache, runFetch]);

  // Manual `↻` refresh path — always re-fetches.
  const triggerManualRefresh = useCallback(() => {
    void runFetch();
  }, [runFetch]);

  const remountShell = useCallback(() => {
    setShellRemountKey((k) => k + 1);
  }, []);

  onReady({
    cache,
    triggerOnDrawerOpen,
    triggerManualRefresh,
    remountShell,
  });

  return <div data-testid="harness" data-shell-key={shellRemountKey} />;
}

function flushAsync() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DetectionTabsShell customer cache lifecycle", () => {
  it("starts idle (page entry does not fetch)", () => {
    const fetchFn = vi.fn();
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <CacheHarness
        fetchFn={fetchFn}
        onReady={(a) => {
          if (!ref.current) ref.current = a;
        }}
      />,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.cache.status).toBe("idle");
    expect(fetchFn).toHaveBeenCalledTimes(0);
  });

  it("first drawer open issues exactly one fetch and lands on loaded", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      kind: "assigned",
      customers: [{ id: 1, name: "Acme" }],
    });
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <CacheHarness
        fetchFn={fetchFn}
        onReady={(a) => {
          ref.current = a;
        }}
      />,
    );
    await act(async () => {
      ref.current?.triggerOnDrawerOpen();
    });
    await flushAsync();
    expect(ref.current?.cache.status).toBe("loaded");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("second drawer open with a loaded cache does NOT refetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      kind: "assigned",
      customers: [{ id: 1, name: "Acme" }],
    });
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <CacheHarness
        fetchFn={fetchFn}
        onReady={(a) => {
          ref.current = a;
        }}
      />,
    );
    await act(async () => {
      ref.current?.triggerOnDrawerOpen();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Open the drawer again — the cache is loaded so the open-drawer
    // path must short-circuit and NOT fetch again. This is the
    // page-session-shared cache contract from #384.
    await act(async () => {
      ref.current?.triggerOnDrawerOpen();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a sibling shell remount under the same wrapper does NOT discard the cache", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      kind: "assigned",
      customers: [{ id: 1, name: "Acme" }],
    });
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <CacheHarness
        fetchFn={fetchFn}
        onReady={(a) => {
          ref.current = a;
        }}
      />,
    );
    await act(async () => {
      ref.current?.triggerOnDrawerOpen();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Simulate a tab-switch / new-tab event: the shell child remounts
    // (incremented key), but the wrapper's `customerCache` state is
    // unchanged.
    await act(async () => {
      ref.current?.remountShell();
    });
    expect(ref.current?.cache.status).toBe("loaded");
    // The freshly mounted shell would call `triggerOnDrawerOpen` on
    // its first drawer open. Because the cache is `loaded`, no fetch
    // fires.
    await act(async () => {
      ref.current?.triggerOnDrawerOpen();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("manual refresh always re-fetches and replaces the cached options", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        kind: "assigned",
        customers: [{ id: 1, name: "Acme" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        kind: "assigned",
        customers: [
          { id: 1, name: "Acme" },
          { id: 2, name: "Beta" },
        ],
      });
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <CacheHarness
        fetchFn={fetchFn}
        onReady={(a) => {
          ref.current = a;
        }}
      />,
    );
    await act(async () => {
      ref.current?.triggerOnDrawerOpen();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Manual `↻` — always re-fetches even though the cache is
    // `loaded`. The shell's `↻` button passes through
    // `triggerCustomerFetch` directly, not via
    // `shouldTriggerCustomerFetch`.
    await act(async () => {
      ref.current?.triggerManualRefresh();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const finalCache = ref.current?.cache;
    expect(finalCache?.status).toBe("loaded");
    if (finalCache?.status === "loaded") {
      expect(finalCache.options.map((o) => o.id)).toEqual([1, 2]);
    }
  });

  it("a fresh wrapper mount discards the cache (page-remount contract)", () => {
    // Two independent mounts of the harness simulate "navigate away
    // and come back to the Detection page" — each new mount starts
    // with its own `useState({ status: "idle" })`. This is the
    // contract behind "page remount → next drawer-open refetches".
    const fetchFn = vi.fn();
    const firstRef: { current: HarnessAPI | null } = { current: null };
    const secondRef: { current: HarnessAPI | null } = { current: null };
    const first = render(
      <CacheHarness
        fetchFn={fetchFn}
        onReady={(a) => {
          if (!firstRef.current) firstRef.current = a;
        }}
      />,
    );
    first.unmount();
    render(
      <CacheHarness
        fetchFn={fetchFn}
        onReady={(a) => {
          if (!secondRef.current) secondRef.current = a;
        }}
      />,
    );
    expect(secondRef.current).not.toBeNull();
    expect(secondRef.current?.cache.status).toBe("idle");
  });
});

describe("shouldTriggerCustomerFetch / customerStateForCache", () => {
  it("shouldTriggerCustomerFetch returns true only for idle and error", () => {
    expect(shouldTriggerCustomerFetch({ status: "idle" })).toBe(true);
    expect(shouldTriggerCustomerFetch({ status: "error" })).toBe(true);
    expect(shouldTriggerCustomerFetch({ status: "loading" })).toBe(false);
    expect(
      shouldTriggerCustomerFetch({
        status: "loaded",
        kind: "assigned",
        options: [],
      }),
    ).toBe(false);
  });

  it("customerStateForCache maps cache status onto the multi-select UI state", () => {
    expect(customerStateForCache({ status: "idle" })).toBe("loading");
    expect(customerStateForCache({ status: "loading" })).toBe("loading");
    expect(
      customerStateForCache({
        status: "loaded",
        kind: "assigned",
        options: [],
      }),
    ).toBe("ready");
    expect(customerStateForCache({ status: "error" })).toBe("error");
  });
});
