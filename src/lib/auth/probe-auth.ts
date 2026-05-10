"use client";

/**
 * Shared cheap probe used by client-side caches that hold customer-
 * private data to detect a stale session before serving a cached
 * payload (#393 Task A — Option 1b).
 *
 * Every probe is one GET to `/api/auth/me`. The endpoint runs through
 * `withAuth`, which 401s on `token_version` mismatch — so when the
 * customer-assignment APIs bump `token_version`, every cache surface
 * that calls `probeAuthOrRedirect` before serving discovers the
 * mismatch instead of painting stale rows.
 *
 * Two surfaces are exposed so the same probe fits all four call sites
 * the issue lists:
 *
 * - {@link probeAuthOrRedirect} — a plain `async` helper safe to call
 *   from module-level code such as the polling driver's `tick()` (which
 *   cannot host React hooks).
 * - {@link useAuthProbeOnCacheHit} — a thin React hook wrapper for
 *   components that prefer the hook idiom.
 *
 * On a 401 the helper:
 *   (a) invokes the consumer-supplied `onUnauthorized` callback so the
 *       caller can drop its own cache, and
 *   (b) initiates a single `window.location` redirect to `/sign-in?
 *       reason=session-ended` so the operator is forced through
 *       sign-in and every mounted client cache is torn down on the
 *       hard navigation.
 *
 * Concurrent callers hitting the same fingerprint share the same
 * in-flight request via the `inFlight` de-dup, so several cache
 * surfaces firing together (e.g. the Detection drawer's sensor +
 * customer fetches) still produce only one `/api/auth/me` round trip.
 * There is intentionally no post-success debounce: an admin can bump
 * `token_version` between two cache hits, and a window where probes
 * are skipped would let stale rows paint for the duration of that
 * window. Each fresh cache hit must issue its own probe.
 */

import { useCallback } from "react";

export type ProbeResult = "ok" | "unauthorized" | "error";

let inFlight: Promise<ProbeResult> | null = null;
let redirectStarted = false;

async function performProbe(): Promise<ProbeResult> {
  try {
    const res = await fetch("/api/auth/me", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return "unauthorized";
    if (res.ok) return "ok";
    return "error";
  } catch {
    return "error";
  }
}

/**
 * Run the cheap auth probe. Concurrent callers share the same
 * in-flight request via the `inFlight` de-dup. A network error reports
 * `"error"` (the caller decides whether to fall through to the cache
 * or treat as a soft failure); only a confirmed 401 reports
 * `"unauthorized"`.
 */
export async function probeAuth(): Promise<ProbeResult> {
  if (inFlight) return inFlight;
  inFlight = performProbe().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function redirectToSignIn(): void {
  if (redirectStarted) return;
  redirectStarted = true;
  if (typeof window === "undefined") return;
  window.location.assign("/sign-in?reason=session-ended");
}

/**
 * Probe `/api/auth/me`; on 401 invoke `onUnauthorized` (typically a
 * cache-clear) and trigger a hard redirect to the sign-in page. Returns
 * `true` when the caller may proceed to serve from cache, `false` when
 * the redirect has fired and the cache must not be surfaced.
 *
 * Network / 5xx errors return `true` — we do not push the operator
 * back through sign-in for transient failures. The cache hit
 * proceeds; the polling loop / next user action will retry.
 */
export async function probeAuthOrRedirect(
  onUnauthorized?: () => void,
): Promise<boolean> {
  const result = await probeAuth();
  if (result === "unauthorized") {
    try {
      onUnauthorized?.();
    } catch {
      // Best-effort cache clear; the redirect tears everything down
      // anyway on the next paint, so a thrown clear must not stop
      // the redirect from running.
    }
    redirectToSignIn();
    return false;
  }
  return true;
}

/**
 * React hook variant of {@link probeAuthOrRedirect}. The returned
 * callback is stable across renders, so a parent can pass it down
 * without re-binding effects on every render.
 */
export function useAuthProbeOnCacheHit() {
  return useCallback(
    (onUnauthorized?: () => void) => probeAuthOrRedirect(onUnauthorized),
    [],
  );
}

/** Test-only reset for the module-level probe state. */
export function __resetProbeAuthForTests(): void {
  inFlight = null;
  redirectStarted = false;
}
