/**
 * Regression coverage for #393 Task D Reviewer Round 1: the cache-hit
 * probe must gate paint inside the drawer, not just fire alongside it.
 *
 * The first iteration of the fix opened the drawer with a `loaded`
 * sensor cache and *then* fired `probeAuthOrRedirect` asynchronously,
 * so the drawer's `sensorOptions` (derived from
 * `sensorCache.status === "loaded"`) painted last-fetch sensor names
 * before `/api/auth/me` had a chance to return 401. The fix flips a
 * `sensorCacheVerifying` flag synchronously in the same event-handler
 * tick as `setDrawerOpen(true)`, and the render path overrides the
 * drawer's `sensorOptions` / `sensorState` to the loading
 * placeholder until the probe resolves.
 *
 * The full `DetectionShell` mount is heavy (next-intl, lucide, the
 * full result-cache machinery, …). We mirror the cache + verifying
 * state in a thin harness — the same pattern
 * `detection-tabs-shell-customer-cache.test.tsx` uses to lock the
 * customer cache contract — so the assertions exercise the exact
 * sequencing the fix relies on (verifying flips synchronously with
 * drawer-open, drops in the probe's `.finally`, and the override
 * suppresses the cache while it's true).
 */

import { act, render } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const probeAuthOrRedirectMock =
  vi.fn<(onUnauthorized?: () => void) => Promise<boolean>>();

vi.mock("@/lib/auth/probe-auth", () => ({
  probeAuthOrRedirect: (onUnauthorized?: () => void) =>
    probeAuthOrRedirectMock(onUnauthorized),
}));

const { sensorStateForCache, shouldTriggerSensorFetch } = await import(
  "@/components/detection/detection-shell"
);

type SensorCache = Parameters<typeof sensorStateForCache>[0];

interface HarnessAPI {
  cache: SensorCache;
  verifying: boolean;
  drawerOpen: boolean;
  drawerSensorOptions: readonly { id: string; name: string }[];
  drawerSensorState: ReturnType<typeof sensorStateForCache>;
  openDrawer: () => void;
  setLoadedCache: (options: { id: string; name: string }[]) => void;
}

/**
 * Mirrors the sensor cache + drawer-open + verifying logic in
 * `DetectionShell.openDrawer` / `openDrawerFocused`. The harness is
 * intentionally minimal — it keeps the contract under test (verifying
 * flips synchronously with drawer open, render path overrides the
 * cached options to a loading placeholder, probe `.finally` resets
 * verifying, and the 401 callback drops the cache to `idle`) without
 * pulling in the rest of the shell's render tree.
 */
function SensorCacheHarness({
  onReady,
}: {
  onReady: (api: HarnessAPI) => void;
}) {
  const [cache, setCache] = useState<SensorCache>({ status: "idle" });
  const [verifying, setVerifying] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const setLoadedCache = useCallback(
    (options: { id: string; name: string }[]) => {
      setCache({ status: "loaded", endpointAvailable: true, options });
    },
    [],
  );

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    if (shouldTriggerSensorFetch(cache)) {
      // Mirrors `triggerSensorFetch` — first-open path is not the
      // surface under test here, so we just transition to loading
      // and let the test fixture decide what comes next.
      setCache({ status: "loading" });
      return;
    }
    setVerifying(true);
    void probeAuthOrRedirectMock(() => {
      setCache({ status: "idle" });
    }).finally(() => {
      setVerifying(false);
    });
  }, [cache]);

  const drawerSensorOptions = verifying
    ? []
    : cache.status === "loaded"
      ? cache.options
      : [];
  const drawerSensorState = verifying ? "loading" : sensorStateForCache(cache);

  onReady({
    cache,
    verifying,
    drawerOpen,
    drawerSensorOptions,
    drawerSensorState,
    openDrawer,
    setLoadedCache,
  });

  return null;
}

function flushAsync() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("sensor cache reopen probe — Reviewer Round 1 (#393 Task D)", () => {
  beforeEach(() => {
    probeAuthOrRedirectMock.mockReset();
  });

  afterEach(() => {
    probeAuthOrRedirectMock.mockReset();
  });

  it("renders the drawer in `loading` state with no options while the probe is in flight", async () => {
    // Hold the probe pending so we can observe the verifying window.
    let resolveProbe: ((ok: boolean) => void) | null = null;
    probeAuthOrRedirectMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <SensorCacheHarness
        onReady={(a) => {
          ref.current = a;
        }}
      />,
    );
    act(() => {
      ref.current?.setLoadedCache([
        { id: "s1", name: "Acme HQ Sensor" },
        { id: "s2", name: "Acme DR Sensor" },
      ]);
    });
    expect(ref.current?.cache.status).toBe("loaded");
    expect(ref.current?.drawerSensorOptions.map((o) => o.name)).toEqual([
      "Acme HQ Sensor",
      "Acme DR Sensor",
    ]);
    // Open the drawer — the verifying flag must flip in the same
    // tick as `setDrawerOpen(true)` so the very first render that
    // sees `drawerOpen: true` already has the override applied. The
    // bug the reviewer flagged is exactly the case where this
    // assertion fails (verifying=false + drawerOpen=true would let
    // the loaded options paint).
    act(() => {
      ref.current?.openDrawer();
    });
    expect(probeAuthOrRedirectMock).toHaveBeenCalledTimes(1);
    expect(ref.current?.drawerOpen).toBe(true);
    expect(ref.current?.verifying).toBe(true);
    expect(ref.current?.drawerSensorState).toBe("loading");
    expect(ref.current?.drawerSensorOptions).toEqual([]);
    // Resolve the probe with OK; verifying drops and the cached
    // payload paints.
    await act(async () => {
      resolveProbe?.(true);
    });
    await flushAsync();
    expect(ref.current?.verifying).toBe(false);
    expect(ref.current?.drawerSensorState).toBe("ready");
    expect(ref.current?.drawerSensorOptions.map((o) => o.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("does not surface a loaded cache when the probe returns 401", async () => {
    // Drive the probe through the production-shape callback: on 401
    // the helper invokes `onUnauthorized` (which clears our cache to
    // `idle`) and resolves to `false`. The drawer must end up in the
    // `loading` state with no options — never the loaded payload.
    probeAuthOrRedirectMock.mockImplementation((onUnauthorized) => {
      onUnauthorized?.();
      return Promise.resolve(false);
    });
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <SensorCacheHarness
        onReady={(a) => {
          ref.current = a;
        }}
      />,
    );
    act(() => {
      ref.current?.setLoadedCache([
        { id: "s1", name: "Stale Customer A Sensor" },
      ]);
    });
    expect(ref.current?.cache.status).toBe("loaded");
    await act(async () => {
      ref.current?.openDrawer();
    });
    await flushAsync();
    // The cache was dropped to `idle` by the 401 callback (mirrors
    // the production `setSensorCache({ status: "idle" })` clear),
    // verifying flipped back via `.finally`, and the drawer's
    // sensor state computes from the cleared cache.
    expect(ref.current?.cache.status).toBe("idle");
    expect(ref.current?.verifying).toBe(false);
    expect(ref.current?.drawerSensorState).toBe("loading");
    expect(ref.current?.drawerSensorOptions).toEqual([]);
  });

  it("first-open with an idle cache does not call the probe (probe is reopen-only)", () => {
    // The probe gates *cache reuse*. The first open against an idle
    // cache fetches fresh data instead, so there is no cached
    // payload to validate; firing the probe here would multiply
    // unrelated `/api/auth/me` traffic on every fresh page.
    probeAuthOrRedirectMock.mockResolvedValue(true);
    const ref: { current: HarnessAPI | null } = { current: null };
    render(
      <SensorCacheHarness
        onReady={(a) => {
          ref.current = a;
        }}
      />,
    );
    act(() => {
      ref.current?.openDrawer();
    });
    expect(probeAuthOrRedirectMock).not.toHaveBeenCalled();
    expect(ref.current?.cache.status).toBe("loading");
    expect(ref.current?.verifying).toBe(false);
  });
});
