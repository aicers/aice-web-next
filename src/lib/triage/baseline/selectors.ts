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
 * the current `observed_event_meta` history. A window of `N` days is
 * active iff the oldest observed event is at least `N` days old —
 * i.e., the corpus spans at least the window's horizon (RFC §7 cold
 * start). Pre-activation windows return `false` so the per-window MAX
 * step zeroes their contribution.
 *
 * Called once per page (before Phase 2) so the scorer can pass the set
 * straight into {@link buildSelectorOutputs}. Cheap: a single
 * `min(event_time)` scan that the `(event_time DESC)` btree resolves.
 */
export async function detectActiveWindows(
  client: pg.PoolClient,
): Promise<ActiveWindows> {
  const result = await client.query<{ oldest: Date | null }>(
    `SELECT min(event_time) AS oldest FROM observed_event_meta`,
  );
  const oldest = result.rows[0]?.oldest ?? null;
  if (oldest === null) {
    return new Set();
  }
  const now = Date.now();
  const ageMs = now - oldest.getTime();
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

  // Three CTEs (one per window) compute s1 = cume_dist over the
  // same-kind slice. Joined back to the page rows so only page event
  // keys remain in the projection.
  //
  // s3 / s4 use a single LEFT JOIN against observed_event_meta filtered
  // to the 30d window with `FILTER (WHERE event_time >= …)` aggregates
  // projecting the 7d / 14d sub-slices. Per RFC §3:
  //   s3 = repeat count of (orig_addr, resp_addr, kind) in window
  //   s4 = distinct categories of (orig_addr, kind) in window
  // The `-1` self-exclusion is applied in JS (post-saturation) so the
  // SQL stays a pure aggregate.
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
    ranked_7d AS (
      SELECT event_key,
             cume_dist() OVER (PARTITION BY kind ORDER BY confidence) AS r
        FROM observed_event_meta
       WHERE event_time >= now() - INTERVAL '7 days'
    ),
    ranked_14d AS (
      SELECT event_key,
             cume_dist() OVER (PARTITION BY kind ORDER BY confidence) AS r
        FROM observed_event_meta
       WHERE event_time >= now() - INTERVAL '14 days'
    ),
    ranked_30d AS (
      SELECT event_key,
             cume_dist() OVER (PARTITION BY kind ORDER BY confidence) AS r
        FROM observed_event_meta
       WHERE event_time >= now() - INTERVAL '30 days'
    ),
    s3 AS (
      SELECT pr.event_key,
             COUNT(o.event_key) FILTER (WHERE o.event_time >= now() - INTERVAL '7 days')  AS c_7d,
             COUNT(o.event_key) FILTER (WHERE o.event_time >= now() - INTERVAL '14 days') AS c_14d,
             COUNT(o.event_key) FILTER (WHERE o.event_time >= now() - INTERVAL '30 days') AS c_30d
        FROM page_rows pr
        LEFT JOIN observed_event_meta o
          ON o.kind = pr.kind
         AND o.orig_addr = pr.orig_addr
         AND o.resp_addr = pr.resp_addr
         AND o.event_time >= now() - INTERVAL '30 days'
       WHERE pr.orig_addr IS NOT NULL AND pr.resp_addr IS NOT NULL
       GROUP BY pr.event_key
    ),
    s4 AS (
      SELECT pr.event_key,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '7 days')  AS c_7d,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '14 days') AS c_14d,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '30 days') AS c_30d
        FROM page_rows pr
        LEFT JOIN observed_event_meta o
          ON o.kind = pr.kind
         AND o.orig_addr = pr.orig_addr
         AND o.event_time >= now() - INTERVAL '30 days'
       WHERE pr.orig_addr IS NOT NULL
       GROUP BY pr.event_key
    )
    SELECT pr.event_key::text                  AS event_key,
           COALESCE(r7.r, 0)::float8           AS s1_7d,
           COALESCE(r14.r, 0)::float8          AS s1_14d,
           COALESCE(r30.r, 0)::float8          AS s1_30d,
           COALESCE(s3.c_7d, 0)::bigint        AS s3_7d,
           COALESCE(s3.c_14d, 0)::bigint       AS s3_14d,
           COALESCE(s3.c_30d, 0)::bigint       AS s3_30d,
           COALESCE(s4.c_7d, 0)::bigint        AS s4_7d,
           COALESCE(s4.c_14d, 0)::bigint       AS s4_14d,
           COALESCE(s4.c_30d, 0)::bigint       AS s4_30d
      FROM page_rows pr
      LEFT JOIN ranked_7d  r7  ON r7.event_key  = pr.event_key
      LEFT JOIN ranked_14d r14 ON r14.event_key = pr.event_key
      LEFT JOIN ranked_30d r30 ON r30.event_key = pr.event_key
      LEFT JOIN s3              ON s3.event_key  = pr.event_key
      LEFT JOIN s4              ON s4.event_key  = pr.event_key
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
  for (const row of res.rows) {
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
        7: Math.max(0, Number(row.s4_7d) - 1),
        14: Math.max(0, Number(row.s4_14d) - 1),
        30: Math.max(0, Number(row.s4_30d) - 1),
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
