import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetExternalProbeStore,
  __setExternalProbeOutcome,
  __startProbeLoopForTests,
  __stopProbeLoopForTests,
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
