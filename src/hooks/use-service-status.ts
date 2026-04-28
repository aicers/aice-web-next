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

/**
 * Default polling cadence for the per-external-service probe. Mirrors
 * `NEXT_PUBLIC_NODE_STATUS_POLL_MS` so the external probes track the
 * same operator-tunable cadence as the node-status poll. Clamped so a
 * misconfigured override cannot hammer Giganto / Tivan.
 */
const DEFAULT_PROBE_MS = 10_000;
const PROBE_MS_MIN = 5_000;
const PROBE_MS_MAX = 300_000;

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
  const abort = new AbortController();
  probeAborts[index] = abort;
  try {
    const outcome = await activeProbeFetcher(kind, abort.signal);
    setExternalProbe(kind, outcome, new Date());
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    setExternalProbe(kind, "off", new Date());
  } finally {
    if (probeAborts[index] === abort) probeAborts[index] = null;
  }
}

function startProbeLoop(intervalMs: number): void {
  clearProbeTimers();
  probeTimers = PROBE_KINDS.map(() => null);
  probeAborts = PROBE_KINDS.map(() => null);
  // Stagger: spread the first dispatch of each probe across the
  // interval so Giganto and Tivan never fire on the same tick. Each
  // probe then fires every `intervalMs` from its own offset.
  const stagger = Math.floor(intervalMs / PROBE_KINDS.length);
  PROBE_KINDS.forEach((kind, index) => {
    const startDelay = index * stagger;
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
  /** Override the env-derived probe interval (clamped). */
  probeIntervalMs?: number;
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
 * Staggering: the first dispatch of each probe is offset by
 * `intervalMs / 2` so Giganto and Tivan never hit on the same tick.
 * Subsequent dispatches keep that offset.
 */
export function useExternalServiceProbes(
  options: UseExternalServiceProbesOptions = {},
): ExternalProbeSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeExternalProbe,
    getExternalProbeSnapshot,
    () => externalProbeInitial,
  );
  const intervalMs = readProbeIntervalMs(options.probeIntervalMs);
  const enabled = options.enabled ?? true;
  const fetcherRef = useRef(options.fetcher ?? defaultProbeFetcher);
  fetcherRef.current = options.fetcher ?? defaultProbeFetcher;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    activeProbeFetcher = fetcherRef.current;
    probeDriverCount += 1;
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
        startProbeLoop(intervalMs);
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
  }, [enabled, intervalMs]);

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
  probeIntervalMs?: number;
  fetcher?: typeof defaultProbeFetcher;
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

  return useMemo<UseServiceStatusResult>(() => {
    const buf = polling.byNodeId.get(nodeId) ?? null;
    const live = buf?.latest ?? null;
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
    const nodeSampleAt = buf?.lastSampleAt ?? null;
    const lastCheckedByService = {} as Record<ServiceKind, Date | null>;
    for (const kind of AGENT_SERVICE_KINDS) {
      lastCheckedByService[kind] = nodeSampleAt;
    }
    for (const kind of EXTERNAL_SERVICE_KINDS) {
      lastCheckedByService[kind] = probes.lastCheckedAt[kind];
    }

    return { status, entries, lastCheckedByService };
  }, [nodeId, polling.byNodeId, probes.outcomes, probes.lastCheckedAt]);
}
