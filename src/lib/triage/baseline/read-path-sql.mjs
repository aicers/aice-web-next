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
 * Per-tenant defense-in-depth `LIMIT` on branch B (Story-protected
 * rows). The merge-layer cap (`STORY_PROTECTED_HARD_CAP`) is the
 * authoritative ceiling; this per-tenant cap bounds any single
 * tenant's contribution to the cross-tenant merge sort (#471 §2
 * "Per-tenant branch B cap"). Equal to the merge cap by RFC §8.
 *
 * The truncation banner reads from the projected
 * `protected_total_in_window` column rather than from the returned
 * row count, so this `LIMIT` truncating a single tenant's overflow is
 * still correctly attributed (the unbounded `COUNT(*) OVER ()` is
 * computed before the `LIMIT` slice).
 */
export const STORY_PROTECTED_PER_TENANT_LIMIT = 2_000;

/**
 * Single-pass menu cohort SELECT — see `selectMenuCohort` in
 * `server-actions.ts` for the full RFC §3 / §4 derivation.
 *
 * Parameters:
 *   $1 :: timestamptz       — period start (inclusive)
 *   $2 :: timestamptz       — period end (exclusive)
 *   $3 :: int               — per-bucket row cap (`MENU_CANDIDATES_PER_BUCKET`)
 *
 * The strictness slider cutoff (#471) is **not** applied at the SQL
 * level — `composeMenu` (RFC §6 option (a), "cutoff on top of
 * unchanged quota") owns the filter so the full-cohort
 * `bucket_count` / `bucket_tag_sum` / `cohort_count` aggregates that
 * drive quota allocation are not narrowed by the slider. Filtering in
 * the `ranked` CTE here would drop buckets whose rows all sit below
 * the cutoff and silently redistribute their quota to surviving
 * buckets, contradicting the working choice in
 * `src/lib/triage/strictness/RFC.md` §6.
 *
 * Story-membership projection (`in_story`, #596 Round 4 item 2). The
 * `scored` CTE evaluates the same `EXISTS (… event_group_member …)`
 * predicate branch B's SELECT uses, projecting a per-row boolean. The
 * merge layer reads this to identify branch-A-shown Story members in
 * the final union and compute `storyProtectedDroppedCount` exactly —
 * without it, the dropped count would either over-attribute branch-A-
 * shown rows (unfiltered SQL pre-count) or under-detect quota-rescue
 * SQL-LIMIT overflow (FILTERed pre-count). Cost is one EXISTS per
 * row against the small `event_group_member` table.
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
               AND 'unlabeled-cluster' = ANY(selector_tags)) AS is_unlabeled,
              EXISTS (
                SELECT 1
                  FROM event_group_member m
                 WHERE m.event_key = baseline_triaged_event.event_key
              ) AS in_story
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
            in_story                              AS in_story,
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
 *   $1 :: timestamptz       — period start (inclusive)
 *   $2 :: timestamptz       — period end (exclusive)
 *   $3 :: inet[]            — addresses to filter on (pg accepts `string[]`)
 *   $4 :: int               — per-asset row cap (`TRIAGE_ASSET_DETAIL_LIMIT`)
 *   $5 :: double precision  — strictness slider cutoff (#471). `0` means
 *                             "All" / no user-side cutoff. Applied
 *                             BEFORE the per-address `ROW_NUMBER()` so
 *                             newer sub-cutoff rows cannot push
 *                             qualifying older rows out of the newest-N
 *                             window. Unlike the menu cohort SELECT, the
 *                             detail path has no bucket aggregates to
 *                             preserve, so the cutoff lives in SQL where
 *                             the `ROW_NUMBER()` partition already does.
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
              baseline_version,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score,
              EXISTS (
                SELECT 1
                  FROM event_group_member m
                 WHERE m.event_key = baseline_triaged_event.event_key
              ) AS in_story
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
          AND (baseline_score >= $5 OR in_story)
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
            baseline_version,
            baseline_score::double precision AS baseline_score,
            (baseline_score < $5 AND in_story) AS protected_by_story
       FROM filtered
      WHERE rn <= $4
      ORDER BY orig_addr, event_time DESC`;

/**
 * Branch B SELECT — Story-protected force-union (#471 §1). Parallels
 * {@link SELECT_MENU_COHORT_SQL} but:
 *
 *  - filters to `EXISTS (SELECT 1 FROM event_group_member ...)`, so
 *    only events that are members of a Story survive,
 *  - drops the per-bucket SQL candidate cap — branch B bypasses both
 *    the SQL cap and `composeMenu`'s per-bucket quota by contract,
 *  - projects the same read-time `baseline_score` (`cume_dist()` over
 *    the post-`Blocklist*` window) so the marker's four-condition rule
 *    and the post-quota tie-breaker sort both have a score on every
 *    branch B row, and
 *  - applies a defense-in-depth per-tenant `LIMIT` so a pathological
 *    Story cannot stream tens of thousands of members into the merge
 *    layer.
 *
 * Branch-A-overlap awareness (#596 Round 2 / Round 4). Branch A's SQL
 * cohort is exactly the rows where `bucket_rn <= $4` (matching the
 * `MENU_CANDIDATES_PER_BUCKET` filter in {@link SELECT_MENU_COHORT_SQL}),
 * partitioned by `(kind, is_unlabeled)` in the same `baseline_score DESC,
 * event_time DESC, event_key DESC` order. Above-cutoff rows inside
 * that cohort are also surfaced by branch A's `composeMenu` only when
 * the per-bucket quota has room; the SQL cannot know whether quota
 * will keep them, so rows with `bucket_rn > $4 OR baseline_score < $5`
 * are flagged `branch_b_unique` (guaranteed-not-served by branch A's
 * SQL or post-`composeMenu` output) and the SQL `ORDER BY` pulls them
 * to the head of the result. The per-tenant `LIMIT` therefore prefers
 * the rows that genuinely depend on branch B's force-union; non-unique
 * (predicted-in-branch-A) rows are still returned when the `LIMIT`
 * has slack so that above-cutoff in-cohort rows that branch A's
 * `composeMenu` ends up dropping by per-bucket quota are still rescued.
 *
 * Dedup of branch B against branch A is decided in the merge layer
 * (`loadTriagePeriod`), not per-tenant: a Story member that branch A
 * happens to surface inside one tenant can still be dropped by the
 * cross-tenant `TRIAGE_HARD_EVENT_CAP`, and removing the branch B copy
 * before that cap fires would leave the row with no rescue path
 * (#596 Round 4 item 1). Branch B therefore returns every in-window
 * Story member it can fit under the `LIMIT`, and the merge layer
 * applies branch A precedence on overlap after both caps have run.
 *
 * Every returned row carries `protected_total_in_window` — the
 * unfiltered `COUNT(*) OVER ()` of in-window Story members in this
 * tenant, computed before the `LIMIT` slices the result. The merge
 * layer subtracts the count of visible Story members in the final
 * union to compute `storyProtectedDroppedCount`, which is exact under
 * the Round 4 fix: branch A's menu cohort SQL also projects
 * `in_story`, so the merge layer can tell which branch-A-shown rows
 * are Story members and avoid the Round 2 over-attribution without
 * needing a FILTERed pre-count here (#596 Round 4 item 2). A tenant
 * returning exactly `LIMIT` rows could still legitimately have either
 * `LIMIT` or `LIMIT + N` total in-window members, and the unfiltered
 * pre-count is what proves the difference (#471 §2 acceptance
 * "single-tenant overflow surfaces the truncation banner").
 *
 * Parameters:
 *   $1 :: timestamptz       — period start (inclusive)
 *   $2 :: timestamptz       — period end (exclusive)
 *   $3 :: int               — per-tenant LIMIT (`STORY_PROTECTED_PER_TENANT_LIMIT`)
 *   $4 :: int               — per-bucket cap (`MENU_CANDIDATES_PER_BUCKET`) that
 *                             branch A's SQL applies; rows with `bucket_rn > $4`
 *                             cannot be in branch A's cohort
 *   $5 :: double precision  — strictness slider cutoff (#471); rows with
 *                             `baseline_score < $5` cannot be in branch A's
 *                             post-`composeMenu` output. `0` at the "All" stop.
 */
export const SELECT_STORY_PROTECTED_COHORT_SQL = `WITH scored AS (
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
              ) AS bucket_rn
         FROM scored
     ),
     in_story AS (
       SELECT *,
              (bucket_rn > $4 OR baseline_score < $5) AS branch_b_unique
         FROM ranked
        WHERE EXISTS (
                SELECT 1
                  FROM event_group_member m
                 WHERE m.event_key = ranked.event_key
              )
     ),
     in_story_counted AS (
       SELECT *,
              COUNT(*) OVER () AS protected_total_in_window
         FROM in_story
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
            branch_b_unique                       AS branch_b_unique,
            protected_total_in_window::text       AS protected_total_in_window
       FROM in_story_counted
      ORDER BY branch_b_unique DESC,
               baseline_score DESC,
               event_time DESC,
               event_key DESC
      LIMIT $3`;

/**
 * Per-tenant per-stop "eligible_top_n" counts (#471 §4). Single-pass
 * `COUNT(*) FILTER` aggregate against the same read-time `scored` CTE
 * the menu cohort SELECT uses. Returns one row with one column per
 * stop plus the corpus-wide `total_all`. PostgreSQL emits one row
 * even on an empty input (bare aggregate without `GROUP BY`), so the
 * empty-window path stays error-free.
 *
 * Parameters:
 *   $1 :: timestamptz — period start (inclusive)
 *   $2 :: timestamptz — period end (exclusive)
 */
export const COUNT_ELIGIBLE_BY_STOP_SQL = `WITH scored AS (
       SELECT cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score,
              EXISTS (
                SELECT 1
                  FROM event_group_member m
                 WHERE m.event_key = b.event_key
              ) AS in_story
         FROM baseline_triaged_event b
        WHERE event_time >= $1
          AND event_time <  $2
          AND kind NOT LIKE 'Blocklist%'
     )
     SELECT COUNT(*)::text                                                AS total_all,
            COUNT(*) FILTER (WHERE baseline_score >= 0.20 OR in_story)::text AS eligible_top80,
            COUNT(*) FILTER (WHERE baseline_score >= 0.50 OR in_story)::text AS eligible_top50,
            COUNT(*) FILTER (WHERE baseline_score >= 0.80 OR in_story)::text AS eligible_top20,
            COUNT(*) FILTER (WHERE baseline_score >= 0.95 OR in_story)::text AS eligible_top5
       FROM scored`;

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
      ctx.menuCutoff ?? 0,
    ],
  },
  {
    name: "selectStoryProtectedCohort",
    sql: SELECT_STORY_PROTECTED_COHORT_SQL,
    buildParams: (ctx) => [
      ctx.periodStartIso,
      ctx.periodEndIso,
      STORY_PROTECTED_PER_TENANT_LIMIT,
      MENU_CANDIDATES_PER_BUCKET,
      ctx.menuCutoff ?? 0,
    ],
  },
  {
    name: "countEligibleByStop",
    sql: COUNT_ELIGIBLE_BY_STOP_SQL,
    buildParams: (ctx) => [ctx.periodStartIso, ctx.periodEndIso],
  },
];
