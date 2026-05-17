import "server-only";

import { createHash } from "node:crypto";
import type pg from "pg";

import { ENGAGEMENT_TUNABLES } from "../baseline/engagement-tunables";
import { ENGAGEMENT_AGGREGATE_SQL } from "./aggregate";

/**
 * Lazily seed the `engagement_model_snapshot` row for the active
 * `engagement_model_version` (RFC 0003 §8.2). Called by
 * `recordImpressions` before the first impression batch on a given
 * pool so the audit-side JOIN is always satisfiable:
 *
 *   `engagement_impression i
 *      LEFT JOIN engagement_model_snapshot s
 *        ON s.version = i.engagement_model_version`
 *
 * Without this row, Phase 2a impressions would carry
 * `engagement_model_version = 'phase2-v1'` but the JOIN would return
 * NULL — the audit chain the RFC's §8.2 contract is built on would be
 * broken from day one.
 *
 * The insert is `ON CONFLICT (version) DO NOTHING`, so concurrent
 * batches collapse to a single row. The per-pool cache skips the DB
 * call entirely once the version has been observed on the same
 * process / pool — a redeploy or a pool churn re-runs the upsert.
 *
 * The `aggregate_sql_digest` is the SHA-256 of the canonical §7 SQL
 * template (`ENGAGEMENT_AGGREGATE_SQL`) rather than a per-load filled
 * query. The digest changes only when the formula / aggregate shape
 * changes, which is exactly when `engagement_model_version` must bump.
 */
let seededPools = new WeakSet<pg.Pool>();

export async function ensureEngagementModelSnapshot(
  pool: pg.Pool,
): Promise<void> {
  if (seededPools.has(pool)) return;
  await pool.query(
    `INSERT INTO engagement_model_snapshot
       (version, formula, window_bounds, aggregate_sql_digest)
     VALUES ($1, $2::JSONB, $3::JSONB, $4)
     ON CONFLICT (version) DO NOTHING`,
    [
      ENGAGEMENT_TUNABLES.engagementModelVersion,
      JSON.stringify(buildFormula()),
      JSON.stringify(buildWindowBounds()),
      aggregateSqlDigest(),
    ],
  );
  seededPools.add(pool);
}

function buildFormula(): Record<string, unknown> {
  return {
    gamma: ENGAGEMENT_TUNABLES.gamma,
    per_bucket_min_impressions: ENGAGEMENT_TUNABLES.perBucketMinImpressions,
    ewma_half_life_window_ratio: ENGAGEMENT_TUNABLES.ewmaHalfLifeWindowRatio,
    exploration_share: ENGAGEMENT_TUNABLES.explorationShare,
    tenant_cold_start_min_impressions:
      ENGAGEMENT_TUNABLES.tenantColdStartMinImpressions,
    engaged_actions: [...ENGAGEMENT_TUNABLES.engagedActions],
    included_shown_by: [...ENGAGEMENT_TUNABLES.includedShownBy],
  };
}

function buildWindowBounds(): Record<string, unknown> {
  return {
    active_windows_days: [...ENGAGEMENT_TUNABLES.activeWindowsDays],
    half_life_window_ratio: ENGAGEMENT_TUNABLES.ewmaHalfLifeWindowRatio,
    selection_rule: "longest_window_with_min_impressions",
  };
}

let cachedDigest: string | undefined;

export function aggregateSqlDigest(): string {
  if (cachedDigest === undefined) {
    cachedDigest = createHash("sha256")
      .update(ENGAGEMENT_AGGREGATE_SQL)
      .digest("hex");
  }
  return cachedDigest;
}

/** Test-only: reset the per-pool seed cache. */
export function _resetEngagementSnapshotSeedCache(): void {
  seededPools = new WeakSet<pg.Pool>();
}
