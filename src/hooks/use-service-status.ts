"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useNodeStatusPolling } from "@/hooks/use-node-status-polling";
import { NodePermissionError } from "@/lib/node/errors";
import {
  AGENT_SERVICE_KINDS,
  composeServiceStatusEntries,
  EXTERNAL_SERVICE_KINDS,
  type ExternalProbeOutcome,
  type ExternalServiceKindKey,
  entriesToStatusMap,
  type ServiceKind,
  type ServiceStatus,
  type ServiceStatusEntryMap,
} from "@/lib/node/service-status";
import type { NodeStatus } from "@/lib/node/types";

/**
 * Default polling cadence for the per-external-service probe. Mirrors
 * `NEXT_PUBLIC_NODE_STATUS_POLL_MS` so the external probes track the
 * same operator-tunable cadence as the node-status poll. Clamped so a
 * misconfigured override cannot hammer Giganto / Tivan.
 */
const DEFAULT_PROBE_MS = 10_000;
const PROBE_MS_MIN = 5_000;
const PROBE_MS_MAX = 300_000;

/**
 * Override shape accepted by {@link useExternalServiceProbes} and
 * {@link useServiceStatus}. A bare number is applied to every external
 * probe; a per-service partial record lets Giganto and Tivan poll at
 * different cadences (issue #313 explicitly asks for "configurable
 * per-service interval"). Missing keys fall back to the env-derived
 * default.
 */
export type ProbeIntervalOverride =
  | number
  | Partial<Record<ExternalServiceKindKey, number>>;

function readProbeIntervalMs(override?: number): number {
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
  if (!Number.isFinite(parsed)) return DEFAULT_PROBE_MS;
  if (parsed < PROBE_MS_MIN) return PROBE_MS_MIN;
  if (parsed > PROBE_MS_MAX) return PROBE_MS_MAX;
  return parsed;
}

/**
 * Resolve the per-kind probe interval map. The single-number form is
 * mirrored to every external service; the record form lets each service
 * carry its own cadence. Each value is clamped through
 * {@link readProbeIntervalMs} so a misconfigured override cannot
 * hammer Giganto / Tivan, regardless of which form the caller used.
 */
function resolveProbeIntervals(
  override?: ProbeIntervalOverride,
): Record<ExternalServiceKindKey, number> {
  if (typeof override === "object" && override !== null) {
    return {
      dataStore: readProbeIntervalMs(override.dataStore),
      tiContainer: readProbeIntervalMs(override.tiContainer),
    };
  }
  const single = readProbeIntervalMs(override);
  return { dataStore: single, tiContainer: single };
}

// ── External-probe store ─────────────────────────────────────────
//
// Single module-level store so multiple Status / detail consumers do
// not each fire their own probe loop. The `useExternalServiceProbes`
// hook below ref-counts mounts and drives one stagger loop while at
// least one consumer is mounted.

interface ExternalProbeSnapshot {
  outcomes: Record<ExternalServiceKindKey, ExternalProbeOutcome>;
  lastCheckedAt: Record<ExternalServiceKindKey, Date | null>;
  version: number;
}

const externalProbeInitial: ExternalProbeSnapshot = {
  outcomes: { dataStore: "unknown", tiContainer: "unknown" },
  lastCheckedAt: { dataStore: null, tiContainer: null },
  version: 0,
};

let externalProbeSnapshot: ExternalProbeSnapshot = externalProbeInitial;
const externalProbeListeners = new Set<() => void>();

function emitExternalProbe(): void {
  for (const listener of externalProbeListeners) listener();
}

function subscribeExternalProbe(listener: () => void): () => void {
  externalProbeListeners.add(listener);
  return () => {
    externalProbeListeners.delete(listener);
  };
}

function getExternalProbeSnapshot(): ExternalProbeSnapshot {
  return externalProbeSnapshot;
}

function setExternalProbe(
  kind: ExternalServiceKindKey,
  outcome: ExternalProbeOutcome,
  checkedAt: Date,
): void {
  externalProbeSnapshot = {
    outcomes: { ...externalProbeSnapshot.outcomes, [kind]: outcome },
    lastCheckedAt: {
      ...externalProbeSnapshot.lastCheckedAt,
      [kind]: checkedAt,
    },
    version: externalProbeSnapshot.version + 1,
  };
  emitExternalProbe();
}

/** Test-only reset hook — mirrors `__resetNodeStatusStore`. */
export function __resetExternalProbeStore(): void {
  externalProbeSnapshot = {
    outcomes: { dataStore: "unknown", tiContainer: "unknown" },
    lastCheckedAt: { dataStore: null, tiContainer: null },
    version: externalProbeSnapshot.version + 1,
  };
  emitExternalProbe();
}

/** Test helper: imperatively push a probe outcome. */
export function __setExternalProbeOutcome(
  kind: ExternalServiceKindKey,
  outcome: ExternalProbeOutcome,
  checkedAt: Date = new Date(),
): void {
  setExternalProbe(kind, outcome, checkedAt);
}

/**
 * Test-only entry into the module-level probe loop driver. The
 * production driver is `useExternalServiceProbes`, which threads the
 * same `startProbeLoop` call through React's effect lifecycle; the
 * project ships without `@testing-library/react`, so unit tests bypass
 * React entirely and exercise the loop directly. Use with vitest fake
 * timers + a fetcher mock.
 */
export function __startProbeLoopForTests(
  intervals: Record<ExternalServiceKindKey, number>,
  fetcher: (
    kind: ExternalServiceKindKey,
    signal?: AbortSignal,
  ) => Promise<ExternalProbeOutcome>,
): void {
  activeProbeFetcher = fetcher;
  startProbeLoop(intervals);
}

export function __stopProbeLoopForTests(): void {
  stopProbeLoop();
  activeProbeFetcher = defaultProbeFetcher;
}

// ── Probe fetcher ────────────────────────────────────────────────

interface ProbeResponse {
  ok: boolean;
}

const PROBE_PATHS: Record<ExternalServiceKindKey, string> = {
  dataStore: "/api/services/external/giganto/status",
  tiContainer: "/api/services/external/tivan/status",
};

async function defaultProbeFetcher(
  kind: ExternalServiceKindKey,
  signal?: AbortSignal,
): Promise<ExternalProbeOutcome> {
  try {
    const res = await fetch(PROBE_PATHS[kind], {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return "off";
    const body = (await res.json()) as ProbeResponse;
    return body.ok ? "on" : "off";
  } catch (err) {
    // Aborts are part of normal teardown — propagate so the caller can
    // distinguish "we cancelled" from "the fetch reported off". The
    // probe loop swallows this and never updates the store.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return "off";
  }
}

// ── Probe loop driver ────────────────────────────────────────────

let probeDriverCount = 0;
let probeTimers: Array<ReturnType<typeof setTimeout> | null> = [];
let probeAborts: Array<AbortController | null> = [];
// Per-service in-flight guard. Without this a probe that takes longer
// than its `probeIntervalMs` to resolve would have the next interval
// tick start a second concurrent fetch for the same service —
// stacking requests against a slow / wedged Giganto or Tivan and
// reintroducing the hammering this issue is explicitly trying to
// avoid. Mirrors the `inFlight` guard the node-status poller uses.
let probeInFlight: boolean[] = [];
let activeProbeFetcher: typeof defaultProbeFetcher = defaultProbeFetcher;

const PROBE_KINDS: readonly ExternalServiceKindKey[] = [
  "dataStore",
  "tiContainer",
];

function clearProbeTimers(): void {
  for (let i = 0; i < probeTimers.length; i += 1) {
    const timer = probeTimers[i];
    if (timer !== null && timer !== undefined) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    probeTimers[i] = null;
    const abort = probeAborts[i];
    if (abort !== null && abort !== undefined) abort.abort();
    probeAborts[i] = null;
    probeInFlight[i] = false;
  }
}

async function runProbe(
  kind: ExternalServiceKindKey,
  index: number,
): Promise<void> {
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return;
  }
  // Per-service in-flight skip: if the previous probe for this kind
  // has not resolved yet, drop this tick rather than stacking a
  // second request. The next interval boundary picks it back up.
  if (probeInFlight[index]) return;
  probeInFlight[index] = true;
  const abort = new AbortController();
  probeAborts[index] = abort;
  try {
    const outcome = await activeProbeFetcher(kind, abort.signal);
    setExternalProbe(kind, outcome, new Date());
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    setExternalProbe(kind, "off", new Date());
  } finally {
    probeInFlight[index] = false;
    if (probeAborts[index] === abort) probeAborts[index] = null;
  }
}

function startProbeLoop(
  intervalsByKind: Record<ExternalServiceKindKey, number>,
): void {
  clearProbeTimers();
  probeTimers = PROBE_KINDS.map(() => null);
  probeAborts = PROBE_KINDS.map(() => null);
  probeInFlight = PROBE_KINDS.map(() => false);
  // Stagger the first dispatch so Giganto and Tivan never fire on the
  // same first tick. The offset is computed against the smallest
  // configured cadence so per-service overrides cannot collapse the
  // stagger window. After the first dispatch each probe runs on its
  // own `setInterval(...)` at its own cadence.
  const minInterval = Math.min(
    ...PROBE_KINDS.map((kind) => intervalsByKind[kind]),
  );
  const stagger = Math.floor(minInterval / PROBE_KINDS.length);
  PROBE_KINDS.forEach((kind, index) => {
    const startDelay = index * stagger;
    const intervalMs = intervalsByKind[kind];
    probeTimers[index] = setTimeout(() => {
      void runProbe(kind, index);
      probeTimers[index] = setInterval(() => {
        void runProbe(kind, index);
      }, intervalMs);
    }, startDelay);
  });
}

function stopProbeLoop(): void {
  clearProbeTimers();
}

interface UseExternalServiceProbesOptions {
  /**
   * Override the env-derived probe interval (clamped). A bare number
   * applies to every external probe; a per-service partial record
   * lets Giganto and Tivan poll at different cadences.
   */
  probeIntervalMs?: ProbeIntervalOverride;
  /** Inject a custom fetcher (used by tests). */
  fetcher?: typeof defaultProbeFetcher;
  /**
   * If false, the controller never starts the loop. Page-level
   * consumers within the same `nodes/(gate)/layout.tsx` segment pass
   * `enabled: false` so they only consume the shared store.
   */
  enabled?: boolean;
}

/**
 * Drive the global Giganto / Tivan probe loop and expose the latest
 * outcome map. The loop is single-driver (ref-counted) so multiple
 * consumers do not each fire their own probes.
 *
 * Staggering: the first dispatch of each probe is offset by a fraction
 * of the smallest configured cadence so Giganto and Tivan never hit on
 * the same first tick. After that each probe runs on its own
 * `setInterval` at its own per-service cadence.
 */
export function useExternalServiceProbes(
  options: UseExternalServiceProbesOptions = {},
): ExternalProbeSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeExternalProbe,
    getExternalProbeSnapshot,
    () => externalProbeInitial,
  );
  const intervals = resolveProbeIntervals(options.probeIntervalMs);
  const dataStoreInterval = intervals.dataStore;
  const tiContainerInterval = intervals.tiContainer;
  const enabled = options.enabled ?? true;
  const fetcherRef = useRef(options.fetcher ?? defaultProbeFetcher);
  fetcherRef.current = options.fetcher ?? defaultProbeFetcher;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    activeProbeFetcher = fetcherRef.current;
    probeDriverCount += 1;
    const localIntervals: Record<ExternalServiceKindKey, number> = {
      dataStore: dataStoreInterval,
      tiContainer: tiContainerInterval,
    };
    if (probeDriverCount === 1) {
      // Debounce the first effect so React 19 strict-effects double-
      // invoke does not start two loops.
      const id = setTimeout(() => {
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
        ) {
          return;
        }
        startProbeLoop(localIntervals);
      }, 0);
      return () => {
        clearTimeout(id);
        probeDriverCount -= 1;
        if (probeDriverCount <= 0) {
          probeDriverCount = 0;
          stopProbeLoop();
        }
      };
    }
    return () => {
      probeDriverCount -= 1;
      if (probeDriverCount <= 0) {
        probeDriverCount = 0;
        stopProbeLoop();
      }
    };
  }, [enabled, dataStoreInterval, tiContainerInterval]);

  return snapshot;
}

// ── Per-node service-status hook ─────────────────────────────────

export type ServiceStatusMap = Record<ServiceKind, ServiceStatus>;
export type { ServiceStatusEntryMap };

interface UseServiceStatusOptions {
  /**
   * Whether the caller holds `services:read`. The hook throws
   * `NodePermissionError` when this is false — defence-in-depth so a
   * page that forgets to gate the renderer cannot leak the per-service
   * signal.
   *
   * The page-level gate in `nodes/(gate)/layout.tsx` already enforces
   * the combined `nodes:read + services:read` permission, so in
   * production this value is always `true` for any caller that reaches
   * the rendered surface. Tests can flip it to drive the throw path.
   */
  canRead: boolean;
  /** Driver toggle for the external-probe loop. */
  enabled?: boolean;
  /**
   * Per-service probe interval override. A bare number applies to
   * every external probe; a per-service partial record lets Giganto
   * and Tivan poll at different cadences.
   */
  probeIntervalMs?: ProbeIntervalOverride;
  fetcher?: typeof defaultProbeFetcher;
  /**
   * SSR-rendered `NodeStatus` for `nodeId`, used as the first-paint
   * fallback when the client polling buffer has not yet observed this
   * node. Without this, a cold load of `/nodes/[id]` server-renders
   * (and hydrates) every card as `Off / absent` because the shared
   * polling store starts empty on the server snapshot, even when the
   * SSR `getNodeStatusList()` payload already carried this node's
   * agents and external services. Page-level callers thread the
   * matching edge in; the Status tab leaves this undefined and reads
   * from the seeded buffer.
   */
  initialNodeStatus?: NodeStatus | null;
  /**
   * Server `capturedAt` paired with {@link initialNodeStatus}. Used
   * as the agent "last checked" timestamp until the first client poll
   * lands. Ignored when the polling buffer already carries a sample
   * for this node.
   */
  initialCapturedAt?: Date | null;
}

export interface UseServiceStatusResult {
  status: ServiceStatusMap;
  entries: ServiceStatusEntryMap;
  /**
   * Per-card "last checked" timestamp keyed to the relevant signal:
   *
   *  - Agent services (`sensor`, `unsupervised`, `semiSupervised`,
   *    `timeSeries`) carry the per-node poll's `lastSampleAt`. Every
   *    agent on a given node refreshes on the same `nodeStatusList`
   *    tick, so they share the same timestamp.
   *  - External services (`dataStore`, `tiContainer`) carry their own
   *    probe's `lastCheckedAt`. The probes are staggered, so each card
   *    advances independently and the unrelated probe firing does
   *    *not* refresh a card whose own signal has not been re-read.
   *
   * Used by the detail page's "Last checked Xs ago" footer so a
   * Giganto probe never refreshes the TI Container card's timer (and
   * vice versa).
   */
  lastCheckedByService: Record<ServiceKind, Date | null>;
}

/**
 * Per-node mapping of agent / external storedStatus + live probe into
 * the unified `off / on / idle` UI vocabulary.
 *
 * Composition contract:
 *  - Reads the latest `NodeStatus` for `nodeId` from the polling store
 *    (driven by `useNodeStatusPolling`).
 *  - Reads the global Giganto / Tivan probe outcome from the shared
 *    external-probe store (driven by `useExternalServiceProbes`).
 *  - Applies the dead-node override: when `ping === null`, every cell
 *    collapses to `off` regardless of the raw signal.
 *  - Throws `NodePermissionError` when `canRead === false`. Page-level
 *    callers must thread the permission down rather than relying on
 *    the layout gate alone (the umbrella issue calls this out).
 *
 * The Manager badge is **not** part of the result. The exposed type
 * has no `manager` key, so `useServiceStatus(node).manager` raises a
 * type error at compile time — matching the issue's acceptance.
 */
export function useServiceStatus(
  nodeId: string,
  options: UseServiceStatusOptions,
): UseServiceStatusResult {
  if (!options.canRead) {
    throw new NodePermissionError(
      "Caller lacks the services:read permission required to read service status.",
    );
  }
  const polling = useNodeStatusPolling({ enabled: false });
  const probes = useExternalServiceProbes({
    enabled: options.enabled ?? true,
    probeIntervalMs: options.probeIntervalMs,
    fetcher: options.fetcher,
  });
  const initialNodeStatus = options.initialNodeStatus ?? null;
  const initialCapturedAt = options.initialCapturedAt ?? null;

  return useMemo<UseServiceStatusResult>(() => {
    const buf = polling.byNodeId.get(nodeId) ?? null;
    // Fall back to the SSR-rendered `NodeStatus` when the polling
    // buffer has nothing for this node yet. Without this fallback the
    // first paint (server *and* client pre-effect) renders every card
    // as `Off / absent`, because the shared polling store starts
    // empty on the server snapshot and the seed effect only runs
    // after hydration. Once a real poll lands, `buf.latest` takes
    // over.
    const live = buf?.latest ?? initialNodeStatus;
    const entries = composeServiceStatusEntries({
      live,
      externalProbes: probes.outcomes,
    });
    const status: ServiceStatusMap = entriesToStatusMap(entries);

    // Key the "last checked" timestamp to the signal that actually
    // refreshed each card. Agent cards share the per-node poll
    // timestamp; external cards carry their own probe timestamp so a
    // Giganto probe does not refresh the TI Container footer (and
    // vice versa) when the probes are staggered.
    const nodeSampleAt = buf?.lastSampleAt ?? initialCapturedAt;
    const lastCheckedByService = {} as Record<ServiceKind, Date | null>;
    for (const kind of AGENT_SERVICE_KINDS) {
      lastCheckedByService[kind] = nodeSampleAt;
    }
    for (const kind of EXTERNAL_SERVICE_KINDS) {
      lastCheckedByService[kind] = probes.lastCheckedAt[kind];
    }

    return { status, entries, lastCheckedByService };
  }, [
    nodeId,
    polling.byNodeId,
    probes.outcomes,
    probes.lastCheckedAt,
    initialNodeStatus,
    initialCapturedAt,
  ]);
}
