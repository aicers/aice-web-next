// Shared SQL builders for the Phase 1.B menu read path.
//
// Imported by both the production caller in `src/lib/triage/server-actions.ts`
// and the measurement harness at `scripts/measure-baseline-read-path.mjs`.
// The two callers MUST share the same SQL text — otherwise a measurement
// run silently diverges from production the moment the production query
// is edited. The CI guard `scripts/check-read-path-sql-drift.mjs` fails
// the build if any of the measured-query shape patterns reappears in
// string literals outside this module.
//
// Module constraints (issue #524 §4):
//
//   * No `import "server-only"`. The harness loads this module from
//     plain Node and the Next runtime hook would throw.
//   * No imports from `next/*` or `@/lib/*` that pull Next runtime, and
//     no `process.env` access at import time. The module exports SQL
//     strings only — no Pool, no execution.
//   * Plain ESM. The recommended `.mjs` extension lets every consumer
//     (Next bundler via `@/` alias, plain Node via relative path) load
//     the module without a transpile step.
//
// Address-binding shape (issue #524 §5): both queries that filter by
// `orig_addr` bind a single `$N::inet[]` parameter and compare with
// `orig_addr = ANY(...)`. The previous `orig_addr::text = ANY($N::text[])`
// shape cast the column to `text` and foreclosed any future use of the
// GiST inet index on `orig_addr` (or a btree we might add). The new
// shape keeps the column type aligned with the existing index and the
// underlying column. The JS-side value (`string[]`) passes through
// unchanged — pg's parameter binding accepts `string[]` for an `inet[]`
// placeholder.
//
// Sibling type declarations live in `read-path-sql.d.ts`.

/**
 * Upper bound on per-bucket candidate rows the menu SELECT returns.
 * See `MENU_CANDIDATES_PER_BUCKET` rationale in `server-actions.ts`.
 */
export const MENU_CANDIDATES_PER_BUCKET = 500;

/**
 * Bound on the per-asset detail panel (newest-first).
 */
export const TRIAGE_ASSET_DETAIL_LIMIT = 50;

/**
 * Single-pass menu cohort SELECT — see `selectMenuCohort` in
 * `server-actions.ts` for the full RFC §3 / §4 derivation.
 *
 * Parameters:
 *   $1 :: timestamptz — period start (inclusive)
 *   $2 :: timestamptz — period end (exclusive)
 *   $3 :: int         — per-bucket row cap (`MENU_CANDIDATES_PER_BUCKET`)
 */
export const SELECT_MENU_COHORT_SQL = `WITH scored AS (
       SELECT event_key,
              event_time,
              kind,
              sensor,
              orig_addr,
              resp_addr,
              orig_port,
              resp_port,
              host,
              dns_query,
              uri,
              category,
              baseline_version,
              raw_score,
              selector_tags,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score,
              (kind = 'HttpThreat'
               AND 'unlabeled-cluster' = ANY(selector_tags)) AS is_unlabeled
         FROM baseline_triaged_event
        WHERE event_time >= $1
          AND event_time <  $2
          AND kind NOT LIKE 'Blocklist%'
     ),
     ranked AS (
       SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY kind, is_unlabeled
                ORDER BY baseline_score DESC, event_time DESC, event_key DESC
              ) AS bucket_rn,
              COUNT(*) OVER (PARTITION BY kind, is_unlabeled) AS bucket_count,
              SUM(coalesce(cardinality(selector_tags), 0))
                OVER (PARTITION BY kind, is_unlabeled) AS bucket_tag_sum,
              COUNT(*) OVER () AS cohort_count
         FROM scored
     )
     SELECT event_key::text                       AS event_key,
            event_time,
            kind,
            sensor,
            orig_addr::text                       AS orig_addr,
            resp_addr::text                       AS resp_addr,
            orig_port,
            resp_port,
            host,
            dns_query,
            uri,
            category,
            baseline_version,
            raw_score,
            selector_tags,
            baseline_score::double precision      AS baseline_score,
            is_unlabeled,
            bucket_count::text                    AS bucket_count,
            bucket_tag_sum::text                  AS bucket_tag_sum,
            cohort_count::text                    AS cohort_count
       FROM ranked
      WHERE bucket_rn <= $3
      ORDER BY baseline_score DESC, event_time DESC, event_key DESC`;

/**
 * Funnel "Detected" denominator.
 *
 * Parameters:
 *   $1 :: timestamptz — `observedFromIso` (max of period start and
 *                        `now() - OBSERVED_EVENT_META_RETENTION_MS`)
 *   $2 :: timestamptz — period end (exclusive)
 */
export const COUNT_OBSERVED_SQL = `SELECT COUNT(*)::text AS count
       FROM observed_event_meta
      WHERE event_time >= $1
        AND event_time <  $2`;

/**
 * Funnel "Triaged" numerator.
 *
 * Parameters:
 *   $1 :: timestamptz — period start (inclusive)
 *   $2 :: timestamptz — period end (exclusive)
 */
export const COUNT_TRIAGED_SQL = `SELECT COUNT(*)::text AS count
       FROM baseline_triaged_event
      WHERE event_time >= $1
        AND event_time <  $2`;

/**
 * Per-asset observed COUNT — joined against the visible asset page.
 *
 * Parameters:
 *   $1 :: timestamptz — `observedFromIso`
 *   $2 :: timestamptz — period end (exclusive)
 *   $3 :: inet[]      — addresses to filter on (pg accepts `string[]`)
 */
export const PER_ASSET_OBSERVED_COUNTS_SQL = `SELECT o.orig_addr::text AS address,
            COUNT(*)::text     AS detected_count
       FROM observed_event_meta o
      WHERE o.event_time >= $1
        AND o.event_time <  $2
        AND o.orig_addr IS NOT NULL
        AND o.orig_addr = ANY($3::inet[])
      GROUP BY o.orig_addr`;

/**
 * Batched per-asset detail SELECT — `cume_dist()` over the post-
 * `Blocklist*` cohort, then keep the newest
 * `TRIAGE_ASSET_DETAIL_LIMIT` rows for each address.
 *
 * Parameters:
 *   $1 :: timestamptz — period start (inclusive)
 *   $2 :: timestamptz — period end (exclusive)
 *   $3 :: inet[]      — addresses to filter on (pg accepts `string[]`)
 *   $4 :: int         — per-asset row cap (`TRIAGE_ASSET_DETAIL_LIMIT`)
 */
export const SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL = `WITH scored AS (
       SELECT event_key,
              event_time,
              kind,
              sensor,
              orig_addr,
              resp_addr,
              orig_port,
              resp_port,
              host,
              dns_query,
              uri,
              category,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score
         FROM baseline_triaged_event
        WHERE event_time >= $1
          AND event_time <  $2
          AND kind NOT LIKE 'Blocklist%'
     ),
     filtered AS (
       SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY orig_addr
                ORDER BY event_time DESC, event_key DESC
              ) AS rn
         FROM scored
        WHERE orig_addr IS NOT NULL
          AND orig_addr = ANY($3::inet[])
     )
     SELECT event_key::text                  AS event_key,
            event_time,
            kind,
            sensor,
            orig_addr::text                  AS orig_addr,
            resp_addr::text                  AS resp_addr,
            orig_port,
            resp_port,
            host,
            dns_query,
            uri,
            category,
            baseline_score::double precision AS baseline_score
       FROM filtered
      WHERE rn <= $4
      ORDER BY orig_addr, event_time DESC`;

/**
 * Ordered list of measured queries, keyed by the function name used in
 * `server-actions.ts`. Consumed by the harness so the harness's query
 * coverage stays in lock-step with this module — adding a sixth
 * measurable query is a one-line change in this array, not a forked
 * loop body.
 *
 * @type {ReadonlyArray<{
 *   name: string,
 *   sql: string,
 *   buildParams: (ctx: import("./read-path-sql.js").HarnessContext) => unknown[]
 * }>}
 */
export const MEASURED_QUERIES = [
  {
    name: "selectMenuCohort",
    sql: SELECT_MENU_COHORT_SQL,
    buildParams: (ctx) => [
      ctx.periodStartIso,
      ctx.periodEndIso,
      MENU_CANDIDATES_PER_BUCKET,
    ],
  },
  {
    name: "countObserved",
    sql: COUNT_OBSERVED_SQL,
    buildParams: (ctx) => [ctx.observedFromIso, ctx.periodEndIso],
  },
  {
    name: "countTriaged",
    sql: COUNT_TRIAGED_SQL,
    buildParams: (ctx) => [ctx.periodStartIso, ctx.periodEndIso],
  },
  {
    name: "perAssetObservedCounts",
    sql: PER_ASSET_OBSERVED_COUNTS_SQL,
    buildParams: (ctx) => [
      ctx.observedFromIso,
      ctx.periodEndIso,
      ctx.addresses,
    ],
  },
  {
    name: "selectAssetDetailEventsBatch",
    sql: SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
    buildParams: (ctx) => [
      ctx.periodStartIso,
      ctx.periodEndIso,
      ctx.addresses,
      TRIAGE_ASSET_DETAIL_LIMIT,
    ],
  },
];
