/**
 * Pivot breadcrumb state for the Triage menu (Phase 1.A — Tier 1).
 *
 * The breadcrumb is local React state in the Triage view (per #452 —
 * URL persistence is out of scope for 1A-2). Each step has the
 * information the Related-events panel needs to determine its focus
 * event set:
 *
 *   - `asset` step: focus = events whose `origAddr === address`
 *   - `dimension` step: focus = events with the given `(dimension,
 *     valueKey)` pair
 */

import type { ScoredTriageEvent } from "../types";
import type { PivotDimensionId, PivotValue } from "./dimensions";
import {
  buildPivotIndex,
  lookupPivotEntry,
  type PivotIndex,
  type TriagePivotMode,
} from "./index-builder";

export type PivotStep =
  | { kind: "asset"; customerId: number; address: string }
  | {
      kind: "dimension";
      dimension: PivotDimensionId;
      value: PivotValue;
    };

/**
 * Append a new pivot step to the trail. If the new step matches the
 * tail (same `kind` + identifier) it is ignored — clicking the same
 * pivot twice should not double the breadcrumb.
 */
export function appendPivotStep(
  trail: readonly PivotStep[],
  next: PivotStep,
): PivotStep[] {
  const tail = trail.length > 0 ? trail[trail.length - 1] : null;
  if (tail && stepEquals(tail, next)) return [...trail];
  return [...trail, next];
}

/**
 * Truncate the trail to the first `count` crumbs. Used by the
 * "click an earlier crumb" affordance: clicking crumb at index `i`
 * restores the trail to `[0..i]` inclusive.
 */
export function backtrackPivotTrail(
  trail: readonly PivotStep[],
  toIndexInclusive: number,
): PivotStep[] {
  if (toIndexInclusive < 0) return [];
  return trail.slice(0, toIndexInclusive + 1);
}

/**
 * Reset the breadcrumb to its root (just the asset crumb, if any).
 * Used after a period-change confirmation modal.
 */
export function clearPivotTrail(trail: readonly PivotStep[]): PivotStep[] {
  if (trail.length === 0) return [];
  const head = trail[0];
  return head.kind === "asset" ? [head] : [];
}

/**
 * `true` when the trail has at least one dimension crumb beyond the
 * root asset — used by the period-change handler to decide whether
 * to surface the confirmation modal.
 */
export function hasPivotedAwayFromAsset(trail: readonly PivotStep[]): boolean {
  return trail.some((step) => step.kind === "dimension");
}

function stepEquals(a: PivotStep, b: PivotStep): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "asset" && b.kind === "asset") {
    return a.customerId === b.customerId && a.address === b.address;
  }
  if (a.kind === "dimension" && b.kind === "dimension") {
    return a.dimension === b.dimension && a.value.key === b.value.key;
  }
  return false;
}

/**
 * Resolve the focus event set for a single pivot step.
 *
 *   - For `asset` steps, the focus is every loaded event whose
 *     originator address equals the asset's address. This intentionally
 *     uses the full corpus (not the 50-cap detail panel events) so
 *     pivot dimensions like `country` or `userAgent` aren't dropped
 *     just because they happened on a non-baseline event.
 *   - For `dimension` steps, the focus is the events the index
 *     already groups by `(dimension, value)`.
 */
export function resolveStepFocusEvents(
  step: PivotStep,
  events: readonly ScoredTriageEvent[],
  index: PivotIndex,
): ScoredTriageEvent[] {
  if (step.kind === "asset") {
    // Asset focus matches on `(customerId, address)` so two same-IP
    // assets on different customers stay distinct. The SQL-backed
    // corpus rows from `selectCorpusEvents` carry a `${customerId}/
    // ${event_key}` `rowKey` (not the `${customerId}/${address}#index`
    // shape used by per-asset detail events), so we filter on the
    // event's explicit `customerId` tenant marker rather than on the
    // rowKey prefix.
    return events.filter(
      (ev) => ev.origAddr === step.address && ev.customerId === step.customerId,
    );
  }
  const entry = lookupPivotEntry(index, step.dimension, step.value.key);
  return entry ? entry.events.slice() : [];
}

/**
 * Build a human-readable label for a pivot step. UI components
 * compose these into a "Asset 10.0.0.1 › ja3 abc..." trail. The
 * caller supplies the dimension label (i18n) and the helper just
 * concatenates with the value's display label.
 */
export function describePivotStep(
  step: PivotStep,
  dimensionLabel: (id: PivotDimensionId) => string,
): { dimensionLabel: string; valueLabel: string } {
  if (step.kind === "asset") {
    return {
      dimensionLabel: "asset",
      valueLabel: step.address,
    };
  }
  return {
    dimensionLabel: dimensionLabel(step.dimension),
    valueLabel: step.value.label,
  };
}

/**
 * Convenience — many UI sites need the index built once and the
 * focus set for the current step. Pulled out so the test suite can
 * exercise the trail walker without rebuilding the index per step.
 */
export function pivotIndexFor(
  events: readonly ScoredTriageEvent[],
  mode: TriagePivotMode = "policy",
): PivotIndex {
  return buildPivotIndex(events, mode);
}
