/**
 * Phase 2 baseline streaming push payload loader (sub-issue #571).
 *
 * Used by `POST /api/aimer/phase2/baseline-event/next-batch` to assemble
 * the new-row batch payload that goes into a `phase2.baseline.v1`
 * envelope, and to enrich queued `refresh_baseline_window` /
 * `backfill_baseline_window` payloads with the same RFC 0002 §6 baseline-
 * batch fields so the wire shape is symmetric across the streaming and
 * replay paths (option (a) in the issue's open design call).
 *
 * Each baseline event is enriched with the §6 fields that are NOT
 * persisted on the corpus row:
 *
 *   - `window_signals` — S1 / S3 / S4 + correlated event_keys at push
 *     time, computed against `observed_event_meta` using the same
 *     multi-window (7d / 14d / 30d) FILTER aggregates the Triage menu
 *     uses (`src/lib/triage/baseline/selectors.ts`), combined via
 *     MAX across active windows per RFC 0001 §7.
 *   - `score_window_context` — `kind_cohort_window`, `kind_cohort_size`,
 *     `baseline_rank_snapshot`. Cohort partition is
 *     `(kind, baseline_version)` to match the menu cohort SQL
 *     (`src/lib/triage/baseline/read-path-sql.mjs`); `kind_cohort_size`
 *     is per-kind, not slice-wide.
 *   - `asset_context` — `primary_asset` + a small `peer_event_summary`
 *     condensing other baseline-passing events from the same asset in
 *     the same window.
 *   - `scoring_weights_snapshot` — the §9 selector weights / saturation
 *     caps / tag thresholds in effect at push time.
 *
 * **Cohort window choice.** For streaming batches the cohort is the
 * Triage menu's default rendering window: `[now − TRIAGE_DEFAULT_DURATION,
 * now]`. The issue's payload-builder section explicitly directs picking
 * "a sensible default that the menu rendering layer already uses" since
 * there is no single user-selected period at push time. For
 * refresh / backfill enrichment the cohort is the queue payload's own
 * `window.from`..`window.to` — the specific historical window being
 * replaced on aimer-web.
 *
 * The slice is limited per call by the shared
 * {@link PHASE2_REFRESH_PAYLOAD_MAX_BYTES} budget so a single round-trip
 * stays well below aimer-web's `BRIDGE_MAX_PAYLOAD_BYTES` ceiling — the
 * drain loop handles multi-batch progress on its own.
 *
 * **Scope of `raw_event` enrichment.** The on-wire `raw_event` is
 * assembled from `baseline_triaged_event` — i.e., the local mirror's
 * packet-bytes-excluded subset of the upstream REview row. Fields not
 * persisted on the corpus (TLS ja3, HTTP user-agent, country codes,
 * etc.) are not joined back in this issue; cross-system REview GraphQL
 * enrichment at push time is a deliberate follow-up (RFC 0002 §11.5
 * "implementation-time decision" band) since the corpus columns are
 * what the menu surfaces today and aimer-web's `baseline_event`
 * `payload` column is `jsonb` and accepts both the subset and the
 * future superset without migration.
 */

import "server-only";

import type pg from "pg";

import {
  type BaselineRefreshEvent,
  type BaselineRefreshSubPayload,
  PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
  PHASE2_REFRESH_PAYLOAD_MAX_BYTES,
} from "@/lib/aimer/phase2/payload-builders";
import { detectActiveWindows } from "@/lib/triage/baseline/selectors";
import {
  SELECTOR_SATURATION,
  SELECTOR_TAGS,
  SELECTOR_WEIGHTS,
  STATISTICS_WINDOW_DAYS,
  type StatisticsWindowDays,
  TAG_THRESHOLDS,
} from "@/lib/triage/baseline/tunables";
import { TRIAGE_DEFAULT_DURATION_MS } from "@/lib/triage/period";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * Default page size — upper bound on rows pulled per call before the
 * byte budget kicks in. Sized to ~baseline cadence page so the SQL
 * round-trip cost stays bounded even on very busy tenants. The byte
 * budget below trims further as needed.
 */
const DEFAULT_ROW_LIMIT = 500;

/**
 * Hard cap on rows actually emitted per call after the byte budget is
 * enforced. Multi-batch progress is the drain loop's job; this loader
 * never tries to produce more than one batch per call.
 */
const MAX_ROWS_PER_BATCH = 500;

/**
 * Cap on the `top_peer_kinds[]` array embedded in
 * `asset_context.peer_event_summary`. Keeps the per-event budget under
 * the 2 KB target stated in #571's "Asset short context" section.
 */
const PEER_KIND_TOP_LIMIT = 5;

/**
 * Cap on `window_signals.s4_correlated_event_keys[]`. Bounds the
 * per-event payload contribution from the correlated-event set while
 * still surfacing the most relevant peers.
 */
const S4_EVENT_KEYS_LIMIT = 50;

export interface BaselineStreamingEvent extends BaselineRefreshEvent {
  raw_score: number | null;
  selector_tags: string[] | null;
  raw_event: Record<string, unknown>;
  score_window_context: {
    kind_cohort_window: { from: string; to: string };
    kind_cohort_size: number;
    baseline_rank_snapshot: number | null;
  };
  window_signals: {
    s1_percentile_rank: number | null;
    s3_recurring_count: number;
    s4_correlated_count: number;
    s4_correlated_event_keys: string[];
  };
  asset_context: {
    primary_asset: string | null;
    peer_event_summary: {
      total_peer_count: number;
      top_peer_kinds: Array<{ kind: string; count: number }>;
    };
  };
  scoring_weights_snapshot: typeof SCORING_WEIGHTS_SNAPSHOT;
}

export interface BaselineStreamingSlice {
  events: BaselineStreamingEvent[];
  /** Last (event_time, event_key) tuple consumed — cursor target on ack. */
  lastEventTime: Date | null;
  lastEventKey: string | null;
  /** True when at least one un-consumed row remains past this slice. */
  hasMore: boolean;
  /** Baseline version observed (single — streaming is single-version). */
  baselineVersion: string | null;
}

interface BaselineCursorRowSql {
  event_key: string;
  event_time: Date;
  event_time_iso: string;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  orig_port: number | null;
  resp_addr: string | null;
  resp_port: number | null;
  proto: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: string | null;
  baseline_version: string;
  exclusions_fp: string;
  raw_score: number | null;
  selector_tags: string[] | null;
}

const SCORING_WEIGHTS_SNAPSHOT = Object.freeze({
  selector_weights: { ...SELECTOR_WEIGHTS },
  selector_saturation: { ...SELECTOR_SATURATION },
  tag_thresholds: { ...TAG_THRESHOLDS },
  statistics_window_days: [...STATISTICS_WINDOW_DAYS] as readonly number[],
  selector_tags: { ...SELECTOR_TAGS },
});

export interface LoadBaselineStreamingSliceInput {
  customerId: number;
  cursorEventTime: Date | null;
  cursorEventKey: string | null;
  /**
   * Maximum payload bytes (inner JSON, before envelope). Defaults to
   * {@link PHASE2_REFRESH_PAYLOAD_MAX_BYTES} minus the
   * {@link PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES} reserve so the
   * post-augmentation payload still fits the shared cap.
   */
  maxBytes?: number;
  /** Max rows pulled from PG before the byte budget trims. */
  rowLimit?: number;
  /** Override for tests; defaults to the wall-clock `now`. */
  now?: Date;
}

/**
 * Load the next streaming slice of baseline rows past the cursor +
 * enrich each row with the §6 baseline-batch fields. Returns the slice,
 * the (event_time, event_key) cursor target for the post-ack advance,
 * and a `hasMore` hint.
 */
export async function loadBaselineStreamingSlice(
  input: LoadBaselineStreamingSliceInput,
): Promise<BaselineStreamingSlice> {
  const pool = await getCustomerPool(input.customerId);
  const client = await pool.connect();
  try {
    return await loadSlice(client, input);
  } finally {
    client.release();
  }
}

/**
 * Cheap existence check: are there any `baseline_triaged_event` rows
 * past the given cursor? Used by the queue-notice branch of the drain
 * route to set `has_more=true` when streaming work remains behind a
 * queue batch, so the "queue notices first, new-row batches second"
 * sequence actually plays out within a single drain activation rather
 * than terminating after the queue batch alone.
 */
export async function hasStreamingRowsPastCursor(input: {
  customerId: number;
  cursorEventTime: Date | null;
  cursorEventKey: string | null;
}): Promise<boolean> {
  const pool = await getCustomerPool(input.customerId);
  const params: unknown[] = [];
  let where = "";
  if (input.cursorEventTime !== null && input.cursorEventKey !== null) {
    params.push(input.cursorEventTime, input.cursorEventKey);
    where = "WHERE (event_time, event_key) > ($1::timestamptz, $2::numeric)";
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM baseline_triaged_event ${where} LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

async function loadSlice(
  client: pg.PoolClient,
  input: LoadBaselineStreamingSliceInput,
): Promise<BaselineStreamingSlice> {
  const rowLimit = Math.min(
    Math.max(1, input.rowLimit ?? DEFAULT_ROW_LIMIT),
    MAX_ROWS_PER_BATCH,
  );
  const rows = await selectCursorSlice(client, {
    cursorEventTime: input.cursorEventTime,
    cursorEventKey: input.cursorEventKey,
    // Pull one extra row so we can compute `hasMore` without a second
    // round-trip — the trailing row stays in the cursor for the next
    // call.
    limit: rowLimit + 1,
  });

  const oversizeCheck = rows.slice(0, rowLimit);
  const hasMore = rows.length > rowLimit;

  if (oversizeCheck.length === 0) {
    return {
      events: [],
      lastEventTime: null,
      lastEventKey: null,
      hasMore: false,
      baselineVersion: null,
    };
  }

  const baselineVersion = oversizeCheck[0].baseline_version;

  // Cohort window for streaming: the Triage menu's default rendering
  // window anchored at `now`. The issue explicitly directs picking
  // "a sensible default the menu rendering layer already uses" — the
  // menu's default period (last 24 h) is what an analyst sees when
  // they open the tab without changing the date picker, so the snapshot
  // matches that read-time view. Refresh / backfill enrichment uses
  // the queue payload's own window instead (see {@link enrichRefreshPayload}).
  const now = input.now ?? new Date();
  const cohortFrom = new Date(now.getTime() - TRIAGE_DEFAULT_DURATION_MS);
  const cohortFromIso = cohortFrom.toISOString();
  const cohortToIso = now.toISOString();

  const enriched = await enrichEvents(client, {
    rows: oversizeCheck,
    cohortFromIso,
    cohortToIso,
    baselineVersion,
    now,
  });

  // Trim by serialized byte budget. The drain loop will pick up the
  // trimmed tail on the next iteration via the unchanged cursor.
  const rawBudget = input.maxBytes ?? PHASE2_REFRESH_PAYLOAD_MAX_BYTES;
  const budget = Math.max(
    1,
    rawBudget - PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
  );
  const fitted = trimToBudget(enriched, baselineVersion, budget);

  if (fitted.length === 0) {
    // Even a single event exceeds the budget — emit it anyway (the
    // byte cap is a soft preference, never a deadlock). The next loop
    // iteration will advance past it.
    fitted.push(enriched[0]);
  }
  const trimmed = fitted.length < enriched.length || hasMore;
  const last = fitted[fitted.length - 1];

  return {
    events: fitted,
    lastEventTime: oversizeCheck[fitted.length - 1].event_time,
    lastEventKey: last.event_key,
    hasMore: trimmed,
    baselineVersion,
  };
}

async function selectCursorSlice(
  client: pg.PoolClient,
  input: {
    cursorEventTime: Date | null;
    cursorEventKey: string | null;
    limit: number;
  },
): Promise<BaselineCursorRowSql[]> {
  const params: unknown[] = [];
  let where = "";
  if (input.cursorEventTime !== null && input.cursorEventKey !== null) {
    params.push(input.cursorEventTime, input.cursorEventKey);
    where = `WHERE (event_time, event_key) > ($1::timestamptz, $2::numeric)`;
  }
  params.push(input.limit);
  const limitParamIdx = params.length;
  const { rows } = await client.query<BaselineCursorRowSql>(
    `SELECT event_key::text                  AS event_key,
            event_time,
            to_char(event_time AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS event_time_iso,
            kind,
            sensor,
            host(orig_addr)::text            AS orig_addr,
            orig_port,
            host(resp_addr)::text            AS resp_addr,
            resp_port,
            proto,
            host,
            dns_query,
            uri,
            category,
            baseline_version,
            exclusions_fp,
            raw_score,
            selector_tags
       FROM baseline_triaged_event
       ${where}
       ORDER BY event_time, event_key
       LIMIT $${limitParamIdx}`,
    params,
  );
  return rows;
}

/**
 * Per-kind cohort size + per-event `baseline_rank_snapshot` against the
 * `(kind, baseline_version)` partition matching the menu cohort SQL in
 * `src/lib/triage/baseline/read-path-sql.mjs`.
 *
 * `kind_cohort_size` is the count of rows in the cohort window sharing
 * the event's `kind` (within the given `baseline_version`) — per-kind,
 * not slice-wide, since the wire field is named `kind_cohort_size`.
 */
async function loadBaselineRankSnapshot(
  client: pg.PoolClient,
  input: {
    cohortFromIso: string;
    cohortToIso: string;
    baselineVersion: string;
    rows: ReadonlyArray<{ event_key: string; kind: string }>;
  },
): Promise<{
  rankByKey: Map<string, number>;
  cohortSizeByKind: Map<string, number>;
}> {
  const rankByKey = new Map<string, number>();
  const cohortSizeByKind = new Map<string, number>();
  if (input.rows.length === 0) {
    return { rankByKey, cohortSizeByKind };
  }
  // Mirrors `SELECT_MENU_COHORT_SQL` partition: `(kind, baseline_version)`
  // ordered by `raw_score`. `event_time >= from AND event_time < to` is
  // the same half-open shape the menu's period filter uses.
  const eventKeys = input.rows.map((r) => r.event_key);
  const { rows: rankRows } = await client.query<{
    event_key: string;
    rank: number;
  }>(
    `WITH cohort AS (
       SELECT event_key,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS rank
         FROM baseline_triaged_event
        WHERE event_time >= $1::timestamptz
          AND event_time <  $2::timestamptz
          AND baseline_version = $3
     )
     SELECT event_key::text AS event_key,
            rank::float8    AS rank
       FROM cohort
      WHERE event_key = ANY($4::numeric[])`,
    [
      input.cohortFromIso,
      input.cohortToIso,
      input.baselineVersion,
      eventKeys as unknown as string[],
    ],
  );
  for (const row of rankRows) {
    rankByKey.set(row.event_key, Number(row.rank));
  }
  // Per-kind cohort size — the COUNT(*) over the same partition shape.
  const kinds = Array.from(new Set(input.rows.map((r) => r.kind)));
  const { rows: sizeRows } = await client.query<{
    kind: string;
    count: string;
  }>(
    `SELECT kind,
            COUNT(*)::text AS count
       FROM baseline_triaged_event
      WHERE event_time >= $1::timestamptz
        AND event_time <  $2::timestamptz
        AND baseline_version = $3
        AND kind = ANY($4::text[])
      GROUP BY kind`,
    [input.cohortFromIso, input.cohortToIso, input.baselineVersion, kinds],
  );
  for (const row of sizeRows) {
    cohortSizeByKind.set(row.kind, Number(row.count));
  }
  return { rankByKey, cohortSizeByKind };
}

interface WindowSignalsRowKey {
  event_key: string;
  kind: string;
  orig_addr: string | null;
  resp_addr: string | null;
  category: string | null;
}

interface WindowSignalsValue {
  s1_percentile_rank: number | null;
  s3_recurring_count: number;
  s4_correlated_count: number;
  s4_correlated_event_keys: string[];
}

type PerWindow<T> = Record<StatisticsWindowDays, T>;

/**
 * Window-level signals (S1 / S3 / S4) computed at push time against
 * `observed_event_meta` per RFC 0001 §8. Mirrors the menu's batched
 * SELECT in `src/lib/triage/baseline/selectors.ts` so the pushed S1 /
 * S3 / S4 values match the menu's read-time values for the same row:
 *
 *   - All three statistics windows (7d / 14d / 30d) are computed in
 *     one SELECT via `FILTER` aggregates.
 *   - Active windows (`detectActiveWindows`) gate which window
 *     contributes; pre-activation windows zero out per RFC 0001 §7
 *     cold-start.
 *   - Per-selector value is the MAX across active windows — same shape
 *     as `maxAcrossActive` in `selectors.ts`.
 *   - `s4_correlated_event_keys` are unioned across active windows
 *     (deduped, capped at {@link S4_EVENT_KEYS_LIMIT}) so the keys
 *     reflect the same union the count summarizes.
 */
async function loadWindowSignals(
  client: pg.PoolClient,
  rows: readonly WindowSignalsRowKey[],
): Promise<Map<string, WindowSignalsValue>> {
  const result = new Map<string, WindowSignalsValue>();
  if (rows.length === 0) return result;

  const activeWindows = await detectActiveWindows(client);

  const pageParams: unknown[] = [];
  const placeholderRows: string[] = [];
  for (const row of rows) {
    const baseIdx = pageParams.length;
    pageParams.push(row.event_key, row.kind, row.orig_addr, row.resp_addr);
    placeholderRows.push(
      `($${baseIdx + 1}::numeric, $${baseIdx + 2}::text, $${baseIdx + 3}::inet, $${baseIdx + 4}::inet)`,
    );
  }
  const pageValues = placeholderRows.join(", ");

  // Same shape as `scoreSelectorsForPage` in
  // `src/lib/triage/baseline/selectors.ts`: three ranked CTEs for S1 +
  // s3_aggr / s4_aggr with per-window FILTER aggregates. The 30d corpus
  // is grouped once per (kind, orig_addr [, resp_addr]) tuple and the
  // per-window values are filtered out via FILTER aggregates so the
  // planner picks a single shape regardless of which windows are
  // active.
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
        ) k
          ON k.kind = o.kind
         AND k.orig_addr = o.orig_addr
         AND k.resp_addr = o.resp_addr
       WHERE o.event_time >= now() - INTERVAL '30 days'
       GROUP BY o.kind, o.orig_addr, o.resp_addr
    ),
    s4_aggr AS (
      SELECT o.kind, o.orig_addr,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '7 days')  AS c_7d,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '14 days') AS c_14d,
             COUNT(DISTINCT o.category) FILTER (WHERE o.event_time >= now() - INTERVAL '30 days') AS c_30d,
             COALESCE(array_agg(o.event_key::text ORDER BY o.event_time DESC)
                        FILTER (WHERE o.event_time >= now() - INTERVAL '7 days'
                                  AND o.category IS NOT NULL),
                      ARRAY[]::text[]) AS keys_7d,
             COALESCE(array_agg(o.event_key::text ORDER BY o.event_time DESC)
                        FILTER (WHERE o.event_time >= now() - INTERVAL '14 days'
                                  AND o.category IS NOT NULL),
                      ARRAY[]::text[]) AS keys_14d,
             COALESCE(array_agg(o.event_key::text ORDER BY o.event_time DESC)
                        FILTER (WHERE o.event_time >= now() - INTERVAL '30 days'
                                  AND o.category IS NOT NULL),
                      ARRAY[]::text[]) AS keys_30d
        FROM observed_event_meta o
        JOIN (
          SELECT DISTINCT kind, orig_addr
            FROM page_rows
           WHERE orig_addr IS NOT NULL
        ) k
          ON k.kind = o.kind
         AND k.orig_addr = o.orig_addr
       WHERE o.event_time >= now() - INTERVAL '30 days'
       GROUP BY o.kind, o.orig_addr
    )
    SELECT pr.event_key::text                       AS event_key,
           COALESCE(r7.r,  0)::float8               AS s1_7d,
           COALESCE(r14.r, 0)::float8               AS s1_14d,
           COALESCE(r30.r, 0)::float8               AS s1_30d,
           (r7.r  IS NOT NULL)                      AS s1_7d_has,
           (r14.r IS NOT NULL)                      AS s1_14d_has,
           (r30.r IS NOT NULL)                      AS s1_30d_has,
           COALESCE(s3a.c_7d,  0)::bigint           AS s3_7d,
           COALESCE(s3a.c_14d, 0)::bigint           AS s3_14d,
           COALESCE(s3a.c_30d, 0)::bigint           AS s3_30d,
           COALESCE(s4a.c_7d,  0)::bigint           AS s4_7d,
           COALESCE(s4a.c_14d, 0)::bigint           AS s4_14d,
           COALESCE(s4a.c_30d, 0)::bigint           AS s4_30d,
           COALESCE(s4a.keys_7d,  ARRAY[]::text[])  AS s4_keys_7d,
           COALESCE(s4a.keys_14d, ARRAY[]::text[])  AS s4_keys_14d,
           COALESCE(s4a.keys_30d, ARRAY[]::text[])  AS s4_keys_30d
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
    s1_7d_has: boolean;
    s1_14d_has: boolean;
    s1_30d_has: boolean;
    s3_7d: string;
    s3_14d: string;
    s3_30d: string;
    s4_7d: string;
    s4_14d: string;
    s4_30d: string;
    s4_keys_7d: string[];
    s4_keys_14d: string[];
    s4_keys_30d: string[];
  };
  const { rows: outRows } = await client.query<Row>(sql, pageParams);
  const categoryByKey = new Map(rows.map((r) => [r.event_key, r.category]));
  for (const row of outRows) {
    const category = categoryByKey.get(row.event_key) ?? null;
    const s1: PerWindow<number | null> = {
      7: row.s1_7d_has ? Number(row.s1_7d) : null,
      14: row.s1_14d_has ? Number(row.s1_14d) : null,
      30: row.s1_30d_has ? Number(row.s1_30d) : null,
    };
    // S3 self-exclusion: `COUNT(*)` counts the page row when its
    // (orig_addr, resp_addr) is non-NULL; the s3_aggr join filters
    // NULL-address keys so NULL-address page rows already miss the join
    // (COALESCE 0). Math.max guards the underflow.
    const s3: PerWindow<number> = {
      7: Math.max(0, Number(row.s3_7d) - 1),
      14: Math.max(0, Number(row.s3_14d) - 1),
      30: Math.max(0, Number(row.s3_30d) - 1),
    };
    // S4 self-exclusion: `COUNT(DISTINCT category)` ignores NULL, so
    // subtract only when the page row's `category` is non-NULL.
    const s4Sub = category != null ? 1 : 0;
    const s4: PerWindow<number> = {
      7: Math.max(0, Number(row.s4_7d) - s4Sub),
      14: Math.max(0, Number(row.s4_14d) - s4Sub),
      30: Math.max(0, Number(row.s4_30d) - s4Sub),
    };
    const s4Keys: PerWindow<string[]> = {
      7: row.s4_keys_7d,
      14: row.s4_keys_14d,
      30: row.s4_keys_30d,
    };

    const s1Max = maxAcrossActive(s1, activeWindows);
    const s3Max = maxAcrossActive(s3, activeWindows);
    const s4Max = maxAcrossActive(s4, activeWindows);

    // Union the correlated keys across active windows (deduped, self
    // excluded, capped). Empty when no window is active.
    const seen = new Set<string>();
    const unionedKeys: string[] = [];
    for (const days of STATISTICS_WINDOW_DAYS) {
      if (!activeWindows.has(days)) continue;
      for (const key of s4Keys[days]) {
        if (key === row.event_key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        unionedKeys.push(key);
        if (unionedKeys.length >= S4_EVENT_KEYS_LIMIT) break;
      }
      if (unionedKeys.length >= S4_EVENT_KEYS_LIMIT) break;
    }

    // S3 / S4 are counts — a cold-start tenant just hasn't seen peers
    // yet, which is semantically zero. S1 stays nullable so the wire
    // payload can distinguish "rank is zero" from "no statistics
    // window is active yet."
    result.set(row.event_key, {
      s1_percentile_rank: s1Max,
      s3_recurring_count: s3Max ?? 0,
      s4_correlated_count: s4Max ?? 0,
      s4_correlated_event_keys: unionedKeys,
    });
  }
  return result;
}

/**
 * MAX across active statistics windows. Pre-activation windows
 * contribute zero per RFC 0001 §7. `null` per-window values (e.g. S1
 * has no rank because the page row's `confidence` is NULL) are treated
 * as zero — same as the menu's `maxAcrossActive` in `selectors.ts`.
 *
 * Returns `null` only when no statistics window is active (cold-start
 * tenants) so the wire payload distinguishes "value is zero" from
 * "no window covers this row yet" in the S1 field.
 */
function maxAcrossActive(
  per: PerWindow<number | null>,
  active: ReadonlySet<StatisticsWindowDays>,
): number | null {
  if (active.size === 0) return null;
  let m = 0;
  for (const days of STATISTICS_WINDOW_DAYS) {
    if (!active.has(days)) continue;
    const v = per[days] ?? 0;
    if (v > m) m = v;
  }
  return m;
}

interface PeerSummary {
  total_peer_count: number;
  top_peer_kinds: Array<{ kind: string; count: number }>;
}

/**
 * Build {@link PeerSummary} per primary asset (host address). Counts
 * other baseline-passing events from the same asset within the cohort
 * window, grouped by kind. Capped at {@link PEER_KIND_TOP_LIMIT}
 * entries to keep the per-event payload contribution under the 2 KB
 * target.
 */
async function loadPeerEventSummaries(
  client: pg.PoolClient,
  input: {
    cohortFromIso: string;
    cohortToIso: string;
    assets: readonly string[];
  },
): Promise<Map<string, PeerSummary>> {
  const map = new Map<string, PeerSummary>();
  if (input.assets.length === 0) return map;
  const { rows } = await client.query<{
    orig_addr: string;
    kind: string;
    count: string;
  }>(
    `SELECT host(orig_addr)::text AS orig_addr,
            kind,
            COUNT(*)::text AS count
       FROM baseline_triaged_event
      WHERE event_time >= $1::timestamptz
        AND event_time <  $2::timestamptz
        AND orig_addr IS NOT NULL
        AND host(orig_addr)::text = ANY($3::text[])
      GROUP BY orig_addr, kind
      ORDER BY orig_addr, COUNT(*) DESC`,
    [
      input.cohortFromIso,
      input.cohortToIso,
      input.assets as unknown as string[],
    ],
  );
  for (const row of rows) {
    const summary = map.get(row.orig_addr) ?? {
      total_peer_count: 0,
      top_peer_kinds: [],
    };
    const count = Number(row.count);
    summary.total_peer_count += count;
    if (summary.top_peer_kinds.length < PEER_KIND_TOP_LIMIT) {
      summary.top_peer_kinds.push({ kind: row.kind, count });
    }
    map.set(row.orig_addr, summary);
  }
  return map;
}

interface EventRowForEnrichment {
  event_key: string;
  event_time: Date | string;
  event_time_iso: string;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  orig_port: number | null;
  resp_addr: string | null;
  resp_port: number | null;
  proto: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: string | null;
  baseline_version: string;
  exclusions_fp: string;
  raw_score: number | null;
  selector_tags: string[] | null;
}

interface EnrichEventsInput {
  rows: ReadonlyArray<EventRowForEnrichment>;
  cohortFromIso: string;
  cohortToIso: string;
  baselineVersion: string;
  now?: Date;
}

/**
 * Shared enrichment driver — fans out the score-window / window-signals
 * / peer-summary loaders and assembles {@link BaselineStreamingEvent}
 * rows. Used by both the streaming path and the refresh/backfill
 * enrichment helper so the wire shape is symmetric across paths.
 */
async function enrichEvents(
  client: pg.PoolClient,
  input: EnrichEventsInput,
): Promise<BaselineStreamingEvent[]> {
  if (input.rows.length === 0) return [];

  const [rankResult, signalsByKey, peerSummaryByAsset] = await Promise.all([
    loadBaselineRankSnapshot(client, {
      cohortFromIso: input.cohortFromIso,
      cohortToIso: input.cohortToIso,
      baselineVersion: input.baselineVersion,
      rows: input.rows.map((r) => ({ event_key: r.event_key, kind: r.kind })),
    }),
    loadWindowSignals(
      client,
      input.rows.map((r) => ({
        event_key: r.event_key,
        kind: r.kind,
        orig_addr: r.orig_addr,
        resp_addr: r.resp_addr,
        category: r.category,
      })),
    ),
    loadPeerEventSummaries(client, {
      cohortFromIso: input.cohortFromIso,
      cohortToIso: input.cohortToIso,
      assets: Array.from(
        new Set(
          input.rows
            .map((r) => r.orig_addr)
            .filter((v): v is string => v !== null),
        ),
      ),
    }),
  ]);

  return input.rows.map((row) =>
    buildStreamingEvent(row, {
      cohortFromIso: input.cohortFromIso,
      cohortToIso: input.cohortToIso,
      cohortSizeByKind: rankResult.cohortSizeByKind,
      rankByKey: rankResult.rankByKey,
      signal: signalsByKey.get(row.event_key) ?? null,
      peerSummary: peerSummaryByAsset.get(row.orig_addr ?? "") ?? null,
    }),
  );
}

interface EnrichmentInputs {
  cohortFromIso: string;
  cohortToIso: string;
  cohortSizeByKind: Map<string, number>;
  rankByKey: Map<string, number>;
  signal: WindowSignalsValue | null;
  peerSummary: PeerSummary | null;
}

function buildStreamingEvent(
  row: EventRowForEnrichment,
  enrich: EnrichmentInputs,
): BaselineStreamingEvent {
  // `raw_event` mirrors the packet-bytes-excluded subset of the
  // upstream REview row that lives on `baseline_triaged_event` — the
  // same columns the Triage menu surfaces today. Future REview GraphQL
  // enrichment is documented in the module header.
  const rawEvent: Record<string, unknown> = {
    event_key: row.event_key,
    event_time: row.event_time_iso,
    kind: row.kind,
    sensor: row.sensor,
    orig_addr: row.orig_addr,
    orig_port: row.orig_port,
    resp_addr: row.resp_addr,
    resp_port: row.resp_port,
    proto: row.proto,
    host: row.host,
    dns_query: row.dns_query,
    uri: row.uri,
    category: row.category,
  };
  const signal = enrich.signal ?? {
    s1_percentile_rank: null,
    s3_recurring_count: 0,
    s4_correlated_count: 0,
    s4_correlated_event_keys: [],
  };
  return {
    event_key: row.event_key,
    event_time: row.event_time_iso,
    kind: row.kind,
    sensor: row.sensor,
    orig_addr: row.orig_addr,
    orig_port: row.orig_port,
    resp_addr: row.resp_addr,
    resp_port: row.resp_port,
    proto: row.proto,
    host: row.host,
    dns_query: row.dns_query,
    uri: row.uri,
    category: row.category,
    baseline_version: row.baseline_version,
    exclusions_fp: row.exclusions_fp,
    raw_score: row.raw_score,
    selector_tags: row.selector_tags,
    raw_event: rawEvent,
    score_window_context: {
      kind_cohort_window: {
        from: enrich.cohortFromIso,
        to: enrich.cohortToIso,
      },
      kind_cohort_size: enrich.cohortSizeByKind.get(row.kind) ?? 0,
      baseline_rank_snapshot: enrich.rankByKey.get(row.event_key) ?? null,
    },
    window_signals: signal,
    asset_context: {
      primary_asset: row.orig_addr,
      peer_event_summary: enrich.peerSummary ?? {
        total_peer_count: 0,
        top_peer_kinds: [],
      },
    },
    scoring_weights_snapshot: SCORING_WEIGHTS_SNAPSHOT,
  };
}

/**
 * Trim a fully-enriched slice so the inner payload (events + top-level
 * `baseline_version` / future `external_key`) stays under `budget`
 * bytes. The drain loop will pick up the trimmed tail on the next
 * iteration via the unchanged cursor.
 */
function trimToBudget(
  events: BaselineStreamingEvent[],
  baselineVersion: string,
  budget: number,
): BaselineStreamingEvent[] {
  const fitted: BaselineStreamingEvent[] = [];
  const overhead = JSON.stringify({
    baseline_version: baselineVersion,
    events: [],
  }).length;
  let runningBytes = overhead;
  for (const event of events) {
    const eventBytes = JSON.stringify(event).length + 1; // +1 for array comma
    if (fitted.length > 0 && runningBytes + eventBytes > budget) break;
    fitted.push(event);
    runningBytes += eventBytes;
  }
  return fitted;
}

// ── Refresh / backfill enrichment (option (a) parity) ────────────────

/**
 * Enrich a queued `refresh_baseline_window` / `backfill_baseline_window`
 * payload so the wire shape is symmetric with the streaming-kind
 * batches (option (a) in the issue's open design call). The queue
 * payload is built by the mutation hook (#573 / PR 608) and carries the
 * schema-minimal `BaselineRefreshSubPayload` shape; this helper adds
 * the §6 baseline-batch fields (`window_signals`,
 * `score_window_context`, `raw_event`, `asset_context`,
 * `scoring_weights_snapshot`) at push time so aimer-web receives the
 * same per-event shape regardless of streaming vs. replay path.
 *
 * Cohort window for the §6 fields is the queue payload's own
 * `window.from`..`window.to` — the specific historical window being
 * replaced. Window-signal SQL still uses the rolling 7d / 14d / 30d
 * `observed_event_meta` windows anchored at `now()` since those
 * aggregates are read-time and not stored on the corpus.
 *
 * The `events[]` array of the input payload may carry rows with already-
 * present enrichment fields (e.g. produced by a prior reset that
 * already ran through this helper); the row's existing fields are
 * preserved if the loader returns no row for that event_key (already-
 * retention-swept), and overwritten with the freshly-computed values
 * otherwise. Schema passthrough on `baselineEvent` keeps both shapes
 * valid on the wire (see `payload-builders.ts:85-98`).
 */
export async function enrichRefreshPayload<P extends BaselineRefreshSubPayload>(
  customerId: number,
  payload: P,
): Promise<P> {
  if (payload.events.length === 0) return payload;
  const pool = await getCustomerPool(customerId);
  const client = await pool.connect();
  try {
    return await enrichRefreshPayloadWithClient(client, payload);
  } finally {
    client.release();
  }
}

async function enrichRefreshPayloadWithClient<
  P extends BaselineRefreshSubPayload,
>(client: pg.PoolClient, payload: P): Promise<P> {
  if (payload.events.length === 0) return payload;
  // Map the queue payload's row shape into the enrichment driver's
  // shape. The queue payload uses ISO `event_time` strings (built by
  // the mutation hook from `to_char` SQL); we pass the same value as
  // both `event_time` and `event_time_iso` so `buildStreamingEvent`
  // can copy it into `raw_event.event_time` without re-parsing.
  const rows: EventRowForEnrichment[] = payload.events.map((e) => ({
    event_key: e.event_key,
    event_time: e.event_time,
    event_time_iso: e.event_time,
    kind: e.kind,
    sensor: (e.sensor as string | undefined) ?? "",
    orig_addr: (e.orig_addr as string | null | undefined) ?? null,
    orig_port: (e.orig_port as number | null | undefined) ?? null,
    resp_addr: (e.resp_addr as string | null | undefined) ?? null,
    resp_port: (e.resp_port as number | null | undefined) ?? null,
    proto: (e.proto as number | null | undefined) ?? null,
    host: (e.host as string | null | undefined) ?? null,
    dns_query: (e.dns_query as string | null | undefined) ?? null,
    uri: (e.uri as string | null | undefined) ?? null,
    category: (e.category as string | null | undefined) ?? null,
    baseline_version:
      (e.baseline_version as string | undefined) ?? payload.baseline_version,
    exclusions_fp: (e.exclusions_fp as string | undefined) ?? "",
    raw_score: (e.raw_score as number | null | undefined) ?? null,
    selector_tags: (e.selector_tags as string[] | null | undefined) ?? null,
  }));

  const enriched = await enrichEvents(client, {
    rows,
    cohortFromIso: payload.window.from,
    cohortToIso: payload.window.to,
    baselineVersion: payload.baseline_version,
  });

  // Merge the enriched §6 fields back onto the queue payload's row,
  // preserving any extra passthrough fields the mutation hook already
  // wrote (the `baselineEvent` schema is `passthrough()`).
  const enrichedByKey = new Map(enriched.map((e) => [e.event_key, e]));
  const events = payload.events.map((original) => {
    const extra = enrichedByKey.get(original.event_key);
    if (!extra) return original;
    return {
      ...original,
      raw_event: extra.raw_event,
      score_window_context: extra.score_window_context,
      window_signals: extra.window_signals,
      asset_context: extra.asset_context,
      scoring_weights_snapshot: extra.scoring_weights_snapshot,
    };
  });

  return { ...payload, events } as P;
}

export const _testing = {
  trimToBudget,
  SCORING_WEIGHTS_SNAPSHOT,
  enrichRefreshPayloadWithClient,
};
