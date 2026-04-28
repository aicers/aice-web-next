"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import type { NodeStatus } from "@/lib/node/types";

// Sparkline buffer length matches `NODE_STATUS_SPARKLINE_SAMPLES` from
// `src/lib/node/status.ts`. The constant is duplicated rather than
// imported across the server/client boundary because `status.ts`
// carries `import "server-only"` and importing it from a hook would
// poison the client bundle.
export const SPARKLINE_BUFFER_SIZE = 60;

const DEFAULT_POLL_MS = 10_000;
const POLL_MS_MIN = 5_000;
const POLL_MS_MAX = 300_000;

function readPollIntervalMs(override?: number): number {
  // Server-render path: NEXT_PUBLIC_* are inlined at build, but values
  // outside the contract still need to be clamped at the call site.
  const raw =
    override ??
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_NODE_STATUS_POLL_MS
      : undefined);
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_MS;
  if (parsed < POLL_MS_MIN) return POLL_MS_MIN;
  if (parsed > POLL_MS_MAX) return POLL_MS_MAX;
  return parsed;
}

// ── Sample shape ──────────────────────────────────────────────────

export interface NodeStatusSample {
  capturedAt: Date;
  cpuUsage: number | null;
  totalMemory: string | null;
  usedMemory: string | null;
  totalDiskSpace: string | null;
  usedDiskSpace: string | null;
  manager: boolean;
  ping: number | null;
  /**
   * `true` when this sample begins a new visual segment because the gap
   * between this sample and the previous buffered sample exceeded
   * `2 × pollIntervalMs`. The chart breaks the line at this point.
   */
  segmentBoundary: boolean;
}

/**
 * Per-node rolling buffer plus the latest snapshot. `samples` holds at
 * most `SPARKLINE_BUFFER_SIZE` entries, oldest first. `lastSampleAt` is
 * the `capturedAt` of the most recent sample (for stale detection).
 *
 * `latest === null` means the node was absent from the most recent
 * snapshot. The samples and `lastSampleAt` are still preserved so that
 * if the node reappears in a later poll, the gap between
 * `lastSampleAt` and the new sample's `capturedAt` is computed against
 * real elapsed time and `segmentBoundary` fires honestly. Wiping the
 * buffer on a brief absence would silently drop that gap signal and
 * leave the post-reappearance line fused to the pre-absence segment.
 * Consumers that drive row visibility (Status table, Settings list)
 * already filter on `latest === null`, so the absent-from-snapshot
 * intent is preserved without conflating it with sample history.
 */
export interface NodeStatusBuffer {
  samples: NodeStatusSample[];
  lastSampleAt: Date | null;
  latest: NodeStatus | null;
}

// ── Module-level store (useSyncExternalStore-backed) ──────────────

interface StoreSnapshot {
  byNodeId: Map<string, NodeStatusBuffer>;
  capturedAt: Date | null;
  isPolling: boolean;
  isStale: boolean;
  // True once the most recent fetch surfaces the manager as
  // unreachable (HTTP 503 from `/api/nodes/status`). Flips back to
  // false on the next successful sample. Consumers swap to the
  // "Cannot reach manager" panel while this is true so the table is
  // not left rendering a stale snapshot after the manager drops.
  isManagerUnreachable: boolean;
  pollIntervalMs: number;
  // Increases on every state mutation; serves as a stable reference for
  // useSyncExternalStore so consumers re-render on snapshot changes
  // without needing to deep-compare the Map.
  version: number;
}

const initialSnapshot: StoreSnapshot = {
  byNodeId: new Map(),
  capturedAt: null,
  isPolling: false,
  isStale: false,
  isManagerUnreachable: false,
  pollIntervalMs: DEFAULT_POLL_MS,
  version: 0,
};

let snapshot: StoreSnapshot = initialSnapshot;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoreSnapshot {
  return snapshot;
}

function getServerSnapshot(): StoreSnapshot {
  return initialSnapshot;
}

// Reset hook only used by tests.
export function __resetNodeStatusStore(): void {
  snapshot = {
    byNodeId: new Map(),
    capturedAt: null,
    isPolling: false,
    isStale: false,
    isManagerUnreachable: false,
    pollIntervalMs: DEFAULT_POLL_MS,
    version: 0,
  };
  emit();
}

interface ApplySampleArgs {
  capturedAt: Date;
  pollIntervalMs: number;
  edges: NodeStatus[];
}

function applySample({
  capturedAt,
  pollIntervalMs,
  edges,
}: ApplySampleArgs): void {
  const next = new Map(snapshot.byNodeId);
  // Track the ids that arrived in this snapshot so a node that is
  // absent from this poll can be marked as such (`latest = null`)
  // WITHOUT wiping its sample history. The history map keeps the
  // 60-sample ring + `lastSampleAt` so that if the node reappears in
  // a later poll, the gap calculation runs against real elapsed time
  // and `segmentBoundary` fires honestly. Consumers that drive row
  // visibility (Status table iterates `byNodeId` and skips on
  // `!latest`; Settings list projects rows missing a `latest` to
  // "no current status") already treat absent-from-snapshot
  // correctly via `latest === null`.
  const seen = new Set<string>();
  for (const edge of edges) {
    seen.add(edge.id);
    const prev = next.get(edge.id) ?? {
      samples: [],
      lastSampleAt: null,
      latest: null,
    };
    const gapMs =
      prev.lastSampleAt !== null
        ? capturedAt.getTime() - prev.lastSampleAt.getTime()
        : 0;
    const segmentBoundary =
      prev.lastSampleAt !== null && gapMs > 2 * pollIntervalMs;
    const newSample: NodeStatusSample = {
      capturedAt,
      cpuUsage: edge.cpuUsage,
      totalMemory: edge.totalMemory,
      usedMemory: edge.usedMemory,
      totalDiskSpace: edge.totalDiskSpace,
      usedDiskSpace: edge.usedDiskSpace,
      manager: edge.manager,
      ping: edge.ping,
      segmentBoundary,
    };
    const samples = [...prev.samples, newSample];
    if (samples.length > SPARKLINE_BUFFER_SIZE) {
      samples.splice(0, samples.length - SPARKLINE_BUFFER_SIZE);
    }
    next.set(edge.id, {
      samples,
      lastSampleAt: capturedAt,
      latest: edge,
    });
  }
  // Mark nodes missing from this poll as absent (`latest = null`) but
  // preserve `samples` + `lastSampleAt`. An absent → reappears flow
  // must keep the pre-absence history so the reappearing sample's gap
  // crosses the 2× threshold and `segmentBoundary` is honestly true.
  for (const [id, buf] of next) {
    if (seen.has(id)) continue;
    if (buf.latest === null) continue;
    next.set(id, {
      samples: buf.samples,
      lastSampleAt: buf.lastSampleAt,
      latest: null,
    });
  }
  snapshot = {
    ...snapshot,
    byNodeId: next,
    capturedAt,
    isStale: false,
    // A successful sample clears the manager-unreachable flag — the
    // next paint can drop the fallback panel and resume rendering rows.
    isManagerUnreachable: false,
    pollIntervalMs,
    version: snapshot.version + 1,
  };
  emit();
}

function setPolling(isPolling: boolean): void {
  if (snapshot.isPolling === isPolling) return;
  snapshot = { ...snapshot, isPolling, version: snapshot.version + 1 };
  emit();
}

function setStale(isStale: boolean): void {
  if (snapshot.isStale === isStale) return;
  snapshot = { ...snapshot, isStale, version: snapshot.version + 1 };
  emit();
}

function setManagerUnreachable(value: boolean): void {
  if (snapshot.isManagerUnreachable === value) return;
  snapshot = {
    ...snapshot,
    isManagerUnreachable: value,
    version: snapshot.version + 1,
  };
  emit();
}

// ── Fetcher ───────────────────────────────────────────────────────

interface NodeStatusListResponse {
  capturedAt: string;
  edges: NodeStatus[];
}

/**
 * Marker error raised when `/api/nodes/status` reports the upstream
 * manager is unreachable (HTTP 503). The polling controller catches
 * this specifically and flips the `isManagerUnreachable` flag so
 * consumers can swap to the fallback panel mid-session, instead of
 * waiting for the table to go stale on a frozen snapshot.
 */
export class ManagerUnreachableFetchError extends Error {
  constructor(message = "Manager unreachable") {
    super(message);
    this.name = "ManagerUnreachableFetchError";
  }
}

async function defaultFetcher(
  signal?: AbortSignal,
): Promise<NodeStatusListResponse> {
  const res = await fetch("/api/nodes/status", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (res.status === 503) {
    throw new ManagerUnreachableFetchError();
  }
  if (!res.ok) {
    throw new Error(`status fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as NodeStatusListResponse;
}

// ── Hook controller (driver) ──────────────────────────────────────

interface UseNodeStatusPollingOptions {
  /** Override the env-derived polling interval (clamped). */
  pollIntervalMs?: number;
  /** Inject a custom fetcher (used by tests). */
  fetcher?: (signal?: AbortSignal) => Promise<NodeStatusListResponse>;
  /**
   * If false, the controller never starts an interval. Used by the
   * settings page to consume samples without driving its own loop.
   */
  enabled?: boolean;
}

/**
 * Drive the rolling status buffer and expose a stable view to the
 * caller. The single driver mount lives in `nodes/(gate)/layout.tsx`
 * via `NodeStatusPollingDriver` so the buffer survives every
 * intra-segment navigation (Status ↔ Settings ↔ Detail). Page-level
 * components must call `useNodeStatusPolling({ enabled: false })` so
 * they only consume the shared store and never bounce `driverCount`
 * through zero on a page swap.
 *
 * Behaviour highlights (acceptance criteria from the issue):
 *  - Pauses on `document.visibilityState === "hidden"`.
 *  - On `visibilitychange` from hidden → visible, immediately issues
 *    one `getNodeStatusList()` call before the next interval tick;
 *    the regular cadence resumes after that one-shot.
 *  - Each buffered sample carries `capturedAt: Date`; consumers reason
 *    about freshness from timestamps, not from sample count.
 *  - When a new sample arrives with `gap > 2 × pollIntervalMs` since
 *    the previous sample, it carries `segmentBoundary: true` so the
 *    chart breaks the line at that point. Previous samples remain.
 *  - `isStale` is `true` iff `now - lastSampleAt > 2 × pollIntervalMs`.
 *    A fresh sample arriving (e.g. from the resume one-shot) flips
 *    `isStale` back to `false` immediately.
 *  - No backfill: a hidden window of any length does NOT result in
 *    retroactively-inserted filler samples.
 *  - Debounces the first poll to avoid double-fetch on mount: the SSR
 *    pages under `/nodes` already issued a `getNodeStatusList()` for
 *    their first paint, so the bootstrap arms the interval but does
 *    NOT issue an immediate client fetch. The first client poll lands
 *    at the first `pollIntervalMs` boundary; until then, page-level
 *    callers paint from the SSR snapshot they already have via the
 *    existing `polling.capturedAt === null` fallback.
 *  - Skips a tick while a previous fetch is still in flight, so a slow
 *    but healthy poll is not self-cancelled by the next interval
 *    boundary on a deployment large enough that paginating
 *    `nodeStatusList` exceeds `pollIntervalMs`.
 */
export interface UseNodeStatusPollingResult {
  byNodeId: Map<string, NodeStatusBuffer>;
  capturedAt: Date | null;
  isPolling: boolean;
  isStale: boolean;
  /**
   * True when the most recent poll surfaced the upstream manager as
   * unreachable (HTTP 503 from `/api/nodes/status`). Flips back to
   * false on the next successful sample. The Status table swaps to
   * the "Cannot reach manager" panel while this is true, so a manager
   * dropping after the first paint does not leave the UI rendering a
   * frozen snapshot until staleness kicks in.
   */
  isManagerUnreachable: boolean;
  lastSampleAt: Date | null;
  pollIntervalMs: number;
}

// Active driver count so multiple page mounts do not spin up parallel
// polling loops. The first driver starts the loop; subsequent drivers
// piggy-back on it and only the last unmount clears the timer.
let driverCount = 0;
let activeTimer: ReturnType<typeof setInterval> | null = null;
let visibilityHandler: (() => void) | null = null;
let activeAbort: AbortController | null = null;
let activePollIntervalMs = DEFAULT_POLL_MS;
let activeFetcher: (signal?: AbortSignal) => Promise<NodeStatusListResponse> =
  defaultFetcher;
// Tracks the last fetch's start time so the stale detector below has a
// signal to work with even before the first sample arrives.
let lastFetchStartedAt: number | null = null;
// True while a `tick()` round-trip is in flight. Subsequent interval
// ticks skip while this is set so a slow-but-healthy poll is not
// self-cancelled by the next interval boundary. `getNodeStatusList`
// pages through the manager's status connection, so a larger
// deployment can take longer than `pollIntervalMs` to drain — without
// this guard each tick aborted its predecessor before it resolved,
// `applySample()` never ran, and the UI froze on a stale snapshot
// despite the manager being reachable.
let inFlight = false;

function clearActiveTimerOnly(): void {
  if (activeTimer !== null) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}

function clearActiveTimer(): void {
  clearActiveTimerOnly();
  if (activeAbort !== null) {
    activeAbort.abort();
    activeAbort = null;
  }
  // Drop the in-flight guard synchronously so a re-mount immediately
  // after teardown does not skip its first tick while waiting for the
  // aborted fetch's finally to run on a later microtask.
  inFlight = false;
}

async function tick(): Promise<void> {
  // Hidden tabs explicitly skip the network round-trip — the
  // visibilitychange handler stops the interval, but a tick already
  // in flight when the tab hides should fall through cheaply.
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return;
  }
  // Skip if a previous tick is still resolving. The healthy steady
  // state never aborts itself; the only paths that abort `activeAbort`
  // are teardown (`clearActiveTimer`) and the visibility-pause stop —
  // both of which want to drop the in-flight request anyway.
  if (inFlight) return;
  inFlight = true;
  activeAbort = new AbortController();
  const signal = activeAbort.signal;
  lastFetchStartedAt = Date.now();
  try {
    const result = await activeFetcher(signal);
    applySample({
      capturedAt: new Date(result.capturedAt),
      pollIntervalMs: activePollIntervalMs,
      edges: result.edges,
    });
  } catch (err) {
    // Aborts are part of normal teardown.
    if (err instanceof DOMException && err.name === "AbortError") return;
    // Manager-unreachable (HTTP 503) flips the dedicated flag so the
    // table swaps to the fallback panel mid-session — the SSR-only
    // fallback would otherwise leave a stale snapshot frozen in place
    // after the manager drops post-hydration. The flag clears the next
    // time `applySample` runs, so the panel disappears as soon as the
    // manager returns.
    if (err instanceof ManagerUnreachableFetchError) {
      setManagerUnreachable(true);
      return;
    }
    // Other transient errors (e.g. a one-off network blip) are swallowed
    // so the polling loop continues; the consumer detects the gap via
    // `isStale`.
  } finally {
    inFlight = false;
    // Only clear the abort handle if it is still ours. A teardown that
    // ran while we were awaiting may have aborted+nulled it already
    // and started a fresh controller for a later tick.
    if (activeAbort !== null && activeAbort.signal === signal) {
      activeAbort = null;
    }
  }
}

function startInterval(intervalMs: number): void {
  // Only clear the timer here — DO NOT abort the in-flight fetch or
  // reset `inFlight`. The bootstrap path is `void tick(); startInterval(...)`,
  // and the resume one-shot path is `void tick(); startInterval(...)` too;
  // a full `clearActiveTimer()` here would synchronously cancel that
  // tick's fetch before it ever resolves, defeating both the
  // visibility-resume one-shot and the no-self-cancel guarantee.
  clearActiveTimerOnly();
  activePollIntervalMs = intervalMs;
  activeTimer = setInterval(() => {
    void tick();
  }, intervalMs);
  setPolling(true);
}

function stopInterval(): void {
  clearActiveTimer();
  setPolling(false);
}

// Reset the per-node buffer + freshness flags on the last driver
// unmount. The store is module-level and survives across React
// re-renders by design (so the Status table and the future detail page
// observe the same samples), but it should not survive across SPA
// route changes that leave the Nodes area entirely. Without this,
// returning to /nodes hours later would let the stale snapshot shadow
// the next page load's fresh SSR data — `polling.capturedAt !== null`
// would point the table at old buffer entries until the next client
// poll completed, so a node that has since been removed could
// reappear and a newly added node could stay missing for a window.
function resetStoreForUnmount(): void {
  snapshot = {
    byNodeId: new Map(),
    capturedAt: null,
    isPolling: false,
    isStale: false,
    isManagerUnreachable: false,
    pollIntervalMs: snapshot.pollIntervalMs,
    version: snapshot.version + 1,
  };
  lastFetchStartedAt = null;
  emit();
}

export function useNodeStatusPolling(
  options: UseNodeStatusPollingOptions = {},
): UseNodeStatusPollingResult {
  const store = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const intervalMs = readPollIntervalMs(options.pollIntervalMs);
  const enabled = options.enabled ?? true;
  const fetcherRef = useRef(options.fetcher ?? defaultFetcher);
  fetcherRef.current = options.fetcher ?? defaultFetcher;

  // Driver effect — only one active per app via the module-level
  // refcount, so a Status tab + detail page mounted together share the
  // same interval rather than racing two of them.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    activeFetcher = fetcherRef.current;
    activePollIntervalMs = intervalMs;
    driverCount += 1;
    if (driverCount === 1) {
      // Debounce the very first effect so React 19's strict-effects
      // double-invoke does not start two intervals on mount.
      //
      // Crucially, this bootstrap does NOT call `tick()`. The Node
      // SSR pages already invoked `getNodeStatusList()` on the
      // server for their first paint, and an immediate client tick
      // would walk the entire `nodeStatusList` connection a second
      // time on every visit. The first client poll lands at the
      // first `pollIntervalMs` boundary; page-level callers paint
      // from the SSR snapshot in the meantime via the existing
      // `polling.capturedAt === null` fallback in
      // `NodeStatusTable` / `NodeListTable`.
      const id = setTimeout(() => {
        // If the page mounted while the tab was already hidden, do
        // NOT start the interval — the visibilitychange handler will
        // start it when the tab becomes visible. Otherwise
        // `startInterval()` would set `isPolling=true` on a hidden
        // tab (no visible→hidden transition is ever observed for the
        // visibility handler to react to), violating the acceptance
        // criterion that hidden tabs pause polling and that the
        // `data-polling` attribute reflects real state.
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
        ) {
          return;
        }
        startInterval(intervalMs);
      }, 0);

      visibilityHandler = () => {
        if (typeof document === "undefined") return;
        if (document.visibilityState === "hidden") {
          stopInterval();
        } else {
          // Resume one-shot: fire `tick()` immediately, then restart
          // the interval. The acceptance criterion says exactly one
          // `getNodeStatusList()` call lands before the next
          // `pollIntervalMs` tick on resume. This branch also covers
          // the "mounted-while-hidden, then revealed" case — the
          // bootstrap setTimeout above intentionally bails when the
          // tab starts hidden, and this handler kicks the loop off
          // when the tab actually becomes visible.
          void tick();
          startInterval(activePollIntervalMs);
        }
      };
      document.addEventListener("visibilitychange", visibilityHandler);

      return () => {
        clearTimeout(id);
        driverCount -= 1;
        if (driverCount <= 0) {
          driverCount = 0;
          stopInterval();
          if (visibilityHandler !== null) {
            document.removeEventListener("visibilitychange", visibilityHandler);
            visibilityHandler = null;
          }
          resetStoreForUnmount();
        }
      };
    }

    return () => {
      driverCount -= 1;
      if (driverCount <= 0) {
        driverCount = 0;
        stopInterval();
        if (visibilityHandler !== null) {
          document.removeEventListener("visibilitychange", visibilityHandler);
          visibilityHandler = null;
        }
        resetStoreForUnmount();
      }
    };
  }, [enabled, intervalMs]);

  // Stale detector — runs on a separate interval at a fraction of the
  // polling cadence so the `isStale` flag flips even when no fresh
  // sample arrives. Acceptance: `isStale === true` iff
  // `now - lastSampleAt > 2 * pollIntervalMs`.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const checkStale = () => {
      const lastAt = snapshot.capturedAt?.getTime();
      if (lastAt === undefined) {
        // No sample has ever arrived — but if the first fetch has been
        // pending for longer than 2x the interval, surface that as
        // stale so the UI does not pretend the data is fresh.
        if (
          lastFetchStartedAt !== null &&
          Date.now() - lastFetchStartedAt > 2 * intervalMs
        ) {
          setStale(true);
        }
        return;
      }
      const stale = Date.now() - lastAt > 2 * intervalMs;
      setStale(stale);
    };
    const id = setInterval(checkStale, Math.max(1_000, intervalMs / 4));
    checkStale();
    return () => clearInterval(id);
  }, [enabled, intervalMs]);

  // Compose the public view. `lastSampleAt` is the most recent
  // `capturedAt` we have observed, exposed both at the top level (so a
  // detail-page consumer can render a "last updated …" indicator) and
  // per-node via `byNodeId.get(id).lastSampleAt`.
  return {
    byNodeId: store.byNodeId,
    capturedAt: store.capturedAt,
    isPolling: store.isPolling,
    isStale: store.isStale,
    isManagerUnreachable: store.isManagerUnreachable,
    lastSampleAt: store.capturedAt,
    pollIntervalMs: intervalMs,
  };
}

// ── Test/integration helpers ──────────────────────────────────────

/**
 * Imperatively push a sample into the buffer. Used by tests to drive
 * the store without a real fetch round-trip; production code should
 * not call this.
 */
export function __pushNodeStatusSample(
  capturedAt: Date,
  edges: NodeStatus[],
  pollIntervalMs: number = DEFAULT_POLL_MS,
): void {
  applySample({ capturedAt, pollIntervalMs, edges });
}

/**
 * Seed the polling buffer from the SSR snapshot on first table mount.
 *
 * The polling driver intentionally does NOT issue a client-side
 * `getNodeStatusList()` on bootstrap (the SSR pages already paid that
 * cost) — the first client tick lands at the first `pollIntervalMs`
 * boundary. Without this seed, per-row signals derived from the rolling
 * buffer (the per-service `on / off / idle` cells, the detail-page
 * service cards) would render as `absent` placeholders for up to a full
 * polling interval after the first paint, even though the SSR payload
 * already carried the agents / external services for every row.
 *
 * The seed is a no-op when the buffer already holds a sample at or
 * after `capturedAt`, so a remount after a real poll has landed cannot
 * shadow the fresher data with the stale SSR snapshot.
 */
export function seedNodeStatusFromSnapshot(
  capturedAt: Date,
  edges: NodeStatus[],
  pollIntervalMs: number = DEFAULT_POLL_MS,
): void {
  if (
    snapshot.capturedAt !== null &&
    snapshot.capturedAt.getTime() >= capturedAt.getTime()
  ) {
    return;
  }
  applySample({ capturedAt, pollIntervalMs, edges });
}

export function __getNodeStatusSnapshot(): {
  isPolling: boolean;
  isStale: boolean;
  isManagerUnreachable: boolean;
  capturedAt: Date | null;
} {
  return {
    isPolling: snapshot.isPolling,
    isStale: snapshot.isStale,
    isManagerUnreachable: snapshot.isManagerUnreachable,
    capturedAt: snapshot.capturedAt,
  };
}

export function __setNodeStatusStale(stale: boolean): void {
  setStale(stale);
}

export function __setNodeStatusManagerUnreachable(value: boolean): void {
  setManagerUnreachable(value);
}

/** Test-only accessor for the full per-node buffer state. */
export function __getNodeStatusStoreForTests(): {
  byNodeId: Map<string, NodeStatusBuffer>;
} {
  return { byNodeId: snapshot.byNodeId };
}
