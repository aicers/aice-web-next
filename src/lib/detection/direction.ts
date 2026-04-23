/**
 * Direction multi-select helpers for the Detection filter drawer.
 *
 * The drawer exposes the three `FlowKind` values as a multi-select.
 * "All selected" is equivalent to "no filter" — it's omitted from
 * the submitted `EventListFilterInput.directions`. "None selected"
 * is not allowed; the toggle helper silently refuses the last
 * deselection so the user can never reach an empty set.
 */

import type { FlowKind } from "./types";

/**
 * Canonical ordering for the three flow kinds. Used to keep the
 * drawer order, the submitted `directions` array, and the chip-bar
 * order deterministic regardless of the order the operator clicked.
 */
export const FLOW_KINDS = [
  "OUTBOUND",
  "INTERNAL",
  "INBOUND",
] as const satisfies readonly FlowKind[];

export const DEFAULT_DIRECTIONS: readonly FlowKind[] = FLOW_KINDS;

export function isAllDirections(directions: readonly FlowKind[]): boolean {
  return FLOW_KINDS.every((kind) => directions.includes(kind));
}

/**
 * Toggle `kind` in `current`, preserving `FLOW_KINDS` ordering. If
 * `kind` is the only selection, silently revert to all three
 * (the "no filter" default) rather than entering an empty state.
 */
export function toggleDirection(
  current: readonly FlowKind[],
  kind: FlowKind,
): FlowKind[] {
  if (current.includes(kind)) {
    if (current.length <= 1) return [...FLOW_KINDS];
    return FLOW_KINDS.filter((k) => k !== kind && current.includes(k));
  }
  return FLOW_KINDS.filter((k) => k === kind || current.includes(k));
}

/** Reorder an arbitrary `FlowKind[]` into canonical `FLOW_KINDS` order. */
export function normalizeDirections(
  directions: readonly FlowKind[],
): FlowKind[] {
  return FLOW_KINDS.filter((k) => directions.includes(k));
}

/**
 * Encode a draft `directions` selection for `EventListFilterInput`.
 * Returns `undefined` when all three are selected so the submitted
 * filter omits `directions` (matching the "no filter" contract).
 */
export function directionsForFilterInput(
  directions: readonly FlowKind[] | null | undefined,
): FlowKind[] | undefined {
  if (!directions || directions.length === 0 || isAllDirections(directions)) {
    return undefined;
  }
  return normalizeDirections(directions);
}

/**
 * Rehydrate the drawer draft from a committed
 * `EventListFilterInput.directions`. An omitted or empty value
 * means "no filter" → all three selected.
 */
export function readDirectionsFromInput(
  directions: readonly FlowKind[] | null | undefined,
): FlowKind[] {
  if (!directions || directions.length === 0) return [...DEFAULT_DIRECTIONS];
  return normalizeDirections(directions);
}

export interface DirectionChip {
  id: string;
  label: string;
  value: string;
}

export interface DirectionChipLabels {
  /** Chip prefix label, e.g. `"Direction"`. */
  label: string;
  /** Short per-value chip text, e.g. `OUTBOUND` → `"Outbound"`. */
  values: Record<FlowKind, string>;
}

/**
 * Build per-value chips for the active filter chip bar. Returns an
 * empty list when all three are selected (the "no filter" state)
 * and one chip per selected value otherwise, in `FLOW_KINDS` order.
 */
export function buildDirectionChips(
  directions: readonly FlowKind[] | null | undefined,
  labels: DirectionChipLabels,
): DirectionChip[] {
  if (!directions || directions.length === 0 || isAllDirections(directions)) {
    return [];
  }
  return FLOW_KINDS.filter((k) => directions.includes(k)).map((k) => ({
    id: `direction:${k}`,
    label: labels.label,
    value: labels.values[k],
  }));
}
