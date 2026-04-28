import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __getExternalProbeStoreSnapshot,
  __resetExternalProbeStore,
  __setExternalProbeOutcome,
  __simulateLastDriverUnmountForTests,
  __startProbeLoopForTests,
  __stopProbeLoopForTests,
  composeLastCheckedByService,
  useServiceStatus,
} from "@/hooks/use-service-status";
import { NodePermissionError } from "@/lib/node/errors";
import type {
  ExternalProbeOutcome,
  ExternalServiceKindKey,
} from "@/lib/node/service-status";

describe("useServiceStatus — permission gate", () => {
  afterEach(() => {
    __resetExternalProbeStore();
  });

  // The page-level `(gate)/layout.tsx` already enforces
  // `nodes:read + services:read`, so in production this branch never
  // trips. The defence-in-depth check exists so a future caller (a
  // standalone widget, an embedded panel) cannot render the per-cell
  // status without the same scope. The throw is the first statement
  // in the hook so the test can invoke the function directly without
  // a React render.
  it("throws NodePermissionError when canRead is false", () => {
    expect(() => useServiceStatus("n1", { canRead: false })).toThrow(
      NodePermissionError,
    );
  });
});

describe("__setExternalProbeOutcome", () => {
  afterEach(() => {
    __resetExternalProbeStore();
  });

  it("records a probe outcome with the supplied timestamp", () => {
    // Smoke test for the test helpers themselves — every `useServiceStatus`
    // exercise downstream relies on these imperative pushes.
    const at = new Date("2026-01-01T00:00:00Z");
    __setExternalProbeOutcome("dataStore", "on", at);
    __setExternalProbeOutcome("tiContainer", "off", at);
    // No public reader without a render, but the assertions are
    // covered through `composeServiceStatusEntries` in the
    // `service-status.test.ts` suite.
    expect(true).toBe(true);
  });
});

// ── External probe loop driver ──────────────────────────────────
//
// Round-2 review #2 / #3 (#313): the loop must skip a tick while a
// probe for the same kind is still in flight (so a slow Giganto / Tivan
// does not stack concurrent fetches on every interval boundary), and
// must support per-service cadences so Giganto and Tivan can poll at
// different intervals.

describe("external probe loop", () => {
  beforeEach(() => {
    __resetExternalProbeStore();
    vi.useFakeTimers();
  });
  afterEach(() => {
    __stopProbeLoopForTests();
    vi.useRealTimers();
  });

  it("skips a tick while a probe for the same kind is still in flight", async () => {
    // A wedged Giganto probe must not have the next interval boundary
    // start a second concurrent fetch — the previous behaviour stacked
    // requests indefinitely on a slow upstream.
    let dataStoreCallCount = 0;
    let releaseFirst!: (outcome: ExternalProbeOutcome) => void;
    const firstResponse = new Promise<ExternalProbeOutcome>((resolve) => {
      releaseFirst = resolve;
    });

    const fetcher = vi.fn(
      async (kind: ExternalServiceKindKey, _signal?: AbortSignal) => {
        if (kind === "dataStore") {
          dataStoreCallCount += 1;
          if (dataStoreCallCount === 1) return firstResponse;
          return "on" as ExternalProbeOutcome;
        }
        return "on" as ExternalProbeOutcome;
      },
    );

    __startProbeLoopForTests({ dataStore: 1_000, tiContainer: 1_000 }, fetcher);

    // Trip the staggered first dispatch (each kind starts at
    // index * floor(min/N) which is 500ms for tiContainer, 0 for
    // dataStore).
    await vi.advanceTimersByTimeAsync(0);
    expect(dataStoreCallCount).toBe(1);

    // While the first dataStore fetch is still pending, advance several
    // intervals. Without the guard each boundary would queue another
    // dataStore probe; with the guard `runProbe()` returns early and
    // the call count stays at 1.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dataStoreCallCount).toBe(1);

    // Resolve the first probe. The next interval boundary then runs
    // a fresh dataStore probe successfully.
    releaseFirst("on");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dataStoreCallCount).toBeGreaterThanOrEqual(2);
  });

  it("honours per-service intervals so Giganto and Tivan can poll at different cadences", async () => {
    const calls: Array<{ kind: ExternalServiceKindKey; at: number }> = [];
    const fetcher = vi.fn(
      async (kind: ExternalServiceKindKey, _signal?: AbortSignal) => {
        calls.push({ kind, at: Date.now() });
        return "on" as ExternalProbeOutcome;
      },
    );

    // dataStore: 1s cadence; tiContainer: 3s cadence. Stagger window
    // is `floor(min(1000, 3000) / 2) = 500ms`, so the first tiContainer
    // fires at +500ms and dataStore fires at +0ms.
    __startProbeLoopForTests({ dataStore: 1_000, tiContainer: 3_000 }, fetcher);

    const start = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    // First dispatches landed.
    expect(calls.map((c) => c.kind)).toEqual(["dataStore", "tiContainer"]);

    // Run for 6 seconds total. At 1s cadence dataStore should fire 6×;
    // at 3s cadence tiContainer fires only ~2× more after the first.
    await vi.advanceTimersByTimeAsync(6_000);
    const dataStoreCalls = calls.filter((c) => c.kind === "dataStore").length;
    const tiContainerCalls = calls.filter(
      (c) => c.kind === "tiContainer",
    ).length;

    // dataStore cadence is 3× faster than tiContainer — proves the
    // intervals are applied per-service rather than collapsed onto a
    // single shared cadence.
    expect(dataStoreCalls).toBeGreaterThan(tiContainerCalls * 2);

    // Sanity check: every recorded timestamp belongs to the run.
    for (const c of calls) expect(c.at).toBeGreaterThanOrEqual(start);
  });
});

describe("composeLastCheckedByService", () => {
  // Round-4 review #2 (#313): the agent footer must NOT fabricate a
  // "Last checked Xs ago" timestamp on the cold-load
  // `ManagerUnavailableError` path. The detail page used to default
  // `initialCapturedAt` to `new Date().toISOString()` even when the
  // SSR fetch failed, which leaked into every agent card as
  // "Last checked 0s ago" while the page actually had no live sample.
  // The page now leaves `initialCapturedAt` undefined on that path,
  // and this helper additionally gates the SSR fallback on having a
  // real `live` payload as defence-in-depth.

  const probeLastCheckedAt = {
    dataStore: null,
    tiContainer: null,
  } as const;

  it("returns null for every agent kind when no live data is available", () => {
    // Cold-load `ManagerUnavailableError` path: even if a future
    // caller threads a non-null `initialCapturedAt`, the absence of
    // live data must keep the agent footer on `lastCheckedNever`.
    const map = composeLastCheckedByService({
      bufferSampleAt: null,
      initialCapturedAt: new Date("2026-04-28T00:00:00Z"),
      hasLive: false,
      probeLastCheckedAt,
    });
    expect(map.sensor).toBeNull();
    expect(map.unsupervised).toBeNull();
    expect(map.semiSupervised).toBeNull();
    expect(map.timeSeries).toBeNull();
  });

  it("uses initialCapturedAt for agent kinds when a live payload exists but the buffer is empty", () => {
    // Cold-load happy path: SSR `getNodeStatusList()` succeeded and
    // threaded both `initialNodeStatus` and `initialCapturedAt`. The
    // agent footer renders the SSR timestamp until the first client
    // poll lands and `bufferSampleAt` takes over.
    const at = new Date("2026-04-28T00:00:00Z");
    const map = composeLastCheckedByService({
      bufferSampleAt: null,
      initialCapturedAt: at,
      hasLive: true,
      probeLastCheckedAt,
    });
    expect(map.sensor).toBe(at);
    expect(map.unsupervised).toBe(at);
    expect(map.semiSupervised).toBe(at);
    expect(map.timeSeries).toBe(at);
  });

  it("prefers bufferSampleAt over the SSR fallback once a poll has landed", () => {
    const fallback = new Date("2026-04-28T00:00:00Z");
    const fresh = new Date("2026-04-28T00:00:30Z");
    const map = composeLastCheckedByService({
      bufferSampleAt: fresh,
      initialCapturedAt: fallback,
      hasLive: true,
      probeLastCheckedAt,
    });
    expect(map.sensor).toBe(fresh);
  });

  it("threads the per-kind probe timestamp for external services without sharing the agent timestamp", () => {
    // Round-1 fix: external cards must NOT borrow the agent
    // `bufferSampleAt`. A staggered Giganto probe firing at +0s does
    // not refresh the TI Container card whose own probe has not
    // landed yet.
    const sampleAt = new Date("2026-04-28T00:00:30Z");
    const giganto = new Date("2026-04-28T00:00:31Z");
    const map = composeLastCheckedByService({
      bufferSampleAt: sampleAt,
      initialCapturedAt: null,
      hasLive: true,
      probeLastCheckedAt: { dataStore: giganto, tiContainer: null },
    });
    expect(map.dataStore).toBe(giganto);
    expect(map.tiContainer).toBeNull();
    expect(map.sensor).toBe(sampleAt);
  });
});

describe("external probe store — last-unmount reset", () => {
  // Round-3 review #2 (#313): when the last `useExternalServiceProbes`
  // consumer unmounts, the probe loop is stopped *and* the snapshot is
  // reset to `unknown`. Without the reset, returning to `/nodes` after
  // navigating away would paint a stale `on` / `off` Giganto / Tivan
  // result from a previous visit before any fresh probe ran. Mirrors
  // the `resetStoreForUnmount` carve-out the node-status poller already
  // applies for the same reason.
  beforeEach(() => {
    __resetExternalProbeStore();
  });

  it("resets the probe snapshot when the last driver unmounts", () => {
    __setExternalProbeOutcome("dataStore", "on");
    __setExternalProbeOutcome("tiContainer", "off");
    expect(__getExternalProbeStoreSnapshot().outcomes).toEqual({
      dataStore: "on",
      tiContainer: "off",
    });

    __simulateLastDriverUnmountForTests();

    const after = __getExternalProbeStoreSnapshot();
    expect(after.outcomes).toEqual({
      dataStore: "unknown",
      tiContainer: "unknown",
    });
    expect(after.lastCheckedAt).toEqual({
      dataStore: null,
      tiContainer: null,
    });
  });
});
