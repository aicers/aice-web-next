// Shared SQL builders for the Stories tab read path (#490).
//
// Co-located with the rest of the Triage read-path SQL pattern from
// #524 so the production caller and any future measurement-gate
// extension share the same SQL text. Same module constraints as
// `../baseline/read-path-sql.mjs`:
//
//   * No `import "server-only"`. A non-Next harness must be able to
//     load this module with plain Node.
//   * No `process.env`, no Next runtime imports. The module exports
//     SQL strings only.
//   * Plain ESM. Sibling `read-path-sql.d.ts` declares the types.

/**
 * Default form of the list SELECT — sort by `time_window_end DESC`
 * with no unsent filter. Kept as a top-level constant so the unit
 * tests (and any future read-shape audit) can pin the canonical
 * default-sort string. For non-default sort or the "Show only
 * unsent" toggle, callers go through {@link buildSelectStoriesForPeriodSql}
 * so the server applies the sort / filter against the full period
 * rather than the post-LIMIT first page.
 */
export const SELECT_STORIES_FOR_PERIOD_SQL = buildSelectStoriesForPeriodSql({
  sortOrder: "time-window-end",
  unsentOnly: false,
});

/**
 * Build the list SELECT for one tenant's slice of the Stories tab.
 *
 * The sort key and the unsent filter MUST be pushed down to SQL so a
 * tenant with more than {@link TRIAGE_STORY_PAGE_SIZE} overlapping
 * Stories does not silently truncate sort / filter to the first
 * time-sorted page. The unsent filter is also the partial-index
 * consumer named in #490's spec
 * (`(score DESC) WHERE last_sent_at IS NULL`).
 *
 * Overlap predicate (half-open intervals):
 *
 *     time_window_start < :periodEnd
 *     AND time_window_end >= :periodStart
 *
 * A purely-`time_window_end BETWEEN` filter would drop a Story that
 * started before the period and extends into it — the long-running R3
 * cluster case the issue's acceptance criteria explicitly call out.
 *
 * Parameters:
 *   $1 :: timestamptz — period start (inclusive)
 *   $2 :: timestamptz — period end (exclusive)
 *   $3 :: int         — page size cap
 *
 * @param {{ sortOrder: "time-window-end" | "score"; unsentOnly: boolean }} opts
 * @returns {string}
 */
export function buildSelectStoriesForPeriodSql(opts) {
  const sortOrder = opts?.sortOrder ?? "time-window-end";
  const unsentOnly = Boolean(opts?.unsentOnly);
  const whereUnsent = unsentOnly ? "\n        AND last_sent_at IS NULL" : "";
  const orderBy =
    sortOrder === "score"
      ? "ORDER BY score DESC NULLS LAST, time_window_end DESC, id DESC"
      : "ORDER BY time_window_end DESC, score DESC NULLS LAST, id DESC";
  return `SELECT id::text                       AS id,
            kind,
            correlation_rule_id,
            story_version,
            time_window_start,
            time_window_end,
            host(primary_asset)            AS primary_asset,
            score::double precision        AS score,
            summary_payload,
            created_at,
            last_sent_at,
            send_count
       FROM event_group
      WHERE time_window_start <  $2
        AND time_window_end   >= $1${whereUnsent}
      ${orderBy}
      LIMIT $3`;
}

/**
 * Per-Story top-3 member preview. Sort key is `raw_score DESC,
 * event_time DESC` — see #490's "Top-3 event preview" subsection for
 * the rationale (Phase 1.B stores `raw_score`; `baseline_score` is
 * computed at read time via `cume_dist()` in the menu SELECT and is
 * unnecessary cost for a 3-row preview).
 *
 * Aged-out members (`event_group_member.event_key` no longer present
 * in `baseline_triaged_event`) are silently absent — the
 * `INNER JOIN` is the contract the issue commits to. `summary_payload.
 * memberCount` remains the stable count for the card's "N events" badge.
 *
 * Parameters:
 *   $1 :: bigint[] — event_group ids to fetch top-3 previews for
 */
export const SELECT_STORY_TOP_MEMBERS_SQL = `WITH ranked AS (
       SELECT em.event_group_id,
              b.event_key,
              b.event_time,
              b.kind,
              b.category,
              b.raw_score,
              ROW_NUMBER() OVER (
                PARTITION BY em.event_group_id
                ORDER BY b.raw_score DESC, b.event_time DESC, b.event_key DESC
              ) AS rn
         FROM event_group_member em
         JOIN baseline_triaged_event b USING (event_key)
        WHERE em.event_group_id = ANY($1::bigint[])
     )
     SELECT event_group_id::text                  AS event_group_id,
            event_key::text                       AS event_key,
            event_time,
            kind,
            category,
            raw_score
       FROM ranked
      WHERE rn <= 3
      ORDER BY event_group_id, rn`;

/**
 * Story detail panel member SELECT.
 *
 * Two joins working together:
 *
 *   - `INNER JOIN baseline_triaged_event b` on `event_key` — the
 *     dangling-member contract. Aged-out members (whose `event_key`
 *     no longer exists in corpus A) are silently absent; the caller
 *     renders the muted "<shown> of <stored> events shown" notice
 *     when `joinedCount < summary_payload.memberCount`. This join is
 *     period-INDEPENDENT so a Story that overlaps the menu period
 *     but began before `period.start` still shows its earlier
 *     members — those rows still live in `baseline_triaged_event`
 *     and must NOT be misclassified as aged-out.
 *
 *   - `LEFT JOIN scored s` for the read-time `baseline_score`. The
 *     cohort is filtered to the menu period (`event_time >= $2
 *     AND event_time < $3`) so an in-period member's score equals
 *     what the asset list would show; for members whose `event_time`
 *     falls outside the period, `baseline_score` projects as NULL
 *     and the UI renders `—` (the score is genuinely not defined
 *     against the menu's cohort, distinct from a missing row).
 *
 * Parameters:
 *   $1 :: bigint     — event_group id
 *   $2 :: timestamptz — period start (inclusive) — `cume_dist()` cohort
 *   $3 :: timestamptz — period end (exclusive)
 */
export const SELECT_STORY_MEMBERS_DETAIL_SQL = `WITH scored AS (
       SELECT event_key,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score
         FROM baseline_triaged_event
        WHERE event_time >= $2
          AND event_time <  $3
          AND kind NOT LIKE 'Blocklist%'
     )
     SELECT b.event_key::text                  AS event_key,
            b.event_time,
            b.kind,
            b.sensor,
            host(b.orig_addr)                  AS orig_addr,
            host(b.resp_addr)                  AS resp_addr,
            b.orig_port,
            b.resp_port,
            b.host,
            b.dns_query,
            b.uri,
            b.category,
            s.baseline_score::double precision AS baseline_score
       FROM event_group_member em
       JOIN baseline_triaged_event b USING (event_key)
       LEFT JOIN scored s USING (event_key)
      WHERE em.event_group_id = $1
      ORDER BY b.event_time DESC, b.event_key DESC`;

/**
 * Per-customer existence check for analyst-curated Save: every
 * `event_key` in the request must resolve in that customer's
 * `baseline_triaged_event` (corpus A). Returns the rows that *did*
 * resolve; the caller diffs against the request to emit
 * `MEMBER_NOT_FOUND` for misses and `ASSET_MISMATCH` for an
 * unresolved `orig_addr`.
 *
 * Parameters:
 *   $1 :: numeric[] — event_key (NUMERIC(39, 0)) values to look up
 */
export const SELECT_BASELINE_EVENTS_BY_KEY_SQL = `SELECT event_key::text                  AS event_key,
            event_time,
            kind,
            host(orig_addr)                  AS orig_addr,
            category,
            selector_tags,
            raw_score
       FROM baseline_triaged_event
      WHERE event_key = ANY($1::numeric[])`;
