/**
 * Chip aggregation for the active-filter chip bar on the Detection
 * page. Isolated from `url-filters.ts` because pivot chips come
 * from URL hand-off while these chips are derived from the
 * committed `EventListFilterInput` the drawer built.
 *
 * The only dimension summarised here today is `sensors` — other
 * multi-select dimensions join later phases. The shape is generic
 * enough that follow-ups (#278-adjacent work) can extend it
 * without reshaping the chip bar: each summariser returns either
 * zero, N individual chips, or a single aggregate chip per the
 * umbrella's "1–3 → individual chips, more → `Dimension: N
 * selected`" rule.
 */

import type { EventListFilterInput } from "./types";

export interface FilterChip {
  /** Stable id used as React key and for test lookups. */
  id: string;
  /** Human-readable dimension prefix — e.g. "Sensor". */
  label: string;
  /** Concrete value or aggregate token. */
  value: string;
}

export interface SummarizeFilterLabels {
  sensor: string;
  /**
   * Template for the aggregate chip when a dimension has more than
   * the per-chip cap. `{count}` is substituted with the count.
   */
  sensorAggregate: string;
}

export interface SensorOption {
  id: string;
  name: string;
}

/** Upper bound on individual chips per multi-select dimension. */
export const CHIP_DIMENSION_CAP = 3;

/**
 * Build display chips from a committed `EventListFilterInput`.
 *
 * `sensorOptions` is used to resolve IDs → display names. An ID
 * with no matching option still produces a chip (falling back to
 * the raw ID) so a session-cache miss cannot silently drop a
 * committed filter from the bar — the user always sees that the
 * filter is in effect.
 */
export function summarizeFilter(
  filter: EventListFilterInput,
  sensorOptions: readonly SensorOption[],
  labels: SummarizeFilterLabels,
): FilterChip[] {
  const chips: FilterChip[] = [];

  const sensors = filter.sensors ?? [];
  if (sensors.length > 0 && sensors.length <= CHIP_DIMENSION_CAP) {
    const byId = new Map(sensorOptions.map((o) => [o.id, o.name]));
    for (const id of sensors) {
      chips.push({
        id: `sensor:${id}`,
        label: labels.sensor,
        value: byId.get(id) ?? id,
      });
    }
  } else if (sensors.length > CHIP_DIMENSION_CAP) {
    chips.push({
      id: "sensor:aggregate",
      label: labels.sensor,
      value: labels.sensorAggregate.replace("{count}", String(sensors.length)),
    });
  }

  return chips;
}
