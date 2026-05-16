/**
 * Strictness slider stops (issue #471).
 *
 * The slider lets an analyst dial the volume of Triage menu results up
 * or down at read time. Stops correspond to fixed cutoffs against the
 * read-time `baseline_score = cume_dist()` projection in
 * {@link SELECT_MENU_COHORT_SQL} — the cutoff for "Top X%" is
 * `1 - X/100` by identity.
 *
 * See `RFC.md` in this directory for the rationale (stop count, labels,
 * default position, "All" semantics, hash/query-param contract).
 *
 * This module is plain TypeScript (no `server-only`); both the client
 * slider component and the server-side menu loader import it so the
 * stop set is the single source of truth.
 */

export type StrictnessStopId = "top5" | "top20" | "top50" | "top80" | "all";

export interface StrictnessStop {
  /** Stable URL/query/localStorage token. */
  id: StrictnessStopId;
  /** Hint key for the slider UI translation lookup. */
  labelKey: "top5" | "top20" | "top50" | "top80" | "all";
  /**
   * Cutoff applied against `baseline_score = cume_dist()` in
   * {@link SELECT_MENU_COHORT_SQL}. A row passes when
   * `baseline_score >= cutoff`. "All" uses `0` (no additional cutoff)
   * — the cadence threshold owned by #456 is still in effect.
   */
  cutoff: number;
  /**
   * Multiplier applied to `composeMenu`'s `defaultN` (RFC §6 option
   * (b), #471 §5). Tightens or widens the per-bucket quota that
   * derives from #462's `FINAL_COUNT` curve. `null` lifts the quota
   * entirely — used at the "All" stop so the menu's per-bucket cap
   * is the SQL candidate cap, not `composeMenu` itself. Strict stops
   * apply a smaller multiplier (the analyst opted into a narrower
   * set); loose stops apply a larger multiplier so "Top 80%"
   * actually widens beyond the production default.
   */
  defaultNMultiplier: number | null;
}

/**
 * Ordered loose → strict. UI renders the slider with this orientation
 * so the "tighten the result set" intent maps to "move the thumb to
 * the right". The default stop is the middle stop (`top50`) so a
 * first-time analyst sees a moderate volume of results.
 */
export const STRICTNESS_STOPS: readonly StrictnessStop[] = [
  { id: "all", labelKey: "all", cutoff: 0, defaultNMultiplier: null },
  { id: "top80", labelKey: "top80", cutoff: 0.2, defaultNMultiplier: 2 },
  { id: "top50", labelKey: "top50", cutoff: 0.5, defaultNMultiplier: 1 },
  { id: "top20", labelKey: "top20", cutoff: 0.8, defaultNMultiplier: 0.5 },
  { id: "top5", labelKey: "top5", cutoff: 0.95, defaultNMultiplier: 0.25 },
] as const;

export const DEFAULT_STRICTNESS_STOP_ID: StrictnessStopId = "top50";

const STOPS_BY_ID = new Map<StrictnessStopId, StrictnessStop>(
  STRICTNESS_STOPS.map((s) => [s.id, s]),
);

/**
 * Parse an arbitrary string (URL query / hash / localStorage) into a
 * known stop id. Unknown values map to the default — the slider must
 * never error out on stale persisted state, and `loadTriagePeriod`
 * must always be callable with a valid stop.
 *
 * This coercion is appropriate for hydration boundaries (URL/hash/
 * localStorage) where stale state must not block the UI. It is NOT
 * appropriate at strictly-validated boundaries (e.g. the engagement
 * ingest endpoint) — use {@link isStrictnessStopId} there so a
 * malformed producer is rejected instead of silently rewritten to the
 * default.
 */
export function parseStrictnessStopId(
  raw: string | null | undefined,
): StrictnessStopId {
  if (raw === null || raw === undefined) return DEFAULT_STRICTNESS_STOP_ID;
  if (STOPS_BY_ID.has(raw as StrictnessStopId)) {
    return raw as StrictnessStopId;
  }
  return DEFAULT_STRICTNESS_STOP_ID;
}

/**
 * Strict type guard: returns true only when `raw` is a known stop id.
 * Unlike {@link parseStrictnessStopId}, this never coerces unknown
 * values. Used at validated boundaries (engagement ingest) where a
 * malformed value must surface as a 400, not as a silent fallback to
 * the default stop.
 */
export function isStrictnessStopId(raw: unknown): raw is StrictnessStopId {
  return typeof raw === "string" && STOPS_BY_ID.has(raw as StrictnessStopId);
}

/** Resolve a stop record by id. Unknown ids fall back to the default. */
export function getStrictnessStop(id: StrictnessStopId): StrictnessStop {
  return (
    STOPS_BY_ID.get(id) ??
    (STOPS_BY_ID.get(DEFAULT_STRICTNESS_STOP_ID) as StrictnessStop)
  );
}

/** Convenience: cutoff value for a stop id. */
export function cutoffForStop(id: StrictnessStopId): number {
  return getStrictnessStop(id).cutoff;
}

/**
 * Convenience: `defaultN` multiplier for a stop id. `null` lifts the
 * `composeMenu` quota entirely (the "All" stop, #471 §5).
 */
export function defaultNMultiplierForStop(id: StrictnessStopId): number | null {
  return getStrictnessStop(id).defaultNMultiplier;
}
