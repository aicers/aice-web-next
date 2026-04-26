/**
 * System-provided filter presets surfaced in the Detection sidebar's
 * `Recommended Filter` rail (Phase Detection-16).
 *
 * Presets are defined in code rather than persisted: they are global,
 * read-only in v1, and require no admin UI. The list is curated to
 * give operators a one-click broad view — long lookbacks plus a
 * direction-narrowed alternative — that complements the default 1
 * hour filter the page boots with.
 *
 * Each preset carries an i18n key (`nameKey`) so the rail label can
 * be translated to KR; the `period` is computed at activation time
 * via {@link computePeriodRange} so the start/end pair is always
 * relative to "now" rather than frozen at page load. Forward-compat:
 * presets only ever emit `mode: "structured"` filters today, but the
 * `Filter` shape from {@link Filter} stays the contract the rail
 * activates so the future search-language phase can extend the
 * preset list without touching the rail wiring.
 */

import type { Filter } from "./filter";
import { computePeriodRange, type PeriodKey } from "./period";
import type { EventListFilterInput, FlowKind } from "./types";

/**
 * Read-only preset definition. The `id` is a stable React key /
 * activation discriminator and is **not** localized. The `nameKey`
 * resolves under the `detection.recommendedFilters` namespace in the
 * i18n bundle so the same preset surfaces with locale-appropriate
 * copy.
 */
export interface RecommendedPreset {
  /** Stable identifier — used as React key and activation discriminator. */
  readonly id: string;
  /**
   * i18n key resolved under `detection.recommendedFilters` (e.g.
   * `last3Years` → `detection.recommendedFilters.last3Years`).
   */
  readonly nameKey: string;
  /**
   * Period the preset's start / end range derives from. Activation
   * computes the range against "now" so a preset bound to `3y` always
   * lines up with the period chip when the saved tab is opened.
   */
  readonly period: PeriodKey;
  /**
   * Extra `EventListFilterInput` fields layered onto the period-derived
   * range when the preset is activated. `start` / `end` are owned by
   * `period` and must not be set here. Empty / omitted means the
   * preset only narrows by time.
   */
  readonly extra?: Readonly<Omit<EventListFilterInput, "start" | "end">>;
}

/**
 * Curated v1 presets. Order matters — the rail renders in this order.
 * Names land in i18n under `detection.recommendedFilters.<key>`.
 *
 * Initial set (per #287):
 * - `last3Years` — Last 3 years, no other narrowing.
 * - `last1YearInbound` — Last 1 year, `directions: [INBOUND]`.
 * - `last1Year` — Last 1 year, no other narrowing.
 */
export const RECOMMENDED_PRESETS: readonly RecommendedPreset[] = [
  {
    id: "last-3-years",
    nameKey: "last3Years",
    period: "3y",
  },
  {
    id: "last-1-year-inbound",
    nameKey: "last1YearInbound",
    period: "1y",
    extra: { directions: ["INBOUND"] satisfies FlowKind[] },
  },
  {
    id: "last-1-year",
    nameKey: "last1Year",
    period: "1y",
  },
] as const;

/**
 * Resolve a preset into a concrete {@link Filter} the rail can hand to
 * the multi-tab wrapper's "load in new tab" path. The period range is
 * computed from `now` (defaults to `new Date()`; tests inject a fixed
 * clock) so the saved start / end always reflect the activation time.
 */
export function buildRecommendedFilter(
  preset: RecommendedPreset,
  now: Date = new Date(),
): Filter {
  const range = computePeriodRange(preset.period, now);
  const input: EventListFilterInput = {
    start: range.start,
    end: range.end,
    ...(preset.extra ?? {}),
  };
  return { mode: "structured", input };
}
