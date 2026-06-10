import "server-only";

/**
 * Phase 1.B four-selector batch scoring (RFC 0001 §3, §7, §8).
 *
 * Once a cadence page has been inserted into `observed_event_meta`
 * (Phase 1), this module computes the per-event `raw_score` and
 * `selector_tags` for the same page rows against the corpus state
 * `observed_event_meta` is now in (Phase 2). The batch shape is one
 * grouped query per selector (S1 / S3 / S4) over all three statistics
 * windows simultaneously via `FILTER` aggregates, then joined back to
 * the page rows once — `O(selector × page_size)` PG round-trips, not
 * `O(selector × window × page_size)`.
 *
 * Steps:
 *
 *   1. `scoreSelectorsForPage` — runs one batched SELECT against
 *      `observed_event_meta` for s1 / s3 / s4 per window. Returns the
 *      raw per-window numerator values (percentile rank for S1; repeat
 *      count − 1 for S3; distinct categories − 1 for S4).
 *   2. `buildSelectorOutputs` — combines the per-window values via
 *      per-selector `max`, applies saturation caps and §9 weights,
 *      adds the per-event S2 and UNLABELED_BONUS contributions, and
 *      emits the §9 `selector_tags` set.
 *
 * The two-step split keeps the SQL focused on the GROUP BY shape and
 * lets the per-event tag-threshold + weight logic stay pure TypeScript
 * for direct unit testing.
 */

import type pg from "pg";

import type { ThreatCategory } from "@/lib/detection";
import { CRITICAL_CATEGORIES } from "@/lib/triage/baseline/categories";
import {
  SELECTOR_SATURATION,
  SELECTOR_TAGS,
  SELECTOR_WEIGHTS,
  STATISTICS_WINDOW_DAYS,
  type StatisticsWindowDays,
  TAG_THRESHOLDS,
} from "@/lib/triage/baseline/tunables";
import { isClusterNone } from "@/lib/triage/scoring";
import type { TriageEvent } from "@/lib/triage/types";

const HTTP_THREAT_TYPENAME = "HttpThreat";

/**
 * Active statistics windows for the page. Pre-activation windows
 * contribute 0 to the per-selector MAX combination (§7 cold-start).
 */
export type ActiveWindows = ReadonlySet<StatisticsWindowDays>;

/**
 * Compact row passed to {@link scoreSelectorsForPage}. Carries only the
 * columns the SQL needs; the broader `TriageEvent` shape stays in the
 * pager layer for the eventual INSERT.
 */
export interface PageScoringRow {
  /** Numeric event_key matching `observed_event_meta.event_key`. */
  eventKey: string;
  /** Event typename used as the `kind` column. */
  kind: string;
  /** Originator IP, nullable per the schema and the §3 NULL contract. */
  origAddr: string | null;
  /** Responder IP, nullable per the schema. */
  respAddr: string | null;
  /** Originating threat category; NULL falls through to `s2 = 0`. */
  category: string | null;
  /** Confidence value; NULL means S1 has no peer to rank against. */
  confidence: number | null;
  /** HttpThreat clusterId for the UNLABELED_BONUS check. */
  clusterId: string | null | undefined;
}

/**
 * Raw per-window numerator values pulled out of the batched SELECT.
 * Used by {@link buildSelectorOutputs} to compute the final `raw_score`.
 */
export interface PerWindowValues {
  /** S1 percentile rank in `[0, 1]` per active window. */
  s1: Record<StatisticsWindowDays, number>;
  /** S3 raw repeat-minus-self count per active window (pre-saturation). */
  s3RepeatMinusSelf: Record<StatisticsWindowDays, number>;
  /** S4 distinct-category-minus-self count per active window (pre-saturation). */
  s4DistinctMinusSelf: Record<StatisticsWindowDays, number>;
}

export interface SelectorOutputs {
  rawScore: number;
  selectorTags: string[];
  /** Per-selector final value after MAX-across-windows and saturation. */
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  unlabeled: number;
}

const EMPTY_PER_WINDOW: PerWindowValues = {
  s1: { 7: 0, 14: 0, 30: 0 },
  s3RepeatMinusSelf: { 7: 0, 14: 0, 30: 0 },
  s4DistinctMinusSelf: { 7: 0, 14: 0, 30: 0 },
};

/**
 * Determine which statistics windows have wall-clock activation against
 * the corpus's first-ingest marker. A window of `N` days is active iff
 * the cadence has been collecting data for at least `N` wall-clock days
 * — i.e., the corpus has spent the window's full horizon accumulating
 * peer events (RFC §7 cold start). Pre-activation windows return
 * `false` so the per-window MAX step zeroes their contribution.
 *
 * The activation anchor is `baseline_corpus_state.corpus_activated_at`,
 * set by {@link markOk} on the first successful page commit. Reading
 * the singleton row is O(1) (PK lookup) and
 * — crucially — measures elapsed wall-clock time since ingestion began,
 * not the age of the oldest event in the page. The latter would
 * misfire on an initial catch-up page of historical events: the oldest
 * observed event could be months old while the corpus itself is still
 * minutes old and partial, immediately and incorrectly enabling 7d /
 * 14d / 30d scoring.
 *
 * Called once per page (before Phase 2) so the scorer can pass the set
 * straight into {@link buildSelectorOutputs}.
 */
export async function detectActiveWindows(
  client: pg.PoolClient,
): Promise<ActiveWindows> {
  const result = await client.query<{ corpus_activated_at: Date | null }>(
    `SELECT corpus_activated_at FROM baseline_corpus_state WHERE id = true`,
  );
  const activatedAt = result.rows[0]?.corpus_activated_at ?? null;
  if (activatedAt === null) {
    return new Set();
  }
  const now = Date.now();
  const ageMs = now - activatedAt.getTime();
  const active = new Set<StatisticsWindowDays>();
  for (const days of STATISTICS_WINDOW_DAYS) {
    if (ageMs >= days * 24 * 60 * 60 * 1000) active.add(days);
  }
  return active;
}

/**
 * Run the batched S1 / S3 / S4 query for the page rows against
 * `observed_event_meta`. Returns a map keyed by `event_key` with the
 * raw per-window numerator values. Page rows missing from the map
 * (because they had NULL `orig_addr` / `resp_addr` and therefore did
 * not participate in S3 / S4 aggregates) fall back to the per-window
 * zero defaults at lookup time.
 *
 * The query packs all three windows into one SELECT via `FILTER`
 * aggregates so the planner can resolve the kind / time slice once per
 * selector and project the per-window slices from the same group.
 *
 * Page rows must already be present in `observed_event_meta` (Phase 1
 * inserted them) — that is what makes `cume_dist()` over the same-kind
 * window include the page rows in the percentile denominator, per the
 * RFC §3 "S1 / S3 / S4 already account for self via the `- 1` terms,
 * and S1's `CUME_DIST`-style percentile rank conventionally includes
 * self" contract.
 */
export async function scoreSelectorsForPage(
  client: pg.PoolClient,
  pageRows: ReadonlyArray<PageScoringRow>,
): Promise<Map<string, PerWindowValues>> {
  const result = new Map<string, PerWindowValues>();
  if (pageRows.length === 0) return result;

  // Build the page-row VALUES tuple once; ordered (eventKey, kind,
  // origAddr, respAddr, confidence). `confidence` is sent as REAL to
  // match the `observed_event_meta.confidence REAL` column type so
  // ties resolve identically.
  const pageParams: unknown[] = [];
  const placeholderRows: string[] = [];
  for (const row of pageRows) {
    const baseIdx = pageParams.length;
    pageParams.push(row.eventKey, row.kind, row.origAddr, row.respAddr);
    placeholderRows.push(
      `($${baseIdx + 1}::numeric, $${baseIdx + 2}::text, $${baseIdx + 3}::inet, $${baseIdx + 4}::inet)`,
    );
  }
  const pageValues = placeholderRows.join(", ");

  // S1 (three windowed CTEs) ranks confidence within each page kind's
  // same-kind slice. The `kind IN page_kinds` filter restricts the
  // window-function input to the kinds actually represented in this
  // page, so the planner never partitions over tenant-wide kinds it
  // will throw away. `confidence IS NOT NULL` excludes rows the schema
  // permits to be NULL — PG orders NULLs LAST in ASC, so leaving them
  // in would give a NULL-confidence row `cume_dist() = 1.0` and falsely
  // emit `S1-high`. Page rows whose own confidence is NULL therefore
  // miss the rank entirely and the LEFT JOIN below coalesces them to 0.
  //
  // S3 / S4 use the "aggregate once, join back" shape requested by the
  // OQ4 review: `s3_aggr` / `s4_aggr` group the 30d corpus once per
  // (kind, orig_addr [, resp_addr]) tuple actually present in the page
  // (the inner SELECT is the join key set), with per-window FILTER
  // aggregates for 7d / 14d, then a single LEFT JOIN projects the
  // aggregate back to each page row. This avoids re-grouping the
  // 30d corpus per page row. Per RFC §3:
  //   s3 = repeat count of (orig_addr, resp_addr, kind) in window
  //   s4 = distinct categories of (orig_addr, kind) in window
  // The `-1` self-exclusion is applied in JS so the SQL stays a pure
  // aggregate. S3 always subtracts 1 (the page row is always counted
  // by `COUNT(*)` when its addresses are non-NULL); S4 subtracts 1
  // only when the page row's `category` is non-NULL because
  // `COUNT(DISTINCT category)` ignores NULL.
  //
  // Pre-activation windows: handled in JS by zeroing the per-window
  // value before the MAX combination — the SQL always returns all
  // three windows so the planner picks one shape regardless of which
  // ones are active.
  const sql = `
    WITH page_rows AS (
      SELECT pr.event_key, pr.kind, pr.orig_addr, pr.resp_addr
      FROM (VALUES ${pageValues}) AS pr(event_key, kind, orig_addr, resp_addr)
    ),
    page_kinds AS (
      SELECT DISTINCT kind FROM page_rows
    ),
    ranked_7d AS (
      SELECT event_key,
             cume_dist() OVER (PARTITION BY kind ORDER BY confidence) AS r
        FROM observed_event_meta
       WHERE event_time >= now() - INTERVAL '7 days'
         AND confidence IS NOT NULL
         AND kind IN (SELECT kind FROM page_kinds)
    ),
    ranked_14d AS (
      SELECT event_key,
             cume_dist() OVER (PARTITION BY kind ORDER BY confidence) AS r
        FROM observed_event_meta
       WHERE event_time >= now() - INTERVAL '14 days'
         AND confidence IS NOT NULL
         AND kind IN (SELECT kind FROM page_kinds)
    ),
    ranked_30d AS (
      SELECT event_key,
             cume_dist() OVER (PARTITION BY kind ORDER BY confidence) AS r
        FROM observed_event_meta
       WHERE event_time >= now() - INTERVAL '30 days'
         AND confidence IS NOT NULL
         AND kind IN (SELECT kind FROM page_kinds)
    ),
    s3_aggr AS (
      SELECT o.kind, o.orig_addr, o.resp_addr,
             COUNT(*) FILTER (WHERE o.event_time >= now() - INTERVAL '7 days')  AS c_7d,
             COUNT(*) FILTER (WHERE o.event_time >= now() - INTERVAL '14 days') AS c_14d,
             COUNT(*) FILTER (WHERE o.event_time >= now() - INTERVAL '30 days') AS c_30d
        FROM observed_event_meta o
        JOIN (
          SELECT DISTINCT kind, orig_addr, resp_addr
            FROM page_rows
           WHERE orig_addr IS NOT NULL AND resp_addr IS NOT NULL
        ) page_s3_keys
          ON page_s3_keys.kind      = o.kind
         AND page_s3_keys.orig_addr = o.orig_addr
         AND page_s3_keys.resp_addr = o.resp_addr
       WHERE o.event_time >= now() - INTERVAL '30 days'
       GROUP BY o.kind, o.orig_addr, o.resp_addr
    ),
    s4_aggr AS (
      SELECT o.kind, o.orig_addr,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '7 days')  AS c_7d,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '14 days') AS c_14d,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '30 days') AS c_30d
        FROM observed_event_meta o
        JOIN (
          SELECT DISTINCT kind, orig_addr
            FROM page_rows
           WHERE orig_addr IS NOT NULL
        ) page_s4_keys
          ON page_s4_keys.kind      = o.kind
         AND page_s4_keys.orig_addr = o.orig_addr
       WHERE o.event_time >= now() - INTERVAL '30 days'
       GROUP BY o.kind, o.orig_addr
    )
    SELECT pr.event_key::text                  AS event_key,
           COALESCE(r7.r, 0)::float8           AS s1_7d,
           COALESCE(r14.r, 0)::float8          AS s1_14d,
           COALESCE(r30.r, 0)::float8          AS s1_30d,
           COALESCE(s3a.c_7d, 0)::bigint       AS s3_7d,
           COALESCE(s3a.c_14d, 0)::bigint      AS s3_14d,
           COALESCE(s3a.c_30d, 0)::bigint      AS s3_30d,
           COALESCE(s4a.c_7d, 0)::bigint       AS s4_7d,
           COALESCE(s4a.c_14d, 0)::bigint      AS s4_14d,
           COALESCE(s4a.c_30d, 0)::bigint      AS s4_30d
      FROM page_rows pr
      LEFT JOIN ranked_7d  r7  ON r7.event_key  = pr.event_key
      LEFT JOIN ranked_14d r14 ON r14.event_key = pr.event_key
      LEFT JOIN ranked_30d r30 ON r30.event_key = pr.event_key
      LEFT JOIN s3_aggr s3a
             ON s3a.kind      = pr.kind
            AND s3a.orig_addr = pr.orig_addr
            AND s3a.resp_addr = pr.resp_addr
      LEFT JOIN s4_aggr s4a
             ON s4a.kind      = pr.kind
            AND s4a.orig_addr = pr.orig_addr
  `;

  type Row = {
    event_key: string;
    s1_7d: number;
    s1_14d: number;
    s1_30d: number;
    s3_7d: string;
    s3_14d: string;
    s3_30d: string;
    s4_7d: string;
    s4_14d: string;
    s4_30d: string;
  };
  const res = await client.query<Row>(sql, pageParams);
  // Lookup table for the page row's `category` — needed for the
  // conditional S4 self-exclusion below.
  const pageRowsByKey = new Map(pageRows.map((r) => [r.eventKey, r]));
  for (const row of res.rows) {
    const pageRow = pageRowsByKey.get(row.event_key);
    // S3 self-exclusion: `COUNT(*)` always counts the page row when its
    // (orig_addr, resp_addr) is non-NULL (Phase 1 always inserts those
    // survivors into `observed_event_meta`, and `s3_aggr` filters out
    // NULL-address rows so the JOIN misses NULL-address page rows
    // entirely → COALESCE 0 → max(0, -1) = 0). Subtract unconditionally.
    //
    // S4 self-exclusion: `COUNT(DISTINCT o.category)` ignores NULL
    // categories (standard SQL), so the page row only contributes a
    // distinct value when its own `category` is non-NULL. Subtracting
    // unconditionally would undercount when the page row's category is
    // NULL — e.g., peers contribute {A, B}, page row is NULL → count = 2,
    // RFC §3 distinct-peer-categories should be 2, not 1.
    const s4Subtract = pageRow?.category != null ? 1 : 0;
    result.set(row.event_key, {
      s1: {
        7: Number(row.s1_7d) || 0,
        14: Number(row.s1_14d) || 0,
        30: Number(row.s1_30d) || 0,
      },
      s3RepeatMinusSelf: {
        7: Math.max(0, Number(row.s3_7d) - 1),
        14: Math.max(0, Number(row.s3_14d) - 1),
        30: Math.max(0, Number(row.s3_30d) - 1),
      },
      s4DistinctMinusSelf: {
        7: Math.max(0, Number(row.s4_7d) - s4Subtract),
        14: Math.max(0, Number(row.s4_14d) - s4Subtract),
        30: Math.max(0, Number(row.s4_30d) - s4Subtract),
      },
    });
  }
  return result;
}

/**
 * Per-event tag set helper. Exported for direct unit testing of the
 * §9 thresholds without round-tripping through the batched SELECT.
 */
export function emitSelectorTags(
  s1: number,
  s2: number,
  s3: number,
  s4: number,
  unlabeled: number,
): string[] {
  const tags: string[] = [];
  if (s1 > TAG_THRESHOLDS.s1_high) tags.push(SELECTOR_TAGS.S1_HIGH);
  if (s2 >= 1) tags.push(SELECTOR_TAGS.S2_SEVERE);
  if (s3 > TAG_THRESHOLDS.s3_recurring) tags.push(SELECTOR_TAGS.S3_RECURRING);
  if (s4 > TAG_THRESHOLDS.s4_correlated) tags.push(SELECTOR_TAGS.S4_CORRELATED);
  if (unlabeled >= 1) tags.push(SELECTOR_TAGS.UNLABELED_CLUSTER);
  return tags;
}

/**
 * Combine the per-window selector values for one event with the
 * per-event S2 / UNLABELED_BONUS values, apply §9 weights, and emit
 * the §9 tag set.
 *
 * Per RFC §7: per-selector value is the MAX across active windows;
 * pre-activation windows contribute 0 and never depress the max. The
 * selector union is still the weighted sum of §3.
 */
export function buildSelectorOutputs(
  row: PageScoringRow,
  perWindow: PerWindowValues | undefined,
  activeWindows: ActiveWindows,
): SelectorOutputs {
  const pw = perWindow ?? EMPTY_PER_WINDOW;

  const s1 = maxAcrossActive(pw.s1, activeWindows);

  const s3Raw = row.origAddr !== null && row.respAddr !== null;
  const s3 = s3Raw
    ? Math.min(
        1,
        maxAcrossActive(pw.s3RepeatMinusSelf, activeWindows) /
          SELECTOR_SATURATION.R,
      )
    : 0;

  const s4Raw = row.origAddr !== null;
  const s4 = s4Raw
    ? Math.min(
        1,
        maxAcrossActive(pw.s4DistinctMinusSelf, activeWindows) /
          SELECTOR_SATURATION.C,
      )
    : 0;

  const s2 =
    row.category !== null &&
    CRITICAL_CATEGORIES.has(row.category as ThreatCategory)
      ? 1
      : 0;

  const unlabeled =
    row.kind === HTTP_THREAT_TYPENAME && isClusterNone(row.clusterId) ? 1 : 0;

  const rawScore =
    SELECTOR_WEIGHTS.w_S1 * s1 +
    SELECTOR_WEIGHTS.w_S2 * s2 +
    SELECTOR_WEIGHTS.w_S3 * s3 +
    SELECTOR_WEIGHTS.w_S4 * s4 +
    SELECTOR_WEIGHTS.w_UNLABELED * unlabeled;

  return {
    rawScore,
    selectorTags: emitSelectorTags(s1, s2, s3, s4, unlabeled),
    s1,
    s2,
    s3,
    s4,
    unlabeled,
  };
}

/**
 * Score a TriageEvent directly given its per-window aggregates. Thin
 * wrapper around {@link buildSelectorOutputs} that pulls the per-event
 * inputs off the GraphQL node. Used by the pager to translate the
 * batched SELECT output back into per-event INSERT parameters.
 */
export function scoreEventFromBatch(
  event: TriageEvent,
  eventKey: string,
  origAddr: string | null,
  respAddr: string | null,
  perWindow: PerWindowValues | undefined,
  activeWindows: ActiveWindows,
): SelectorOutputs {
  return buildSelectorOutputs(
    {
      eventKey,
      kind: event.__typename,
      origAddr,
      respAddr,
      category: event.category,
      confidence:
        typeof (event as TriageEvent & { confidence?: number | null })
          .confidence === "number"
          ? ((event as TriageEvent & { confidence?: number | null })
              .confidence ?? null)
          : null,
      clusterId: event.clusterId ?? null,
    },
    perWindow,
    activeWindows,
  );
}

function maxAcrossActive(
  per: Record<StatisticsWindowDays, number>,
  active: ActiveWindows,
): number {
  let m = 0;
  for (const days of STATISTICS_WINDOW_DAYS) {
    if (!active.has(days)) continue;
    const v = per[days];
    if (v > m) m = v;
  }
  return m;
}
