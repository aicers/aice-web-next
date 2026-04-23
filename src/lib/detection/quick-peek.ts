import type { Event as DetectionEvent } from "./types";

/**
 * Pairs a Quick peek'd event with the stable server-side cursor key
 * that identified it in the result list at open time. The cursor
 * survives re-renders while the event payload and its index may not,
 * so reconciliation against a new result slice keys on it.
 */
export interface QuickPeekSelection {
  event: DetectionEvent;
  key: string;
}

/**
 * Reconcile a Quick peek selection against a newly committed result
 * set. Returns:
 *
 * - `null` when no row is selected, the committed query errored /
 *   went empty, or the inspected row's cursor is no longer in the
 *   new slice — the inspector should close and the Investigation
 *   handoff must not latch onto a stale event.
 * - The original selection object when the cursor still points at
 *   the same event reference — preserves referential identity so
 *   React state downstream of the inspector doesn't churn.
 * - A fresh `{event, key}` when the cursor is still present but the
 *   payload changed — keeps the inspector showing the just-committed
 *   data.
 *
 * `events` and `eventKeys` are expected to be parallel arrays (the
 * shell maintains this invariant). The helper intentionally does
 * nothing about `loading` — an in-flight query does not yet replace
 * the committed slice, so the selection stays put until the response
 * lands.
 */
export function revalidateQuickPeekSelection(
  current: QuickPeekSelection | null,
  events: readonly DetectionEvent[],
  eventKeys: readonly string[],
): QuickPeekSelection | null {
  if (!current) return null;
  const idx = eventKeys.indexOf(current.key);
  if (idx < 0) return null;
  const next = events[idx];
  if (!next) return null;
  if (next === current.event) return current;
  return { event: next, key: current.key };
}
