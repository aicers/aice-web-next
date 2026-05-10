/**
 * Driver-lifecycle tests for `useNodeStatusPolling`.
 *
 * The hook reads `document.visibilityState`, listens for
 * `visibilitychange`, and uses `setInterval`/`setTimeout` plus a global
 * `fetch`. We exercise the driver by stubbing those globals with
 * vitest fakes; the hook itself is invoked with a mocked React shim
 * that captures the effect callbacks for synchronous replay (matching
 * the pattern in `use-session-monitor.test.ts`). This isolates the
 * acceptance criteria — visibility pause, resume one-shot,
 * no-backfill, isStale — from React's runtime scheduling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── React mock that captures effect callbacks ────────────────────

interface CapturedEffect {
  cb: () => (() => void) | undefined;
  cleanup: (() => void) | undefined;
}
const captured: CapturedEffect[] = [];

vi.mock("react", () => {
  const stateBag: unknown[] = [];
  const refBag: { current: unknown }[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let storeSubscriber: (() => void) | null = null;
  let storeSnapshot: unknown = null;

  return {
    useState: (initial: unknown) => {
      const idx = stateIndex++;
      const resolved =
        typeof initial === "function" ? (initial as () => unknown)() : initial;
      if (stateBag[idx] === undefined) stateBag[idx] = resolved;
      return [
        stateBag[idx],
        (v: unknown) => {
          stateBag[idx] =
            typeof v === "function"
              ? (v as (p: unknown) => unknown)(stateBag[idx])
              : v;
        },
      ] as const;
    },
    useRef: (initial: unknown) => {
      const idx = refIndex++;
      if (refBag[idx] === undefined) refBag[idx] = { current: initial };
      const ref = refBag[idx] as { current: unknown };
      return ref;
    },
    useCallback: (fn: (...args: unknown[]) => unknown) => fn,
    useMemo: <T>(fn: () => T) => fn(),
    useEffect: (cb: () => (() => void) | undefined) => {
      captured.push({ cb, cleanup: undefined });
    },
    useSyncExternalStore: (
      subscribe: (l: () => void) => () => void,
      getSnap: () => unknown,
    ) => {
      storeSubscriber = () => {
        storeSnapshot = getSnap();
      };
      storeSnapshot = getSnap();
      subscribe(() => {
        if (storeSubscriber) storeSubscriber();
      });
      return storeSnapshot;
    },
    useContext: () => ({}),
  };
});

// ── Document / visibility stubs ───────────────────────────────────

let visibilityState: "visible" | "hidden" = "visible";
const docListeners = new Map<string, Set<() => void>>();

vi.stubGlobal("document", {
  get visibilityState() {
    return visibilityState;
  },
  addEventListener: (event: string, cb: () => void) => {
    if (!docListeners.has(event)) docListeners.set(event, new Set());
    docListeners.get(event)?.add(cb);
  },
  removeEventListener: (event: string, cb: () => void) => {
    docListeners.get(event)?.delete(cb);
  },
});

function fireVisibilityChange(): void {
  for (const cb of docListeners.get("visibilitychange") ?? []) cb();
}

// `window` needs `addEventListener` / `removeEventListener` for the
// polling driver's `focus` probe and `location.assign` for the probe-
// auth helper's redirect on 401 (#393 Task E). Listeners are captured
// here so tests can simulate a focus regain by calling
// `fireWindowFocus()`; the location spy lets us assert the sign-in
// redirect fired.
const windowListeners = new Map<string, Set<() => void>>();
const locationAssign = vi.fn();

vi.stubGlobal("window", {
  addEventListener: (event: string, cb: () => void) => {
    if (!windowListeners.has(event)) windowListeners.set(event, new Set());
    windowListeners.get(event)?.add(cb);
  },
  removeEventListener: (event: string, cb: () => void) => {
    windowListeners.get(event)?.delete(cb);
  },
  location: { assign: locationAssign },
});

function fireWindowFocus(): void {
  for (const cb of windowListeners.get("focus") ?? []) cb();
}

// ── Fetch stub ────────────────────────────────────────────────────

let fetchCallCount = 0;
type FetchScript =
  | { kind: "ok"; capturedAt: string; edges: unknown[] }
  | { kind: "status"; status: number }
  | {
      kind: "deferred";
      gate: Promise<{ capturedAt: string; edges: unknown[] }>;
    };
const fetchScript: FetchScript[] = [];
function pushFetchResponse(capturedAt: Date): void {
  fetchScript.push({
    kind: "ok",
    capturedAt: capturedAt.toISOString(),
    edges: [],
  });
}
function pushFetchStatus(status: number): void {
  fetchScript.push({ kind: "status", status });
}
/**
 * Push a fetch response that does NOT resolve until the returned
 * resolver is invoked. Lets a test pin a fetch in mid-flight so it can
 * advance the polling interval and assert no second fetch starts.
 */
function pushDeferredFetchResponse(): {
  resolve: (capturedAt: Date) => void;
} {
  let resolveOuter: (v: { capturedAt: string; edges: unknown[] }) => void;
  const gate = new Promise<{ capturedAt: string; edges: unknown[] }>(
    (resolve) => {
      resolveOuter = resolve;
    },
  );
  fetchScript.push({ kind: "deferred", gate });
  return {
    resolve: (capturedAt: Date) => {
      resolveOuter({ capturedAt: capturedAt.toISOString(), edges: [] });
    },
  };
}

const fetchStub = vi.fn(async () => {
  fetchCallCount += 1;
  const next = fetchScript.shift() ?? {
    kind: "ok" as const,
    capturedAt: new Date().toISOString(),
    edges: [],
  };
  if (next.kind === "status") {
    return {
      ok: false,
      status: next.status,
      json: async () => ({ error: "stub" }),
    };
  }
  if (next.kind === "deferred") {
    const payload = await next.gate;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ capturedAt: next.capturedAt, edges: next.edges }),
  };
});

vi.stubGlobal("fetch", fetchStub);

// ── Driver lifecycle helpers ──────────────────────────────────────

async function runAllEffects(): Promise<void> {
  for (const eff of captured) {
    if (!eff.cleanup) {
      eff.cleanup = eff.cb() ?? undefined;
    }
  }
  // Allow the debounce setTimeout(0) to run.
  await vi.advanceTimersByTimeAsync(0);
}

function teardownEffects(): void {
  while (captured.length > 0) {
    const e = captured.pop();
    if (e?.cleanup) e.cleanup();
  }
}

describe("useNodeStatusPolling — driver lifecycle", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchCallCount = 0;
    fetchScript.length = 0;
    docListeners.clear();
    windowListeners.clear();
    visibilityState = "visible";
    fetchStub.mockClear();
    locationAssign.mockClear();
    captured.length = 0;
    const mod = await import("@/hooks/use-node-status-polling");
    mod.__resetNodeStatusStore();
    // Reset module-level state in `probe-auth` so the post-success
    // debounce and the one-shot redirect latch from earlier tests do
    // not bleed into this one.
    const probe = await import("@/lib/auth/probe-auth");
    probe.__resetProbeAuthForTests();
  });

  afterEach(() => {
    teardownEffects();
    vi.useRealTimers();
  });

  it("does NOT fetch on mount, then issues a one-shot fetch when visibility flips hidden → visible", async () => {
    const pollMs = 10_000;
    const { useNodeStatusPolling } = await import(
      "@/hooks/use-node-status-polling"
    );
    useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    // Acceptance: the SSR pages under /nodes already issued a
    // `getNodeStatusList()` for their first paint, so the bootstrap
    // must NOT issue a duplicate client fetch. The first client poll
    // happens at the first pollMs boundary.
    expect(fetchCallCount).toBe(0);

    // First interval boundary lands the first fetch.
    pushFetchResponse(new Date());
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(fetchCallCount).toBe(1);

    // Tab hides — interval cleared, no new fetches even after time passes.
    visibilityState = "hidden";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(pollMs * 3);
    const fetchCountWhileHidden = fetchCallCount;
    expect(fetchCountWhileHidden).toBe(1);

    // Tab returns — exactly one one-shot fetch lands before the next
    // pollMs tick. We advance by less than pollMs so the regular
    // interval cannot fire; only the one-shot path can have run.
    pushFetchResponse(new Date());
    visibilityState = "visible";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(pollMs / 2);
    expect(fetchCallCount).toBe(fetchCountWhileHidden + 1);

    // The regular cadence resumes after the one-shot — at least one
    // more fetch lands once we cross the pollMs boundary. (Asserting
    // ≥, not equality, avoids coupling to the fake-timer's exact
    // microtask interleaving when the interval boundary is crossed.)
    pushFetchResponse(new Date());
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(fetchCallCount).toBeGreaterThanOrEqual(fetchCountWhileHidden + 2);
  });

  it("flips isManagerUnreachable on a 503 mid-session and clears it on recovery", async () => {
    const pollMs = 10_000;
    pushFetchResponse(new Date());
    const mod = await import("@/hooks/use-node-status-polling");
    mod.useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    // First poll lands at the first interval boundary — manager is
    // reachable.
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(mod.__getNodeStatusSnapshot().isManagerUnreachable).toBe(false);

    // Next poll returns 503 (manager dropped post-paint). The driver
    // should flag manager-unreachable so the table swaps to the
    // fallback panel mid-session rather than freezing on the last
    // snapshot.
    pushFetchStatus(503);
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(mod.__getNodeStatusSnapshot().isManagerUnreachable).toBe(true);

    // A subsequent successful poll clears the flag — the panel
    // disappears and the table resumes rendering rows.
    pushFetchResponse(new Date());
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(mod.__getNodeStatusSnapshot().isManagerUnreachable).toBe(false);
  });

  it("flips isStale to true after 2x pollIntervalMs without a new sample", async () => {
    const pollMs = 5_000;
    pushFetchResponse(new Date());
    const mod = await import("@/hooks/use-node-status-polling");
    mod.useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    // Land the first sample at the first interval boundary so the
    // stale detector has a `capturedAt` to anchor on; otherwise it
    // takes the no-sample-yet path which is exercised elsewhere.
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(mod.__getNodeStatusSnapshot().isStale).toBe(false);

    // Hide so no further fetches land, then advance past 2x pollMs.
    visibilityState = "hidden";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(2 * pollMs + 1_500);

    expect(mod.__getNodeStatusSnapshot().isStale).toBe(true);
  });

  it("does NOT start the interval when the page mounts while the tab is already hidden", async () => {
    // Acceptance: hidden tabs pause polling and `data-polling`
    // reflects real state. The previous bootstrap unconditionally
    // called `startInterval()` after the mount-debounce setTimeout,
    // which set `isPolling=true` even when the tab was already
    // hidden — and because no visible→hidden transition ever
    // happened, the visibilitychange handler never got the chance
    // to stop it. This test pins the corrected behaviour.
    const pollMs = 10_000;
    visibilityState = "hidden";
    const mod = await import("@/hooks/use-node-status-polling");
    mod.useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    // No fetch on mount and `isPolling=false` while hidden.
    expect(fetchCallCount).toBe(0);
    expect(mod.__getNodeStatusSnapshot().isPolling).toBe(false);

    // Advancing past several intervals while still hidden must not
    // produce any fetch — the interval was never armed.
    await vi.advanceTimersByTimeAsync(pollMs * 3);
    expect(fetchCallCount).toBe(0);
    expect(mod.__getNodeStatusSnapshot().isPolling).toBe(false);

    // When the tab finally becomes visible, the visibilitychange
    // handler kicks the loop off — one immediate fetch and
    // `isPolling=true` from then on.
    pushFetchResponse(new Date());
    visibilityState = "visible";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCallCount).toBe(1);
    expect(mod.__getNodeStatusSnapshot().isPolling).toBe(true);
  });

  it("skips a tick while a previous fetch is still in flight, instead of self-cancelling", async () => {
    // Acceptance: a slow but healthy poll must not be aborted by the
    // next interval boundary. Pin one fetch in mid-flight, advance
    // through several `pollMs` boundaries, and assert no second fetch
    // ever starts; once the in-flight fetch resolves, `applySample()`
    // runs and the buffer carries the sample.
    const pollMs = 10_000;
    const deferred = pushDeferredFetchResponse();
    const mod = await import("@/hooks/use-node-status-polling");
    mod.useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    // No fetch on mount — the SSR pages already issued one. The first
    // client fetch lands at the first interval boundary and pulls the
    // deferred response, which stays in flight until we resolve it.
    expect(fetchCallCount).toBe(0);
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(fetchCallCount).toBe(1);

    // Cross several interval boundaries while the first fetch hangs —
    // the previous behaviour aborted the in-flight fetch and started a
    // new one each time, leaving the UI permanently stale on a
    // deployment where the fetch outruns `pollMs`. The new behaviour
    // skips while in-flight, so the count stays at 1.
    await vi.advanceTimersByTimeAsync(pollMs * 3);
    expect(fetchCallCount).toBe(1);
    expect(mod.__getNodeStatusSnapshot().capturedAt).toBeNull();

    // Resolve the deferred fetch — `applySample()` must finally land,
    // and the next interval tick can now start a fresh fetch.
    deferred.resolve(new Date());
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.__getNodeStatusSnapshot().capturedAt).not.toBeNull();

    pushFetchResponse(new Date());
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(fetchCallCount).toBeGreaterThanOrEqual(2);
  });

  it("clears the per-node buffer when the last driver unmounts", async () => {
    // Acceptance: returning to /nodes after leaving the area must
    // not surface a stale module-level snapshot — the SSR-rendered
    // snapshot drives the first paint, and the buffer is rebuilt
    // from polling samples afterwards.
    const pollMs = 10_000;
    pushFetchResponse(new Date());
    const mod = await import("@/hooks/use-node-status-polling");
    mod.useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    // Land the first sample at the first interval boundary so the
    // buffer carries something before we tear the driver down.
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(mod.__getNodeStatusSnapshot().capturedAt).not.toBeNull();

    // Last driver unmounts (the cleanup path runs).
    teardownEffects();

    // Buffer is cleared back to its initial-empty state, so the next
    // mount's `polling.capturedAt === null` fallback re-uses the
    // fresh SSR snapshot rather than the stale module-level one.
    const after = mod.__getNodeStatusSnapshot();
    expect(after.capturedAt).toBeNull();
    expect(after.isPolling).toBe(false);
    expect(after.isStale).toBe(false);
    expect(after.isManagerUnreachable).toBe(false);
    expect(mod.__getNodeStatusStoreForTests().byNodeId.size).toBe(0);
  });

  it("routes a 401 from the polling fetch through the probe-auth helper (#393 Task E)", async () => {
    // Acceptance: a `token_version` mismatch surfacing as 401 from
    // `/api/nodes/status` must NOT be swallowed by the polling loop's
    // transient-error path. The buffer must clear and the operator
    // must be redirected through sign-in so the rolling per-node
    // samples don't keep painting customer data the caller no longer
    // has access to.
    const pollMs = 10_000;
    pushFetchResponse(new Date());
    const mod = await import("@/hooks/use-node-status-polling");
    mod.useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    // First sample lands so the buffer carries something we expect to
    // be cleared on the 401.
    await vi.advanceTimersByTimeAsync(pollMs);
    expect(mod.__getNodeStatusSnapshot().capturedAt).not.toBeNull();

    // Next poll comes back 401; the probe-auth helper then issues a
    // GET to `/api/auth/me` which also lands on the same fetch stub —
    // make it return 401 so the redirect path fires.
    pushFetchStatus(401); // /api/nodes/status
    pushFetchStatus(401); // /api/auth/me probe
    await vi.advanceTimersByTimeAsync(pollMs);
    // Drain the probe-auth fetch microtask + redirect.
    await vi.advanceTimersByTimeAsync(0);

    // Buffer cleared and redirect fired.
    const after = mod.__getNodeStatusSnapshot();
    expect(after.capturedAt).toBeNull();
    expect(mod.__getNodeStatusStoreForTests().byNodeId.size).toBe(0);
    expect(locationAssign).toHaveBeenCalledWith(
      "/sign-in?reason=session-ended",
    );
  });

  it("fires the probe on window.focus and clears the buffer on 401 (#393 Task E)", async () => {
    // Acceptance: refocusing the tab from another window — a path
    // `visibilitychange` does not always surface — must trigger the
    // shared probe and route a 401 through the same cache-clear +
    // redirect handler.
    const pollMs = 10_000;
    pushFetchResponse(new Date());
    const mod = await import("@/hooks/use-node-status-polling");
    mod.useNodeStatusPolling({ pollIntervalMs: pollMs });
    await runAllEffects();

    await vi.advanceTimersByTimeAsync(pollMs);
    expect(mod.__getNodeStatusSnapshot().capturedAt).not.toBeNull();

    // Focus probe sees a 401 from `/api/auth/me` — the only fetch the
    // focus handler issues. No `/api/nodes/status` call is needed
    // because the probe runs ahead of the next regular tick.
    pushFetchStatus(401);
    fireWindowFocus();
    await vi.advanceTimersByTimeAsync(0);

    expect(mod.__getNodeStatusSnapshot().capturedAt).toBeNull();
    expect(mod.__getNodeStatusStoreForTests().byNodeId.size).toBe(0);
    expect(locationAssign).toHaveBeenCalledWith(
      "/sign-in?reason=session-ended",
    );
  });
});
