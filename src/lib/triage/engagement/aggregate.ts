import "server-only";

import type pg from "pg";
import { ENGAGEMENT_TUNABLES } from "../baseline/engagement-tunables";
import type { BucketEngagement } from "../baseline/menu";
import type { StrictnessStopId } from "../strictness/stops";

/**
 * Phase 2 per-bucket engagement aggregate (RFC 0003 §7).
 *
 * The menu loader calls {@link selectBucketEngagement} once per menu
 * load to fetch the per-bucket exposure-normalized engagement rate
 * and raw impression count, then passes the result into
 * `composeMenu` as `bucketEngagement`. With `gamma = 0` (Phase 2a
 * kill-switch) the rate is recorded for audit but `composeMenu`
 * multiplies it to zero, so menu output is byte-identical to RFC
 * 0001 — the read is wired so that the calibration retune (Phase 2b)
 * can flip `gamma > 0` without touching the loader.
 *
 * Read-time aggregation (one `GROUP BY` per side) was chosen over a
 * materialised periodic rollup per RFC §7's revisit trigger
 * (inherited from RFC 0001 §8): introduce periodic materialisation
 * only if measurement on production-shape Phase 2 data shows the
 * per-load cost is unacceptable.
 *
 * The query never runs at the `"all"` strictness stop — RFC §2.3
 * excludes it (the quota is lifted, so there is no engagement-driven
 * allocation to weight). The loader should skip this call at `"all"`
 * and pass `bucketEngagement: undefined` to `composeMenu`.
 *
 * @returns array of one entry per surfaced bucket in the active
 *   window. Buckets with no impressions in the window are absent;
 *   `composeMenu` treats absence as `engagement_signal = 0` (RFC §6
 *   cold-start / §5.2 new-bucket cap semantics).
 */
export async function selectBucketEngagement(
  pool: pg.Pool,
  options: {
    windowDays: 7 | 14 | 30;
    strictnessStop: StrictnessStopId;
  },
  signal?: AbortSignal,
): Promise<BucketEngagement[]> {
  signal?.throwIfAborted();
  // RFC §2.3: the `"all"` stop lifts the per-bucket quota entirely.
  // The engagement term has nothing to weight, so the aggregate is
  // not consulted. Returning empty is the right "noop" — the loader
  // can still call this helper unconditionally.
  if (options.strictnessStop === "all") return [];

  const includedShownBy = ENGAGEMENT_TUNABLES.includedShownBy;
  const engagedActions = ENGAGEMENT_TUNABLES.engagedActions;
  // §5.3 half-life is `windowDays * ratio`, in seconds.
  const halfLifeSeconds =
    options.windowDays *
    24 *
    60 *
    60 *
    ENGAGEMENT_TUNABLES.ewmaHalfLifeWindowRatio;
  const windowInterval = `${options.windowDays} days`;

  const result = await pool.query<{
    slot_bucket: string;
    impression_count: string;
    engagement_rate: string;
  }>(ENGAGEMENT_AGGREGATE_SQL, [
    windowInterval,
    halfLifeSeconds,
    options.strictnessStop,
    includedShownBy as unknown as string[],
    engagedActions as unknown as string[],
  ]);
  signal?.throwIfAborted();
  return result.rows.map((row) => ({
    bucketKey: row.slot_bucket,
    engagementRate: clampToUnit(Number(row.engagement_rate)),
    impressionCount: Number(row.impression_count),
    windowDays: options.windowDays,
  }));
}

function clampToUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Per-tenant raw impression count over the longest window, used by
 * RFC §6's tenant cold-start gate. Until this count crosses
 * `tenantColdStartMinImpressions`, the loader should pass
 * `bucketEngagement: undefined` so the engagement term is inert for
 * the tenant.
 */
export async function tenantImpressionCount(
  pool: pg.Pool,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const windowDays = Math.max(...ENGAGEMENT_TUNABLES.activeWindowsDays);
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
     FROM   engagement_impression
     WHERE  created_at >= NOW() - ($1::TEXT)::INTERVAL
       AND  shown_by = ANY($2::TEXT[])`,
    [
      `${windowDays} days`,
      ENGAGEMENT_TUNABLES.includedShownBy as unknown as string[],
    ],
  );
  signal?.throwIfAborted();
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * RFC §7 canonical aggregate. Read-time per menu load, one GROUP BY
 * per side. Emits raw `impression_count` (for §5.2 N_min) alongside
 * the EWMA-weighted ratio that is the actual rate.
 *
 * Bucket attribution for actions uses the impression's `slot_bucket`
 * (the authoritative source) via the `(menu_load_id, event_key)`
 * JOIN — `engagement_action.kind` alone does not distinguish
 * `HttpThreat:true` from `HttpThreat:false`.
 *
 * Parameters:
 *   $1 — window length as a Postgres interval string (e.g. `'14 days'`)
 *   $2 — EWMA half-life in seconds
 *   $3 — strictness_stop in effect
 *   $4 — included `shown_by` values (TEXT[])
 *   $5 — engaged action types (TEXT[])
 */
export const ENGAGEMENT_AGGREGATE_SQL = `
WITH impressions AS (
    SELECT i.slot_bucket,
           COUNT(*)                                                  AS raw_impression_count,
           SUM(EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - i.created_at))
                          / $2::DOUBLE PRECISION))                   AS weighted_imp
    FROM   engagement_impression i
    WHERE  i.created_at >= NOW() - ($1::TEXT)::INTERVAL
      AND  i.shown_by      = ANY($4::TEXT[])
      AND  i.strictness_stop = $3
    GROUP  BY i.slot_bucket
), engagements AS (
    SELECT i.slot_bucket,
           SUM(EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - i.created_at))
                          / $2::DOUBLE PRECISION)) AS weighted_eng
    FROM   engagement_impression i
    WHERE  i.created_at >= NOW() - ($1::TEXT)::INTERVAL
      AND  i.shown_by      = ANY($4::TEXT[])
      AND  i.strictness_stop = $3
      AND  EXISTS (
            SELECT 1
            FROM   engagement_action a
            WHERE  a.menu_load_id = i.menu_load_id
              AND  a.event_key    = i.event_key
              AND  a.action_type  = ANY($5::TEXT[])
          )
    GROUP  BY i.slot_bucket
)
SELECT  imp.slot_bucket,
        imp.raw_impression_count::TEXT AS impression_count,
        (COALESCE(eng.weighted_eng, 0)
         / NULLIF(imp.weighted_imp, 0))::TEXT AS engagement_rate
FROM    impressions imp
LEFT JOIN engagements eng USING (slot_bucket);
`;
