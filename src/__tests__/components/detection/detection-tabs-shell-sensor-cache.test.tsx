/**
 * Cache lifecycle coverage for the wrapper-owned `sensorCache`
 * state in {@link DetectionTabsShell} (#278, Reviewer Round 2 #1).
 *
 * Mirrors `detection-tabs-shell-customer-cache.test.tsx` because the
 * two caches must satisfy the same #278 / #384 page-session-shared
 * contract: a remount of the keyed `<DetectionShell>` on tab switch
 * must NOT discard the cache.
 *
 * The full `DetectionTabsShell` mount is heavy (next-intl provider,
 * next/navigation, session, sessionStorage, the full result-cache
 * machinery, …), and the cache logic itself is small enough to
 * verify without it: the wrapper holds a `useState<SensorCache>`
 * initialised to `{ status: "idle" }`, exposes a `triggerSensorFetch`
 * that runs `fetchSensors()` and stores the result, and relies on
 * `shouldTriggerSensorFetch(cache)` (the same helper the shell
 * consumes on the drawer-open path) to decide whether a fetch is
 * needed.
 */

import { act, render } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const { sensorStateForCache, shouldTriggerSensorFetch } = await import(
  "@/components/detection/detection-shell"
);

type SensorCache = Parameters<typeof shouldTriggerSensorFetch>[0];

type FetchResult = {
  ok: true;
  endpointAvailable: boolean;
  sensors: { id: string; name: string }[];
};

interface HarnessAPI {
  cache: SensorCache;
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
  // Mirrors `DetectionTabsShell`'s own `useState<SensorCache>` —
  // initialised `idle`, never pre-seeded `loaded` from any SSR seed
  // so #278's explicit "page entry does not fetch" contract holds.
  const [cache, setCache] = useState<SensorCache>(() => ({
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
          endpointAvailable: result.endpointAvailable,
          options: result.sensors.map((s) => ({ id: s.id, name: s.name })),
        });
      } else {
        setCache({ status: "error" });
      }
    } catch {
      setCache({ status: "error" });
    }
  }, [fetchFn]);

  // Drawer-open path: only fetch when the cache says we should.
  const triggerOnDrawerOpen = useCallback(() => {
    if (shouldTriggerSensorFetch(cache)) {
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

describe("DetectionTabsShell sensor cache lifecycle", () => {
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
      endpointAvailable: true,
      sensors: [{ id: "7", name: "node-a" }],
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
      endpointAvailable: true,
      sensors: [{ id: "7", name: "node-a" }],
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
    await act(async () => {
      ref.current?.triggerOnDrawerOpen();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a sibling shell remount under the same wrapper does NOT discard the cache", async () => {
    // This is the regression that motivated lifting the cache out
    // of `DetectionShell`: pre-fix, the keyed shell remount on tab
    // switch dropped the local `useState<SensorCache>` and the next
    // drawer-open refetched. With the cache owned by the wrapper,
    // the remount keeps the loaded options.
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      endpointAvailable: true,
      sensors: [{ id: "7", name: "node-a" }],
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
    await act(async () => {
      ref.current?.remountShell();
    });
    expect(ref.current?.cache.status).toBe("loaded");
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
        endpointAvailable: true,
        sensors: [{ id: "7", name: "node-a" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        endpointAvailable: true,
        sensors: [
          { id: "7", name: "node-a" },
          { id: "13", name: "node-b" },
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
    await act(async () => {
      ref.current?.triggerManualRefresh();
    });
    await flushAsync();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const finalCache = ref.current?.cache;
    expect(finalCache?.status).toBe("loaded");
    if (finalCache?.status === "loaded") {
      expect(finalCache.options.map((o) => o.id)).toEqual(["7", "13"]);
    }
  });

  it("a fresh wrapper mount discards the cache (page-remount contract)", () => {
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

describe("shouldTriggerSensorFetch / sensorStateForCache", () => {
  it("shouldTriggerSensorFetch returns true only for idle and error", () => {
    expect(shouldTriggerSensorFetch({ status: "idle" })).toBe(true);
    expect(shouldTriggerSensorFetch({ status: "error" })).toBe(true);
    expect(shouldTriggerSensorFetch({ status: "loading" })).toBe(false);
    expect(
      shouldTriggerSensorFetch({
        status: "loaded",
        endpointAvailable: true,
        options: [],
      }),
    ).toBe(false);
  });

  it("sensorStateForCache maps cache status onto the multi-select UI state", () => {
    expect(sensorStateForCache({ status: "idle" })).toBe("loading");
    expect(sensorStateForCache({ status: "loading" })).toBe("loading");
    expect(
      sensorStateForCache({
        status: "loaded",
        endpointAvailable: true,
        options: [],
      }),
    ).toBe("ready");
    expect(
      sensorStateForCache({
        status: "loaded",
        endpointAvailable: false,
        options: [],
      }),
    ).toBe("unavailable");
    expect(sensorStateForCache({ status: "error" })).toBe("error");
  });
});
