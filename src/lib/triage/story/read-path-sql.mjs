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
            b.baseline_version,
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

// ── R1 / R3 cadence per-page SELECTs (issue #601) ─────────────────
//
// Extracted from `./repository.ts`'s `readR1Candidates` and
// `readR3Candidates` so the measurement harness can register the same
// SQL strings in `MEASURED_QUERIES` and the drift guard can prove no
// inlined copy lives outside this module. `repository.ts` calls the
// builders below and passes the result to `client.query` — runtime
// behaviour is unchanged from the prior inline form.
//
// The builders are parameterized on two boolean shapes the cadence
// already varies over:
//
//   * `memberScanStartIsNull` — first-tick (NULL watermark) collapses
//     the WHERE clause to a single `event_time {<,<=} $1` bound. Slop
//     replay binds both `event_time >= $1` and `event_time {<,<=} $2`.
//   * `endExclusive`         — cadence call site is inclusive
//     (`event_time <= memberScanEnd`); the rebuild path passes
//     `endExclusive: true` to drop `event_time == memberScanEnd` rows
//     so they cannot extend a cluster's end past the rebuild's
//     half-open `[from, to)` finalization predicate.
//
// The harness only measures the `endExclusive: false` shape — cadence
// is the gated path; the rebuild path's `<` form is structurally
// identical to the planner and not separately gated.

const R1_R3_CANDIDATE_SELECT = `SELECT event_key::text   AS event_key,
                              event_time,
                              kind,
                              host(orig_addr)   AS orig_addr,
                              category,
                              selector_tags,
                              raw_score
                         FROM baseline_triaged_event`;

/**
 * R1's per-page candidate scan SQL — `category = ANY($::text[])` over
 * the member-scan range, with `orig_addr IS NOT NULL` pushed into the
 * predicate. See `./repository.ts:readR1Candidates` for the bind
 * order; see Story RFC §3.R1 / §5 for the rationale.
 *
 * Parameters (slop-replay, both bounds):
 *   $1 :: timestamptz — memberScanStart (inclusive lower bound)
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: text[]      — critical-category set (from `critical-sets.mjs`)
 *
 * Parameters (first-tick, no lower bound):
 *   $1 :: timestamptz — memberScanEnd
 *   $2 :: text[]      — critical-category set
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR1CandidatesSql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND category = ANY($2::text[])`
    : `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND category = ANY($3::text[])`;
}

/**
 * R3's phase-1 candidate-asset pre-aggregation SQL —
 * `GROUP BY orig_addr HAVING COUNT(*) >= 3` over the member-scan range
 * filtered to rows whose `selector_tags` overlap the critical set. See
 * `./repository.ts:readR3Candidates` and Story RFC §3.R3.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: text[]      — critical-selector set
 *
 * Parameters (first-tick):
 *   $1 :: timestamptz — memberScanEnd
 *   $2 :: text[]      — critical-selector set
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR3CandidatesPhase1Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `SELECT host(orig_addr) AS orig_addr
           FROM baseline_triaged_event
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND selector_tags && $2::text[]
          GROUP BY orig_addr
         HAVING COUNT(*) >= 3`
    : `SELECT host(orig_addr) AS orig_addr
           FROM baseline_triaged_event
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND selector_tags && $3::text[]
          GROUP BY orig_addr
         HAVING COUNT(*) >= 3`;
}

/**
 * R3's phase-2 per-asset member scan SQL — the "R3 same-asset-1h"
 * SELECT shape the issue gate names. The `orig_addr = ANY($::inet[])`
 * predicate is what the planner uses to fan out into per-asset GiST
 * index probes against `baseline_triaged_event_orig_addr_gist`.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: inet[]      — phase-1 candidate assets (deduped)
 *   $4 :: text[]      — critical-selector set
 *
 * Parameters (first-tick):
 *   $1 :: timestamptz — memberScanEnd
 *   $2 :: inet[]      — phase-1 candidate assets (deduped)
 *   $3 :: text[]      — critical-selector set
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR3CandidatesPhase2Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time ${endOp} $1
            AND orig_addr = ANY($2::inet[])
            AND selector_tags && $3::text[]`
    : `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr = ANY($3::inet[])
            AND selector_tags && $4::text[]`;
}

// ── R4 / R5 multi-source cadence per-page SELECTs (issue #694) ─────
//
// The fan-in (R4) and campaign (R5) rules read a candidate set that
// also carries `resp_addr` (the victim), so they cannot reuse
// `R1_R3_CANDIDATE_SELECT`. Both follow the R3 two-phase pattern:
// phase 1 pre-aggregates candidate keys with predicate push-down,
// phase 2 reads the member rows for those keys; final sliding-window
// clustering and distinct-source counting stay in the rule layer
// (`rules.ts`). Both rules share the "same-attack" eligibility:
// `category = ANY($criticalCategories::text[])` AND
// `selector_tags && $criticalSelectors::text[]`, with both
// `orig_addr` and `resp_addr` non-NULL.
//
// As with R1/R3 the builders vary over `memberScanStartIsNull`
// (first-tick omits the lower bound) and `endExclusive` (rebuild
// drops `event_time == memberScanEnd`).

const MULTI_SOURCE_CANDIDATE_SELECT = `SELECT event_key::text   AS event_key,
                              event_time,
                              kind,
                              host(orig_addr)   AS orig_addr,
                              host(resp_addr)   AS resp_addr,
                              category,
                              selector_tags,
                              raw_score
                         FROM baseline_triaged_event`;

/**
 * R4 phase-1 — candidate `(resp_addr, category)` pre-aggregation:
 * `GROUP BY resp_addr, category HAVING COUNT(DISTINCT orig_addr) >=
 * $R4_MIN_SOURCES` (one candidate key per victim × signature) over
 * the eligible rows. The `$N` placeholder for `R4_MIN_SOURCES` is
 * bound (not inlined) so the rule-layer tunable is the single source
 * of truth.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: text[]      — critical-category set
 *   $4 :: text[]      — critical-selector set
 *   $5 :: int         — R4_MIN_SOURCES
 *
 * Parameters (first-tick): the same list shifted left by one (no
 * lower bound), so the threshold binds at `$4`.
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR4CandidatesPhase1Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `SELECT host(resp_addr) AS resp_addr, category
           FROM baseline_triaged_event
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND resp_addr IS NOT NULL
            AND category = ANY($2::text[])
            AND selector_tags && $3::text[]
          GROUP BY resp_addr, category
         HAVING COUNT(DISTINCT orig_addr) >= $4`
    : `SELECT host(resp_addr) AS resp_addr, category
           FROM baseline_triaged_event
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND resp_addr IS NOT NULL
            AND category = ANY($3::text[])
            AND selector_tags && $4::text[]
          GROUP BY resp_addr, category
         HAVING COUNT(DISTINCT orig_addr) >= $5`;
}

/**
 * R4 phase-2 — per-victim member scan against the candidate victims
 * phase 1 returned: `resp_addr = ANY($::inet[])` co-occurring with
 * the eligibility predicate. The rule layer re-groups by
 * `(resp_addr, category)` and re-applies the source threshold per
 * sliding window, so over-reading a victim that only met the
 * threshold for a different category is harmless.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: inet[]      — phase-1 candidate victims (deduped)
 *   $4 :: text[]      — critical-category set
 *   $5 :: text[]      — critical-selector set
 *
 * Parameters (first-tick): same list shifted left by one.
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR4CandidatesPhase2Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `${MULTI_SOURCE_CANDIDATE_SELECT}
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND resp_addr = ANY($2::inet[])
            AND category = ANY($3::text[])
            AND selector_tags && $4::text[]`
    : `${MULTI_SOURCE_CANDIDATE_SELECT}
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND resp_addr = ANY($3::inet[])
            AND category = ANY($4::text[])
            AND selector_tags && $5::text[]`;
}

/**
 * R5 phase-1 — candidate `category` pre-aggregation:
 * `GROUP BY category HAVING COUNT(DISTINCT orig_addr) >=
 * $R5_MIN_SOURCES AND COUNT(DISTINCT resp_addr) >= $R5_MIN_VICTIMS`
 * (one candidate key per signature). The `COUNT(DISTINCT resp_addr)`
 * clause is what enforces the ≥2-victims floor that separates a
 * campaign from an R4 fan-in.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: text[]      — critical-category set
 *   $4 :: text[]      — critical-selector set
 *   $5 :: int         — R5_MIN_SOURCES
 *   $6 :: int         — R5_MIN_VICTIMS
 *
 * Parameters (first-tick): same list shifted left by one.
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR5CandidatesPhase1Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `SELECT category
           FROM baseline_triaged_event
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND resp_addr IS NOT NULL
            AND category = ANY($2::text[])
            AND selector_tags && $3::text[]
          GROUP BY category
         HAVING COUNT(DISTINCT orig_addr) >= $4
            AND COUNT(DISTINCT resp_addr) >= $5`
    : `SELECT category
           FROM baseline_triaged_event
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND resp_addr IS NOT NULL
            AND category = ANY($3::text[])
            AND selector_tags && $4::text[]
          GROUP BY category
         HAVING COUNT(DISTINCT orig_addr) >= $5
            AND COUNT(DISTINCT resp_addr) >= $6`;
}

/**
 * R5 phase-2 — per-signature member scan against the candidate
 * categories phase 1 returned: `category = ANY($::text[])`
 * co-occurring with the eligibility predicate. The rule layer
 * re-groups by `category` and re-applies the source/victim
 * thresholds per sliding window.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: text[]      — phase-1 candidate categories (deduped)
 *   $4 :: text[]      — critical-selector set
 *
 * Parameters (first-tick): same list shifted left by one.
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR5CandidatesPhase2Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `${MULTI_SOURCE_CANDIDATE_SELECT}
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND resp_addr IS NOT NULL
            AND category = ANY($2::text[])
            AND selector_tags && $3::text[]`
    : `${MULTI_SOURCE_CANDIDATE_SELECT}
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND resp_addr IS NOT NULL
            AND category = ANY($3::text[])
            AND selector_tags && $4::text[]`;
}

// ── R6 persistent low-and-slow sweep per-page SELECTs (issue #701) ──
//
// R6 is single-source (`primary_asset = orig_addr`, like R3) but runs
// over a 24h window from the hourly low-and-slow sweep, not per-page
// step (f). It reuses `R1_R3_CANDIDATE_SELECT` for the member read
// (no `resp_addr`). Two-phase like R3:
//
//   * Phase 1 pre-aggregates candidate assets with BOTH a member
//     floor (`COUNT(*) >= 3`) AND a dispersion floor
//     (`COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE
//     'UTC')) >= 3`). The dispersion floor is what excludes a burst
//     (a ≤1h R3 cluster straddles at most two hour buckets), so R6
//     does not overlap R3. The `AT TIME ZONE 'UTC'` anchor makes the
//     hour bucketing independent of the DB/session timezone, matching
//     the JS-side `utcHourBucket` in `rules.ts`.
//   * Phase 2 reads the member rows for the candidate assets via
//     `orig_addr = ANY($::inet[])`, riding the existing
//     `baseline_triaged_event_orig_addr_gist` index.
//
// The `>= 3` literals mirror the rule-layer tunables `R6_MIN_MEMBERS`
// / `LOWSLOW_MIN_BUCKETS` (`rules.ts`); the two must stay in sync.
// They are inlined (not bound) for the same reason R3 inlines its
// `>= 3`: this `.mjs` is Node-safe and cannot import the `.ts`
// rule-layer tunables, and the R6 selector set — which IS shared —
// already lives in `critical-sets.mjs` and binds as `$N::text[]`.
//
// As with R1/R3 the builders vary over `memberScanStartIsNull`
// (first-tick omits the lower bound) and `endExclusive`. The sweep
// always binds a non-null `memberScanStart` (its lower bound is
// `wm − 24h`), so the first-tick shape exists only for measurement
// parity with the other rules.

/**
 * R6 phase-1 — candidate-asset pre-aggregation with the member +
 * dispersion floors. See `./repository.ts:readR6Candidates` and issue
 * #701.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: text[]      — R6 selector set (`LOWSLOW_SELECTOR_SET`)
 *
 * Parameters (first-tick):
 *   $1 :: timestamptz — memberScanEnd
 *   $2 :: text[]      — R6 selector set
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR6CandidatesPhase1Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `SELECT host(orig_addr) AS orig_addr
           FROM baseline_triaged_event
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND selector_tags && $2::text[]
          GROUP BY orig_addr
         HAVING COUNT(*) >= 3
            AND COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE 'UTC')) >= 3`
    : `SELECT host(orig_addr) AS orig_addr
           FROM baseline_triaged_event
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND selector_tags && $3::text[]
          GROUP BY orig_addr
         HAVING COUNT(*) >= 3
            AND COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE 'UTC')) >= 3`;
}

/**
 * R6 phase-2 — per-asset member scan against the candidate assets
 * phase 1 returned. Same shape as R3 phase-2 but bound with the R6
 * selector set; the rule layer (`detectR6`) re-applies the 24h
 * sliding-window cluster, member floor, and hour-bucket dispersion.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: inet[]      — phase-1 candidate assets (deduped)
 *   $4 :: text[]      — R6 selector set
 *
 * Parameters (first-tick):
 *   $1 :: timestamptz — memberScanEnd
 *   $2 :: inet[]      — phase-1 candidate assets (deduped)
 *   $3 :: text[]      — R6 selector set
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR6CandidatesPhase2Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time ${endOp} $1
            AND orig_addr = ANY($2::inet[])
            AND selector_tags && $3::text[]`
    : `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr = ANY($3::inet[])
            AND selector_tags && $4::text[]`;
}

// ── R2 multi-stage low-and-slow sweep per-page SELECTs (issue #702) ──
//
// R2 is single-source (`primary_asset = orig_addr`, like R3/R6) and
// runs over the same 24h window from the hourly low-and-slow sweep, but
// keys on `category` rather than `selector_tags`: the "slow R1". It
// reuses `R1_R3_CANDIDATE_SELECT` for the member read (no `resp_addr`).
// Two-phase like R6, but the phase-1 push-down swaps R6's selector
// member floor for a distinct-category floor:
//
//   * Phase 1 pre-aggregates candidate assets with BOTH a
//     distinct-category floor (`COUNT(DISTINCT category) >= 3`) AND the
//     same UTC-hour dispersion floor R6 uses
//     (`COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE
//     'UTC')) >= 3`). The dispersion floor excludes a single-window
//     multi-category burst already covered by R1; the category floor is
//     mandatory (not just an optimization) to keep phase 2 bounded,
//     because R2 keys on the very broad `category IS NOT NULL` rather
//     than R6's narrow `selector_tags && LOWSLOW_SELECTOR_SET`.
//   * Phase 2 reads the member rows for the candidate assets via
//     `orig_addr = ANY($::inet[])`, also carrying `AND category IS NOT
//     NULL` — R2 is category-driven, so a null-category row can never
//     contribute and is filtered here rather than read and discarded.
//
// The `>= 3` literals mirror the rule-layer tunables `R2_MIN_CATEGORIES`
// / `LOWSLOW_MIN_BUCKETS` (`rules.ts`); the two must stay in sync. They
// are inlined (not bound) for the same reason R3/R6 inline their `>= 3`:
// this `.mjs` is Node-safe and cannot import the `.ts` rule-layer
// tunables. The ≥1-critical guard (`CRITICAL_CATEGORIES`) stays a
// rule-layer re-validation on the phase-2 rows (`detectR2`), simpler
// than encoding the critical set in SQL.
//
// R2 binds NO `$N::text[]` selector/category array: `category IS NOT
// NULL` is a bare predicate, so phase 1 binds only the time bound(s) and
// phase 2 adds the `$N::inet[]` asset list. As with R3/R6 the builders
// vary over `memberScanStartIsNull` and `endExclusive`; the sweep always
// binds a non-null `memberScanStart`, so the first-tick shape exists
// only for measurement parity.

/**
 * R2 phase-1 — candidate-asset pre-aggregation with the
 * distinct-category + UTC-hour dispersion floors. See
 * `./repository.ts:readR2Candidates` and issue #702.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *
 * Parameters (first-tick):
 *   $1 :: timestamptz — memberScanEnd
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR2CandidatesPhase1Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `SELECT host(orig_addr) AS orig_addr
           FROM baseline_triaged_event
          WHERE event_time ${endOp} $1
            AND orig_addr IS NOT NULL
            AND category IS NOT NULL
          GROUP BY orig_addr
         HAVING COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE 'UTC')) >= 3
            AND COUNT(DISTINCT category) >= 3`
    : `SELECT host(orig_addr) AS orig_addr
           FROM baseline_triaged_event
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr IS NOT NULL
            AND category IS NOT NULL
          GROUP BY orig_addr
         HAVING COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE 'UTC')) >= 3
            AND COUNT(DISTINCT category) >= 3`;
}

/**
 * R2 phase-2 — per-asset member scan against the candidate assets
 * phase 1 returned. Same single-source shape as R6 phase-2 but bound on
 * `category IS NOT NULL` instead of the R6 selector set; the rule layer
 * (`detectR2`) re-applies the 24h sliding-window cluster, the
 * distinct-category gate, hour-bucket dispersion, and the ≥1-critical
 * guard.
 *
 * Parameters (slop-replay):
 *   $1 :: timestamptz — memberScanStart
 *   $2 :: timestamptz — memberScanEnd
 *   $3 :: inet[]      — phase-1 candidate assets (deduped)
 *
 * Parameters (first-tick):
 *   $1 :: timestamptz — memberScanEnd
 *   $2 :: inet[]      — phase-1 candidate assets (deduped)
 *
 * @param {{ memberScanStartIsNull: boolean, endExclusive?: boolean }} opts
 * @returns {string}
 */
export function buildReadR2CandidatesPhase2Sql(opts) {
  const memberScanStartIsNull = Boolean(opts?.memberScanStartIsNull);
  const endOp = opts?.endExclusive ? "<" : "<=";
  return memberScanStartIsNull
    ? `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time ${endOp} $1
            AND orig_addr = ANY($2::inet[])
            AND category IS NOT NULL`
    : `${R1_R3_CANDIDATE_SELECT}
          WHERE event_time >= $1
            AND event_time ${endOp} $2
            AND orig_addr = ANY($3::inet[])
            AND category IS NOT NULL`;
}
