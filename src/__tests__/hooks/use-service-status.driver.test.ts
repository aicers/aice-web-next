/**
 * Driver-lifecycle test for `useExternalServiceProbes`.
 *
 * Round-5 regression (#313): when the external probe driver mounts on
 * a tab that is already hidden, the bootstrap `setTimeout` bails out
 * before arming any timers. Without a `visibilitychange` resume path,
 * the loop never starts and every Giganto / Tivan badge stays on
 * `unknown` (rendered as `Off`) for the rest of the session. The node-
 * status poller already solved this exact mounted-hidden case in
 * `use-node-status-polling.ts` — the external probe driver now matches.
 *
 * The test bypasses `@testing-library/react` (which the project does
 * not ship): React's runtime is stubbed with a captured-effect shim,
 * `document` / `window` are stubbed, and the actual production hook is
 * imported and exercised so the assertions cover the real driver path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── React mock that captures effect callbacks ────────────────────

interface CapturedEffect {
  cb: () => (() => void) | undefined;
  cleanup: (() => void) | undefined;
}
const captured: CapturedEffect[] = [];

vi.mock("react", () => {
  const refBag: { current: unknown }[] = [];
  let refIndex = 0;
  return {
    useRef: (initial: unknown) => {
      const idx = refIndex++;
      if (refBag[idx] === undefined) refBag[idx] = { current: initial };
      return refBag[idx] as { current: unknown };
    },
    useMemo: <T>(fn: () => T) => fn(),
    useEffect: (cb: () => (() => void) | undefined) => {
      captured.push({ cb, cleanup: undefined });
    },
    useSyncExternalStore: (
      _subscribe: (l: () => void) => () => void,
      getSnap: () => unknown,
    ) => getSnap(),
  };
});

// ── Document / visibility / fetch stubs ──────────────────────────

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

vi.stubGlobal("window", {});

let fetchCallCount = 0;
const fetchStub = vi.fn(async () => {
  fetchCallCount += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  } as unknown as Response;
});
vi.stubGlobal("fetch", fetchStub);

async function runAllEffects(): Promise<void> {
  for (const eff of captured) {
    if (!eff.cleanup) {
      eff.cleanup = eff.cb() ?? undefined;
    }
  }
  await vi.advanceTimersByTimeAsync(0);
}

function teardownEffects(): void {
  while (captured.length > 0) {
    const e = captured.pop();
    if (e?.cleanup) e.cleanup();
  }
}

describe("useExternalServiceProbes — mounted-hidden visibility resume", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchCallCount = 0;
    fetchStub.mockClear();
    docListeners.clear();
    visibilityState = "visible";
    captured.length = 0;
    const mod = await import("@/hooks/use-service-status");
    mod.__resetExternalProbeStore();
  });

  afterEach(() => {
    teardownEffects();
    vi.useRealTimers();
  });

  it("does NOT arm probes while the tab is hidden, then fires the first probes when the tab becomes visible", async () => {
    const probeMs = 10_000;
    visibilityState = "hidden";

    const mod = await import("@/hooks/use-service-status");
    mod.useExternalServiceProbes({ probeIntervalMs: probeMs });
    await runAllEffects();

    // Mounted-hidden bootstrap: no probe should have run.
    expect(fetchCallCount).toBe(0);

    // Advance well past several intervals while still hidden — without
    // the visibility resume path the loop is permanently inert.
    await vi.advanceTimersByTimeAsync(probeMs * 3);
    expect(fetchCallCount).toBe(0);

    // Reveal the tab. The visibility handler kicks the loop off; the
    // staggered first dispatches land on the next macrotask, then each
    // probe runs on its own cadence.
    visibilityState = "visible";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    // Stagger window for two kinds at probeMs cadence is `floor(probeMs / 2)`.
    await vi.advanceTimersByTimeAsync(probeMs / 2);
    expect(fetchCallCount).toBeGreaterThanOrEqual(2);

    // Hiding again pauses the loop — no further probes land.
    const seen = fetchCallCount;
    visibilityState = "hidden";
    fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(probeMs * 2);
    expect(fetchCallCount).toBe(seen);
  });
});
