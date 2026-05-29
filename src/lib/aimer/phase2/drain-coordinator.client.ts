/**
 * In-tab Phase 2 drain coordinator (#651).
 *
 * Two call sites drain the opportunistic push queue from the browser:
 *
 *   - the app-shell cadence manager (one {@link createPeriodicDrain} per
 *     in-scope customer × `['baseline_event', 'story']`), and
 *   - the Settings "Sync now" button (all kinds, on demand).
 *
 * Both ultimately call {@link drainOpportunisticPushQueue}. Within a
 * single tab they can otherwise fire concurrent drains for the *same*
 * `(kind, customerId)` — wasteful (duplicate `next-batch` round-trips)
 * even though aimer-web's natural-key idempotency makes it harmless on
 * the wire. The per-instance `inFlight` guard inside `createPeriodicDrain`
 * only coordinates one controller with itself; it cannot see the Sync
 * now button, which lives in a different React subtree.
 *
 * {@link coordinatedDrain} is the shared chokepoint. It is single-flight
 * per `(kind, customerId)` *within the tab*: a second caller for a key
 * with a drain already in flight joins the in-flight promise and
 * receives the same {@link DrainResult} instead of starting a second
 * drain. Different kinds / different customers run concurrently.
 *
 * Cross-tab duplication is intentionally NOT coordinated here — RFC 0002
 * Phase 2 relies on `claimPendingNotices` being non-exclusive and on
 * aimer-web's natural-key idempotency to absorb the duplicate, so a
 * global (cross-tab) lock is unnecessary.
 */

import {
  type DrainOptions,
  type DrainResult,
  drainOpportunisticPushQueue,
  type Phase2DrainKind,
} from "./transport.client";

const inFlight = new Map<string, Promise<DrainResult>>();

function keyFor(kind: Phase2DrainKind, customerId: number): string {
  return `${kind}:${customerId}`;
}

/**
 * Run an opportunistic drain for `(kind, customerId)`, joining an
 * already-in-flight drain for the same key rather than starting a
 * second one. The `options` of the *joining* caller are ignored — the
 * winning (first) caller's options drive the shared drain — which is
 * acceptable because both call sites use the same drain semantics
 * (full drain to exhaustion); only the progress callback differs, and a
 * joined caller simply does not receive per-batch progress.
 */
export function coordinatedDrain(
  kind: Phase2DrainKind,
  customerId: number,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const key = keyFor(kind, customerId);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = drainOpportunisticPushQueue(
    kind,
    customerId,
    options,
  ).finally(() => {
    // Only clear if this promise is still the registered one — a later
    // drain for the same key cannot have replaced it while we held the
    // slot, but guard anyway so a stale settle never evicts a fresh
    // entry.
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: clear the in-flight registry between cases. */
export function __resetDrainCoordinatorForTests(): void {
  inFlight.clear();
}
