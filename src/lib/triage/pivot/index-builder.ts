/**
 * Pivot index over the Triage corpus.
 *
 * The index is built once over the `≤5,000`-event scored list from
 * `TriageLoadResult.events` and consulted by the Related-events panel
 * for every breadcrumb step. No network requests are issued when the
 * operator changes pivot steps in Tier 1 (per #452 acceptance) — the
 * panel reads only from this in-memory index.
 *
 * Per #447 §6 deprecatable seam this module must not import from any
 * policy module. Tier 2 expansion to all detection events is #453's
 * scope.
 */

import type { ScoredTriageEvent } from "../types";
import {
  eventsWithinSameKindWindow,
  getPivotDimension,
  isDimensionAvailableInBaseline,
  PIVOT_DIMENSIONS,
  type PivotDimension,
  type PivotDimensionId,
  type PivotValue,
  parseSameKindKey,
} from "./dimensions";

/** Triage menu mode toggle — gates which dimensions the index covers. */
export type TriagePivotMode = "baseline" | "policy";

/** Default rows shown per dimension before "Show more" is clicked. */
export const PIVOT_GROUP_DEFAULT_ROWS = 10;
/** Max rows shown per dimension after "Show more" is clicked. */
export const PIVOT_GROUP_EXPANDED_ROWS = 50;

/** A single (dimension, value) pair carrying the events that share it. */
export interface PivotIndexEntry {
  dimension: PivotDimensionId;
  value: PivotValue;
  /** Events sharing this dimension+value, sorted score desc. */
  events: ScoredTriageEvent[];
}

/**
 * Sparse index over the loaded corpus. `byDimension` carries
 * value-keyed `Map<valueKey, PivotIndexEntry>` buckets for the
 * standard pivot dimensions. `corpus` is retained so dynamic
 * dimensions — currently `sameKindWithin15Min`, which resolves
 * focus-relative ±15-minute membership rather than a fixed bucket —
 * can compute their event sets on demand without rebuilding the
 * index per click.
 */
export interface PivotIndex {
  byDimension: Map<PivotDimensionId, Map<string, PivotIndexEntry>>;
  corpus: readonly ScoredTriageEvent[];
}

function compareEventsByScoreDesc(
  a: ScoredTriageEvent,
  b: ScoredTriageEvent,
): number {
  if (a.score !== b.score) return b.score - a.score;
  // Tie-break newest first so the panel reads chronologically inside a
  // score band — operator scanning a high-score JA3 group sees the
  // recent activity first.
  if (a.time !== b.time) return a.time < b.time ? 1 : -1;
  return 0;
}

/** Dimensions whose membership is computed on demand from the corpus. */
const DYNAMIC_DIMENSIONS: ReadonlySet<PivotDimensionId> = new Set([
  "sameKindWithin15Min",
]);

function activeDimensionsFor(mode: TriagePivotMode): readonly PivotDimension[] {
  return mode === "baseline"
    ? PIVOT_DIMENSIONS.filter(isDimensionAvailableInBaseline)
    : PIVOT_DIMENSIONS;
}

/**
 * Build the index over a flat scored-event list. O(events × dims) but
 * dims is a fixed ~18, so the cost is dominated by the 5,000-event
 * corpus cap from #451.
 *
 * `mode` (default `"baseline"`) gates Policy-only dimensions out of
 * the index when reading from the corpus A row shape — those
 * dimensions read from `TriageEvent` fields that are not present on
 * `baseline_triaged_event` and would always extract no values, so
 * skipping them at index time keeps the panel honest about which
 * sections are available in Baseline mode.
 */
export function buildPivotIndex(
  events: readonly ScoredTriageEvent[],
  mode: TriagePivotMode = "policy",
): PivotIndex {
  const dimensions = activeDimensionsFor(mode);
  const byDimension: PivotIndex["byDimension"] = new Map();
  for (const dim of dimensions) {
    if (DYNAMIC_DIMENSIONS.has(dim.id)) continue;
    byDimension.set(dim.id, new Map());
  }
  for (const event of events) {
    for (const dim of dimensions) {
      if (DYNAMIC_DIMENSIONS.has(dim.id)) continue;
      const values = dim.extract(event);
      if (values.length === 0) continue;
      const bucket = byDimension.get(dim.id);
      if (!bucket) continue;
      for (const value of values) {
        let entry = bucket.get(value.key);
        if (!entry) {
          entry = { dimension: dim.id, value, events: [] };
          bucket.set(value.key, entry);
        }
        entry.events.push(event);
      }
    }
  }
  // Sort each entry once at build time. The panel just slices.
  for (const bucket of byDimension.values()) {
    for (const entry of bucket.values()) {
      entry.events.sort(compareEventsByScoreDesc);
    }
  }
  return { byDimension, corpus: events };
}

/**
 * Look up a single (dimension, value) entry, or `null` if absent.
 * For dynamic dimensions the entry is materialized from the corpus:
 * `sameKindWithin15Min` resolves to events with the same typename
 * whose time is within ±15 minutes of the value key's center.
 */
export function lookupPivotEntry(
  index: PivotIndex,
  dimension: PivotDimensionId,
  valueKey: string,
): PivotIndexEntry | null {
  if (dimension === "sameKindWithin15Min") {
    const parsed = parseSameKindKey(valueKey);
    if (!parsed) return null;
    const events = eventsWithinSameKindWindow(
      index.corpus,
      parsed.typename,
      parsed.centerMs,
    );
    if (events.length === 0) return null;
    events.sort(compareEventsByScoreDesc);
    const label = `${parsed.typename} near ${new Date(parsed.centerMs).toISOString()}`;
    return {
      dimension,
      value: { key: valueKey, label },
      events,
    };
  }
  return index.byDimension.get(dimension)?.get(valueKey) ?? null;
}

/**
 * Collect every event that matches ANY of the focus values for the
 * given dimension. Used by the Related-events panel to render a row
 * group: "all events sharing a registrable domain with the focused
 * asset". Result is sorted by score desc and deduped (an event that
 * carries multiple focus values for the same dimension appears once).
 *
 * For `sameKindWithin15Min` the focus values encode a center time
 * each: matching events are those of the same typename within ±15
 * minutes of any focus center, unioned across the focus.
 */
export function eventsMatchingFocusValues(
  index: PivotIndex,
  dimension: PivotDimensionId,
  focusValueKeys: readonly string[],
): ScoredTriageEvent[] {
  if (focusValueKeys.length === 0) return [];
  if (dimension === "sameKindWithin15Min") {
    const seen = new Set<ScoredTriageEvent>();
    const out: ScoredTriageEvent[] = [];
    for (const key of focusValueKeys) {
      const parsed = parseSameKindKey(key);
      if (!parsed) continue;
      for (const ev of eventsWithinSameKindWindow(
        index.corpus,
        parsed.typename,
        parsed.centerMs,
      )) {
        if (seen.has(ev)) continue;
        seen.add(ev);
        out.push(ev);
      }
    }
    out.sort(compareEventsByScoreDesc);
    return out;
  }
  const bucket = index.byDimension.get(dimension);
  if (!bucket) return [];
  const seen = new Set<ScoredTriageEvent>();
  const out: ScoredTriageEvent[] = [];
  for (const key of focusValueKeys) {
    const entry = bucket.get(key);
    if (!entry) continue;
    for (const ev of entry.events) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      out.push(ev);
    }
  }
  out.sort(compareEventsByScoreDesc);
  return out;
}

/**
 * Extract the union of all values for `dimension` carried by the
 * given focus events. The Related-events panel uses this twice:
 *
 *   1. To decide whether to render a dimension at all — if the focus
 *      has zero values for the dimension, the dimension is hidden.
 *   2. To pass into {@link eventsMatchingFocusValues} to find the row
 *      set for that dimension.
 *
 * Returned in extraction order, deduped by value key.
 */
export function focusValuesFor(
  dimension: PivotDimensionId,
  focusEvents: readonly ScoredTriageEvent[],
): PivotValue[] {
  const dim = getPivotDimension(dimension);
  return collectValues(dim, focusEvents);
}

function collectValues(
  dim: PivotDimension,
  events: readonly ScoredTriageEvent[],
): PivotValue[] {
  const seen = new Set<string>();
  const out: PivotValue[] = [];
  for (const event of events) {
    for (const v of dim.extract(event)) {
      if (seen.has(v.key)) continue;
      seen.add(v.key);
      out.push(v);
    }
  }
  return out;
}

/**
 * One section of the Related-events panel: a dimension and the rows
 * to render under it. `totalCount` is the full match count in the
 * loaded corpus (not capped at 50) so the panel's "Showing N of M"
 * hint can render the actually-visible row count once the operator
 * clicks "Show more"; the hint is suppressed while the section is
 * collapsed at the default-row cap so the count never disagrees
 * with what is on screen.
 */
export interface PivotPanelSection {
  dimension: PivotDimensionId;
  family: string;
  /**
   * The values from the focus that drive this section. Surfaces in
   * the breadcrumb crumb construction when the operator pivots —
   * Phase 1.A shows the first focus value as the section's "this
   * asset's value" hint, all values are searchable in the index.
   */
  focusValues: PivotValue[];
  events: ScoredTriageEvent[];
  totalCount: number;
}

/**
 * Build the Related-events panel content for a focus event set.
 *
 * Rules (#452 AC):
 *   - Hide dimensions where the focus carries no value.
 *   - Hide dimensions where the loaded corpus has zero matches (the
 *     focus value's only matches are the focus events themselves
 *     and they overlap entirely with the focus set — nothing pivot-
 *     interesting to show).
 *   - Cap each section at {@link PIVOT_GROUP_EXPANDED_ROWS} rows in
 *     the data; the UI renders the first
 *     {@link PIVOT_GROUP_DEFAULT_ROWS} until "Show more" is clicked.
 *   - Sort within a section by event score desc, ties broken
 *     newest-first.
 */
export function buildPivotPanel(
  index: PivotIndex,
  focusEvents: readonly ScoredTriageEvent[],
  options: { excludeFocusEvents?: boolean; mode?: TriagePivotMode } = {},
): PivotPanelSection[] {
  const { excludeFocusEvents = true, mode = "policy" } = options;
  const focusSet = excludeFocusEvents ? new Set(focusEvents) : null;
  const sections: PivotPanelSection[] = [];
  for (const dim of activeDimensionsFor(mode)) {
    const focusValues = collectValues(dim, focusEvents);
    if (focusValues.length === 0) continue;
    const matched = eventsMatchingFocusValues(
      index,
      dim.id,
      focusValues.map((v) => v.key),
    );
    const visible = focusSet
      ? matched.filter((ev) => !focusSet.has(ev))
      : matched;
    if (visible.length === 0) continue;
    sections.push({
      dimension: dim.id,
      family: dim.family,
      focusValues,
      events: visible.slice(0, PIVOT_GROUP_EXPANDED_ROWS),
      totalCount: visible.length,
    });
  }
  return sections;
}
